/**
 * GET /api/sms/account — SMS platform account overview (KFT SMS).
 * Auth: user session. Provisions the account+wallet on first hit
 * (ensure_sms_account) and returns everything the dashboard shell needs.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { getSmsAccountContext } from '@/lib/sms-campaign-pipeline'
import { resolveSmsPolicy } from '@/lib/sms-policy'
import { bundlesForMode } from '@/lib/sms-platform-types'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-account:${user.id}`, 60, 60_000)
        if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

        const db = createServerClient() as any
        const ctxRes = await getSmsAccountContext(db, user.id)
        if (!ctxRes.ok) {
            return NextResponse.json({ success: false, error: ctxRes.error }, { status: ctxRes.status })
        }
        const { ctx } = ctxRes

        const [{ data: bundles }, { data: profile }, { data: ledger }, { data: wallet }] = await Promise.all([
            db.from('sms_bundles').select('*').eq('is_active', true).order('sort_order'),
            db.from('sms_business_profiles').select('id, business_name, description, domain_link, status, review_notes, created_at').eq('account_id', ctx.account.id).maybeSingle(),
            db.from('sms_credit_ledger').select('delta, balance_after, kind, reference, created_at').eq('account_id', ctx.account.id).order('created_at', { ascending: false }).limit(20),
            db.from('sms_wallets').select('credits, total_purchased, total_used').eq('account_id', ctx.account.id).maybeSingle(),
        ])

        // Effective sending policy (may be an error state, e.g. NO_SENDER_AVAILABLE).
        // ctx.senderRows is the sendable set (getSmsAccountContext →
        // getSendableSenderRows): the account's own sms_sender_ids rows, plus —
        // for PLATFORM mode ONLY — the owner's approved shop sender, if any
        // (feature-wave7). Business mode gets its own rows only (unchanged), so
        // `senders` below carries exactly what the compose page needs to offer a
        // platform-mode user their own approved sender(s).
        const policy = resolveSmsPolicy(ctx.account, ctx.senderRows as any, ctx.settings, ctx.role)

        return NextResponse.json({
            success: true,
            data: {
                account: {
                    id: ctx.account.id,
                    mode: ctx.account.mode,
                    status: ctx.account.status,
                    suspended_reason: ctx.account.suspended_reason,
                    default_sender: ctx.account.default_sender,
                    use_own_sender_for_confirmations: ctx.account.use_own_sender_for_confirmations,
                },
                wallet: wallet ?? { credits: 0, total_purchased: 0, total_used: 0 },
                senders: ctx.senderRows,
                poolSenders: ctx.settings.defaultSenders,
                caps: ctx.settings.caps[ctx.account.mode],
                policy: policy.ok
                    ? { canSend: true, sender: policy.sender, senderSource: policy.senderSource, filterProfile: policy.filterProfile }
                    : { canSend: false, reason: policy.error, message: policy.message },
                businessProfile: profile ?? null,
                ledger: ledger ?? [],
                bundles: bundlesForMode(bundles ?? [], ctx.account.mode),
            },
        })
    } catch (e: any) {
        console.error('[SMS Account] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}

/**
 * PATCH — two independent, optionally-combined self-row updates:
 *  - `defaultSender` — choose the account's default sender from the admin
 *    pool (business accounts without their own approved sender pick which
 *    pool ID to send as).
 *  - `use_own_sender_for_confirmations` (Task E4) — opt in/out of having the
 *    account's own approved sender used on the user's own order-confirmation
 *    SMS. Turning it ON requires ≥1 approved sender; turning it OFF is
 *    always allowed.
 */
export async function PATCH(request: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-account-patch:${user.id}`, 20, 60_000)
        if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

        const body = await request.json().catch(() => null)
        const hasDefaultSender = typeof body?.defaultSender === 'string'
        const hasUseOwnSender = typeof body?.use_own_sender_for_confirmations === 'boolean'
        if (!hasDefaultSender && !hasUseOwnSender) {
            return NextResponse.json({ success: false, error: 'Nothing to update' }, { status: 400 })
        }

        const db = createServerClient() as any
        const ctxRes = await getSmsAccountContext(db, user.id)
        if (!ctxRes.ok) return NextResponse.json({ success: false, error: ctxRes.error }, { status: ctxRes.status })

        const update: Record<string, unknown> = { updated_at: new Date().toISOString() }

        if (hasDefaultSender) {
            const requested = (body.defaultSender as string).trim()
            if (!requested || requested.length > 11) {
                return NextResponse.json({ success: false, error: 'Invalid sender' }, { status: 400 })
            }
            const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
            const inPool = ctxRes.ctx.settings.defaultSenders.find(p => eq(p, requested))
            const ownApproved = ctxRes.ctx.senderRows.find(r => r.status === 'approved' && eq(r.sender_text, requested))
            if (!inPool && !ownApproved) {
                return NextResponse.json({ success: false, error: 'Sender is not available for your account' }, { status: 400 })
            }
            update.default_sender = inPool || requested
        }

        if (hasUseOwnSender) {
            const nextValue = body.use_own_sender_for_confirmations as boolean
            if (nextValue) {
                const hasApprovedSender = ctxRes.ctx.senderRows.some(r => r.status === 'approved')
                if (!hasApprovedSender) {
                    return NextResponse.json({ success: false, error: 'Request and get a sender ID approved first' }, { status: 400 })
                }
            }
            update.use_own_sender_for_confirmations = nextValue
        }

        const { error } = await db.from('sms_accounts')
            .update(update)
            .eq('id', ctxRes.ctx.account.id)
        if (error) {
            console.error('[SMS Account PATCH] error:', error.message)
            return NextResponse.json({ success: false, error: 'Could not update account' }, { status: 500 })
        }
        return NextResponse.json({
            success: true,
            data: {
                ...(hasDefaultSender ? { default_sender: update.default_sender } : {}),
                ...(hasUseOwnSender ? { use_own_sender_for_confirmations: update.use_own_sender_for_confirmations } : {}),
            },
        })
    } catch (e: any) {
        console.error('[SMS Account PATCH] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
