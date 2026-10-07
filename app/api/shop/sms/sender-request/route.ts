import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { createNotification } from '@/lib/notification-service'
import { sendAdminPushNotification } from '@/lib/push-service'

// /api/shop/sms/sender-request — shop owner requests a custom SMS sender ID
// for their storefront's order confirmations (Feature Wave 6 Task 2 REDESIGN
// — single-pending-slot model: a shop may have at most ONE request
// under_review at a time, sourced from shop_sender_ids — replaces the old
// "up to 5 concurrent" model and the old single-slot shop_profiles.sms_sender_id
// column, which is now maintained purely as a MIRROR of the shop's approved
// sender by this route (POST) and the admin review route
// (app/api/admin/shop-sms/route.ts review_shop_sender). Task F3's
// resolveShopConfirmationSender (lib/sms-confirmation-sender.ts) reads ONLY
// that mirror and needs no changes.
//
// GET    — list all of the caller's shop's sender-ID requests.
// POST   — submit a new request (loose validation: charset/length + own-shop
//          duplicate + single-pending guard; reserved-brand + cross-tenant
//          uniqueness are enforced at admin approval, same split as before
//          this task). Submitting while an APPROVED sender already exists is
//          allowed — that's the "request a new one to replace the current
//          one" flow; approval auto-revokes the old default.
// DELETE — owner removes their own terminal-state (rejected/revoked) row.
//
// Status flow per row: (none) → under_review → approved | rejected
//              approved → revoked (admin-only)
// A rejected/revoked row does not count against the single-pending guard or
// the duplicate check — the owner may re-request the same text.

const senderRequestSchema = z.object({
    sender: z.string().trim().regex(
        /^[A-Za-z0-9 ]{3,11}$/,
        'Sender ID must be 3-11 characters — letters, numbers and spaces only',
    ),
})

const deleteSchema = z.object({ senderId: z.string().uuid() })

// GET — list every sender-ID request for the caller's shop.
export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const adminDb = createServerClient()
        const { data: shop } = await adminDb.from('shop_profiles').select('id').eq('owner_id', user.id).maybeSingle()
        if (!shop) return NextResponse.json({ success: false, error: 'Create your shop first' }, { status: 404 })

        const { data: senders, error } = await (adminDb as any)
            .from('shop_sender_ids')
            .select('id, sender_text, status, is_default, requested_at, reviewed_at, reason')
            .eq('shop_id', (shop as any).id)
            .order('requested_at', { ascending: false })
        if (error) {
            console.error('[ShopSMS SenderRequest] GET query error:', error)
            return NextResponse.json({ success: false, error: 'Failed to load sender IDs' }, { status: 500 })
        }

        return NextResponse.json({
            success: true,
            data: {
                senders: ((senders as any[]) || []).map(r => ({
                    id: r.id,
                    sender: r.sender_text,
                    status: r.status,
                    isDefault: r.is_default,
                    requestedAt: r.requested_at,
                    reviewedAt: r.reviewed_at,
                    reason: r.reason,
                })),
                cap: 1,
            },
        })
    } catch (err) {
        console.error('[ShopSMS SenderRequest] GET error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// POST — submit an additional sender-ID request.
export async function POST(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`shop-sms-sender-request:${user.id}`, 5, 60 * 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many requests. Try again later.' }, { status: 429 })
        }

        const parsed = senderRequestSchema.safeParse(await req.json().catch(() => null))
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: parsed.error.errors[0]?.message || 'Invalid request' },
                { status: 400 },
            )
        }
        const sender = parsed.data.sender

        const adminDb = createServerClient()
        const { data: shop } = await adminDb
            .from('shop_profiles')
            .select('id, shop_name, approval_status, sms_sender_id')
            .eq('owner_id', user.id)
            .maybeSingle()
        if (!shop) return NextResponse.json({ success: false, error: 'Create your shop first' }, { status: 404 })

        const s = shop as any
        if (s.approval_status !== 'approved') {
            return NextResponse.json(
                { success: false, error: 'Your shop must be approved before requesting a sender ID' },
                { status: 403 },
            )
        }

        // Single-pending-slot rule: a shop may have at most ONE request under_review at a
        // time (Feature Wave 6 Task 2 REDESIGN — was up to 5 concurrent; now single-slot
        // with auto-replace, see migration 20260812_shop_sender_single.sql). Submitting a
        // new request while an APPROVED sender already exists is still allowed — that's
        // the "request a new one to replace the current one" flow; approval auto-revokes
        // the old default (see admin/shop-sms/route.ts review_shop_sender).
        //
        // This check-then-insert is a TOCTOU race on its own (two concurrent submits can
        // both pass this count check) — the partial unique index
        // idx_shop_sender_ids_one_pending (migration 20260816_shop_sender_one_pending.sql)
        // is the actual backstop; the 23505 handler below turns a lost race into the same
        // friendly 409 this check returns, instead of a raw 500.
        const { count: pendingCount } = await (adminDb as any)
            .from('shop_sender_ids')
            .select('id', { count: 'exact', head: true })
            .eq('shop_id', s.id)
            .eq('status', 'under_review')
        if ((pendingCount ?? 0) > 0) {
            return NextResponse.json(
                { success: false, error: 'You already have a pending sender ID request — wait for it to be reviewed before submitting another.' },
                { status: 409 },
            )
        }
        const { data: liveRows } = await (adminDb as any)
            .from('shop_sender_ids')
            .select('sender_text')
            .eq('shop_id', s.id)
            .in('status', ['under_review', 'approved'])
        if (((liveRows as any[]) || []).some(r => r.sender_text.trim().toLowerCase() === sender.toLowerCase())) {
            return NextResponse.json(
                { success: false, error: 'You already have this sender ID pending or approved' },
                { status: 409 },
            )
        }

        const { data: inserted, error: insertErr } = await (adminDb as any)
            .from('shop_sender_ids')
            .insert({ shop_id: s.id, sender_text: sender, status: 'under_review' })
            .select('id')
            .single()
        if (insertErr) {
            // 23505 = unique_violation. idx_shop_sender_ids_one_pending caught a
            // concurrent submit that slipped past the count check above.
            if (insertErr.code === '23505') {
                return NextResponse.json(
                    { success: false, error: 'You already have a pending sender ID request — wait for it to be reviewed before submitting another.' },
                    { status: 409 },
                )
            }
            console.error('[ShopSMS SenderRequest] insert error:', insertErr)
            return NextResponse.json({ success: false, error: 'Could not submit sender ID request' }, { status: 500 })
        }

        // Compat: mirror onto shop_profiles ONLY on this shop's very
        // first-ever request (columns still empty) — in case a surface
        // hasn't migrated to the new table yet. Never overwrites an existing
        // mirror; that stays the admin approve/revoke path's responsibility,
        // pointed at whichever row is the shop's default.
        if (!s.sms_sender_id) {
            const { error: mirrorErr } = await (adminDb as any)
                .from('shop_profiles')
                .update({
                    sms_sender_id: sender,
                    sms_sender_status: 'under_review',
                    sms_sender_requested_at: new Date().toISOString(),
                })
                .eq('id', s.id)
                .is('sms_sender_id', null)
            if (mirrorErr) console.error('[ShopSMS SenderRequest] compat mirror write failed (non-fatal):', mirrorErr)
        }

        // Best-effort admin notify — awaited so serverless teardown cannot
        // drop it (this is the only signal admins get), but the .catch means
        // a notification failure never fails the request.
        const { data: admins } = await adminDb.from('users').select('id').eq('role', 'admin')
        await Promise.all(((admins as any[]) || []).map(a => createNotification({
            userId: a.id,
            title: 'New shop sender ID request',
            message: `${s.shop_name} requested sender ID "${sender}" — review in the Shop SMS admin console.`,
            type: 'system',
            actionUrl: '/admin/shop-sms',
        }))).catch(() => {})

        // Feature-wave5 Task 4: device push alongside the in-app notification above.
        await sendAdminPushNotification({
            title: 'Sender ID request',
            body: `"${sender}" requested by ${s.shop_name} — review in the Shop SMS admin console.`,
            url: '/admin/shop-sms',
        }).catch(() => {})

        return NextResponse.json({ success: true, data: { id: (inserted as any).id, status: 'under_review' } })
    } catch (err) {
        console.error('[ShopSMS SenderRequest] POST error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// DELETE — owner removes their own terminal-state (rejected/revoked) row. Pure
// cleanup: these statuses never fed the shop_profiles mirror, so no mirror update
// is needed. Deliberately does NOT allow deleting 'under_review' or 'approved' rows.
export async function DELETE(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-sender-delete:${user.id}`, 10, 60 * 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many requests. Try again later.' }, { status: 429 })
        }

        const parsed = deleteSchema.safeParse(await req.json().catch(() => null))
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'Invalid request' }, { status: 400 })
        }

        const adminDb = createServerClient()
        const { data: shop } = await adminDb.from('shop_profiles').select('id').eq('owner_id', user.id).maybeSingle()
        if (!shop) return NextResponse.json({ success: false, error: 'Create your shop first' }, { status: 404 })

        const { data: deleted, error } = await (adminDb as any)
            .from('shop_sender_ids')
            .delete()
            .eq('id', parsed.data.senderId)
            .eq('shop_id', (shop as any).id)
            .in('status', ['rejected', 'revoked'])
            .select('id')
        if (error) {
            console.error('[ShopSMS SenderRequest] DELETE error:', error)
            return NextResponse.json({ success: false, error: 'Could not delete sender ID' }, { status: 500 })
        }
        if (!deleted || deleted.length === 0) {
            return NextResponse.json({ success: false, error: 'Sender ID not found, or not in a deletable state' }, { status: 404 })
        }

        return NextResponse.json({ success: true })
    } catch (err) {
        console.error('[ShopSMS SenderRequest] DELETE error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
