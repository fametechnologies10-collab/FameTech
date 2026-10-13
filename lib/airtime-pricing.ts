// lib/airtime-pricing.ts
//
// Single source of truth for airtime limits and fee arithmetic, shared by the
// dashboard route (app/api/airtime/create) and the developer API
// (app/api/v2/airtime/purchase).
//
// ── WHY THIS EXISTS (review finding I6) ────────────────────────────────────
// The v2 airtime route was written as a full second copy of the dashboard's
// pricing block: the same settings-key construction, min/max limits, fee-rate
// defaults and exact/inclusive fee arithmetic, ~80 lines duplicated line for
// line. Two fee tables that must be changed in lockstep forever is exactly the
// shape of drift this codebase has already been bitten by three times (three
// private fulfillment dispatchers) — and the drift had already started here,
// since only one of the two copies carried the ownership-mismatch safety log.
//
// The FALLBACK constants are the dangerous half. A fee change made in the
// admin panel reaches both callers through admin_settings and is fine; a change
// to these defaults applied to one copy and not the other silently underprices
// one surface against the other, with nothing failing loudly.
//
// Deliberately pure: no DB access, no auth. Callers fetch admin_settings (they
// already do, for their own kill-switches) and pass the map in. That keeps this
// unit-testable without mocking Supabase and lets each caller keep its own
// error-response shape — the dashboard returns NextResponse.json, the API
// returns the v2 envelope.

/** Maps a network name to the token used inside admin_settings keys. */
export const AIRTIME_NETWORK_KEY_MAP: Record<string, string> = {
    MTN: 'mtn',
    Telecel: 'telecel',
    AT: 'at',
}

/** Used only when the corresponding admin_settings row is absent or unparseable. */
const MIN_DEFAULT = 1
const MAX_DEFAULTS: Record<string, number> = { customer: 500, agent: 1000, dealer: 2000 }
const FEE_DEFAULTS: Record<string, number> = { customer: 5, agent: 3, dealer: 2 }

export interface AirtimeQuote {
    /** What the beneficiary receives. */
    airtimeAmount: number
    /** Platform fee, already rounded to 2dp. */
    feeAmount: number
    /** What the customer's wallet is debited. */
    totalPaid: number
    /** Percentage fee rate actually applied, for persisting on the order row. */
    feeRate: number
    minAmount: number
    maxAmount: number
}

export type AirtimeQuoteResult =
    | { ok: true; quote: AirtimeQuote }
    | { ok: false; reason: 'invalid_amount' | 'below_min' | 'above_max' | 'too_low_after_fees'; message: string }

/**
 * Rounds a customer-typed amount to whole pesewas, or returns null when the input is not a
 * positive, finite amount with at most 2 decimal places.
 *
 * WHY: `totalPaid = amount` used to be written verbatim. A 3-decimal amount (10.005) was debited
 * from the wallet at one precision and stored on the order at another (both columns are
 * numeric(12,2)), so the wallet debit, the order row and the airtime actually sent could disagree
 * by a pesewa. Rejecting >2dp up front keeps all three identical.
 */
export function normaliseAmount(amount: number): number | null {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null
    const cents = Math.round(amount * 100)
    if (Math.abs(amount * 100 - cents) > 1e-6) return null
    return cents / 100
}

// parseFloat of a missing key yields NaN, which would make every comparison below false and
// silently disable the limit. Fall back explicitly instead.
const num = (raw: string | undefined, fallback: number) => {
    const parsed = parseFloat(raw ?? '')
    return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Min/max for one product + role. A stored value that is negative (min) or non-positive (max)
 * is treated as misconfiguration and replaced by the default rather than honoured.
 */
export function resolveAirtimeLimits(
    settings: Record<string, string>,
    role: string,
    orderType: 'airtime' | 'mashup' = 'airtime',
): { minAmount: number; maxAmount: number } {
    const minDefault = orderType === 'mashup' ? 5 : MIN_DEFAULT
    const maxDefault = MAX_DEFAULTS[role] ?? MAX_DEFAULTS.customer
    let minAmount = num(settings[`${orderType}_min_amount_${role}`], minDefault)
    let maxAmount = num(settings[`${orderType}_max_amount_${role}`], maxDefault)
    if (minAmount < 0) minAmount = minDefault
    if (maxAmount <= 0) maxAmount = maxDefault
    return { minAmount, maxAmount }
}

/**
 * Percentage fee for one product + network + role. Anything outside [0, 100] is a
 * misconfiguration: a NEGATIVE fee would hand the beneficiary more airtime than the customer paid
 * for, so it falls back to the default instead of being applied. A configured 0 is honoured.
 */
export function resolveFeeRate(
    settings: Record<string, string>,
    network: string,
    role: string,
    orderType: 'airtime' | 'mashup' = 'airtime',
): number {
    const networkKey = AIRTIME_NETWORK_KEY_MAP[network]
    const fallback = FEE_DEFAULTS[role] ?? FEE_DEFAULTS.customer
    const rate = num(settings[`${orderType}_fee_${networkKey}_${role}`], fallback)
    return rate >= 0 && rate <= 100 ? rate : fallback
}

/**
 * Resolve limits + fees for one airtime purchase.
 *
 * `role` MUST be the caller's EFFECTIVE role (lib/effective-role.ts), not the
 * raw users.role — a lapsed dealer is priced as a customer everywhere, and
 * passing the raw role here would reintroduce exactly the inconsistency that
 * unification closed.
 *
 * `orderType` exists because the dashboard serves both 'airtime' and 'mashup'
 * from the same settings shape (mashup_min_amount_*, mashup_fee_*). The API
 * only ever passes 'airtime' — mashup is dashboard-only and MTN-only.
 */
export function quoteAirtime(params: {
    settings: Record<string, string>
    network: string
    role: string
    amount: number
    useExactAmount: boolean
    orderType?: 'airtime' | 'mashup'
}): AirtimeQuoteResult {
    const { settings, network, role, useExactAmount } = params
    const orderType = params.orderType ?? 'airtime'

    const amount = normaliseAmount(params.amount)
    if (amount === null) {
        return { ok: false, reason: 'invalid_amount', message: 'Enter a valid amount (at most 2 decimal places)' }
    }

    const { minAmount, maxAmount } = resolveAirtimeLimits(settings, role, orderType)

    if (amount < minAmount) {
        return { ok: false, reason: 'below_min', message: `Minimum airtime amount is GHS ${minAmount.toFixed(2)}` }
    }
    if (amount > maxAmount) {
        return { ok: false, reason: 'above_max', message: `Maximum airtime amount is GHS ${maxAmount.toFixed(2)}` }
    }

    const feeRate = resolveFeeRate(settings, network, role, orderType)

    // Two modes, and the difference is who absorbs the fee:
    //   useExactAmount — the beneficiary receives `amount` exactly and the
    //                    customer pays amount + fee on top.
    //   otherwise      — the customer pays `amount` exactly and the beneficiary
    //                    receives amount - fee.
    let airtimeAmount: number
    let feeAmount: number
    let totalPaid: number
    if (useExactAmount) {
        airtimeAmount = amount
        feeAmount = parseFloat((amount * (feeRate / 100)).toFixed(2))
        totalPaid = parseFloat((amount + feeAmount).toFixed(2))
    } else {
        totalPaid = amount
        feeAmount = parseFloat((amount * (feeRate / 100)).toFixed(2))
        airtimeAmount = parseFloat((amount - feeAmount).toFixed(2))
    }

    if (airtimeAmount <= 0) {
        return { ok: false, reason: 'too_low_after_fees', message: 'Airtime amount after fees is too low' }
    }

    return { ok: true, quote: { airtimeAmount, feeAmount, totalPaid, feeRate, minAmount, maxAmount } }
}

/**
 * Zero-fee variant of quoteAirtime, used ONLY by the developer API's
 * commission-key airtime purchase route (app/api/v2/airtime/purchase). API
 * buyers pay Hubtel's face value exactly -- no markup fee -- because they earn
 * a share of Hubtel's REAL commission instead (see lib/api-auth.ts's
 * credit_airtime_commission RPC call sites). Still enforces the same
 * admin-configurable min/max limits as quoteAirtime (Hubtel's own 100 GHS/
 * request cap is enforced separately in lib/hubtel-commission-service.ts).
 *
 * Deliberately NOT a mode flag on quoteAirtime -- that function's fee
 * arithmetic stays exactly as the dashboard/shop need it; this is a distinct,
 * separately testable zero-fee code path.
 */
export function quoteAirtimeCommission(params: {
    settings: Record<string, string>
    network: string
    role: string
    amount: number
}): AirtimeQuoteResult {
    const { settings, role } = params

    const amount = normaliseAmount(params.amount)
    if (amount === null) {
        return { ok: false, reason: 'invalid_amount', message: 'amount must be a positive number with at most 2 decimal places' }
    }

    const { minAmount, maxAmount } = resolveAirtimeLimits(settings, role, 'airtime')

    if (amount < minAmount) {
        return { ok: false, reason: 'below_min', message: `Minimum airtime amount is GHS ${minAmount.toFixed(2)}` }
    }
    if (amount > maxAmount) {
        return { ok: false, reason: 'above_max', message: `Maximum airtime amount is GHS ${maxAmount.toFixed(2)}` }
    }

    return {
        ok: true,
        quote: {
            airtimeAmount: amount,
            feeAmount: 0,
            totalPaid: amount,
            feeRate: 0,
            minAmount,
            maxAmount,
        },
    }
}

// ── Admin settings validation ───────────────────────────────────────────────
//
// app/api/admin/airtime/settings used to upsert any string for any whitelisted key. A fee of -50
// or a max of 0 was stored as-is and (before resolveFeeRate/resolveAirtimeLimits clamped it) priced
// orders at a loss. Validate at the write boundary so bad values never reach admin_settings, and
// keep the clamp in the resolvers as the second line of defence.

const FEE_KEY = /^(airtime|mashup)_fee_(mtn|telecel|at)_(customer|agent|dealer)$/
const MIN_KEY = /^(airtime|mashup)_min_amount_(customer|agent|dealer)$/
const MAX_KEY = /^(airtime|mashup)_max_amount_(customer|agent|dealer)$/
const TOGGLE_KEYS = new Set([
    'airtime_enabled_mtn', 'airtime_enabled_telecel', 'airtime_enabled_at',
    'mashup_enabled_mtn', 'mashup_enabled_telecel', 'mashup_enabled_at',
    'dashboard_airtime_enabled', 'dashboard_mashup_enabled',
    'storefront_airtime_enabled', 'storefront_mashup_enabled',
    'airtime_auto_fulfillment_enabled', 'hubtel_commission_paused',
])
const NETWORK_FLAG_KEY = 'hubtel_airtime_networks'
const AMOUNT_CEILING = 100000

/** True for keys that change what customers are charged (fees and min/max limits). */
export function isAirtimePriceKey(key: string): boolean {
    return FEE_KEY.test(key) || MIN_KEY.test(key) || MAX_KEY.test(key)
}

export type AirtimeSettingsValidation =
    | { ok: true; values: Record<string, string> }
    | { ok: false; errors: string[] }

/**
 * Validates + normalises an admin settings payload (already filtered to known keys).
 * Blank strings are skipped (never written), so an untouched empty field in the admin form cannot
 * fail an unrelated save or overwrite a stored value.
 */
export function validateAirtimeSettings(input: Record<string, unknown>): AirtimeSettingsValidation {
    const values: Record<string, string> = {}
    const errors: string[] = []

    for (const [key, raw] of Object.entries(input)) {
        if (raw === null || raw === undefined) continue
        if (typeof raw === 'string' && raw.trim() === '') continue

        if (FEE_KEY.test(key)) {
            const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
            if (!Number.isFinite(n) || n < 0 || n >= 100) { errors.push(`${key}: must be a number from 0 to under 100`); continue }
            values[key] = String(n)
        } else if (MIN_KEY.test(key) || MAX_KEY.test(key)) {
            const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
            const isMax = MAX_KEY.test(key)
            if (!Number.isFinite(n) || n > AMOUNT_CEILING || (isMax ? n <= 0 : n < 0)) {
                errors.push(`${key}: must be ${isMax ? 'greater than 0' : '0 or more'} and at most ${AMOUNT_CEILING}`)
                continue
            }
            values[key] = String(n)
        } else if (TOGGLE_KEYS.has(key)) {
            const v = typeof raw === 'boolean' ? String(raw) : String(raw).trim().toLowerCase()
            if (v !== 'true' && v !== 'false') { errors.push(`${key}: must be true or false`); continue }
            values[key] = v
        } else if (key === NETWORK_FLAG_KEY) {
            let obj: unknown = raw
            if (typeof raw === 'string') {
                try { obj = JSON.parse(raw) } catch { errors.push(`${key}: must be valid JSON`); continue }
            }
            const ok = !!obj && typeof obj === 'object' && !Array.isArray(obj)
                && Object.entries(obj as Record<string, unknown>).every(([k, v]) => AIRTIME_NETWORK_KEY_MAP[k] !== undefined && typeof v === 'boolean')
            if (!ok) { errors.push(`${key}: must map MTN / Telecel / AT to true or false`); continue }
            values[key] = JSON.stringify(obj)
        } else {
            errors.push(`${key}: unknown setting`)
        }
    }

    // A min above its own max would make every order for that role impossible.
    for (const key of Object.keys(values)) {
        const m = /^(airtime|mashup)_min_amount_(customer|agent|dealer)$/.exec(key)
        if (!m) continue
        const maxKey = `${m[1]}_max_amount_${m[2]}`
        if (maxKey in values && Number(values[key]) > Number(values[maxKey])) {
            errors.push(`${key}: minimum cannot exceed ${maxKey}`)
        }
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true, values }
}
