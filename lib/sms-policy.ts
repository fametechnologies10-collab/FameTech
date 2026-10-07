/**
 * User SMS Platform — policy engine (KFT SMS).
 *
 * Single source of truth for what an SMS account may do:
 *   mode → filter profile ('strict' | 'telco-only'), sender resolution
 *   (own approved sender → admin default pool → platform sender), per-mode
 *   caps, and the admin keyword blocklist (union of the user-platform key AND
 *   the shop key so one admin keyword protects both products).
 *
 * FAIL-CLOSED RULES (Stage-2 review):
 *  - Business mode NEVER falls back to the platform sender (KINGFLEXY). If no
 *    approved own sender and no pool sender resolves, the send is refused.
 *  - The requested sender must belong to the account (approved) or the admin
 *    pool — anything else is INVALID_SENDER.
 *  - Callers re-run this at DISPATCH time too (cron), not just at enqueue.
 *  - Task D4: an admin "hold" on a business account (`business_on_hold`)
 *    forces the SAME enforcement path as platform mode — strict filter,
 *    platform sender only, platform caps — regardless of any approved own
 *    sender. Held accounts never fall through to their own/pool sender.
 *  - Feature-wave7: TRUE platform mode (not held) may ALSO send under any of
 *    the account's own APPROVED senders — KFT `sms_sender_ids` merged with
 *    the owner's approved shop sender (`getSendableSenderRows`) — but only
 *    when explicitly requested; the default (no requestedSender) stays the
 *    platform sender, so nothing silently switches.
 */

import type { FilterPolicy } from '@/lib/sms-content-filter'
import {
    DEFAULT_SMS_CAPS,
    type SmsAccountMode,
    type SmsModeCaps,
    type SmsSenderId,
} from '@/lib/sms-platform-types'

// ─── Settings ────────────────────────────────────────────────────────────────

export interface UserSmsSettings {
    enabled: boolean
    allowedRoles: string[]
    caps: Record<SmsAccountMode, SmsModeCaps>
    blockedKeywords: string[]
    defaultSenders: string[]
    autosuspendThreshold: number
    flagReviewThreshold: number
    /** Business-mode fraud lists — SEPARATE and INDEPENDENT from `blockedKeywords`
     *  (the strict platform list). Never unioned with the platform or shop lists. */
    businessBlockedKeywords: string[]
    businessFlaggedKeywords: string[]
    businessAllowedDomains: string[]
}

const SETTINGS_KEYS = [
    'user_sms_enabled',
    'user_sms_allowed_roles',
    'user_sms_caps',
    'user_sms_blocked_keywords',
    'user_sms_default_senders',
    'user_sms_autosuspend_threshold',
    'user_sms_flag_review_threshold',
    'user_sms_business_blocked_keywords',
    'user_sms_business_flagged_keywords',
    'user_sms_business_allowed_domains',
]

/** admin_settings values are JSONB and occasionally come back with the JSON
 *  quoting still attached (e.g. `"scam,fraud"`) — strip it before parsing. */
function stripSurroundingQuotes(value: unknown): unknown {
    return typeof value === 'string' ? value.replace(/^"|"$/g, '') : value
}

function parseKeywordCsv(value: unknown): string[] {
    if (typeof value !== 'string') return []
    return value.split(',').map(k => k.trim().toLowerCase()).filter(k => k.length >= 2)
}

/** Parses a comma-separated domain allowlist: lowercased, trimmed, protocol
 *  and leading `www.` stripped, empties dropped. */
function parseDomainCsv(value: unknown): string[] {
    if (typeof value !== 'string') return []
    return value
        .split(',')
        .map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, ''))
        .filter(d => d.length > 0)
}

function parseCaps(value: unknown): Record<SmsAccountMode, SmsModeCaps> {
    const out: Record<SmsAccountMode, SmsModeCaps> = {
        platform: { ...DEFAULT_SMS_CAPS.platform },
        business: { ...DEFAULT_SMS_CAPS.business },
    }
    if (value && typeof value === 'object') {
        for (const mode of ['platform', 'business'] as SmsAccountMode[]) {
            const m = (value as any)[mode]
            if (m && typeof m === 'object') {
                for (const k of ['max_recipients_per_send', 'sends_per_hour', 'recipients_per_day'] as const) {
                    const n = Number(m[k])
                    if (Number.isFinite(n) && n > 0) out[mode][k] = Math.floor(n)
                }
            }
        }
    }
    return out
}

/**
 * Load all user-SMS settings in two batched queries.
 * `db` must be a SERVICE-ROLE client (admin_settings/shop_global_settings reads).
 */
export async function loadUserSmsSettings(db: any): Promise<UserSmsSettings> {
    const [{ data: adminRows }, { data: shopKw }] = await Promise.all([
        db.from('admin_settings').select('key, value').in('key', SETTINGS_KEYS),
        db.from('shop_global_settings').select('value').eq('key', 'sms_blocked_keywords').maybeSingle(),
    ])

    const s: Record<string, any> = {}
    for (const row of (adminRows as any[]) || []) s[row.key] = row.value

    const enabledRaw = s['user_sms_enabled']
    const enabled = enabledRaw === true || enabledRaw === 'true'

    const rolesRaw = s['user_sms_allowed_roles']
    const allowedRoles = Array.isArray(rolesRaw)
        ? rolesRaw.map(String)
        : ['customer', 'agent', 'dealer', 'admin']

    const sendersRaw = s['user_sms_default_senders']
    const defaultSenders = (Array.isArray(sendersRaw) ? sendersRaw.map(String) : [])
        .map(x => x.trim().substring(0, 11))
        .filter(x => x.length >= 3)

    // Union: user-platform keyword list + shop keyword list (one admin action
    // protects both products; both stores use the comma-separated convention).
    const blockedKeywords = Array.from(new Set([
        ...parseKeywordCsv(s['user_sms_blocked_keywords']),
        ...parseKeywordCsv(shopKw ? String((shopKw as any).value ?? '').replace(/^"|"$/g, '') : ''),
    ]))

    const toInt = (v: unknown, dflt: number) => {
        const n = Number(typeof v === 'string' ? v.replace(/"/g, '') : v)
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
    }

    // Business-mode fraud lists — independent of the platform `blockedKeywords`
    // union above. Never merged with the platform or shop keyword lists.
    const businessBlockedKeywords = parseKeywordCsv(stripSurroundingQuotes(s['user_sms_business_blocked_keywords']))
    const businessFlaggedKeywords = parseKeywordCsv(stripSurroundingQuotes(s['user_sms_business_flagged_keywords']))
    const businessAllowedDomains = parseDomainCsv(stripSurroundingQuotes(s['user_sms_business_allowed_domains']))

    return {
        enabled,
        allowedRoles,
        caps: parseCaps(s['user_sms_caps']),
        blockedKeywords,
        defaultSenders,
        autosuspendThreshold: toInt(s['user_sms_autosuspend_threshold'], 5),
        flagReviewThreshold: toInt(s['user_sms_flag_review_threshold'], 10),
        businessBlockedKeywords,
        businessFlaggedKeywords,
        businessAllowedDomains,
    }
}

// ─── Policy resolution ───────────────────────────────────────────────────────

export interface ResolvedSmsPolicy {
    ok: true
    mode: SmsAccountMode
    filterProfile: FilterPolicy
    /** Resolved sender ID — always explicit; campaign senders never inherit env defaults. */
    sender: string
    senderSource: 'own' | 'pool' | 'platform'
    caps: SmsModeCaps
    blockedKeywords: string[]
}

export interface SmsPolicyError {
    ok: false
    /** ACCOUNT_SUSPENDED | ROLE_NOT_ALLOWED | FEATURE_DISABLED | NO_SENDER_AVAILABLE | INVALID_SENDER */
    error: string
    message: string
}

export interface PolicyAccountInput {
    id: string
    mode: SmsAccountMode
    status: 'active' | 'suspended'
    default_sender: string | null
    /** Admin "hold business mode" (Task D4). When true on a business-mode
     *  account, the account is enforced as platform mode below — strict
     *  filter, platform sender only, platform caps — until an admin
     *  releases the hold. */
    business_on_hold: boolean
}

const PLATFORM_SENDER = () => (process.env.HUBTEL_SENDER_ID || 'KINGFLEXY').substring(0, 11)

/**
 * Resolve the effective policy for a send. `senderRows` = the account's
 * sms_sender_ids (any status — filtering happens here so revocations bite
 * immediately, including at cron dispatch time).
 */
export function resolveSmsPolicy(
    account: PolicyAccountInput,
    senderRows: Pick<SmsSenderId, 'sender_text' | 'status' | 'is_default'>[],
    settings: UserSmsSettings,
    userRole: string,
    requestedSender?: string | null
): ResolvedSmsPolicy | SmsPolicyError {
    if (!settings.enabled) {
        return { ok: false, error: 'FEATURE_DISABLED', message: 'SMS platform is currently disabled' }
    }
    if (!settings.allowedRoles.includes(userRole)) {
        return { ok: false, error: 'ROLE_NOT_ALLOWED', message: 'SMS platform is not available for your account type' }
    }
    if (account.status !== 'active') {
        return { ok: false, error: 'ACCOUNT_SUSPENDED', message: 'Your SMS account is suspended' }
    }

    // D4: an admin-held business account is enforced as PLATFORM mode
    // everywhere below — strict filter, platform sender only, platform caps.
    // The account's own approved sender(s) remain on file but are not
    // usable for sending until the hold is released.
    const heldAsPlatform = account.mode === 'business' && account.business_on_hold

    const caps = settings.caps[heldAsPlatform ? 'platform' : account.mode]
    const blockedKeywords = settings.blockedKeywords

    if (heldAsPlatform) {
        // D4 — UNCHANGED: an admin-held business account is locked to the
        // platform sender only, strict filter, regardless of any approved
        // own (or shop) sender on file. Held accounts never fall through.
        const sender = PLATFORM_SENDER()
        if (requestedSender && requestedSender.trim().toLowerCase() !== sender.toLowerCase()) {
            return {
                ok: false,
                error: 'INVALID_SENDER',
                message: 'Business mode is on hold — only the platform sender is available until it is released',
            }
        }
        return { ok: true, mode: 'platform', filterProfile: 'strict', sender, senderSource: 'platform', caps, blockedKeywords }
    }

    if (account.mode === 'platform') {
        // True platform mode (feature-wave7): strict filter always. A
        // requested sender may be the platform sender OR one of the
        // account's own APPROVED senders — `senderRows` here is the MERGED
        // set from getSendableSenderRows (KFT sms_sender_ids ∪ the owner's
        // approved shop sender), so a platform-mode user may also send under
        // their own KFT-approved or shop-approved sender. No requested
        // sender ⇒ the platform sender (unchanged default — nothing silently
        // switches; the user must explicitly pick their own sender).
        const sender = PLATFORM_SENDER()
        const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
        if (requestedSender && requestedSender.trim()) {
            if (eq(requestedSender, sender)) {
                return { ok: true, mode: 'platform', filterProfile: 'strict', sender, senderSource: 'platform', caps, blockedKeywords }
            }
            const approved = senderRows.filter(r => r.status === 'approved')
            const own = approved.find(r => eq(r.sender_text, requestedSender))
            if (own) {
                return { ok: true, mode: 'platform', filterProfile: 'strict', sender: own.sender_text.trim().substring(0, 11), senderSource: 'own', caps, blockedKeywords }
            }
            return { ok: false, error: 'INVALID_SENDER', message: 'Sender ID is not approved for your account' }
        }
        return { ok: true, mode: 'platform', filterProfile: 'strict', sender, senderSource: 'platform', caps, blockedKeywords }
    }

    // Business mode — resolve own approved sender or an admin pool sender.
    const approved = senderRows.filter(r => r.status === 'approved')
    const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

    if (requestedSender && requestedSender.trim()) {
        const own = approved.find(r => eq(r.sender_text, requestedSender))
        if (own) {
            return { ok: true, mode: 'business', filterProfile: 'telco-only', sender: own.sender_text.trim().substring(0, 11), senderSource: 'own', caps, blockedKeywords }
        }
        const pool = settings.defaultSenders.find(p => eq(p, requestedSender))
        if (pool) {
            return { ok: true, mode: 'business', filterProfile: 'telco-only', sender: pool, senderSource: 'pool', caps, blockedKeywords }
        }
        return { ok: false, error: 'INVALID_SENDER', message: 'Sender ID is not approved for your account' }
    }

    // No explicit request: own default → any own approved → account pool choice
    // → first pool sender. NEVER the platform sender (fail closed).
    const ownDefault = approved.find(r => r.is_default) || approved[0]
    if (ownDefault) {
        return { ok: true, mode: 'business', filterProfile: 'telco-only', sender: ownDefault.sender_text.trim().substring(0, 11), senderSource: 'own', caps, blockedKeywords }
    }
    const poolChoice = account.default_sender
        && settings.defaultSenders.find(p => eq(p, account.default_sender as string))
    const pool = poolChoice || settings.defaultSenders[0]
    if (pool) {
        return { ok: true, mode: 'business', filterProfile: 'telco-only', sender: pool, senderSource: 'pool', caps, blockedKeywords }
    }

    return {
        ok: false,
        error: 'NO_SENDER_AVAILABLE',
        message: 'No sender ID is available for your business account — choose a default sender or request your own',
    }
}
