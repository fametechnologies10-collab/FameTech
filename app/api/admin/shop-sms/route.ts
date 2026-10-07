import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { validateSenderText, senderCollides } from '@/lib/sms-sender-validation'
import { createNotification } from '@/lib/notification-service'

async function requireAdmin() {
    const client = await createRouteClient()
    const { data: { user }, error } = await client.auth.getUser()
    if (error || !user) return { error: 'Unauthorized', status: 401 }
    const rl = consumeRateLimit(`admin-shop-sms:${user.id}`, 30, 60 * 1000)
    if (!rl.allowed) return { error: 'Too many requests', status: 429 }
    const { data } = await client.from('users').select('role').eq('id', user.id).single()
    if ((data as any)?.role !== 'admin') return { error: 'Forbidden - Admin only', status: 403 }
    return { user }
}

const SETTING_KEYS = [
    'sms_feature_enabled', 'sms_activation_fee', 'sms_max_recipients_per_send',
    'sms_sends_per_hour', 'sms_recipients_per_day', 'sms_blocked_keywords',
    'sms_allowed_link_domains',
] as const

const settingsSchema = z.object({
    sms_feature_enabled: z.enum(['true', 'false']).optional(),
    sms_activation_fee: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    sms_max_recipients_per_send: z.string().regex(/^\d+$/).optional(),
    sms_sends_per_hour: z.string().regex(/^\d+$/).optional(),
    sms_recipients_per_day: z.string().regex(/^\d+$/).optional(),
    sms_blocked_keywords: z.string().max(2000).optional(),
    sms_allowed_link_domains: z.string().max(2000).optional(),
})

// Admin moderation actions on flagged messages / abusive shops.
//
// review_shop_sender operates on a `senderId` row in shop_sender_ids. A shop
// may hold at most one APPROVED sender at a time (enforced at the app layer
// here and backstopped by the partial unique index
// idx_shop_sender_ids_one_approved) — approving a new sender automatically
// revokes whatever sender was previously approved for that shop. The old
// single-slot shop_profiles.sms_sender_id/sms_sender_status columns remain a
// MIRROR of that one approved row, maintained below. This is an admin-only,
// internal endpoint called exclusively by ShopSmsAdminClient.tsx — there are
// no other consumers of the old `shopId`-keyed shape, so the schema is
// migrated outright rather than carrying a dual shopId/senderId branch.
const actionSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('dismiss_flag'), logId: z.string().uuid() }),
    z.object({ action: z.literal('set_shop_sms_suspended'), shopId: z.string().uuid(), suspended: z.boolean() }),
    z.object({
        action: z.literal('review_shop_sender'),
        senderId: z.string().uuid(),
        decision: z.enum(['approved', 'rejected', 'revoked']),
        reason: z.string().max(500).optional(),
    }),
])

const bundleSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(2).max(50),
    credits: z.number().int().positive().max(1000000),
    price: z.number().positive().max(100000),
    is_active: z.boolean().default(true),
    sort_order: z.number().int().min(0).max(100).default(0),
})

const bundleDeleteSchema = z.object({ id: z.string().uuid() })

/** Runs one independent GET sub-query without letting it take the whole
 *  response down. Supabase query builders normally resolve `{ data, error }`
 *  rather than throw, but a genuinely unreachable DB / malformed builder call
 *  can still reject the promise — caught here too. Either way, a failing
 *  section degrades to an empty list plus a human-readable warning instead of
 *  a 500 for the entire admin page. */
async function safeQuery(label: string, query: PromiseLike<{ data: any; error: any }>): Promise<{ rows: any[]; warning: string | null }> {
    try {
        const { data, error } = await query
        if (error) {
            console.error(`[Admin ShopSMS GET] ${label} query failed:`, error?.message || error)
            return { rows: [], warning: `${label}: ${error?.message || 'query failed'}` }
        }
        return { rows: (data as any[]) ?? [], warning: null }
    } catch (e: any) {
        console.error(`[Admin ShopSMS GET] ${label} query threw:`, e?.message || e)
        return { rows: [], warning: `${label}: ${e?.message || 'unexpected error'}` }
    }
}

// ─── GET — settings, bundles, revenue totals, flagged messages ────────────────
export async function GET() {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

        const db = createServerClient()

        const [settingsRes, bundlesRes, activationsRes, purchasesRes, flaggedRes, walletsRes, pendingSendersRes, approvedSendersRes] = await Promise.all([
            safeQuery('Settings', (db as any).from('shop_global_settings').select('key, value').in('key', [...SETTING_KEYS])),
            safeQuery('Bundles', (db as any).from('shop_sms_bundles').select('*').order('sort_order')),
            safeQuery('Activations', (db as any).from('shop_sms_activations').select('shop_id, amount_paid, sms_suspended')),
            safeQuery('Purchases', (db as any).from('shop_sms_purchases').select('price, credits')),
            safeQuery('Flagged messages', (db as any).from('shop_sms_logs')
                .select('id, shop_id, message, recipients_count, status, flagged, flag_reason, created_at, delivered_count, undelivered_count, pending_count, shop_profiles(shop_name)')
                .eq('flagged', true)
                .order('created_at', { ascending: false })
                .limit(100)),
            safeQuery('Wallets', (db as any).from('shop_sms_wallets').select('shop_id, credits, total_purchased, total_used, shop_profiles(shop_name)')),
            // Sender-ID request queue (Feature Wave 6 Task 2) — one row per
            // request now that a shop may hold up to 5 concurrently, sourced
            // from shop_sender_ids instead of the single-slot shop_profiles
            // columns (those are now just a mirror of the default approved row).
            safeQuery('Pending sender requests', (db as any).from('shop_sender_ids')
                .select('id, shop_id, sender_text, status, is_default, requested_at, reviewed_at, reason, shop_profiles(shop_name, owner_id)')
                .eq('status', 'under_review')
                .order('requested_at', { ascending: true })),
            // Approved shop senders — for visibility + the revoke control.
            safeQuery('Approved senders', (db as any).from('shop_sender_ids')
                .select('id, shop_id, sender_text, status, is_default, requested_at, reviewed_at, reason, shop_profiles(shop_name, owner_id)')
                .eq('status', 'approved')
                .order('reviewed_at', { ascending: false })),
        ])

        const results = [settingsRes, bundlesRes, activationsRes, purchasesRes, flaggedRes, walletsRes, pendingSendersRes, approvedSendersRes]
        const warnings = results.map(r => r.warning).filter((w): w is string => !!w)
        // Every independent read failed at once — that's a total-outage signal
        // (e.g. DB unreachable), not a partial-degrade one. Surface it as a
        // real error rather than a 200 that quietly renders as an empty page.
        if (warnings.length === results.length) {
            console.error('[Admin ShopSMS GET] all sub-queries failed:', warnings)
            return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
        }

        const settings: Record<string, string> = {}
        for (const row of settingsRes.rows) settings[row.key] = String(row.value)

        const activations = activationsRes.rows
        const purchases = purchasesRes.rows
        // Shops currently barred from sending — powers the admin suspend toggle.
        const suspendedShopIds = activations
            .filter((a: any) => a.sms_suspended === true)
            .map((a: any) => a.shop_id)

        return NextResponse.json({
            success: true,
            data: {
                settings,
                bundles: bundlesRes.rows,
                revenue: {
                    activationCount: activations.length,
                    activationTotal: activations.reduce((s: number, a: any) => s + parseFloat(String(a.amount_paid || 0)), 0),
                    purchaseCount: purchases.length,
                    purchaseTotal: purchases.reduce((s: number, p: any) => s + parseFloat(String(p.price || 0)), 0),
                    creditsSold: purchases.reduce((s: number, p: any) => s + (p.credits || 0), 0),
                },
                flagged: flaggedRes.rows,
                shopWallets: walletsRes.rows,
                suspendedShopIds,
                pendingSenderRequests: pendingSendersRes.rows,
                approvedSenders: approvedSendersRes.rows,
                warnings,
            },
        })
    } catch (e: any) {
        console.error('[Admin ShopSMS GET]', e)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// ─── PATCH — update settings ──────────────────────────────────────────────────
export async function PATCH(request: NextRequest) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

        const body = await request.json()
        const parsed = settingsSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'Invalid settings payload' }, { status: 400 })
        }

        const updates = Object.entries(parsed.data)
            .filter(([, v]) => v !== undefined)
            .map(([key, value]) => ({ key, value: String(value) }))
        if (updates.length === 0) {
            return NextResponse.json({ success: false, error: 'Nothing to update' }, { status: 400 })
        }

        const db = createServerClient()
        const { error } = await (db as any)
            .from('shop_global_settings')
            .upsert(updates, { onConflict: 'key' })
        if (error) throw error

        return NextResponse.json({ success: true })
    } catch (e: any) {
        console.error('[Admin ShopSMS PATCH]', e)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// ─── PUT — create or update a bundle tier ─────────────────────────────────────
export async function PUT(request: NextRequest) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

        const body = await request.json()
        const parsed = bundleSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: parsed.error.errors[0]?.message || 'Invalid bundle' },
                { status: 400 }
            )
        }

        const db = createServerClient()
        const row = {
            name: parsed.data.name,
            credits: parsed.data.credits,
            price: parsed.data.price,
            is_active: parsed.data.is_active,
            sort_order: parsed.data.sort_order,
            updated_at: new Date().toISOString(),
        }

        if (parsed.data.id) {
            const { error } = await (db as any).from('shop_sms_bundles').update(row).eq('id', parsed.data.id)
            if (error) throw error
        } else {
            const { error } = await (db as any).from('shop_sms_bundles').insert(row)
            if (error) throw error
        }

        return NextResponse.json({ success: true })
    } catch (e: any) {
        console.error('[Admin ShopSMS PUT]', e)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// ─── DELETE — remove a bundle tier ─────────────────────────────────────────────
// A bundle referenced by past purchases (shop_sms_purchases.bundle_id) is
// NEVER hard-deleted — that would either throw a FK violation (the column has
// no ON DELETE clause, i.e. RESTRICT) or, if it didn't, silently orphan
// revenue history the admin dashboard totals depend on. Referenced bundles
// are deactivated instead (is_active=false), which purchase_sms_bundle
// already enforces at purchase time (`WHERE id = p_bundle_id AND
// is_active = true`) — so the tier stops being purchasable immediately,
// exactly like a hard delete, without touching history.
export async function DELETE(request: NextRequest) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

        const body = await request.json().catch(() => null)
        const parsed = bundleDeleteSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'Invalid request — bundle id required' }, { status: 400 })
        }

        const db = createServerClient()

        const { count, error: countErr } = await (db as any)
            .from('shop_sms_purchases')
            .select('id', { count: 'exact', head: true })
            .eq('bundle_id', parsed.data.id)
        if (countErr) throw countErr

        if ((count ?? 0) > 0) {
            const { data: updated, error } = await (db as any)
                .from('shop_sms_bundles')
                .update({ is_active: false, updated_at: new Date().toISOString() })
                .eq('id', parsed.data.id)
                .select('id')
            if (error) throw error
            if (!updated || updated.length === 0) {
                return NextResponse.json({ success: false, error: 'Bundle not found' }, { status: 404 })
            }
            return NextResponse.json({
                success: true,
                data: { deactivated: true },
                message: `This bundle has ${count} past purchase(s) on record, so it was deactivated instead of deleted — shop purchase history and revenue totals stay intact.`,
            })
        }

        const { data: deleted, error } = await (db as any)
            .from('shop_sms_bundles')
            .delete()
            .eq('id', parsed.data.id)
            .select('id')
        if (error) throw error
        if (!deleted || deleted.length === 0) {
            return NextResponse.json({ success: false, error: 'Bundle not found' }, { status: 404 })
        }

        return NextResponse.json({ success: true, data: { deactivated: false } })
    } catch (e: any) {
        console.error('[Admin ShopSMS DELETE]', e)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// ─── POST — moderation actions (dismiss a flag / suspend a shop's SMS) ─────────
export async function POST(request: NextRequest) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

        const body = await request.json()
        const parsed = actionSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'Invalid action payload' }, { status: 400 })
        }

        const db = createServerClient()

        if (parsed.data.action === 'dismiss_flag') {
            // Clear the review marker so it leaves the flagged list. A blocked
            // message was never delivered; this just acknowledges the review.
            // The `flagged=true` guard makes a stale/wrong UUID a no-op (404)
            // rather than silently touching an unrelated row.
            const { data: updated, error } = await (db as any)
                .from('shop_sms_logs')
                .update({ flagged: false })
                .eq('id', parsed.data.logId)
                .eq('flagged', true)
                .select('id')
            if (error) throw error
            if (!updated || updated.length === 0) {
                return NextResponse.json({ success: false, error: 'No flagged message with that ID' }, { status: 404 })
            }
        } else if (parsed.data.action === 'set_shop_sms_suspended') {
            // Verify the activation exists (so a wrong shopId is a 404, not a
            // silent success) and capture owner_id + prior state for the audit.
            const { data: act } = await (db as any)
                .from('shop_sms_activations')
                .select('owner_id, sms_suspended')
                .eq('shop_id', parsed.data.shopId)
                .maybeSingle()
            if (!act) {
                return NextResponse.json({ success: false, error: 'Shop has no SMS activation' }, { status: 404 })
            }

            const { error } = await (db as any)
                .from('shop_sms_activations')
                .update({ sms_suspended: parsed.data.suspended })
                .eq('shop_id', parsed.data.shopId)
            if (error) throw error

            // Audit (non-blocking) — toggling a shop's ability to spend SMS
            // credits is a privileged action and must be attributable.
            ;(db as any).from('admin_audit_log').insert({
                admin_id: auth.user.id,
                action: parsed.data.suspended ? 'shop_sms_suspend' : 'shop_sms_unsuspend',
                target_user_id: (act as any).owner_id,
                old_value: { sms_suspended: (act as any).sms_suspended ?? false },
                new_value: { sms_suspended: parsed.data.suspended, shop_id: parsed.data.shopId },
            }).then(() => {}).catch((e: any) => console.error('[AuditLog] shop_sms_suspend insert failed:', e))
        } else {
            // review_shop_sender — approve/reject/revoke ONE of a shop's
            // sender-ID requests (Feature Wave 6 Task 2: shops may hold up to
            // 5 concurrently in shop_sender_ids, which replaces the old
            // single-slot shop_profiles columns as the review queue's source
            // of truth). Security-sensitive: approval grants the shop the
            // ability to send order-confirmation SMS under its own brand
            // name, so it gets a reserved-name check AND a cross-store +
            // cross-product (KFT user senders) uniqueness check.
            const { senderId, decision, reason } = parsed.data

            const { data: senderRow } = await (db as any)
                .from('shop_sender_ids')
                .select('id, shop_id, sender_text, status, is_default')
                .eq('id', senderId)
                .maybeSingle()
            if (!senderRow) {
                return NextResponse.json({ success: false, error: 'Sender ID request not found' }, { status: 404 })
            }
            const row: any = senderRow

            const { data: shop } = await (db as any)
                .from('shop_profiles')
                .select('id, shop_name, owner_id')
                .eq('id', row.shop_id)
                .maybeSingle()
            if (!shop) {
                return NextResponse.json({ success: false, error: 'Shop not found' }, { status: 404 })
            }
            const s: any = shop

            // approve/reject only make sense against a request currently
            // 'under_review'; revoke only against a currently 'approved'
            // sender. A stale click (already decided by another admin, or
            // the shop re-requested since) is a 409, not a silent no-op.
            const fromStatus = decision === 'revoked' ? 'approved' : 'under_review'
            if (row.status !== fromStatus) {
                return NextResponse.json({
                    success: false,
                    error: decision === 'revoked'
                        ? 'This sender ID is not currently approved'
                        : 'Sender request is no longer under review — reload the queue',
                }, { status: 409 })
            }

            if (decision === 'approved') {
                // The request route only validates charset/length — reserved
                // brand-name protection is enforced here, at approval.
                const check = validateSenderText(row.sender_text)
                if (!check.ok) {
                    return NextResponse.json({ success: false, error: `Refusing approval: ${check.error}` }, { status: 409 })
                }

                // Cross-store + cross-product uniqueness (leet-normalized):
                // can't collide with an approved KFT user sender OR any OTHER
                // shop's approved sender (any row, not just its default).
                const [kftSendersRes, otherShopSendersRes] = await Promise.all([
                    (db as any).from('sms_sender_ids').select('sender_text').eq('status', 'approved'),
                    (db as any).from('shop_sender_ids').select('sender_text').eq('status', 'approved').neq('id', row.id),
                ])
                const existing = [
                    ...(((kftSendersRes.data as any[]) || []).map((r: any) => r.sender_text)),
                    ...(((otherShopSendersRes.data as any[]) || []).map((r: any) => r.sender_text).filter(Boolean)),
                ]
                if (senderCollides(row.sender_text, existing)) {
                    return NextResponse.json({ success: false, error: 'Refusing approval: collides with an already-approved sender ID' }, { status: 409 })
                }
            }

            // ORDER MATTERS. The partial unique index idx_shop_sender_ids_one_approved
            // permits exactly one approved row per shop, so the shop's current
            // approved sender must be revoked BEFORE this row flips to 'approved'.
            // Doing it the other way round makes the update below violate the index,
            // so every replacement approval would fail and the auto-revoke would
            // never run.
            if (decision === 'approved') {
                const { error: revokeErr } = await (db as any)
                    .from('shop_sender_ids')
                    .update({
                        status: 'revoked',
                        reason: 'Replaced by new default sender ID',
                        reviewed_at: new Date().toISOString(),
                        is_default: false,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('shop_id', row.shop_id)
                    .eq('status', 'approved')
                    .neq('id', row.id)
                if (revokeErr) {
                    console.error('[Admin ShopSMS] failed to revoke previous approved sender:', revokeErr)
                    return NextResponse.json(
                        { success: false, error: 'Could not replace the shop\'s current sender ID — nothing was changed' },
                        { status: 500 },
                    )
                }
            }

            const { data: updated, error } = await (db as any)
                .from('shop_sender_ids')
                .update({
                    status: decision,
                    reviewed_at: new Date().toISOString(),
                    reason: reason ?? null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', row.id)
                .eq('status', fromStatus)
                .select('id, is_default')
            if (error) throw error
            if (!updated || updated.length === 0) {
                // A concurrent review won the race. If the revoke above already ran,
                // this shop now has NO approved sender — point the mirror at that
                // truth rather than leave it naming a revoked sender, so
                // confirmations fall back to the platform sender instead of
                // continuing to send under a brand that is no longer approved.
                if (decision === 'approved') {
                    const { error: resyncErr } = await (db as any).from('shop_profiles').update({
                        sms_sender_id: null,
                        sms_sender_status: 'revoked',
                        sms_sender_reviewed_at: new Date().toISOString(),
                    }).eq('id', row.shop_id)
                    if (resyncErr) console.error('[Admin ShopSMS] mirror resync after lost approval race failed:', resyncErr)
                }
                return NextResponse.json({ success: false, error: 'Sender request state changed — reload the queue' }, { status: 409 })
            }

            // ── Mirror maintenance ──────────────────────────────────────────
            // shop_profiles.sms_sender_* is the SINGLE thing
            // resolveShopConfirmationSender + all F3 enforcement read, so it
            // must always reflect exactly the shop's current default APPROVED
            // sender (or be cleared if none remain). becameDefault feeds the
            // owner-facing message below.
            // Every write below is error-checked: an unnoticed failure here leaves the
            // mirror naming a sender the shop no longer holds, and the mirror is the
            // ONLY thing resolveShopConfirmationSender reads.
            let becameDefault = false
            if (decision === 'approved') {
                // New model: every approval becomes the shop's default. The previous
                // approved row was already revoked above, before this row was flipped.
                becameDefault = true
                const { error: defaultErr } = await (db as any)
                    .from('shop_sender_ids').update({ is_default: true }).eq('id', row.id)
                if (defaultErr) console.error('[Admin ShopSMS] failed to flag new sender as default:', defaultErr)

                const { error: mirrorErr } = await (db as any).from('shop_profiles').update({
                    sms_sender_id: row.sender_text,
                    sms_sender_status: 'approved',
                    sms_sender_reviewed_at: new Date().toISOString(),
                }).eq('id', row.shop_id)
                if (mirrorErr) {
                    console.error('[Admin ShopSMS] approved-sender mirror write failed:', mirrorErr)
                    return NextResponse.json({
                        success: false,
                        error: 'Sender ID was approved, but the storefront did not pick it up. Re-open the shop and re-apply before telling the owner it is live.',
                    }, { status: 500 })
                }
            } else if (decision === 'revoked') {
                // With at most one approved sender per shop, revoking it always clears the
                // mirror — there is no "next-oldest approved" to promote anymore.
                const { error: mirrorErr } = await (db as any).from('shop_profiles').update({
                    sms_sender_id: null,
                    sms_sender_status: 'revoked',
                    sms_sender_reviewed_at: new Date().toISOString(),
                }).eq('id', row.shop_id)
                if (mirrorErr) {
                    console.error('[Admin ShopSMS] revoked-sender mirror clear failed:', mirrorErr)
                    return NextResponse.json({
                        success: false,
                        error: 'Sender ID was revoked, but the storefront may still be sending under it. Retry the revoke.',
                    }, { status: 500 })
                }
            }

            const messages: Record<string, string> = {
                approved: `Your sender ID "${row.sender_text}" is approved — customer order confirmations now come from your brand.`,
                rejected: `Your sender ID request "${row.sender_text}" was not approved.${reason ? ` Reason: ${reason}` : ''}`,
                revoked: `Your sender ID "${row.sender_text}" has been revoked.${reason ? ` Reason: ${reason}` : ''}`,
            }
            // Awaited (not fire-and-forget) so serverless teardown can't drop
            // the only signal the shop owner gets; .catch keeps it non-fatal.
            await createNotification({
                userId: s.owner_id,
                title: 'Sender ID update',
                message: messages[decision],
                type: 'system',
                actionUrl: '/dashboard/shop/sms',
            }).catch(() => {})

            // Audit (non-blocking) — mirrors the set_shop_sms_suspended audit above.
            ;(db as any).from('admin_audit_log').insert({
                admin_id: auth.user.id,
                action: `shop_sender_${decision}`,
                target_user_id: s.owner_id,
                old_value: { status: row.status, sender: row.sender_text },
                new_value: { status: decision, sender: row.sender_text, reason: reason ?? null, shop_id: row.shop_id, sender_id: row.id },
            }).then(() => {}).catch((e: any) => console.error('[AuditLog] shop_sender review insert failed:', e))
        }

        return NextResponse.json({ success: true })
    } catch (e: any) {
        console.error('[Admin ShopSMS POST]', e)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
