// Pure helpers for Standard Bundles (KingFlexyGH-fulfilled). No I/O.

export type BundleKind = 'standard' | 'special' | 'broadband'
type BundleNetwork = 'MTN' | 'Telecel' | 'AT'

export interface CatalogBundle {
    value: string | null
    pack_id: string | null
    amount: number
    price: number
    size: string
    family: string
    family_label: string
    network: BundleNetwork
}

const MIN_PRICE = 0.01
const MAX_DISCOUNT_PCT = 50

function asRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function finiteNumber(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    return null
}

function nonEmptyString(v: unknown): string | null {
    if (typeof v === 'string' && v.trim().length > 0) return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return null
}

export function parseCatalog(
    network: BundleNetwork,
    body: unknown,
): { bundles: CatalogBundle[]; enabled: boolean; broadband: { enabled: boolean; min: number; max: number } | null } {
    const data = asRecord(asRecord(body).data)
    const bundles: CatalogBundle[] = []
    if (Array.isArray(data.bundles)) {
        for (const row of data.bundles) {
            const r = asRecord(row)
            const amount = finiteNumber(r.amount)
            const price = finiteNumber(r.price)
            if (amount === null || amount <= 0 || price === null || price <= 0) continue
            const value = nonEmptyString(r.value)
            const pack_id = nonEmptyString(r.pack_id)
            if (value === null && pack_id === null) continue
            bundles.push({
                value,
                pack_id,
                amount,
                price,
                size: typeof r.size === 'string' ? r.size : '',
                family: typeof r.family === 'string' ? r.family : '',
                family_label: typeof r.family_label === 'string' ? r.family_label : '',
                network,
            })
        }
    }

    let broadband: { enabled: boolean; min: number; max: number } | null = null
    const bb = asRecord(data.broadband)
    const min = finiteNumber(bb.min_amount)
    const max = finiteNumber(bb.max_amount)
    if (min !== null && max !== null && min > 0 && max >= min) {
        broadband = { enabled: bb.enabled === true, min, max }
    }

    return { bundles, enabled: data.enabled === true, broadband }
}

export function findBundle(
    bundles: CatalogBundle[],
    sel: { value?: string; pack_id?: string },
): CatalogBundle | null {
    // A Special pack_id that vanished must resolve to "not found", never fall back to a standard value.
    if (sel.pack_id) return bundles.find((b) => b.pack_id === sel.pack_id) ?? null
    if (sel.value) return bundles.find((b) => b.value === sel.value) ?? null
    return null
}

export function parseDiscountSetting(raw: unknown): number {
    const n = finiteNumber(raw)
    if (n === null) return 0
    return Math.min(MAX_DISCOUNT_PCT, Math.max(0, n))
}

export function applyDiscount(price: number, discountPct: number, kind: BundleKind): number {
    if (!Number.isFinite(price)) return MIN_PRICE
    const pct = kind === 'broadband' ? 0 : parseDiscountSetting(discountPct)
    const discounted = Math.round((price * (1 - pct / 100) + Number.EPSILON) * 100) / 100
    return Math.max(MIN_PRICE, discounted)
}

const IDEMPOTENCY_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidIdempotencyKey(k: unknown): boolean {
    return typeof k === 'string' && IDEMPOTENCY_KEY_RE.test(k)
}

export function referenceFromKey(key: string): string {
    return `GHD-${key.replace(/-/g, '').slice(0, 20).toUpperCase()}`
}

export function isValidBeneficiary(kind: BundleKind, phone: string): boolean {
    void kind
    return /^0\d{9}$/.test(phone)
}

export type BundlePurchaseOutcome =
    | 'accepted'
    | 'duplicate'
    | 'definitive_reject'
    | 'insufficient_balance'
    | 'in_flight'
    | 'unavailable'
    | 'rate_limited'
    | 'config_error'
    | 'transient'

export function classifyBundlePurchase(httpStatus: number, body: unknown): BundlePurchaseOutcome {
    const b = asRecord(body)
    if (httpStatus >= 200 && httpStatus < 300) {
        if (b.success !== true) return 'transient'
        return asRecord(b.data).is_duplicate === true ? 'duplicate' : 'accepted'
    }
    if (httpStatus === 401 || httpStatus === 403) return 'config_error'
    if (httpStatus === 409) return 'in_flight'
    if (httpStatus === 429) return 'rate_limited'
    if (httpStatus === 503) return 'unavailable'
    if (httpStatus === 400) {
        const msg = String(b.error ?? b.message ?? '')
        return /insufficient/i.test(msg) ? 'insufficient_balance' : 'definitive_reject'
    }
    if (httpStatus === 404) return 'definitive_reject'
    if (httpStatus >= 400 && httpStatus < 500) return 'definitive_reject'
    return 'transient'
}

export function mapKfBundleStatus(s: unknown): 'pending' | 'processing' | 'completed' | 'failed' {
    if (s === 'completed') return 'completed'
    if (s === 'failed' || s === 'refunded') return 'failed'
    if (s === 'processing') return 'processing'
    return 'pending'
}

export function decideBundleWebhook(payload: unknown): {
    action: 'completed' | 'failed' | 'ignore'
    reference?: string
    previouslyRefunded?: boolean
} {
    const p = asRecord(payload)
    if (p.product !== 'bundles') return { action: 'ignore' }
    if (typeof p.reference !== 'string' || p.reference.length === 0) return { action: 'ignore' }
    const state = mapKfBundleStatus(p.status)
    if (state !== 'completed' && state !== 'failed') return { action: 'ignore' }
    return {
        action: state,
        reference: p.reference,
        previouslyRefunded: asRecord(p.detail).previously_refunded === true,
    }
}

export function decideDispatchAction(
    outcome: BundlePurchaseOutcome,
): 'finalize_failed' | 'revert_pending' | 'stay_processing' | 'accepted' {
    switch (outcome) {
        case 'accepted':
        case 'duplicate':
            return 'accepted'
        case 'definitive_reject':
            return 'finalize_failed'
        case 'in_flight':
            return 'stay_processing'
        default:
            return 'revert_pending'
    }
}

// Kill switches are stored as JSONB strings ('"true"'/'"false"'); only an explicit false disables.
export function isBundleFlagEnabled(v: unknown): boolean {
    return !(v === false || v === 'false')
}

export function bundleKillSwitchKeys(network: string, kind: BundleKind): string[] {
    const suffix = kind === 'broadband' ? 'broadband' : network.toLowerCase()
    return ['std_bundles_enabled', `std_bundles_enabled_${suffix}`]
}

const ALERT_THROTTLE_MS = 60 * 60 * 1000

// At most one admin alert per hour per outcome, tracked in fulfillment_metadata.
export function decideAlertThrottle(
    meta: Record<string, unknown> | null | undefined,
    outcome: string,
    nowMs: number,
): { send: boolean; meta: Record<string, unknown> } {
    const base = meta ?? {}
    const last = typeof base.last_alert_at === 'string' ? Date.parse(base.last_alert_at) : NaN
    const age = nowMs - last
    const suppressed = base.last_alert_outcome === outcome && Number.isFinite(age) && age >= 0 && age < ALERT_THROTTLE_MS
    if (suppressed) return { send: false, meta: base }
    return {
        send: true,
        meta: { ...base, last_alert_at: new Date(nowMs).toISOString(), last_alert_outcome: outcome },
    }
}

export const BUNDLE_FAILURE_CUSTOMER_MESSAGE = "We couldn't deliver your bundle. Your wallet has been refunded."

// True when dispatch retries are exhausted and nobody has been told yet.
export function shouldAlertExhausted(
    attempts: number,
    maxAttempts: number,
    meta: Record<string, unknown> | null | undefined,
): boolean {
    return attempts >= maxAttempts && !(meta && meta.exhausted_at)
}

// ---------------------------------------------------------------------------
// Purchase-route helpers
// ---------------------------------------------------------------------------

export type StoredBundleNetwork = 'MTN' | 'Telecel' | 'AT' | 'TelecelBroadband'

// Value stored in standard_bundle_orders.network. Broadband is Telecel-only and is always stored
// as 'TelecelBroadband'; the UI may send either 'Telecel' or 'TelecelBroadband' for it.
export function normalizeBundleNetwork(kind: unknown, network: unknown): StoredBundleNetwork | null {
    if (kind === 'broadband') {
        return network === 'Telecel' || network === 'TelecelBroadband' ? 'TelecelBroadband' : null
    }
    if (kind !== 'standard' && kind !== 'special') return null
    return network === 'MTN' || network === 'Telecel' || network === 'AT' ? network : null
}

// Returns the validated amount (finite, 2dp max, within [min,max]) or null.
export function validateBroadbandAmount(amount: unknown, min: number, max: number): number | null {
    let n: number
    if (typeof amount === 'number') n = amount
    else if (typeof amount === 'string' && amount.trim() !== '') n = Number(amount.trim())
    else return null
    if (!Number.isFinite(n)) return null
    if (Math.abs(Math.round(n * 100) / 100 - n) > 1e-9) return null
    if (n < min || n > max) return null
    return n
}

// Server-side customer price, or null when it would fall below the minimum chargeable amount.
export function computeBundlePrice(args: {
    catalogPrice: number
    discountSetting: unknown
    kind: BundleKind
}): number | null {
    if (!Number.isFinite(args.catalogPrice) || args.catalogPrice < MIN_PRICE) return null
    const price = applyDiscount(args.catalogPrice, parseDiscountSetting(args.discountSetting), args.kind)
    return price >= MIN_PRICE ? price : null
}

// Decides whether a catalog row may be bought as `kind`, and the price base to charge from.
// Standard orders send `amount` to the supplier while the customer is charged from `price`, so a
// standard row whose amount and price diverge fails closed. A row carrying a pack_id is a Special
// Bundle and can only be bought as 'special'.
export function resolveBundleForPurchase(
    kind: 'standard' | 'special',
    bundle: CatalogBundle,
): { ok: true; catalogPrice: number } | { ok: false } {
    if (kind === 'special') {
        return bundle.pack_id ? { ok: true, catalogPrice: bundle.price } : { ok: false }
    }
    if (!bundle.value || bundle.pack_id !== null) return { ok: false }
    if (Math.abs(bundle.amount - bundle.price) > 0.005) return { ok: false }
    return { ok: true, catalogPrice: bundle.price }
}

// Client-side: after a NON-ok purchase response, may the attempt's idempotency key be dropped?
// Only when the server definitively answered (parseable JSON body, status 400/401/403/404/503):
// those paths never leave a debit behind. 5xx other than 503, 408/409/429 and any unparseable
// body (e.g. a gateway HTML 504) are ambiguous: the order may exist, so the key must be kept.
// A 2xx response is handled by the success path and is not classified here.
export function isDefinitiveOutcome(status: number, bodyParsed: boolean): boolean {
    if (!bodyParsed) return false
    return status === 400 || status === 401 || status === 403 || status === 404 || status === 503
}

// Client-side: is a 2xx purchase body complete enough to show as a success? Anything else (missing
// data/order, no reference_code) is ambiguous and must keep the idempotency key.
export function isValidPurchaseSuccess(json: unknown): boolean {
    const j = json as any
    return !!j && j.success === true && !!j.data && typeof j.data.order === 'object' && j.data.order !== null && !Array.isArray(j.data.order)
        && typeof j.data.order.reference_code === 'string' && j.data.order.reference_code.length > 0
}

// Client-side idempotency-key lifecycle for one purchase response. 'clear' (start a fresh attempt
// next time) only for a valid success or a definitive non-ok answer; everything else keeps the key.
export function decideAttemptKeyAction(input: { ok: boolean; status: number; bodyParsed: boolean; validSuccess: boolean }): 'clear' | 'keep' {
    if (input.ok) return input.validSuccess ? 'clear' : 'keep'
    return isDefinitiveOutcome(input.status, input.bodyParsed) ? 'clear' : 'keep'
}
