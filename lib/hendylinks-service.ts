// HendyLinks Fulfillment Service. See
// docs/superpowers/specs/2026-08-19-hendylinks-supplier-design.md for the full design.
//
// Structural differences from every other supplier in this codebase:
//  - No idempotency key on order placement — POST /api/orders accepts no client-supplied
//    reference. fulfillOrder therefore does NOT retry on transport failure; instead it
//    reconciles via GET /api/orders (see findRecentMatchingOrder below).
//  - Has webhooks (HMAC-SHA256) — completion is resolved primarily via
//    app/api/webhooks/hendylinks/route.ts, not by polling. fetchOrderHistory here is used
//    only for (a) the transport-failure reconciliation lookup, and (b) the safety-net
//    reconciliation sweep in app/api/cron/sync-hendylinks-status/route.ts.
//  - No bundle/plan-ID catalog — always dispatches via `network` + `size_gb`.

import type { OrderToFulfill, BulkOrderResult } from '@/lib/fulfillment-service'

const HENDYLINKS_API_KEY = process.env.HENDYLINKS_API_KEY || ''
const HENDYLINKS_API_BASE_URL = process.env.HENDYLINKS_API_BASE_URL || 'https://hendylinks.net'

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60000 // 1 minute

function checkCircuit(): boolean {
    if (circuitState === 'closed') return true
    if (circuitState === 'open') {
        const now = Date.now()
        if (lastFailureTime && now - lastFailureTime > RECOVERY_TIMEOUT) {
            circuitState = 'half-open'
            return true
        }
        return false
    }
    return true // half-open allows one probe
}

function recordSuccess() {
    failureCount = 0
    circuitState = 'closed'
}

function recordFailure() {
    failureCount++
    lastFailureTime = Date.now()
    if (failureCount >= FAILURE_THRESHOLD) {
        circuitState = 'open'
        console.log('[HendyLinks] Circuit breaker OPENED')
    }
}

// ─── Interfaces ───────────────────────────────────────────────────────────────
export interface FulfillmentResponse {
    success: boolean
    reference?: string
    transactionId?: string
    error?: string
    apiResponse?: any
    isRateLimited?: boolean
    // Set ONLY when the placement's outcome is genuinely UNKNOWN or known-accepted-but-
    // untrackable: a transport failure that reconciliation could not resolve, a 2xx response
    // that doesn't parse as a clear success, or an accepted order returned without an
    // order_id. HendyLinks exposes NO idempotency key, so callers must NOT treat these the
    // same as a definite rejection — reverting them to 'pending' lets the next cron run
    // re-dispatch and pay + deliver a second time. lib/refulfillment-service.ts's step 11
    // reads this (duck-typed off BulkOrderResult) and leaves ambiguous orders in 'processing'
    // with an admin alert instead. Mirrors lib/agentportal-service.ts's BulkOrderResult.ambiguous.
    ambiguous?: boolean
}

export interface HendyLinksOrder {
    id: number
    status: string
    // THE FIELD IS `recipient_msisdn` — verified against the live GET /api/orders response
    // 2026-08-20. `recipient_phone` was assumed from the design spec, never existed, and made
    // matchesRecentOrder() below compare against `undefined` on every row — so the whole
    // post-transport-failure reconciliation path silently never matched anything. Both names
    // are declared and read so a rename on their side cannot re-break it.
    recipient_msisdn?: string
    recipient_phone?: string
    size_mb?: number
    network?: string
    created_at?: string
    // Their human-readable outcome ("Order processed successfully" / "API request failed" /
    // "Order is processing"). Recorded into mtn_fulfillment_tracking.api_response — an
    // ADMIN-ONLY table — by the webhook and both reconciliation sweeps.
    // NEVER write this into orders.error_message: that column is customer-facing and is
    // rendered to the buyer as "Failure Reason" by components/dashboard/RecentOrdersWidget.tsx,
    // so raw supplier text (or anything naming HendyLinks or their upstream provider) must not
    // reach it.
    message?: string
    [key: string]: unknown
}

/**
 * The recipient phone on a history row. Reads the real field first, falling back to the
 * name the original implementation assumed — see the interface comment above.
 */
export function historyOrderPhone(historyOrder: HendyLinksOrder): string | undefined {
    const v = historyOrder.recipient_msisdn ?? historyOrder.recipient_phone
    return typeof v === 'string' ? v : undefined
}

/**
 * Classifies an HTTP status from HendyLinks as a business rejection (they answered
 * correctly, they just declined) vs a genuine integration/system failure. Business
 * rejections must never trip the circuit breaker.
 * 400 = bad params we sent, 401 = bad/missing API key (config problem, not instability),
 * 402 = their wallet is empty, 403 = recipient is not a verified beneficiary,
 * 404 = plan/size not sold. Only 500 is a real instability signal — 429 is handled
 * separately as a rate-limit case, not via this function.
 *
 * 403 was MISSING here until 2026-08-20 and was the most damaging omission of the set:
 * an unverified recipient is an ordinary, frequent, per-order business outcome (it is the
 * exact case the MTN fallback exists for), but being unlisted meant every one of them
 * counted as an instability failure. Five unverified numbers in a row therefore OPENED the
 * breaker and fast-failed every subsequent HendyLinks order — including perfectly valid
 * ones for verified numbers — turning a routine per-order rejection into a supplier-wide
 * self-inflicted outage. Confirmed against a live rejection:
 * "HTTP 403 — Recipient phone number is not a verified beneficiary in our system".
 */
export function isBusinessRejection(httpStatus: number): boolean {
    return httpStatus === 400 || httpStatus === 401 || httpStatus === 402
        || httpStatus === 403 || httpStatus === 404
}

/**
 * Maps our internal network name to HendyLinks'. AT-iShare and AT-BigTime both map to
 * "AirtelTigo" — HendyLinks has no iShare/BigTime split, so isValidAtSizeForNetwork (below)
 * is what actually keeps them apart, by size.
 */
export function resolveHendyLinksNetwork(network: string): 'MTN' | 'Telecel' | 'AirtelTigo' | null {
    if (network === 'MTN') return 'MTN'
    if (network === 'Telecel') return 'Telecel'
    if (network === 'AT-iShare') return 'AirtelTigo'
    if (network === 'AT-BigTime') return 'AirtelTigo'
    return null
}

/**
 * AT-iShare and AT-BigTime collapse to the same "AirtelTigo" network string on the wire —
 * size is the ONLY thing that keeps them apart. Per the user's confirmed catalog
 * configuration: AT-iShare sells 1-15GB, AT-BigTime sells 25-50GB (disjoint, no overlap).
 * This is a real validation gate, not documentation — it is the only thing preventing an
 * AT-BigTime order from silently being dispatched as if it were AT-iShare (or vice versa)
 * once both collapse to the same wire value.
 */
export function isValidAtSizeForNetwork(network: string, sizeGb: number): boolean {
    if (network === 'AT-iShare') return sizeGb >= 1 && sizeGb <= 15
    if (network === 'AT-BigTime') return sizeGb >= 25 && sizeGb <= 50
    return true // not an AT network — no range restriction here
}

/**
 * Normalizes a phone number to HendyLinks' documented accepted forms: strips a leading
 * '+', converts a '233' country-code prefix to a leading '0', adds a '0' to a bare 9-digit
 * number. Matches their docs' "0241234567 / 241234567 / 233241234567 accepted, +233... not"
 * table.
 */
export function normalizeHendyLinksPhone(phoneNumber: string): string {
    let normalized = phoneNumber.replace(/^\+/, '')
    if (normalized.startsWith('233')) normalized = '0' + normalized.slice(3)
    else if (!normalized.startsWith('0')) normalized = '0' + normalized
    return normalized
}

async function callHendyLinks(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>
): Promise<{ httpStatus: number; data: any }> {
    const url = new URL(path, HENDYLINKS_API_BASE_URL)
    const response = await fetch(url.toString(), {
        method,
        headers: {
            'X-API-KEY': HENDYLINKS_API_KEY,
            'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    })

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
        const rawText = await response.text()
        console.error(`[HendyLinks] Non-JSON response (HTTP ${response.status}) for ${method} ${path}:`, rawText.slice(0, 300))
        throw new Error(`HendyLinks returned an unexpected response format (HTTP ${response.status})`)
    }

    const data = await response.json()
    return { httpStatus: response.status, data }
}

// Reconciliation lookback window for the post-transport-failure order-history scan.
export const RECONCILE_WINDOW_MS = 5 * 60 * 1000

/**
 * Parses a HendyLinks timestamp to epoch ms, treating a zone-less value as UTC.
 *
 * Their history rows carry `created_at` as "2026-08-20 20:23:45" — space-separated with NO
 * timezone. A bare `new Date(that)` resolves it against the PROCESS's local timezone, not UTC.
 * That is not academic: on a host running TZ=America/New_York the same string parses four
 * hours later than the true instant, which trivially satisfies the RECONCILE_WINDOW_MS
 * freshness check no matter how old the order really is — silently widening a 5-minute window
 * to an unbounded one. Since that window is what stops matchesRecentOrder from adopting an
 * unrelated older order (and with it a supplier order id we would then treat as this order's),
 * getting it wrong is a wrong-adoption / double-charge risk, not a cosmetic one.
 *
 * Today this is masked only by the coincidence that Vercel defaults to TZ=UTC and Ghana is
 * also UTC+0. Nothing in the repo pins TZ, so the masking is luck, not design.
 *
 * Values that already carry an explicit zone (trailing Z, or a ±HH:MM offset) are parsed
 * verbatim — that covers ISO strings from our own code and any future change on their side.
 */
export function parseHendyLinksTimestamp(value: unknown): number {
    if (typeof value !== 'string') return NaN
    const s = value.trim()
    if (!s) return NaN
    if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s)
    return Date.parse(`${s.includes('T') ? s : s.replace(' ', 'T')}Z`)
}

/**
 * The reconciliation MATCH PREDICATE — pure, so it is testable without mocking fetch, and so
 * there is exactly one implementation of the rule.
 *
 * True when `historyOrder` could be the order we just tried to place: same normalized
 * recipient phone, same size in MB, created inside RECONCILE_WINDOW_MS of `nowMs`, and — when
 * the history row actually exposes a network — the same network.
 *
 * The network check is an ADDITIONAL discriminator only. HendyLinks' order-history schema
 * does not contractually guarantee the field, and treating a missing/blank `network` as a
 * mismatch would weaken the match into "no candidates" and lose a real reconciliation, so an
 * absent value is deliberately permissive. No pre-existing condition is relaxed by it.
 */
export function matchesRecentOrder(
    historyOrder: HendyLinksOrder,
    normalizedPhone: string,
    sizeMb: number,
    nowMs: number,
    expectedNetwork?: string | null
): boolean {
    // Reads recipient_msisdn (the real field) with a recipient_phone fallback. Comparing
    // historyOrder.recipient_phone directly — as this did until 2026-08-20 — meant comparing
    // `undefined` on every row, so this predicate could only ever return false and the entire
    // reconciliation path was dead. See historyOrderPhone / the HendyLinksOrder interface.
    if (historyOrderPhone(historyOrder) !== normalizedPhone) return false
    if (historyOrder.size_mb !== sizeMb) return false
    if (expectedNetwork && typeof historyOrder.network === 'string' && historyOrder.network.length > 0) {
        if (historyOrder.network.toLowerCase() !== expectedNetwork.toLowerCase()) return false
    }
    if (!historyOrder.created_at) return false
    // parseHendyLinksTimestamp, NOT new Date(): their created_at carries no timezone, and the
    // ambient-TZ interpretation a bare Date() applies can shift it by hours and defeat this
    // freshness check entirely. See that function's comment.
    const createdMs = parseHendyLinksTimestamp(historyOrder.created_at)
    return !Number.isNaN(createdMs) && createdMs >= nowMs - RECONCILE_WINDOW_MS
}

/**
 * The reconciliation DECISION — pure, given an already-fetched history page.
 *
 * FAILS CLOSED on ambiguity. Exactly one candidate → adopt it. Zero OR two-or-more → null,
 * which the caller reports as an unreconciled (therefore `ambiguous: true`) failure.
 *
 * Two-or-more is not hypothetical in this business: topping the same beneficiary twice, or a
 * dealer batching identical restocks, routinely produces two legitimate orders to the same
 * number for the same size inside the window. Taking the FIRST (the previous behaviour) let a
 * second local order adopt the FIRST order's HendyLinks id — customer charged, nothing
 * delivered, logged as a success, and two local rows sharing one hendylinks_order_id, which
 * then poisons the webhook and both reconciliation sweeps. We cannot safely tell them apart,
 * so we adopt NEITHER and escalate.
 */
export function selectReconciliationMatch(
    historyOrders: HendyLinksOrder[],
    normalizedPhone: string,
    sizeMb: number,
    nowMs: number,
    expectedNetwork?: string | null
): HendyLinksOrder | null {
    const candidates = historyOrders.filter(o =>
        matchesRecentOrder(o, normalizedPhone, sizeMb, nowMs, expectedNetwork)
    )

    if (candidates.length === 1) return candidates[0]

    if (candidates.length > 1) {
        console.error(
            `[HendyLinks] AMBIGUOUS-RECONCILIATION: ${candidates.length} recent history orders match ` +
            `phone=${normalizedPhone} size_mb=${sizeMb} network=${expectedNetwork ?? 'n/a'} within the ` +
            `${RECONCILE_WINDOW_MS / 60000}-minute window (HendyLinks order ids: ${candidates.map(c => c.id).join(', ')}). ` +
            `Two orders could not be safely told apart — adopting NONE, reporting an ambiguous failure. ` +
            `MANUAL RECONCILIATION REQUIRED.`
        )
    }

    return null
}

/**
 * Fetches recent order history and applies selectReconciliationMatch to it. Used ONLY after a
 * transport failure on POST /api/orders where we don't know if the order actually landed.
 * Returns null if no single unambiguous match is found (or the lookup itself fails) — callers
 * treat that as "could not confirm, report an ambiguous failure."
 */
async function findRecentMatchingOrder(
    normalizedPhone: string,
    sizeMb: number,
    expectedNetwork?: string | null
): Promise<HendyLinksOrder | null> {
    try {
        const { httpStatus, data } = await callHendyLinks('GET', '/api/orders?limit=20&offset=0')
        if (httpStatus !== 200 || data?.success === false || !Array.isArray(data?.orders)) return null

        return selectReconciliationMatch(data.orders as HendyLinksOrder[], normalizedPhone, sizeMb, Date.now(), expectedNetwork)
    } catch (err: any) {
        console.error('[HendyLinks] findRecentMatchingOrder failed:', err.message)
        return null
    }
}

/**
 * The placement-response CLASSIFIER — pure, so it is testable without mocking fetch, and so
 * there is exactly one implementation of the rule.
 *
 * - `success`  — HendyLinks confirmed acceptance AND gave us a trackable order_id.
 * - `ambiguous` — HendyLinks has (or may have) accepted and CHARGED the order, but we cannot
 *   track it. Never retry-eligible: there is no idempotency key, so a retry pays twice. Covers
 *   (a) success:true with no order_id, and (b) ANY other 2xx that doesn't parse as a clear
 *   success — a 2xx is not a rejection, so it must not fall into the plain-rejection branch.
 * - `rate_limited` — HTTP 429. Undocumented (HendyLinks advertises no rate limits) but handled
 *   defensively. Definitely NOT accepted, so safely retryable. Never trips the breaker.
 * - `rejection` — a definite non-2xx decline. `tripsBreaker` is false for business rejections
 *   (400/401/402/404 — they answered correctly, they just declined) and true for real
 *   instability signals such as 500.
 */
export type PlacementDecision =
    | { outcome: 'success'; orderId: string }
    | { outcome: 'ambiguous'; reason: string }
    | { outcome: 'rate_limited' }
    | { outcome: 'rejection'; tripsBreaker: boolean }

export function classifyPlacementResponse(httpStatus: number, data: any): PlacementDecision {
    if (data?.success === true) {
        const hlOrderId = data.order_id
        if (hlOrderId === undefined || hlOrderId === null) {
            return { outcome: 'ambiguous', reason: 'HendyLinks accepted the order but returned no order_id' }
        }
        return { outcome: 'success', orderId: String(hlOrderId) }
    }

    if (httpStatus === 429) return { outcome: 'rate_limited' }

    if (httpStatus >= 200 && httpStatus < 300) {
        return {
            outcome: 'ambiguous',
            reason: `HendyLinks returned HTTP ${httpStatus} without a clear success flag — the order may already have been accepted and charged`,
        }
    }

    return { outcome: 'rejection', tripsBreaker: !isBusinessRejection(httpStatus) }
}

// ─── Main Fulfillment Function ─────────────────────────────────────────────────
export async function fulfillOrder(
    network: string,
    phoneNumber: string,
    dataSize: string,
    orderId: string
): Promise<FulfillmentResponse> {
    if (!checkCircuit()) {
        console.warn(`[HendyLinks] Circuit breaker is OPEN. Order ${orderId} kept pending.`)
        return { success: false, error: 'Service temporarily unavailable (circuit open)' }
    }

    // Validation gates (network, size) run BEFORE the API-key config guard, so a
    // malformed/unsupported request is reported precisely even when the key is unset —
    // mirrors lib/bundleportal-service.ts's Ruling P-1.
    const hlNetwork = resolveHendyLinksNetwork(network)
    if (!hlNetwork) {
        return { success: false, error: `HendyLinks does not support network: ${network}` }
    }

    const sizeMatch = dataSize.match(/[\d.]+/)
    if (!sizeMatch) {
        return { success: false, error: `Invalid data size format: ${dataSize}` }
    }
    const sizeGb = Number(sizeMatch[0])
    if (!(sizeGb > 0)) {
        return { success: false, error: `HendyLinks size_gb must be a positive number, got: ${dataSize}` }
    }

    if (!isValidAtSizeForNetwork(network, sizeGb)) {
        return {
            success: false,
            error: `${sizeGb}GB is out of range for ${network} on HendyLinks (AT-iShare: 1-15GB, AT-BigTime: 25-50GB)`,
        }
    }

    if (!HENDYLINKS_API_KEY) {
        return { success: false, error: 'HendyLinks is not configured' }
    }

    const normalizedPhone = normalizeHendyLinksPhone(phoneNumber)

    try {
        const { httpStatus, data } = await callHendyLinks('POST', '/api/orders', {
            recipient_phone: normalizedPhone,
            network: hlNetwork,
            size_gb: sizeGb,
        })

        const decision = classifyPlacementResponse(httpStatus, data)

        if (decision.outcome === 'success') {
            recordSuccess()
            return {
                success: true,
                reference: decision.orderId,
                transactionId: decision.orderId,
                apiResponse: data,
            }
        }

        if (decision.outcome === 'ambiguous') {
            // HendyLinks has (or may have) accepted and CHARGED this order but we cannot track
            // it. Flagged ambiguous so no dispatcher reverts it to 'pending' and re-dispatches —
            // with no idempotency key that is a guaranteed duplicate charge. Deliberately does
            // NOT record a breaker failure: the supplier answered, this is not instability.
            // No _httpStatus is attached, so the MTN 404 fallback (which keys off
            // apiResponse._httpStatus === 404) can never route an ambiguous order to a second
            // supplier and deliver it twice.
            console.error(`[HendyLinks] AMBIGUOUS-ACCEPTANCE: order ${orderId} — ${decision.reason} (HTTP ${httpStatus}). NOT retry-eligible; left for manual reconciliation.`)
            return {
                success: false,
                ambiguous: true,
                error: decision.reason,
                apiResponse: data,
            }
        }

        if (decision.outcome === 'rate_limited') {
            // Undocumented — HendyLinks advertises "no rate limits" — but handled
            // defensively in case that changes. Does not trip the breaker.
            console.warn(`[HendyLinks] Rate limited (HTTP 429). Order ${orderId} kept pending.`)
            return { success: false, error: data?.message || 'Supplier rate limited', isRateLimited: true, apiResponse: data }
        }

        // Business rejection or hard failure — HendyLinks answered with valid JSON.
        // _httpStatus is attached so lib/mtn-hendylinks-fallback.ts's isFallbackWorthyRejection
        // (which has no `code` field to key off, unlike Bundle Portal) can classify structurally.
        console.warn(`[HendyLinks] Order ${orderId} not fulfilled. HTTP ${httpStatus} — ${data?.message}. Order kept pending.`)
        if (decision.tripsBreaker) {
            recordFailure()
        }
        return {
            success: false,
            error: data?.message || 'HendyLinks declined the order',
            apiResponse: { ...data, _httpStatus: httpStatus },
        }
    } catch (err: any) {
        // Transport/network failure — we genuinely don't know if the order landed.
        // No retry (HendyLinks has no idempotency key); instead, reconcile via order history.
        console.error(`[HendyLinks] Transport error placing order ${orderId}:`, err.message)

        const sizeMb = Math.round(sizeGb * 1024)
        const recentMatch = await findRecentMatchingOrder(normalizedPhone, sizeMb, hlNetwork)

        if (recentMatch) {
            console.warn(`[HendyLinks] Recovered order ${orderId} after transport failure via order-history match (HendyLinks order_id=${recentMatch.id}).`)
            recordSuccess()
            return {
                success: true,
                reference: String(recentMatch.id),
                transactionId: String(recentMatch.id),
                apiResponse: recentMatch,
            }
        }

        // Unreconciled: the original request's outcome is genuinely unknown. Flagged
        // `ambiguous: true` so callers do NOT revert it to 'pending' — HendyLinks has no
        // idempotency key, so re-dispatching would create a second charged order every cron
        // run if the original actually landed. lib/refulfillment-service.ts step 11 leaves
        // these in 'processing' and raises an admin alert instead.
        console.error(`[HendyLinks] POSSIBLE-DUPLICATE-RISK: order ${orderId} transport failure could not be reconciled via order history — the original request's outcome is unknown. AMBIGUOUS: must NOT be auto-retried. Left for manual review.`)
        recordFailure()
        return { success: false, ambiguous: true, error: err.message || 'Persistent network error connecting to HendyLinks' }
    }
}

// ─── Order History (reconciliation + admin/cron sweep) ─────────────────────────
// Fetches ONE page. `limit` above 20 is honoured (verified live 2026-08-20: limit=100
// returned every row), but the response also carries a `total`, so a single page silently
// stops covering the full history once it grows past `limit` — use fetchAllOrderHistory for
// sweeps that must not miss an older order.
export async function fetchOrderHistory(limit = 20, offset = 0): Promise<{ success: boolean; orders: HendyLinksOrder[]; total?: number; error?: string }> {
    if (!HENDYLINKS_API_KEY) return { success: false, orders: [], error: 'HendyLinks is not configured' }

    try {
        const { httpStatus, data } = await callHendyLinks('GET', `/api/orders?limit=${limit}&offset=${offset}`)
        if (httpStatus !== 200 || data?.success === false || !Array.isArray(data?.orders)) {
            return { success: false, orders: [], error: data?.message || `Unexpected response (HTTP ${httpStatus})` }
        }
        const total = Number(data?.total)
        return { success: true, orders: data.orders as HendyLinksOrder[], total: Number.isFinite(total) ? total : undefined }
    } catch (error: any) {
        console.error('[HendyLinks] fetchOrderHistory error:', error)
        return { success: false, orders: [], error: error.message }
    }
}

// Max pages fetchAllOrderHistory will walk. A hard stop so a bad `total` (or a supplier bug
// that keeps returning full pages) can never spin this into an unbounded request loop.
const HISTORY_MAX_PAGES = 10

/**
 * Walks GET /api/orders until it has the whole history, `total` is satisfied, a short page
 * signals the end, or HISTORY_MAX_PAGES is hit — whichever comes first.
 *
 * The reconciliation sweeps resolve an order by matching OUR stored hendylinks_order_id
 * against a row in this list, so anything the fetch fails to cover is an order the sweep
 * silently reports as "not found in recent history" and leaves stuck in 'processing'. With a
 * single page that failure mode arrives the moment history exceeds the page size, which is a
 * question of when, not if.
 *
 * A page that fails mid-walk returns what was gathered so far with success:true — a partial
 * history still lets the sweep resolve every order it DOES cover, and the rest are simply
 * retried on the next run. Only a failure on the FIRST page is reported as an error.
 *
 * `complete` is a SEPARATE signal from `success`, added for a stricter use than the sweeps:
 * app/api/admin/orders/sync-selection releases a `processing` order back to pending when its
 * hendylinks_order_id is absent from this fetch, and that decision must NEVER be made from a
 * silently-partial result. `complete` is true only when the walk reached a genuine end (a short
 * page, or `total` satisfied) — a mid-walk page failure OR exhausting HISTORY_MAX_PAGES without
 * reaching the end both leave it false, even though `success` stays true in the first case
 * (matching this function's existing, deliberate "still usable for the sweeps" contract).
 * Security review finding (2026-08-25): before this, a "not found" caused by either partial
 * case was indistinguishable from a genuine absence.
 */
export async function fetchAllOrderHistory(pageSize = 100): Promise<{ success: boolean; complete: boolean; orders: HendyLinksOrder[]; error?: string }> {
    const all: HendyLinksOrder[] = []
    const seen = new Set<string>()
    let offset = 0

    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
        const res = await fetchOrderHistory(pageSize, offset)
        if (!res.success) {
            if (page === 0) return { success: false, complete: false, orders: [], error: res.error }
            console.warn(`[HendyLinks] fetchAllOrderHistory: page ${page} failed (${res.error}) — proceeding with ${all.length} order(s) gathered so far`)
            return { success: true, complete: false, orders: all }
        }

        // De-dupe by id: offset paging can repeat a row if new orders are placed mid-walk.
        for (const o of res.orders) {
            const key = String(o.id)
            if (!seen.has(key)) { seen.add(key); all.push(o) }
        }

        if (!shouldFetchNextPage(res.orders.length, pageSize, all.length, res.total)) {
            return { success: true, complete: true, orders: all }
        }
        offset += pageSize
    }

    console.warn(`[HendyLinks] fetchAllOrderHistory: hit HISTORY_MAX_PAGES=${HISTORY_MAX_PAGES} without reaching the end of history — ${all.length} order(s) gathered, more may exist.`)
    return { success: true, complete: false, orders: all }
}

/**
 * Applies ONE resolved order-history match to one of our orders — extracted from
 * app/api/admin/fulfillment/sync-hendylinks/route.ts so its cron twin
 * (app/api/cron/sync-hendylinks-status/route.ts) and the admin-selection-scoped sync
 * (app/api/admin/orders/sync-selection/route.ts) apply a match through the exact same path,
 * mirroring lib/agentportal-apply-outcome.ts's reasoning for AgentPortal: divergent duplicate
 * logic between call sites is exactly how this class of bug has shipped before in this repo.
 *
 * The UPDATE is guarded on BOTH the order's current status AND fulfillment_method='hendylinks'
 * — an order can be reassigned to a different supplier via a fallback dispatch between the
 * caller's SELECT and this UPDATE while status stays unchanged, so the fulfillment_method
 * guard must be repeated here rather than trusted from the SELECT alone.
 *
 * Returns `updated: false` (not an error) when the match doesn't call for a change — same
 * status as we already have, or a non-terminal supplier status (still in flight).
 */
export async function applyHendyLinksHistoryMatch(
    supabase: any,
    order: { id: string; status: string },
    match: HendyLinksOrder,
    sourceLabel: string = 'admin-reconciliation'
): Promise<{ updated: boolean; error?: string }> {
    const newStatus = match.status
    if (newStatus === order.status || (newStatus !== 'completed' && newStatus !== 'failed')) {
        return { updated: false }
    }

    const { sanitizeForStorage } = await import('@/lib/sanitize-for-storage')
    // NOT orders.error_message — that column is customer-facing, rendered as "Failure Reason"
    // in components/dashboard/RecentOrdersWidget.tsx. This is recorded admin-only, below.
    const hlMessage = typeof match.message === 'string' && match.message.trim()
        ? sanitizeForStorage(match.message, 500)
        : null

    const { error: updateError } = await supabase
        .from('orders')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', order.id)
        .eq('status', order.status)
        .eq('fulfillment_method', 'hendylinks')

    if (updateError) {
        return { updated: false, error: updateError.message }
    }

    if (newStatus === 'failed') {
        const { error: trackingError } = await supabase.from('mtn_fulfillment_tracking').insert({
            order_id: order.id,
            status: 'failed',
            api_response: {
                supplier: 'hendylinks',
                source: sourceLabel,
                hendylinks_order_id: match.id,
                message: hlMessage,
            },
        })
        if (trackingError) console.error(`[HendyLinksApply] Tracking insert failed for ${order.id}:`, trackingError.message)
    }

    const { syncShopOrderStatus } = await import('@/lib/shop-service')
    await syncShopOrderStatus(order.id, newStatus).catch(err =>
        console.error(`[HendyLinksApply] Failed to sync shop order for ${order.id}:`, err)
    )

    if (newStatus === 'completed') {
        const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
        sendOrderCompletedPushNotification(order.id).catch(e => console.error('[HendyLinksApply] Push error:', e))
    }

    return { updated: true }
}

/**
 * Should the history walk request another page? Pure, so the stop conditions are testable
 * without mocking fetch — the loop above is otherwise untestable I/O, and an off-by-one here
 * means either an unbounded request loop or a silently truncated history.
 *
 * Stop when the page came back short (that is the end of the data), or when we already hold
 * everything the supplier says exists. `total` is advisory: it is absent on older responses
 * and can drift if orders are placed mid-walk, so a short page is the authoritative signal
 * and `total` only ever ends the walk EARLY, never extends it.
 */
export function shouldFetchNextPage(
    pageLength: number,
    pageSize: number,
    collectedCount: number,
    total?: number
): boolean {
    if (pageLength < pageSize) return false
    if (typeof total === 'number' && Number.isFinite(total) && collectedCount >= total) return false
    return true
}

// ─── Balance Fetch ─────────────────────────────────────────────────────────────
export async function fetchSupplierBalance(): Promise<{ success: boolean; balance?: number; currency?: string; error?: string }> {
    if (!HENDYLINKS_API_KEY) return { success: false, error: 'HendyLinks is not configured' }

    try {
        const { httpStatus, data } = await callHendyLinks('GET', '/api/balance')
        if (httpStatus !== 200 || data?.success === false) {
            return { success: false, error: data?.message || `Failed to fetch balance (HTTP ${httpStatus})` }
        }

        const rawBalance = data.balance
        if (rawBalance === undefined || rawBalance === null) {
            return { success: false, error: 'Balance missing from supplier response' }
        }
        const balance = Number(rawBalance)
        if (Number.isNaN(balance)) {
            return { success: false, error: `Unparseable balance value: ${JSON.stringify(rawBalance)}` }
        }
        return { success: true, balance, currency: data.currency || 'GHS' }
    } catch (error: any) {
        console.error('[HendyLinks Balance] Error:', error)
        return { success: false, error: error.message }
    }
}

// ─── Bulk Fulfillment (concurrent) ──────────────────────────────────────────────
/**
 * Fulfills multiple orders via concurrent single fulfillOrder calls. No documented bulk
 * endpoint. Concurrency of 5 matches the other suppliers' bulk pattern. Processes in
 * chunks: all orders in a chunk start simultaneously, the next chunk starts only after the
 * current one fully resolves.
 */
export async function fulfillOrdersConcurrent(
    orders: OrderToFulfill[],
    concurrency = 5
): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return []

    const results: BulkOrderResult[] = new Array(orders.length)

    for (let i = 0; i < orders.length; i += concurrency) {
        const chunk = orders.slice(i, i + concurrency)

        const settled = await Promise.allSettled(
            chunk.map(order => fulfillOrder(order.network, order.phone_number, order.size, order.id))
        )

        settled.forEach((outcome, j) => {
            const order = chunk[j]
            if (outcome.status === 'fulfilled') {
                const r = outcome.value
                // `ambiguous` is carried on an intersection type because the shared
                // BulkOrderResult (lib/fulfillment-service.ts) doesn't declare it — it is read
                // duck-typed by lib/refulfillment-service.ts step 11 via `(r as any).ambiguous`,
                // exactly as lib/agentportal-service.ts's results are. Losing it here would let
                // an ambiguous order be reverted to 'pending' and re-dispatched (double charge).
                const bulkResult: BulkOrderResult & { ambiguous?: boolean } = {
                    orderId: order.id,
                    success: r.success,
                    reference: r.reference,
                    transactionId: r.transactionId,
                    error: r.error,
                    apiResponse: r.apiResponse,
                    isRateLimited: r.isRateLimited,
                    ambiguous: r.ambiguous,
                }
                results[i + j] = bulkResult
            } else {
                results[i + j] = {
                    orderId: order.id,
                    success: false,
                    error: outcome.reason?.message ?? 'Unexpected exception in HendyLinks fulfillOrder',
                }
            }
        })
    }

    return results
}
