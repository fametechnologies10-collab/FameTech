/**
 * /api/sms/sender-ids — own sender-ID requests (KFT SMS).
 *
 * GET : list the account's sender IDs.
 * POST: request a new sender ID. Gates:
 *   - account must be active (any mode — platform or business),
 *   - a Ghana Card document must be attached ONLY for BUSINESS-mode accounts
 *     (Hubtel's approval requirement for business — read off whatever
 *     sms_business_profiles row exists for the account, regardless of its
 *     status; a bare draft with just the KYC doc is enough). Feature-wave7:
 *     PLATFORM-mode accounts request sender IDs KYC-FREE — no Ghana Card, no
 *     business profile, no domain — exactly like the shop route
 *     (app/api/shop/sms/sender-request/route.ts),
 *   - normalized reserved-brand validation (lib/sms-sender-validation),
 *   - normalized collision check vs ALL live sender rows platform-wide,
 *   - a cap of MAX_SENDERS_PER_ACCOUNT live requests + no re-requesting an
 *     already-held name (both mode-agnostic).
 * Status flow: under_review → submitted_to_hubtel → approved/rejected/revoked
 * (admin route drives transitions; approval flips nothing here). An approved
 * sender benefits platform-mode users in TWO ways: the mode-agnostic
 * use_own_sender_for_confirmations toggle (app/api/sms/account/route.ts), AND
 * campaign sends themselves via lib/sms-policy.ts (feature-wave7 — a
 * platform-mode account may explicitly request its own approved sender).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { getSmsAccountContext } from '@/lib/sms-campaign-pipeline'
import { validateSenderText, senderCollides } from '@/lib/sms-sender-validation'
import { createNotification } from '@/lib/notification-service'
import { sendAdminPushNotification } from '@/lib/push-service'

export const dynamic = 'force-dynamic'

const requestSchema = z.object({
    senderText: z.string().min(3).max(11),
    makeDefault: z.boolean().optional().default(false),
})

export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const db = createServerClient() as any
        const { data: account } = await db.from('sms_accounts').select('id').eq('user_id', user.id).maybeSingle()
        if (!account) return NextResponse.json({ success: true, data: { senders: [] } })

        const { data: senders } = await db.from('sms_sender_ids')
            .select('id, sender_text, status, is_default, rejection_reason, requested_at, approved_at')
            .eq('account_id', (account as any).id)
            .order('requested_at', { ascending: false })
        return NextResponse.json({ success: true, data: { senders: senders ?? [] } })
    } catch (e: any) {
        console.error('[SMS Senders GET] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-sender-request:${user.id}`, 5, 3600_000)
        if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

        const parsed = requestSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid request' }, { status: 400 })
        const senderText = parsed.data.senderText.trim()

        const valid = validateSenderText(senderText)
        if (!valid.ok) return NextResponse.json({ success: false, error: valid.error }, { status: 400 })

        const db = createServerClient() as any
        const ctxRes = await getSmsAccountContext(db, user.id)
        if (!ctxRes.ok) return NextResponse.json({ success: false, error: ctxRes.error }, { status: ctxRes.status })
        const accountId = ctxRes.ctx.account.id

        // Gate 1: the business profile must be APPROVED before a business-mode
        // account may request its own sender ID — approval already implies
        // admin verified the Ghana Card + documents over WhatsApp
        // (validateBusinessReview requires whatsapp_verified=true to approve;
        // see lib/sms-business-review.ts). Feature-wave7: PLATFORM-mode
        // accounts skip this entirely and may request sender IDs KYC-free,
        // exactly like the shop route (app/api/shop/sms/sender-request/route.ts).
        if (ctxRes.ctx.account.mode === 'business') {
            const { data: profile } = await db.from('sms_business_profiles')
                .select('status').eq('account_id', accountId).maybeSingle()
            if ((profile as any)?.status !== 'approved') {
                return NextResponse.json({ success: false, error: 'Your business registration must be approved before requesting a sender ID (Dashboard → KFT SMS → Business & Sender ID)' }, { status: 409 })
            }
        }

        // Gate 2: users may hold MULTIPLE sender IDs — cap the total live ones
        // per account (excludes rejected/revoked) to bound abuse. Raised from 10
        // to 200 on 2026-10-06 for dealers (e.g. ARHMSGH) running many branded
        // sub-shops that each need their own sender ID.
        const MAX_SENDERS_PER_ACCOUNT = 200
        const { count: liveForAccount } = await db.from('sms_sender_ids')
            .select('id', { count: 'exact', head: true })
            .eq('account_id', accountId)
            .in('status', ['under_review', 'submitted_to_hubtel', 'approved'])
        if ((liveForAccount ?? 0) >= MAX_SENDERS_PER_ACCOUNT) {
            return NextResponse.json({ success: false, error: `You have reached the maximum of ${MAX_SENDERS_PER_ACCOUNT} sender IDs` }, { status: 409 })
        }
        // Prevent re-requesting a name this account already holds.
        const { data: ownRows } = await db.from('sms_sender_ids')
            .select('sender_text, status').eq('account_id', accountId)
            .in('status', ['under_review', 'submitted_to_hubtel', 'approved'])
        if (((ownRows as any[]) || []).some(r => r.sender_text.trim().toLowerCase() === senderText.toLowerCase())) {
            return NextResponse.json({ success: false, error: 'You already have this sender ID' }, { status: 409 })
        }

        // Gate 3: normalized collision vs ALL live sender rows platform-wide
        // (pending included — closes the duplicate-pending race) + pool names.
        const { data: liveRows } = await db.from('sms_sender_ids')
            .select('sender_text')
            .in('status', ['under_review', 'submitted_to_hubtel', 'approved'])
        const liveNames = (((liveRows as any[]) || []).map(r => r.sender_text) as string[])
            .concat(ctxRes.ctx.settings.defaultSenders)
        if (senderCollides(senderText, liveNames)) {
            return NextResponse.json({ success: false, error: 'This sender ID is already taken or too similar to an existing one' }, { status: 409 })
        }

        const { error } = await db.from('sms_sender_ids').insert({
            account_id: accountId,
            sender_text: senderText,
            status: 'under_review',
            is_default: false, // becomes eligible for default only once approved
        })
        if (error) {
            console.error('[SMS Senders POST] insert error:', error.message)
            return NextResponse.json({ success: false, error: 'Could not submit sender ID request' }, { status: 500 })
        }

        const { data: admins } = await db.from('users').select('id').eq('role', 'admin')
        await Promise.all(((admins as any[]) || []).map(a => createNotification({
            userId: a.id,
            title: 'New sender ID request',
            message: `Sender ID "${senderText}" requested — review and forward to Hubtel.`,
            type: 'system',
            actionUrl: '/admin/sms-platform',
        }))).catch(() => {})

        // Feature-wave5 Task 4: device push alongside the in-app notification above.
        const { data: requester } = await db.from('users')
            .select('first_name, last_name, email').eq('id', user.id).maybeSingle()
        const requesterName = [requester?.first_name, requester?.last_name].filter(Boolean).join(' ').trim()
            || requester?.email || user.id
        await sendAdminPushNotification({
            title: 'Sender ID request',
            body: `"${senderText}" requested by ${requesterName} — review and forward to Hubtel.`,
            url: '/admin/sms-platform',
        }).catch(() => {})

        return NextResponse.json({ success: true, data: { status: 'under_review' } })
    } catch (e: any) {
        console.error('[SMS Senders POST] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
