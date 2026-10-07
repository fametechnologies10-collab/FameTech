/**
 * /api/admin/sms-platform — admin control plane for the user SMS platform.
 *
 * GET : review queues (business profiles, sender IDs), accounts + wallets,
 *       flagged-campaign queue, settings, revenue rollup.
 * POST: zod discriminated-union actions —
 *   review_business    approve/reject/revoke a profile. approve requires
 *                      whatsappVerified=true (docs were checked over
 *                      WhatsApp) and flips mode='business'; reject/revoke
 *                      fall mode back to 'platform' + cancel/refund queued
 *                      campaigns. revoke only applies from status='approved'.
 *   sender_action      submit_to_hubtel / approve / reject / revoke
 *   set_account_status suspend/unsuspend (suspend cancels queued campaigns)
 *   set_business_hold  hold/release a business account (Task D4) — while
 *                      held, the account is enforced as PLATFORM mode
 *                      everywhere policy is resolved (strict filter,
 *                      platform sender only); the mode column itself is
 *                      untouched, so releasing restores business mode as-is
 *   dismiss_flag       clear a campaign flag (guarded, stale ids 404)
 *   set_account_sms_rate_limit  per-account override on an account's SMS-type
 *                      API key's rate_limits.sms (null clears the override,
 *                      falling back to the global default)
 *   update_settings    pool senders / caps / keywords / thresholds / enabled /
 *                      global default SMS API rate limit (smsRateLimitPerMin)
 * All state changes are written to admin_audit_log (non-blocking).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { validateSenderText, senderCollides } from '@/lib/sms-sender-validation'
import { createNotification } from '@/lib/notification-service'
import { URL_SHORTENERS } from '@/lib/sms-content-filter'
import { reviewTransitionFor, validateBusinessReview } from '@/lib/sms-business-review'

export const dynamic = 'force-dynamic'

async function requireAdmin() {
    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
    // Role lookup on the cookie-aware client (users self-read RLS policy
    // covers it) — matches the sibling pattern in app/api/admin/shop-sms/route.ts.
    // Privileged operations below still go through the service-role client.
    const { data: row } = await supabase.from('users').select('role').eq('id', user.id).maybeSingle()
    if ((row as any)?.role !== 'admin') {
        return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
    }
    const db = createServerClient() as any
    return { user, db }
}

function audit(db: any, adminId: string, action: string, targetUserId: string | null, oldValue: any, newValue: any) {
    ;(db.from('admin_audit_log') as any).insert({
        admin_id: adminId,
        action,
        target_user_id: targetUserId,
        old_value: oldValue,
        new_value: newValue,
    }).then(() => {}).catch((e: any) => console.error('[SMS Admin] audit failed:', e?.message))
}

async function notifyUser(userId: string, title: string, message: string) {
    createNotification({ userId, title, message, type: 'system', actionUrl: '/dashboard/sms' }).catch(() => {})
}

/** Parses a comma-separated domain allowlist: lowercased, trimmed, protocol
 *  and leading `www.` stripped, empties dropped. Mirrors the private
 *  parseDomainCsv in lib/sms-policy.ts (kept local here rather than exported
 *  cross-module to stay within this fix wave's file-touch list) — same
 *  normalization the settings value gets when loadUserSmsSettings reads it
 *  back for enforcement, so the Fix 3b validation below rejects the same
 *  entries the filter would later treat as shortener hosts. */
function parseDomainCsv(value: string): string[] {
    return value
        .split(',')
        .map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, ''))
        .filter(d => d.length > 0)
}

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
            console.error(`[SMS Admin GET] ${label} query failed:`, error?.message || error)
            return { rows: [], warning: `${label}: ${error?.message || 'query failed'}` }
        }
        return { rows: (data as any[]) ?? [], warning: null }
    } catch (e: any) {
        console.error(`[SMS Admin GET] ${label} query threw:`, e?.message || e)
        return { rows: [], warning: `${label}: ${e?.message || 'unexpected error'}` }
    }
}

/** Cancel every queued campaign of an account (refunds via cancel RPC). */
async function cancelQueuedCampaigns(db: any, accountId: string) {
    const { data: queued } = await db.from('sms_campaigns')
        .select('id').eq('account_id', accountId).eq('status', 'queued')
    for (const c of (queued as any[]) || []) {
        await db.rpc('cancel_sms_campaign', { p_campaign_id: c.id, p_account_id: accountId })
    }
}

export async function GET() {
    const auth = await requireAdmin()
    if ('error' in auth) return auth.error
    const { db, user } = auth

    const rl = consumeRateLimit(`admin-sms-platform:${user.id}`, 30, 60_000)
    if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

    try {
        const [profiles, senders, flagged, recentCampaigns, accounts, purchases, settings, smsApiKeys] = await Promise.all([
            safeQuery('Business profiles', db.from('sms_business_profiles')
                .select('id, account_id, business_name, description, domain_link, ghana_card_number_masked, contact_whatsapp_number, status, review_notes, whatsapp_verified, whatsapp_verification_note, created_at, sms_accounts(id, user_id, mode, status, business_on_hold)')
                .in('status', ['under_review', 'approved', 'rejected', 'revoked'])
                .order('created_at', { ascending: false }).limit(100)),
            safeQuery('Sender requests', db.from('sms_sender_ids')
                .select('id, account_id, sender_text, status, hubtel_reference, rejection_reason, requested_at, approved_at, sms_accounts(user_id)')
                .order('requested_at', { ascending: false }).limit(100)),
            safeQuery('Flagged campaigns', db.from('sms_campaigns')
                .select('id, account_id, sender_used, mode_at_send, message, recipients_count, status, flag_reason, flag_severity, created_at, sms_accounts(user_id)')
                .eq('flagged', true)
                .order('created_at', { ascending: false }).limit(100)),
            // Task: full message monitoring (not just flagged) — same join
            // style as the flagged-campaigns query above so the client can
            // resolve a sender's user identifier the same way.
            safeQuery('Recent campaigns', db.from('sms_campaigns')
                .select('id, account_id, sender_used, mode_at_send, message, recipients_count, status, flagged, flag_reason, flag_severity, created_at, sms_accounts(user_id)')
                .order('created_at', { ascending: false }).limit(100)),
            safeQuery('Accounts', db.from('sms_accounts')
                .select('id, user_id, mode, status, suspended_reason, default_sender, business_on_hold, created_at, sms_wallets(credits, total_purchased, total_used)')
                .order('created_at', { ascending: false }).limit(200)),
            safeQuery('Purchases', db.from('sms_purchases').select('price, credits, paid_from')),
            safeQuery('Settings', db.from('admin_settings').select('key, value').in('key', [
                'user_sms_enabled', 'user_sms_allowed_roles', 'user_sms_caps',
                'user_sms_blocked_keywords', 'user_sms_default_senders',
                'user_sms_autosuspend_threshold', 'user_sms_flag_review_threshold',
                'user_sms_business_blocked_keywords', 'user_sms_business_flagged_keywords',
                'user_sms_business_allowed_domains', 'api_rate_limits',
            ])),
            safeQuery('SMS API keys', db.from('api_keys')
                .select('id, user_id, status, rate_limits')
                .eq('key_type', 'sms')),
        ])

        const results = [profiles, senders, flagged, recentCampaigns, accounts, purchases, settings, smsApiKeys]
        const warnings = results.map(r => r.warning).filter((w): w is string => !!w)
        // Every independent read failed at once — that's a total-outage signal
        // (e.g. DB unreachable), not a partial-degrade one. Surface it as a
        // real error rather than a 200 that quietly renders as an empty
        // platform with zero of everything and no explanation.
        if (warnings.length === results.length) {
            console.error('[SMS Admin GET] all sub-queries failed:', warnings)
            return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
        }

        const purchaseRows = purchases.rows
        const revenue = {
            totalRevenue: purchaseRows.reduce((s, p) => s + Number(p.price || 0), 0),
            creditsSold: purchaseRows.reduce((s, p) => s + (p.credits || 0), 0),
            purchases: purchaseRows.length,
        }
        const settingsMap: Record<string, any> = {}
        for (const row of settings.rows) settingsMap[row.key] = row.value

        const smsKeyByUserId = new Map<string, any>()
        for (const k of smsApiKeys.rows) smsKeyByUserId.set(k.user_id, k)
        const accountsWithKeys = accounts.rows.map((a: any) => {
            const key = smsKeyByUserId.get(a.user_id)
            return {
                ...a,
                smsApiKey: key
                    ? { id: key.id, status: key.status, rateLimitOverride: (key.rate_limits && key.rate_limits.sms) ?? null }
                    : null,
            }
        })

        return NextResponse.json({
            success: true,
            data: {
                businessProfiles: profiles.rows,
                senderRequests: senders.rows,
                flaggedCampaigns: flagged.rows,
                recentCampaigns: recentCampaigns.rows,
                accounts: accountsWithKeys,
                revenue,
                settings: settingsMap,
                warnings,
            },
        })
    } catch (e: any) {
        console.error('[SMS Admin GET] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}

const actionSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('review_business'),
        profileId: z.string().uuid(),
        decision: z.enum(['approved', 'rejected', 'revoked']),
        notes: z.string().max(1000).optional(),
        whatsappVerified: z.boolean().optional().default(false),
        whatsappVerificationNote: z.string().max(1000).optional(),
    }),
    z.object({ action: z.literal('sender_action'), senderId: z.string().uuid(), op: z.enum(['submit_to_hubtel', 'approve', 'reject', 'revoke']), hubtelReference: z.string().max(120).optional(), reason: z.string().max(500).optional() }),
    z.object({ action: z.literal('set_account_status'), accountId: z.string().uuid(), suspended: z.boolean(), reason: z.string().max(500).optional() }),
    z.object({ action: z.literal('set_business_hold'), accountId: z.string().uuid(), hold: z.boolean(), reason: z.string().max(500).optional() }),
    z.object({ action: z.literal('dismiss_flag'), campaignId: z.string().uuid() }),
    z.object({
        action: z.literal('update_settings'),
        enabled: z.boolean().optional(),
        poolSenders: z.array(z.string().min(3).max(11)).max(20).optional(),
        allowedRoles: z.array(z.enum(['customer', 'agent', 'dealer', 'admin', 'sub-admin'])).optional(),
        caps: z.any().optional(),
        blockedKeywords: z.string().max(2000).optional(),
        businessBlockedKeywords: z.string().max(2000).optional(),
        businessFlaggedKeywords: z.string().max(2000).optional(),
        businessAllowedDomains: z.string().max(2000).optional(),
        autosuspendThreshold: z.number().int().min(1).max(100).optional(),
        flagReviewThreshold: z.number().int().min(1).max(500).optional(),
        smsRateLimitPerMin: z.number().int().min(1).max(10000).optional(),
    }),
    z.object({ action: z.literal('set_account_sms_rate_limit'), userId: z.string().uuid(), limitPerMin: z.number().int().positive().max(10000).nullable() }),
])

export async function POST(request: NextRequest) {
    const auth = await requireAdmin()
    if ('error' in auth) return auth.error
    const { db, user } = auth

    const rl = consumeRateLimit(`admin-sms-platform:${user.id}`, 30, 60_000)
    if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

    const parsed = actionSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 })
    const input = parsed.data

    try {
        switch (input.action) {
            case 'review_business': {
                const check = validateBusinessReview(input.decision, input.whatsappVerified)
                if (!check.ok) return NextResponse.json({ success: false, error: check.error }, { status: 400 })

                const { data: profile } = await db.from('sms_business_profiles')
                    .select('id, account_id, status, business_name, sms_accounts(user_id, mode)')
                    .eq('id', input.profileId).maybeSingle()
                if (!profile) return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 })
                const acc: any = (profile as any).sms_accounts

                const transition = reviewTransitionFor(input.decision)
                if ((profile as any).status !== transition.from) {
                    return NextResponse.json({ success: false, error: `Cannot ${input.decision} a profile in status ${(profile as any).status}` }, { status: 409 })
                }

                const updatePayload: Record<string, any> = {
                    status: transition.to,
                    review_notes: input.notes ?? null,
                    reviewed_by: user.id,
                    reviewed_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                }
                if (input.decision === 'approved') {
                    updatePayload.whatsapp_verified = true
                    updatePayload.whatsapp_verification_note = input.whatsappVerificationNote ?? null
                } else {
                    // Defense in depth (Fix C1): reject/revoke means this
                    // business is not currently verified. The user route
                    // already resets these on every save/submit, but clear
                    // them here too in case a future code path ever writes
                    // to this row directly.
                    updatePayload.whatsapp_verified = false
                    updatePayload.whatsapp_verification_note = null
                }

                // Audit H1: the guarded update can match 0 rows (another admin
                // already decided this profile) with NO error — confirm a row
                // actually transitioned BEFORE touching account mode, else a
                // stale click could grant/revoke business mode against a
                // profile that just changed status.
                const { data: updatedProfile, error } = await db.from('sms_business_profiles').update(updatePayload)
                    .eq('id', input.profileId).eq('status', transition.from).select('id')
                if (error) throw error
                if (!updatedProfile || (updatedProfile as any[]).length === 0) {
                    return NextResponse.json({ success: false, error: 'Profile status changed while processing — reload the queue' }, { status: 409 })
                }

                if (input.decision === 'approved') {
                    await db.from('sms_accounts').update({ mode: 'business', updated_at: new Date().toISOString() })
                        .eq('id', (profile as any).account_id)
                    notifyUser(acc.user_id, 'Business registration approved 🎉',
                        'Your SMS business mode is now active — link freedom, relaxed filtering, and sender ID options are unlocked.')
                } else {
                    // Reject/revoke ⇒ business privileges end: mode back to
                    // platform, queued campaigns cancelled + refunded.
                    await db.from('sms_accounts').update({ mode: 'platform', updated_at: new Date().toISOString() })
                        .eq('id', (profile as any).account_id)
                    await cancelQueuedCampaigns(db, (profile as any).account_id)
                    notifyUser(acc.user_id,
                        input.decision === 'revoked' ? 'Business registration revoked' : 'Business registration update',
                        input.decision === 'revoked'
                            ? `Your business registration was revoked.${input.notes ? ` Reason: ${input.notes}` : ''} Contact us on WhatsApp if you have questions, or resubmit your application at any time.`
                            : `Your business registration was not approved.${input.notes ? ` Note: ${input.notes}` : ''}`)
                }
                audit(db, user.id, `sms_business_${input.decision}`, acc.user_id,
                    { status: (profile as any).status },
                    {
                        status: transition.to,
                        notes: input.notes ?? null,
                        whatsapp_verified: updatePayload.whatsapp_verified,
                        whatsapp_verification_note: updatePayload.whatsapp_verification_note,
                    })
                return NextResponse.json({ success: true })
            }

            case 'sender_action': {
                const { data: sender } = await db.from('sms_sender_ids')
                    .select('id, account_id, sender_text, status, sms_accounts(user_id)')
                    .eq('id', input.senderId).maybeSingle()
                if (!sender) return NextResponse.json({ success: false, error: 'Sender not found' }, { status: 404 })
                const s: any = sender
                const userId = s.sms_accounts.user_id

                const transitions: Record<string, { from: string[]; to: string }> = {
                    submit_to_hubtel: { from: ['under_review'], to: 'submitted_to_hubtel' },
                    approve: { from: ['under_review', 'submitted_to_hubtel'], to: 'approved' },
                    reject: { from: ['under_review', 'submitted_to_hubtel'], to: 'rejected' },
                    revoke: { from: ['approved'], to: 'revoked' },
                }
                const t = transitions[input.op]
                if (!t.from.includes(s.status)) {
                    return NextResponse.json({ success: false, error: `Cannot ${input.op} a sender in status ${s.status}` }, { status: 409 })
                }
                if (input.op === 'approve') {
                    const check = validateSenderText(s.sender_text)
                    if (!check.ok) return NextResponse.json({ success: false, error: `Refusing approval: ${check.error}` }, { status: 409 })
                    // Audit L-5: the DB unique index is only lower(trim()); re-run
                    // the leet-normalized collision check against OTHER approved
                    // senders so 'ACMECORP' and 'ACMEC0RP' can't both go live.
                    const { data: approvedRows } = await db.from('sms_sender_ids')
                        .select('sender_text').eq('status', 'approved').neq('id', s.id)
                    const others = ((approvedRows as any[]) || []).map(r => r.sender_text)
                    if (senderCollides(s.sender_text, others)) {
                        return NextResponse.json({ success: false, error: 'Refusing approval: collides with an already-approved sender ID' }, { status: 409 })
                    }
                    // Sender-ID approval and business-profile approval are
                    // fully decoupled, manual admin actions — approving a
                    // sender never approves (or auto-verifies) the business
                    // profile as a side effect. The profile must already be
                    // 'approved' via review_business (which itself requires
                    // whatsapp_verified=true) before its account may activate
                    // business mode through a sender approval.
                    const { data: profile } = await db.from('sms_business_profiles')
                        .select('id, status').eq('account_id', s.account_id).maybeSingle()
                    if (!profile || (profile as any).status !== 'approved') {
                        return NextResponse.json({ success: false, error: 'Business profile must be approved before a sender ID can be approved.' }, { status: 409 })
                    }
                    await db.from('sms_accounts').update({ mode: 'business', updated_at: new Date().toISOString() })
                        .eq('id', s.account_id)
                }

                const { data: hasDefault } = await db.from('sms_sender_ids')
                    .select('id').eq('account_id', s.account_id).eq('is_default', true).maybeSingle()

                const { error } = await db.from('sms_sender_ids').update({
                    status: t.to,
                    hubtel_reference: input.hubtelReference ?? undefined,
                    rejection_reason: ['reject', 'revoke'].includes(input.op) ? (input.reason ?? null) : null,
                    approved_at: input.op === 'approve' ? new Date().toISOString() : undefined,
                    is_default: input.op === 'approve' ? !hasDefault : (input.op === 'revoke' ? false : undefined),
                    updated_at: new Date().toISOString(),
                }).eq('id', s.id).in('status', t.from)
                if (error) throw error

                // On approval with no prior default, make this the account's
                // active sender so the very next send goes out under it.
                if (input.op === 'approve' && !hasDefault) {
                    await db.from('sms_accounts').update({ default_sender: s.sender_text, updated_at: new Date().toISOString() })
                        .eq('id', s.account_id)
                }

                const messages: Record<string, string> = {
                    submit_to_hubtel: `Your sender ID "${s.sender_text}" has been submitted to the network for approval.`,
                    approve: `Your sender ID "${s.sender_text}" is approved! Business mode is active — your messages now send with your own brand name.`,
                    reject: `Your sender ID request "${s.sender_text}" was not approved.${input.reason ? ` Reason: ${input.reason}` : ''}`,
                    revoke: `Your sender ID "${s.sender_text}" has been revoked.${input.reason ? ` Reason: ${input.reason}` : ''}`,
                }
                notifyUser(userId, 'Sender ID update', messages[input.op])
                audit(db, user.id, `sms_sender_${input.op}`, userId,
                    { status: s.status, sender: s.sender_text },
                    { status: t.to, hubtel_reference: input.hubtelReference ?? null, reason: input.reason ?? null })
                return NextResponse.json({ success: true })
            }

            case 'set_account_status': {
                const { data: account } = await db.from('sms_accounts')
                    .select('id, user_id, status').eq('id', input.accountId).maybeSingle()
                if (!account) return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 })
                const a: any = account

                const { error } = await db.from('sms_accounts').update({
                    status: input.suspended ? 'suspended' : 'active',
                    suspended_reason: input.suspended ? (input.reason ?? 'Suspended by admin') : null,
                    updated_at: new Date().toISOString(),
                }).eq('id', a.id)
                if (error) throw error

                if (input.suspended) await cancelQueuedCampaigns(db, a.id)
                notifyUser(a.user_id, input.suspended ? 'SMS sending suspended' : 'SMS sending restored',
                    input.suspended
                        ? `Your SMS account has been suspended.${input.reason ? ` Reason: ${input.reason}` : ''}`
                        : 'Your SMS account has been re-activated.')
                audit(db, user.id, input.suspended ? 'sms_account_suspend' : 'sms_account_unsuspend',
                    a.user_id, { status: a.status }, { status: input.suspended ? 'suspended' : 'active', reason: input.reason ?? null })
                return NextResponse.json({ success: true })
            }

            case 'set_business_hold': {
                const { data: account } = await db.from('sms_accounts')
                    .select('id, user_id, mode, business_on_hold').eq('id', input.accountId).maybeSingle()
                if (!account) return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 })
                const a: any = account

                // Holding only makes sense for a business-mode account — the
                // policy engine's hold check is itself mode-gated, so setting
                // the flag on a platform account would be an inert no-op that
                // just confuses the audit trail. Releasing is always allowed
                // (idempotent no-op if the account isn't business/held).
                if (input.hold && a.mode !== 'business') {
                    return NextResponse.json({ success: false, error: 'Only a business-mode account can be held' }, { status: 409 })
                }

                const { error } = await db.from('sms_accounts').update({
                    business_on_hold: input.hold,
                    updated_at: new Date().toISOString(),
                }).eq('id', a.id)
                if (error) throw error

                if (input.hold) await cancelQueuedCampaigns(db, a.id)
                notifyUser(a.user_id, input.hold ? 'Business SMS mode paused' : 'Business SMS mode restored',
                    input.hold
                        ? `Your business SMS mode has been paused${input.reason ? `: ${input.reason}` : ' until your business certificate is provided'}. While paused, your messages send under the KFT platform sender with standard filtering — your own sender ID and business filtering are not usable.`
                        : 'Your business SMS mode has been restored — your own sender ID and business filtering are active again.')
                audit(db, user.id, input.hold ? 'sms_business_hold' : 'sms_business_release',
                    a.user_id, { business_on_hold: a.business_on_hold }, { business_on_hold: input.hold, reason: input.reason ?? null })
                return NextResponse.json({ success: true })
            }

            case 'dismiss_flag': {
                const { data, error } = await db.from('sms_campaigns')
                    .update({ flagged: false })
                    .eq('id', input.campaignId)
                    .eq('flagged', true)
                    .select('id')
                if (error) throw error
                if (!data || (data as any[]).length === 0) {
                    return NextResponse.json({ success: false, error: 'Flag not found' }, { status: 404 })
                }
                audit(db, user.id, 'sms_flag_dismiss', null, { campaign_id: input.campaignId, flagged: true }, { flagged: false })
                return NextResponse.json({ success: true })
            }

            case 'set_account_sms_rate_limit': {
                const { data: key } = await db.from('api_keys')
                    .select('id, rate_limits').eq('user_id', input.userId).eq('key_type', 'sms').maybeSingle()
                if (!key) return NextResponse.json({ success: false, error: 'No SMS API key on this account' }, { status: 404 })

                const previousLimit = ((key as any).rate_limits && (key as any).rate_limits.sms) ?? null

                const nextLimits: Record<string, number> = { ...((key as any).rate_limits || {}) }
                if (input.limitPerMin === null) {
                    delete nextLimits.sms
                } else {
                    nextLimits.sms = input.limitPerMin
                }

                const { error } = await db.from('api_keys').update({ rate_limits: nextLimits }).eq('id', (key as any).id)
                if (error) throw error

                audit(db, user.id, 'sms_api_key_rate_limit_update', input.userId, { limitPerMin: previousLimit }, { limitPerMin: input.limitPerMin })
                return NextResponse.json({ success: true })
            }

            case 'update_settings': {
                const writes: Array<{ key: string; value: any }> = []
                if (input.enabled !== undefined) writes.push({ key: 'user_sms_enabled', value: input.enabled })
                if (input.allowedRoles) writes.push({ key: 'user_sms_allowed_roles', value: input.allowedRoles })
                if (input.caps !== undefined) writes.push({ key: 'user_sms_caps', value: input.caps })
                if (input.blockedKeywords !== undefined) writes.push({ key: 'user_sms_blocked_keywords', value: input.blockedKeywords })
                if (input.businessBlockedKeywords !== undefined) writes.push({ key: 'user_sms_business_blocked_keywords', value: input.businessBlockedKeywords })
                if (input.businessFlaggedKeywords !== undefined) writes.push({ key: 'user_sms_business_flagged_keywords', value: input.businessFlaggedKeywords })
                if (input.businessAllowedDomains !== undefined) {
                    // Fix 3b (Stage-4): shorteners can never be allowlisted
                    // (Fix 3a reversal made the exemption dead in the filter
                    // itself) — reject at the settings-write boundary too, so
                    // the admin UI can't silently store an inert/misleading
                    // entry. Same normalization as loadUserSmsSettings uses
                    // when this list is later read for enforcement.
                    const domains = parseDomainCsv(input.businessAllowedDomains)
                    const shortenerHit = domains.find(d => URL_SHORTENERS.some(s => d === s || d.endsWith('.' + s)))
                    if (shortenerHit) {
                        return NextResponse.json({ success: false, error: `URL shorteners cannot be allowlisted: "${shortenerHit}"` }, { status: 400 })
                    }
                    writes.push({ key: 'user_sms_business_allowed_domains', value: input.businessAllowedDomains })
                }
                if (input.autosuspendThreshold !== undefined) writes.push({ key: 'user_sms_autosuspend_threshold', value: input.autosuspendThreshold })
                if (input.flagReviewThreshold !== undefined) writes.push({ key: 'user_sms_flag_review_threshold', value: input.flagReviewThreshold })
                if (input.poolSenders) {
                    // Pool senders are the PLATFORM's own generic brands — the
                    // reserved-brand check does NOT apply (it would reject the
                    // platform's own names); only charset/length matters.
                    for (const p of input.poolSenders) {
                        if (!/^[A-Za-z0-9 ]{3,11}$/.test(p.trim())) {
                            return NextResponse.json({ success: false, error: `Invalid pool sender "${p}"` }, { status: 400 })
                        }
                    }
                    writes.push({ key: 'user_sms_default_senders', value: input.poolSenders.map(p => p.trim()) })
                }
                if (input.smsRateLimitPerMin !== undefined) {
                    const { data: existing } = await db.from('admin_settings')
                        .select('value').eq('key', 'api_rate_limits').maybeSingle()
                    const rawCurrent = (existing as any)?.value
                    const current = rawCurrent && typeof rawCurrent === 'object'
                        ? rawCurrent
                        : (typeof rawCurrent === 'string' ? JSON.parse(rawCurrent) : {})
                    writes.push({ key: 'api_rate_limits', value: { ...current, sms: input.smsRateLimitPerMin } })
                }
                for (const w of writes) {
                    const { error } = await db.from('admin_settings')
                        .upsert({ key: w.key, value: w.value }, { onConflict: 'key' })
                    if (error) throw error
                }
                audit(db, user.id, 'sms_settings_update', null, null, Object.fromEntries(writes.map(w => [w.key, w.value])))
                return NextResponse.json({ success: true })
            }
        }
    } catch (e: any) {
        console.error('[SMS Admin POST] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
