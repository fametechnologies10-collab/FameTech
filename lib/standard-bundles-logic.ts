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
    if (sel.pack_id) {
        const byPack = bundles.find((b) => b.pack_id === sel.pack_id)
        if (byPack) return byPack
    }
    if (sel.value) {
        const byValue = bundles.find((b) => b.value === sel.value)
        if (byValue) return byValue
    }
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
