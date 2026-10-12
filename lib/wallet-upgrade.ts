/**
 * Wallet-based role upgrade processor.
 *
 * The purchase itself (lock → idempotency → eligibility → balance → deduct → ledger → role grant)
 * is ONE atomic Postgres function, `process_wallet_upgrade` (supabase/migrations/
 * 20261012b_wallet_upgrade_atomic_rpc.sql). This file only validates input, calls it, maps the
 * result, and fires best-effort notifications afterwards.
 *
 * Why it lives in the database: the old TS flow read the user, deducted the wallet, then wrote the
 * role as separate statements. Concurrent requests double-charged for one extension, a failed role
 * write kept the money, and a Lifetime Agent could be re-bought into a time-limited pass.
 */

import { randomUUID } from 'node:crypto'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { waitUntil } from '@vercel/functions'

export type UpgradeType = 'agent' | 'dealer'
export type AgentPlan = '3d' | '14d' | '30d' | 'permanent'
export type DealerPlan = '1m' | '3m' | '6m'
export type PlanType = AgentPlan | DealerPlan

const AGENT_PLANS: readonly string[] = ['3d', '14d', '30d', 'permanent']
const DEALER_PLANS: readonly string[] = ['1m', '3m', '6m']

/** Hard ceiling mirrored by the RPC's sanity check. */
const MAX_UPGRADE_PRICE = 100000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Thrown when an upgrade price cannot be resolved to a safe, positive, finite number. */
export class UpgradePriceError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'UpgradePriceError'
    }
}

export type UpgradeFailureCode =
    | 'insufficient_balance'
    | 'already_permanent'
    | 'not_eligible'
    | 'account_inactive'
    | 'not_due'
    | 'invalid_request'
    | 'user_not_found'
    | 'wallet_not_found'
    | 'rpc_error'

interface UpgradeParams {
    userId: string
    upgradeType: UpgradeType
    plan: PlanType
    /** Server-resolved price (fetchUpgradePrice) — never a client-supplied value. */
    price: number
    planLabel: string
    /** Whether this is triggered by the auto-upgrade cron (affects notifications + ledger text) */
    isAutoUpgrade?: boolean
    /**
     * Stable per-attempt key. A retry carrying the same key can never charge twice. Callers that
     * don't pass one get a fresh UUID (the user-row lock still serialises them).
     */
    idempotencyKey?: string
    /** Auto-renewal only: re-verify "due for renewal" on the locked row inside the transaction. */
    onlyIfDue?: boolean
}

export interface UpgradeResult {
    success: boolean
    error?: string
    code?: UpgradeFailureCode
    insufficientBalance?: boolean
    currentBalance?: number
    requiredAmount?: number
    newExpiry?: string | null
    newBalance?: number
    /** True when this reference was already settled — nothing was charged this time. */
    alreadyProcessed?: boolean
    wasExtension?: boolean
}

// ── Pure helpers (unit-tested in scripts/test-wallet-upgrade.ts) ─────────────────────────────

export function isPlanValidForType(upgradeType: UpgradeType, plan: unknown): boolean {
    if (typeof plan !== 'string') return false
    return (upgradeType === 'dealer' ? DEALER_PLANS : AGENT_PLANS).includes(plan)
}

/** Keep a well-formed client UUID; replace anything else with a fresh server-generated one. */
export function normalizeIdempotencyKey(raw: unknown): string {
    if (typeof raw === 'string' && UUID_RE.test(raw)) return raw.toLowerCase()
    return randomUUID()
}

/**
 * Consent check: did the user agree to the price the server is about to charge?
 * An omitted value skips the check (non-UI callers); any present-but-wrong value fails.
 */
export function pricesMatch(expected: unknown, actual: number): boolean {
    if (expected === undefined) return true
    if (typeof expected !== 'number' || !Number.isFinite(expected)) return false
    return Math.abs(expected - actual) <= 0.005
}

function toSafePrice(raw: unknown): number | null {
    let n: number
    if (typeof raw === 'number') n = raw
    else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw)
    else return null
    return Number.isFinite(n) && n > 0 && n <= MAX_UPGRADE_PRICE ? n : null
}

const AGENT_PLAN_META: Record<AgentPlan, { key: string; def: number; label: string; days: number | null }> = {
    '3d':        { key: 'agent_upgrade_price_3d',        def: 9.99,   label: '3 Days Agent Pass',    days: 3 },
    '14d':       { key: 'agent_upgrade_price_14d',       def: 49.99,  label: '14 Days Agent Pass',   days: 14 },
    '30d':       { key: 'agent_upgrade_price_30d',       def: 99.99,  label: '30 Days Agent Pass',   days: 30 },
    'permanent': { key: 'agent_upgrade_price_permanent', def: 149.99, label: 'Permanent Agent Pass', days: null },
}

const DEALER_PLAN_META: Record<DealerPlan, { key: string; def: number; label: string; days: number }> = {
    '1m': { key: 'dealer_upgrade_price_1m', def: 99.99,  label: '1 Month Dealer Pass',  days: 30 },
    '3m': { key: 'dealer_upgrade_price_3m', def: 199.99, label: '3 Months Dealer Pass', days: 90 },
    '6m': { key: 'dealer_upgrade_price_6m', def: 299.99, label: '6 Months Dealer Pass', days: 180 },
}

const PRICE_KEYS = [
    ...Object.values(AGENT_PLAN_META).map(m => m.key),
    ...Object.values(DEALER_PLAN_META).map(m => m.key),
]

/**
 * Resolve a plan's price from `admin_settings` rows. A missing row uses the documented default;
 * a present-but-unusable value (NaN, ≤ 0, Infinity, wrong type) THROWS rather than charging it.
 */
export function resolveUpgradePrice(
    settings: Array<{ key: string; value: unknown }> | null | undefined,
    upgradeType: UpgradeType,
    plan: unknown
): { price: number; planLabel: string; planDays: number | null } {
    if (!isPlanValidForType(upgradeType, plan)) {
        throw new UpgradePriceError(`Invalid ${upgradeType} plan`)
    }
    const meta = upgradeType === 'dealer'
        ? DEALER_PLAN_META[plan as DealerPlan]
        : AGENT_PLAN_META[plan as AgentPlan]

    const row = settings?.find(s => s.key === meta.key)
    if (!row) return { price: meta.def, planLabel: meta.label, planDays: meta.days }

    const price = toSafePrice(row.value)
    if (price === null) throw new UpgradePriceError(`Unusable price configured for ${meta.key}`)
    return { price, planLabel: meta.label, planDays: meta.days }
}

/**
 * Add calendar months in UTC, clamping to the last day of the target month — the same result as
 * Postgres `timestamptz + make_interval(months => n)` (Jan 31 + 1 month = Feb 28). JS `setMonth`
 * would overflow into March. Used by the legacy dealer processor so it agrees with the RPC.
 */
export function addMonthsClamped(base: Date, months: number): Date {
    const targetMonthIndex = base.getUTCMonth() + months
    const year = base.getUTCFullYear() + Math.floor(targetMonthIndex / 12)
    const month = ((targetMonthIndex % 12) + 12) % 12
    const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    const out = new Date(base)
    out.setUTCDate(1)
    out.setUTCFullYear(year, month, Math.min(base.getUTCDate(), daysInTarget))
    return out
}

export function planDaysFromType(plan: AgentPlan): number | null {
    return plan in AGENT_PLAN_META ? AGENT_PLAN_META[plan].days : 30
}

export function dealerMonthsFromPlan(plan: DealerPlan): number {
    if (plan === '1m') return 1
    if (plan === '3m') return 3
    return 6
}

// ── RPC wrapper ──────────────────────────────────────────────────────────────────────────────

const FAILURE_MESSAGES: Record<Exclude<UpgradeFailureCode, 'rpc_error'>, string> = {
    insufficient_balance: 'Insufficient wallet balance',
    already_permanent: 'You already have permanent Agent access — no further Agent pass is needed.',
    not_eligible: 'This upgrade is not available for your account.',
    account_inactive: 'Your account is not active. Please contact support.',
    not_due: 'This membership is not due for renewal yet.',
    invalid_request: 'Invalid upgrade request.',
    user_not_found: 'User not found',
    wallet_not_found: 'Wallet not found',
}

/**
 * Run the atomic purchase. Every non-success outcome means NOTHING was charged or changed.
 * Exported separately from processWalletUpgrade so it can be tested with a stub client.
 */
export async function applyWalletUpgrade(
    client: Pick<SupabaseClient, 'rpc'>,
    params: UpgradeParams
): Promise<UpgradeResult> {
    const { userId, upgradeType, plan, price, planLabel, isAutoUpgrade = false, onlyIfDue = false } = params
    const key = params.idempotencyKey ?? randomUUID()

    const { data, error } = await client.rpc('process_wallet_upgrade', {
        p_user_id: userId,
        p_upgrade_type: upgradeType,
        p_plan: plan,
        p_price: price,
        p_plan_label: planLabel,
        p_reference: `upgrade_${upgradeType}_${key}`,
        p_only_if_due: onlyIfDue,
        p_is_auto: isAutoUpgrade,
    })

    if (error || !data || typeof data !== 'object') {
        console.error('[WalletUpgrade] RPC error:', error?.message ?? 'empty response')
        return {
            success: false,
            code: 'rpc_error',
            error: 'Upgrade could not be completed. Please try again — you will not be charged twice.',
        }
    }

    const r = data as Record<string, any>
    const status = String(r.status)

    if (status === 'ok' || status === 'already_processed') {
        return {
            success: true,
            alreadyProcessed: status === 'already_processed',
            newExpiry: r.new_expiry ?? null,
            newBalance: typeof r.new_balance === 'number' ? r.new_balance : undefined,
            wasExtension: Boolean(r.was_extension),
        }
    }

    if (status === 'insufficient_balance') {
        return {
            success: false,
            code: 'insufficient_balance',
            insufficientBalance: true,
            currentBalance: Number(r.current_balance ?? 0),
            requiredAmount: Number(r.required_amount ?? price),
            error: FAILURE_MESSAGES.insufficient_balance,
        }
    }

    if (status in FAILURE_MESSAGES) {
        const code = status as Exclude<UpgradeFailureCode, 'rpc_error'>
        return { success: false, code, error: FAILURE_MESSAGES[code] }
    }

    console.error('[WalletUpgrade] Unrecognised RPC status:', status)
    return { success: false, code: 'rpc_error', error: 'Upgrade could not be completed. Please try again.' }
}

function buildAdminClient(): SupabaseClient {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } }
    )
}

/**
 * Process a wallet-funded role upgrade for a user (atomic purchase + best-effort notifications).
 */
export async function processWalletUpgrade(params: UpgradeParams): Promise<UpgradeResult> {
    const { userId, upgradeType, plan, price, planLabel, isAutoUpgrade = false } = params
    const supabase = buildAdminClient()

    const result = await applyWalletUpgrade(supabase, params)

    // A replay settled earlier: don't re-send notifications.
    if (!result.success || result.alreadyProcessed) return result

    const newExpiry = result.newExpiry ? new Date(result.newExpiry) : null
    const newBalance = result.newBalance ?? 0
    const isPermanent = plan === 'permanent'
    const isExtension = Boolean(result.wasExtension)
    const expiryFormatted = newExpiry
        ? newExpiry.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        : null

    const notifTitle = isPermanent
        ? 'Permanent Agent Unlocked!'
        : isAutoUpgrade
            ? 'Auto-Upgrade Successful'
            : isExtension
                ? `${upgradeType === 'dealer' ? 'Dealer' : 'Agent'} Membership Extended!`
                : `${upgradeType === 'dealer' ? 'Dealer' : 'Agent'} Status Activated!`

    const notifMessage = isPermanent
        ? 'You now have lifetime access to all Agent benefits. Congratulations!'
        : isAutoUpgrade
            ? `Your ${planLabel} was auto-renewed from your wallet. ${expiryFormatted ? `Active until ${expiryFormatted}.` : ''} Balance: GHS ${newBalance.toFixed(2)}.`
            : `Your ${planLabel} is now active${expiryFormatted ? ` until ${expiryFormatted}` : ''}. GHS ${price.toFixed(2)} deducted from wallet.`

    // The money + role are already committed; notification failures must never surface as an
    // upgrade failure.
    const notify = (async () => {
        try {
            await (supabase.from('notifications') as any).insert({
                user_id: userId,
                title: notifTitle,
                message: notifMessage,
                type: 'system',
                action_url: '/dashboard',
            })

            const { data: user } = await supabase
                .from('users')
                .select('email, first_name, phone_number')
                .eq('id', userId)
                .single()
            const u = (user ?? {}) as any

            const { sendPushNotification } = await import('@/lib/push-service')
            await sendPushNotification(userId, {
                title: notifTitle,
                body: notifMessage,
                url: '/dashboard',
            }).catch(() => null)

            const {
                sendAgentUpgradeSuccessSMS,
                sendAgentExtensionSuccessSMS,
                sendPermanentAgentUpgradeSuccessSMS,
                sendDealerActivationSuccessSMS,
                sendDealerExtensionSuccessSMS,
                sendAutoUpgradeSuccessSMS,
            } = await import('@/lib/sms-service')

            const {
                sendPermanentAgentUpgradeSuccessEmail,
                sendDealerActivationSuccessEmail,
                sendDealerExtensionSuccessEmail,
            } = await import('@/lib/email-service')

            if (u.phone_number) {
                if (isAutoUpgrade && newExpiry) {
                    await sendAutoUpgradeSuccessSMS(u.phone_number, u.first_name || 'User', planLabel, newExpiry, newBalance)
                        .catch(() => null)
                } else if (upgradeType === 'dealer' && newExpiry) {
                    if (isExtension) {
                        await sendDealerExtensionSuccessSMS(u.phone_number, newExpiry).catch(() => null)
                    } else {
                        await sendDealerActivationSuccessSMS(u.phone_number, u.first_name || 'Dealer', newExpiry).catch(() => null)
                    }
                } else if (isPermanent) {
                    await sendPermanentAgentUpgradeSuccessSMS(u.phone_number).catch(() => null)
                } else if (newExpiry) {
                    if (isExtension) {
                        await sendAgentExtensionSuccessSMS(u.phone_number, newExpiry).catch(() => null)
                    } else {
                        const remainingDays = Math.ceil((newExpiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                        await sendAgentUpgradeSuccessSMS(u.phone_number, u.first_name || 'Agent', planLabel, remainingDays, newExpiry.toISOString()).catch(() => null)
                    }
                }
            }

            if (u.email) {
                if (isPermanent) {
                    await sendPermanentAgentUpgradeSuccessEmail(u.email, u.first_name || 'User').catch(() => null)
                } else if (upgradeType === 'dealer' && newExpiry) {
                    if (isExtension) {
                        await sendDealerExtensionSuccessEmail(u.email, u.first_name || 'Dealer', newExpiry).catch(() => null)
                    } else {
                        await sendDealerActivationSuccessEmail(u.email, u.first_name || 'Dealer', newExpiry).catch(() => null)
                    }
                }
            }
        } catch (err) {
            console.error('[WalletUpgrade] Notification error:', err)
        }
    })()

    // waitUntil keeps the serverless invocation alive until notifications finish (a bare
    // floating promise can be frozen as soon as the response is sent).
    try {
        waitUntil(notify)
    } catch {
        // Outside a Vercel request context (local/tests) the promise simply runs on its own.
    }

    return result
}

/**
 * Fetch the authoritative upgrade price from `admin_settings`.
 * Throws UpgradePriceError for an invalid plan or an unusable configured value.
 */
export async function fetchUpgradePrice(
    upgradeType: UpgradeType,
    plan: PlanType,
    supabase: SupabaseClient
): Promise<{ price: number; planLabel: string; planDays: number | null }> {
    const { data: settings, error } = await supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', PRICE_KEYS)

    if (error) {
        console.error('[WalletUpgrade] Failed to load upgrade prices:', error.message)
        throw new UpgradePriceError('Upgrade prices are temporarily unavailable')
    }

    return resolveUpgradePrice(settings as any, upgradeType, plan)
}
