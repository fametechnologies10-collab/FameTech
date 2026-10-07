/**
 * User SMS Platform — campaign pipeline (KFT SMS).
 *
 * ONE implementation shared by the dashboard route (/api/sms/campaigns), the
 * developer API (/api/v2/sms/send) and the dispatch cron — so the policy
 * gates, money contracts and claim discipline can never drift apart.
 *
 * Money/claim contracts (Stage-2 review):
 *  - create_sms_campaign RPC = atomic insert+debit; ledger key debit:{id}.
 *  - Inline-eligible campaigns are born CLAIMED (status 'processing') — the
 *    cron only ever claims 'queued' or stale-claim rows, so inline + cron can
 *    never double-send.
 *  - Refunds happen ONLY in settle_sms_campaign / cancel_sms_campaign
 *    (ledger key refund:{id}) computed from persisted failure rows.
 *  - At dispatch time the policy is re-resolved with the campaign's EXACT
 *    stored sender: a revoked sender or suspended account fails the campaign
 *    (with refund) — it is never re-sent under a substitute sender.
 */

import { filterSmsContent, type FilterResult } from '@/lib/sms-content-filter'
import { deterministicUuid } from '@/lib/sms-idempotency'
import { calculateSegments } from '@/lib/sms-segments'
import { stripUndeliverableChars } from '@/lib/sms-message'
import { normalizeGhanaPhone, sendHubtelCampaignChunk } from '@/lib/sms-service'
import {
    loadUserSmsSettings,
    resolveSmsPolicy,
    type ResolvedSmsPolicy,
    type UserSmsSettings,
} from '@/lib/sms-policy'
import { createNotification } from '@/lib/notification-service'
import { getSendableSenderRows } from '@/lib/sms-sender-set'
import { maybeNotifyLowBalance } from '@/lib/sms-low-balance-alert'
import type { SmsAccount, SmsCampaign } from '@/lib/sms-platform-types'

/** Campaigns at or below this many recipients dispatch inline (one Hubtel
 *  chunk); larger or future-scheduled ones queue for the cron. */
export const INLINE_DISPATCH_MAX = 500
const CHUNK_SIZE = 1000
const MAX_MESSAGE_LEN = 1000


// ─── Account context ─────────────────────────────────────────────────────────

export interface SmsAccountContext {
    account: SmsAccount
    credits: number
    role: string
    senderRows: Array<{ sender_text: string; status: string; is_default: boolean }>
    settings: UserSmsSettings
}

export async function getSmsAccountContext(
    db: any,
    userId: string
): Promise<{ ok: true; ctx: SmsAccountContext } | { ok: false; status: number; error: string }> {
    const settings = await loadUserSmsSettings(db)
    if (!settings.enabled) return { ok: false, status: 503, error: 'SMS platform is currently disabled' }

    const { data: userRow } = await db.from('users')
        .select('role, status').eq('id', userId).maybeSingle()
    if (!userRow) return { ok: false, status: 401, error: 'User not found' }
    if (userRow.status !== 'active') return { ok: false, status: 403, error: 'Your account is suspended or inactive' }
    if (!settings.allowedRoles.includes(userRow.role)) {
        return { ok: false, status: 403, error: 'SMS platform is not available for your account type' }
    }

    const { error: ensureErr } = await db.rpc('ensure_sms_account', { p_user_id: userId })
    if (ensureErr) {
        console.error('[SMS Pipeline] ensure_sms_account failed:', ensureErr.message)
        return { ok: false, status: 500, error: 'Could not initialise SMS account' }
    }

    const { data: account } = await db.from('sms_accounts')
        .select('*').eq('user_id', userId).single()
    // Merged sendable set (feature-wave7): the account's own sms_sender_ids
    // rows PLUS — for PLATFORM mode only — the owner's own approved shop
    // sender, so a platform-mode shop-owner can send KFT SMS under their
    // approved shop sender too. Business mode gets its own rows only.
    const [{ data: wallet }, senderRows] = await Promise.all([
        db.from('sms_wallets').select('credits, total_purchased, total_used').eq('account_id', account.id).maybeSingle(),
        getSendableSenderRows(db, userId, account.id, (account as SmsAccount).mode),
    ])

    return {
        ok: true,
        ctx: {
            account: account as SmsAccount,
            credits: wallet?.credits ?? 0,
            role: userRow.role as string,
            senderRows,
            settings,
        },
    }
}

// ─── DB-backed rate counters (fail closed) ───────────────────────────────────

async function checkRateCounters(
    db: any,
    accountId: string,
    policy: ResolvedSmsPolicy,
    newRecipients: number
): Promise<string | null> {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString()
    const dayAgo = new Date(Date.now() - 86400_000).toISOString()

    const [hourRes, dayRes] = await Promise.all([
        db.from('sms_campaigns')
            .select('id', { count: 'exact', head: true })
            .eq('account_id', accountId)
            .neq('status', 'blocked')
            .gte('created_at', hourAgo),
        db.from('sms_campaigns')
            .select('recipients_count')
            .eq('account_id', accountId)
            .neq('status', 'blocked')
            .gte('created_at', dayAgo),
    ])

    if (hourRes.error || dayRes.error) {
        console.error('[SMS Pipeline] rate-counter query failed — failing closed')
        return 'Rate limits are temporarily unavailable. Please try again shortly.'
    }
    if ((hourRes.count ?? 0) >= policy.caps.sends_per_hour) {
        return `Hourly send limit reached (${policy.caps.sends_per_hour}/hour)`
    }
    const dayRecipients = ((dayRes.data as any[]) || [])
        .reduce((s, r) => s + (r.recipients_count || 0), 0)
    if (dayRecipients + newRecipients > policy.caps.recipients_per_day) {
        return `Daily recipient limit reached (${policy.caps.recipients_per_day}/day)`
    }
    return null
}

// ─── Enqueue (+ inline dispatch) ─────────────────────────────────────────────

export interface CreateCampaignParams {
    db: any                        // service-role client
    userId: string
    ctx: SmsAccountContext
    message: string
    recipients: string[]
    requestedSender?: string | null
    scheduledAt?: string | null    // ISO; future ⇒ queued for the cron
    source: 'dashboard' | 'api'
    /** Developer-API idempotency key: same value ⇒ same campaign, no re-send. */
    idempotencyReference?: string | null
}

export interface CreateCampaignOutcome {
    ok: boolean
    status: number
    error?: string
    blocked?: boolean
    campaign?: {
        id: string
        status: string
        recipients: number
        segments: number
        credits_charged: number
        sender: string
        sent?: number
        failed?: number
        balance?: number
    }
}

export async function createCampaign(params: CreateCampaignParams): Promise<CreateCampaignOutcome> {
    const { db, userId, ctx, source } = params

    const policyRes = resolveSmsPolicy(
        ctx.account, ctx.senderRows as any, ctx.settings, ctx.role, params.requestedSender)
    if (!policyRes.ok) {
        const status = policyRes.error === 'FEATURE_DISABLED' ? 503
            : policyRes.error === 'INVALID_SENDER' || policyRes.error === 'NO_SENDER_AVAILABLE' ? 400 : 403
        return { ok: false, status, error: policyRes.message }
    }
    const policy = policyRes

    // Message preparation — billing and filtering run on the EXACT deliverable text.
    const message = stripUndeliverableChars((params.message || '').trim()).slice(0, MAX_MESSAGE_LEN)
    if (message.length < 3) return { ok: false, status: 400, error: 'Message is too short' }

    // Normalize + dedupe recipients.
    const seen = new Set<string>()
    const invalid: string[] = []
    for (const r of params.recipients || []) {
        const n = normalizeGhanaPhone(String(r))
        if (n) seen.add(n)
        else if (invalid.length < 5) invalid.push(String(r))
    }
    const recipients = Array.from(seen)
    if (recipients.length === 0) {
        return { ok: false, status: 400, error: `No valid Ghana phone numbers${invalid.length ? ` (e.g. ${invalid[0]})` : ''}` }
    }
    if (recipients.length > policy.caps.max_recipients_per_send) {
        return { ok: false, status: 400, error: `Maximum ${policy.caps.max_recipients_per_send} recipients per send for your plan` }
    }

    // Scheduling.
    let scheduledAt: string | null = null
    if (params.scheduledAt) {
        const t = new Date(params.scheduledAt)
        if (isNaN(t.getTime())) return { ok: false, status: 400, error: 'Invalid schedule time' }
        if (t.getTime() > Date.now() + 60_000) {
            if (t.getTime() > Date.now() + 30 * 86400_000) {
                return { ok: false, status: 400, error: 'Schedule must be within 30 days' }
            }
            scheduledAt = t.toISOString()
        }
    }

    const campaignId = params.idempotencyReference
        ? deterministicUuid(`${ctx.account.id}:${params.idempotencyReference}`)
        : crypto.randomUUID()

    // Content filter — profile from the policy engine. Business mode
    // (telco-only) uses its OWN block/flag/domain lists — separate from and
    // never unioned with the platform list — including the allowedDomains list
    // that was previously dropped here. Platform mode (strict) is unchanged:
    // the platform blockedKeywords, no extra allowed domains, no flag list.
    const filter: FilterResult = filterSmsContent(message,
        policy.filterProfile === 'telco-only'
            ? {
                policy: 'telco-only',
                blockedKeywords: ctx.settings.businessBlockedKeywords,
                flaggedKeywords: ctx.settings.businessFlaggedKeywords,
                allowedDomains: ctx.settings.businessAllowedDomains,
            }
            : {
                policy: policy.filterProfile,
                blockedKeywords: policy.blockedKeywords,
            })

    if (filter.blocked) {
        // Persist the refused attempt (feeds the auto-suspend counter), then 400.
        // Use a FRESH id — a blocked attempt must not occupy the idempotency
        // campaign id, so retrying the same reference with fixed content works.
        const { error } = await db.rpc('create_sms_campaign', {
            p_campaign_id: crypto.randomUUID(),
            p_user_id: userId,
            p_message: message,
            p_recipients_count: recipients.length,
            p_segments: calculateSegments(message).segments,
            p_credits: 0,
            p_mode: ctx.account.mode,
            p_sender: null,
            p_source: source,
            p_blocked: true,
            p_flag_reason: filter.reason,
            p_flag_severity: filter.severity ?? 'fraud',
        })
        if (error) console.error('[SMS Pipeline] blocked-campaign insert failed:', error.message)
        maybeEscalate(db, ctx, campaignId).catch(() => {})
        return { ok: false, status: 400, blocked: true, error: 'Message blocked by our content policy' }
    }

    const segments = calculateSegments(message).segments
    const credits = segments * recipients.length

    const rateErr = await checkRateCounters(db, ctx.account.id, policy, recipients.length)
    if (rateErr) return { ok: false, status: 429, error: rateErr }

    const inline = recipients.length <= INLINE_DISPATCH_MAX && !scheduledAt

    // Atomic insert + debit (gates re-checked inside the RPC).
    const { data: created, error: createErr } = await db.rpc('create_sms_campaign', {
        p_campaign_id: campaignId,
        p_user_id: userId,
        p_message: message,
        p_recipients_count: recipients.length,
        p_segments: segments,
        p_credits: credits,
        p_mode: ctx.account.mode,
        p_sender: policy.sender,
        p_source: source,
        p_scheduled_at: scheduledAt,
        p_claim_now: inline,
        p_flagged: filter.flagged,
        p_flag_reason: filter.reason,
        p_flag_severity: filter.severity ?? null,
    })
    if (createErr) {
        const msg = createErr.message || ''
        if (msg.includes('INSUFFICIENT_CREDITS')) return { ok: false, status: 402, error: 'Insufficient SMS credits' }
        if (msg.includes('ACCOUNT_SUSPENDED')) return { ok: false, status: 403, error: 'Your SMS account is suspended' }
        if (msg.includes('ROLE_NOT_ALLOWED')) return { ok: false, status: 403, error: 'SMS platform is not available for your account type' }
        console.error('[SMS Pipeline] create_sms_campaign failed:', msg)
        return { ok: false, status: 500, error: 'Could not create campaign' }
    }

    // Fire-and-forget — never blocks the send.
    if (typeof (created as any)?.balance === 'number') {
        maybeNotifyLowBalance(db, ctx.account.id, userId, (created as any).balance).catch(() => {})
    }

    // Idempotent retry (same reference / same campaign id): the debit ledger
    // key already existed, so no new charge or send — return the prior campaign.
    if ((created as any)?.already_processed) {
        const { data: prior } = await db.from('sms_campaigns')
            .select('id, status, recipients_count, segments, credits_charged, sender_used')
            .eq('id', campaignId).maybeSingle()
        return {
            ok: true,
            status: 200,
            campaign: {
                id: campaignId,
                status: (prior as any)?.status ?? 'processing',
                recipients: (prior as any)?.recipients_count ?? recipients.length,
                segments: (prior as any)?.segments ?? segments,
                credits_charged: (prior as any)?.credits_charged ?? credits,
                sender: (prior as any)?.sender_used ?? policy.sender,
            },
        }
    }

    // Persist per-recipient rows (chunked inserts, 1000/batch).
    for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
        const rows = recipients.slice(i, i + CHUNK_SIZE).map(to => ({
            campaign_id: campaignId,
            account_id: ctx.account.id,
            recipient: to,
            chunk_no: Math.floor(i / CHUNK_SIZE),
        }))
        const { error } = await db.from('sms_messages').insert(rows)
        if (error) {
            console.error('[SMS Pipeline] sms_messages insert failed:', error.message)
            // Fail the campaign cleanly: settle refunds everything still queued.
            await db.rpc('settle_sms_campaign', { p_campaign_id: campaignId })
            return { ok: false, status: 500, error: 'Could not queue campaign recipients' }
        }
    }

    if (filter.flagged) notifyFlag(db, ctx, campaignId, filter).catch(() => {})

    const base = {
        id: campaignId,
        recipients: recipients.length,
        segments,
        credits_charged: credits,
        sender: policy.sender,
        balance: (created as any)?.balance,
    }

    if (!inline) {
        return { ok: true, status: 200, campaign: { ...base, status: 'queued' } }
    }

    // Inline dispatch (≤500 recipients = one Hubtel chunk) + settle.
    const dispatch = await dispatchClaimedCampaign(db, {
        id: campaignId, sender_used: policy.sender, message,
    })
    const { data: settled } = await db.rpc('settle_sms_campaign', { p_campaign_id: campaignId })

    return {
        ok: true,
        status: 200,
        campaign: {
            ...base,
            status: (settled as any)?.final_status || 'processing',
            sent: dispatch.sent,
            failed: dispatch.failed,
        },
    }
}

// ─── Dispatch (inline + cron) ────────────────────────────────────────────────

export interface DispatchResult {
    done: boolean
    sent: number
    failed: number
}

/**
 * Send all still-queued messages of a CLAIMED ('processing') campaign,
 * chunk by chunk. `maxChunks` bounds cron work per run (60 s budget).
 */
export async function dispatchClaimedCampaign(
    db: any,
    campaign: { id: string; sender_used: string | null; message: string },
    maxChunks = 20
): Promise<DispatchResult> {
    let sent = 0
    let failed = 0

    if (!campaign.sender_used) {
        return { done: true, sent: 0, failed: 0 }
    }

    for (let c = 0; c < maxChunks; c++) {
        const { data: rows, error } = await db.from('sms_messages')
            .select('id, recipient')
            .eq('campaign_id', campaign.id)
            .eq('status', 'queued')
            .order('chunk_no', { ascending: true })
            .limit(CHUNK_SIZE)
        if (error) {
            console.error('[SMS Dispatch] fetch chunk failed:', error.message)
            return { done: false, sent, failed }
        }
        const chunk = (rows as any[]) || []
        if (chunk.length === 0) return { done: true, sent, failed }

        const result = await sendHubtelCampaignChunk(
            chunk.map(r => r.recipient), campaign.message, campaign.sender_used)

        let updates: any[]
        if (result.ok) {
            const byPhone = new Map(result.results.map(r => [r.to.replace(/^\+/, ''), r]))
            updates = chunk.map(r => {
                const pr = byPhone.get(r.recipient)
                return {
                    id: r.id,
                    status: 'sent',
                    provider_message_id: pr?.messageId ?? null,
                    network_id: pr?.networkId ?? null,
                    rate: pr?.rate ?? null,
                    detail: pr ? null : 'accepted (no provider id)',
                }
            })
            sent += chunk.length
        } else {
            updates = chunk.map(r => ({
                id: r.id, status: 'failed', provider_message_id: null,
                network_id: null, rate: null, detail: result.error || 'provider error',
            }))
            failed += chunk.length
        }

        const { error: updErr } = await db.rpc('bulk_update_sms_message_status', { p_updates: updates })
        if (updErr) console.error('[SMS Dispatch] bulk status update failed:', updErr.message)
    }

    // maxChunks exhausted — more queued rows may remain; cron continues next tick.
    const { count } = await db.from('sms_messages')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id)
        .eq('status', 'queued')
    return { done: (count ?? 0) === 0, sent, failed }
}

/**
 * Re-validation at claim time (cron path): account still active, role still
 * allowed, and the campaign's EXACT stored sender still valid. On failure the
 * campaign is failed + settled (refund) — never re-sent under another sender.
 */
export async function revalidateForDispatch(
    db: any,
    campaign: Pick<SmsCampaign, 'id' | 'account_id' | 'sender_used' | 'mode_at_send'>
): Promise<boolean> {
    const { data: account } = await db.from('sms_accounts')
        .select('*').eq('id', campaign.account_id).maybeSingle()
    if (!account) return false

    const { data: userRow } = await db.from('users')
        .select('role, status').eq('id', account.user_id).maybeSingle()
    // Merged sendable set (feature-wave7) — mirrors getSmsAccountContext so
    // a revoked/approved shop sender bites at dispatch time too. Mode-gated:
    // the shop sender merges only for platform mode; business (incl. held
    // business, which is mode==='business') gets its own rows only.
    const senders = await getSendableSenderRows(db, account.user_id, account.id, account.mode)

    const settings = await loadUserSmsSettings(db)
    const policy = resolveSmsPolicy(
        account, senders as any, settings,
        userRow?.role || '', campaign.sender_used)

    return policy.ok
        && userRow?.status === 'active'
        && account.mode === campaign.mode_at_send
}

export async function failAndSettleCampaign(db: any, campaignId: string, reason: string): Promise<void> {
    await db.from('sms_messages')
        .update({ status: 'failed', status_detail: reason, status_updated_at: new Date().toISOString() })
        .eq('campaign_id', campaignId)
        .eq('status', 'queued')
    await db.rpc('settle_sms_campaign', { p_campaign_id: campaignId })
}

// ─── Escalation + flag notifications (T24/T25) ───────────────────────────────

/** Auto-suspend after N blocked attempts in 24 h; admin review alert after M
 *  fraud-flagged DELIVERED campaigns in 24 h (flag-only abuse must converge). */
async function maybeEscalate(db: any, ctx: SmsAccountContext, _campaignId: string): Promise<void> {
    const dayAgo = new Date(Date.now() - 86400_000).toISOString()
    const { count } = await db.from('sms_campaigns')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.account.id)
        .eq('status', 'blocked')
        .gte('created_at', dayAgo)

    if ((count ?? 0) >= ctx.settings.autosuspendThreshold) {
        const { data: updated } = await db.from('sms_accounts')
            .update({ status: 'suspended', suspended_reason: `Auto-suspended: ${count} blocked attempts in 24h`, updated_at: new Date().toISOString() })
            .eq('id', ctx.account.id)
            .eq('status', 'active')
            .select('id')
        if (updated && (updated as any[]).length > 0) {
            await notifyAdminsSms(db,
                'SMS account auto-suspended',
                `Account of user ${ctx.account.user_id} was auto-suspended after ${count} blocked attempts in 24h.`)
            createNotification({
                userId: ctx.account.user_id,
                title: 'SMS sending suspended',
                message: 'Your SMS account was suspended after repeated policy violations. Contact support.',
                type: 'system',
                actionUrl: '/dashboard/sms',
            }).catch(() => {})
        }
    }
}

async function notifyFlag(db: any, ctx: SmsAccountContext, campaignId: string, filter: FilterResult): Promise<void> {
    // Fraud-grade flags push to admins immediately; 'info' flags only appear
    // in the admin Flagged tab (alert-fatigue guard).
    if (filter.severity !== 'fraud') return
    await notifyAdminsSms(db,
        'Flagged SMS campaign (fraud pattern)',
        `Campaign ${campaignId}: ${filter.reason}. Delivered under business policy — review required.`)

    const dayAgo = new Date(Date.now() - 86400_000).toISOString()
    const { count } = await db.from('sms_campaigns')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.account.id)
        .eq('flagged', true)
        .eq('flag_severity', 'fraud')
        .neq('status', 'blocked')
        .gte('created_at', dayAgo)
    if ((count ?? 0) >= ctx.settings.flagReviewThreshold) {
        await notifyAdminsSms(db,
            'SMS account needs review',
            `Account of user ${ctx.account.user_id} has ${count} fraud-flagged campaigns in 24h.`)
    }
}

async function notifyAdminsSms(db: any, title: string, message: string): Promise<void> {
    try {
        const { data: admins } = await db.from('users').select('id').eq('role', 'admin')
        await Promise.all(((admins as any[]) || []).map(a =>
            createNotification({ userId: a.id, title, message, type: 'system', actionUrl: '/admin/sms-platform' })))
    } catch (e: any) {
        console.error('[SMS Pipeline] admin notify failed:', e?.message)
    }
}
