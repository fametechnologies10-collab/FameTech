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
    | { ok: false; reason: 'below_min' | 'above_max' | 'too_low_after_fees'; message: string }

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
    const { settings, network, role, amount, useExactAmount } = params
    const orderType = params.orderType ?? 'airtime'
    const networkKey = AIRTIME_NETWORK_KEY_MAP[network]

    // parseFloat of a missing key yields NaN, which would make every comparison
    // below false and silently disable the limit. Fall back explicitly instead.
    const num = (raw: string | undefined, fallback: number) => {
        const parsed = parseFloat(raw ?? '')
        return Number.isFinite(parsed) ? parsed : fallback
    }

    const minAmount = num(settings[`${orderType}_min_amount_${role}`], orderType === 'mashup' ? 5 : MIN_DEFAULT)
    const maxAmount = num(settings[`${orderType}_max_amount_${role}`], MAX_DEFAULTS[role] ?? MAX_DEFAULTS.customer)

    if (amount < minAmount) {
        return { ok: false, reason: 'below_min', message: `Minimum airtime amount is GHS ${minAmount.toFixed(2)}` }
    }
    if (amount > maxAmount) {
        return { ok: false, reason: 'above_max', message: `Maximum airtime amount is GHS ${maxAmount.toFixed(2)}` }
    }

    const feeRate = num(
        settings[`${orderType}_fee_${networkKey}_${role}`],
        FEE_DEFAULTS[role] ?? FEE_DEFAULTS.customer
    )

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
    const { settings, role, amount } = params

    const num = (raw: string | undefined, fallback: number) => {
        const parsed = parseFloat(raw ?? '')
        return Number.isFinite(parsed) ? parsed : fallback
    }

    const minAmount = num(settings[`airtime_min_amount_${role}`], MIN_DEFAULT)
    const maxAmount = num(settings[`airtime_max_amount_${role}`], MAX_DEFAULTS[role] ?? MAX_DEFAULTS.customer)

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
