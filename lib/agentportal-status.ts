// ─── AgentPortal status resolution ──────────────────────────────────────────────
//
// ROOT CAUSE THIS FILE FIXES: AgentPortal's webhook deliveries are order-summary only —
// per-item `reference` (our own orders.id, sent at submit time) is NOT carried in the
// webhook payload; items[].reference is null on every real delivery. Their documented
// recovery path is GET /api/beneficiaries/orders/{order_id}/items, which DOES echo our
// reference correctly. This module is the single place that turns an AgentPortal
// order_id into a map of OUR order id -> terminal outcome, using that endpoint.
//
// It is used by both the webhook handler (app/api/webhooks/agentportal/route.ts, keyed
// off payload.order_id) and the reconcile poller (lib/agentportal-reconcile.ts, keyed off
// AgentPortal's own recent-orders list) so the matching algorithm can never drift between
// the two call sites.
//
// Confirmed live shape (two rows per delivered bundle, sharing batch_id + msisdn):
//   { id, order_id, msisdn, data_mb, status, batch_id, reference, failed_reason, refunded_at }
// One row carries our reference but may itself be non-terminal (e.g. "uploaded"); a
// sibling row shares batch_id + msisdn (+ data_mb when present) and carries the terminal
// status ("success"/"failed") but has reference: null.
//
// RETRIES (verified live 2026-07-26, and the cause of a real refund-then-deliver loss):
// when an item fails retriably, AgentPortal creates a WHOLLY NEW order whose group_name is
// suffixed -R1-/-R2-, and that retry's rows carry an AgentPortal-generated numeric
// `reference` — NOT our uuid. So the retry's terminal row can never be matched back to our
// order by reference, and a per-order items fetch cannot see it at all.
//   What IS stable across retries is `batch_id`. Proven pair:
//     order b68f2178 (…-2GB-R1-…) msisdn 0592615634 batch 7941962a status failed
//     order 6be344d3 (…-2GB-R2-…) msisdn 0592615634 batch 7941962a status success
// Hence matchItemsToOutcomes must be fed rows from ALL recent orders at once (see
// fetchAgentPortalOrderItems + the global sweep in lib/agentportal-reconcile.ts), never one
// order in isolation — otherwise a retry that DID deliver looks like a permanent failure.

const AGENTPORTAL_API_KEY = process.env.AGENTPORTAL_API_KEY || ''
const AGENTPORTAL_API_BASE_URL = process.env.AGENTPORTAL_API_BASE_URL || 'https://api.agentportalgh.com'

// A bulk order can have up to 500 rows (BULK_CHUNK_SIZE in lib/agentportal-service.ts).
// 200/page bounds a full 500-row order to 3 pages; MAX_ITEMS_PAGES is a hard stop so a
// misbehaving/looping API can never turn this into an unbounded fetch.
const ITEMS_PAGE_SIZE = 200
const MAX_ITEMS_PAGES = 5

export type AgentPortalTerminalOutcome = 'completed' | 'failed'

export interface ResolvedOutcome {
    outcome: AgentPortalTerminalOutcome
    failedReason: string | null
}

export interface ResolveItemsResult {
    /** OUR order id (orders.id) -> resolved terminal outcome. */
    resolved: Map<string, ResolvedOutcome>
    /**
     * OUR order id(s) that a human should look at: more than one terminal row exists for the
     * same batch+msisdn and NONE of them is a success — i.e. the bundle failed repeatedly
     * across AgentPortal's retries. Still resolved (as `failed`, which is advisory only), but
     * surfaced separately because repeated failure is the case most worth eyeballing.
     */
    ambiguous: string[]
    /** Set only on a network/API failure fetching the items endpoint itself. Never thrown. */
    error?: string
}

// Loosely typed — AgentPortal's items endpoint is the authority on field presence, and we
// deliberately tolerate fields being absent/renamed rather than throwing.
export interface AgentPortalItemRow {
    id?: string
    order_id?: string
    msisdn: string
    data_mb?: number | null
    status: string
    batch_id?: string | null
    reference?: string | null
    failed_reason?: string | null
    refunded_at?: string | null
}

/**
 * The terminal outcome of ONE item row, or null if it is not the last word yet.
 *
 * `success` is always terminal — delivered data cannot be undelivered.
 *
 * `failed` is the subtle one, and getting it wrong cost real money on 2026-07-26. Per
 * AgentPortal's docs: retriable failures are retried automatically (up to 3 attempts), while
 * NON-retriable failures are terminal and "the cost of each such item is automatically credited
 * back to your wallet" — and "a refunded item is never retried again". So the auto-refund is
 * precisely the marker that separates the two, and `refunded_at` is where it shows up on the
 * row. A `failed` row with refunded_at still null is mid-retry: AgentPortal may yet deliver it,
 * and treating it as final is what made us refund customers who then received their data.
 *
 * This also aligns the economics: refunded_at is set exactly when AgentPortal has given US our
 * money back, which is the only point at which refunding the customer costs us nothing. (We
 * still never refund automatically — that stays an admin decision.)
 */
function terminalOutcome(row: AgentPortalItemRow): AgentPortalTerminalOutcome | null {
    const s = String(row?.status ?? '').toLowerCase()
    if (s === 'success') return 'completed'
    if (s !== 'failed') return null
    return row?.refunded_at ? 'failed' : null
}

/**
 * Pure matching algorithm — no network I/O — so it can be unit tested without ever
 * hitting AgentPortal's live API. See scripts/test-agentportal-status.ts.
 *
 * Algorithm (money-safety critical — do not weaken):
 *  1. Only rows with a non-null `reference` identify one of OUR orders. (Retry rows carry
 *     AgentPortal's own numeric reference; those are not ours and are used only as siblings.)
 *  2. If that row's own status is already terminal, use it directly. "Terminal" is decided by
 *     terminalOutcome(): `success` always, `failed` only once AgentPortal has auto-refunded it
 *     (refunded_at set), because an un-refunded failure is still inside their retry cycle.
 *  3. Otherwise, find sibling rows sharing the SAME batch_id AND msisdn (and data_mb when
 *     both sides have it) whose status is terminal — batch_id is stable across retries, so
 *     these siblings may come from a LATER retry order when rows are pooled across orders.
 *     - Zero terminal siblings -> still in flight, skip (NOT a failure, NOT an error). This is
 *       also where a mid-retry failure lands, which is exactly where we want it: the order
 *       stays `processing` until AgentPortal's retries actually finish.
 *     - Any sibling is a `success` -> completed. SUCCESS ALWAYS WINS, including over a
 *       `failed` sibling from an earlier attempt: delivered data cannot be un-delivered, and
 *       AgentPortal's retry of a failed item routinely does deliver. Treating that pair as
 *       unresolvable (or as a failure) is what refunded customers who had their data.
 *     - Otherwise (every terminal sibling failed) -> failed, flagged for review when there
 *       was more than one such attempt.
 *  4. If several rows carry the SAME reference and disagree, success still wins for the same
 *     reason; a `failed` never overwrites an already-resolved `completed`.
 */
export function matchItemsToOutcomes(rows: AgentPortalItemRow[]): ResolveItemsResult {
    const resolved = new Map<string, ResolvedOutcome>()
    const ambiguous = new Set<string>()

    for (const row of rows) {
        if (!row.reference) continue
        // ROOT CAUSE FIX (2026-08-21 production incident): a retry-order row's `reference` is
        // non-null but is AgentPortal's own generated numeric id, not one of our order ids (see
        // the RETRIES note at the top of this file) — our order ids are always UUIDs and are
        // never purely numeric. Treating it as `ourOrderId` produced a bogus top-level entry in
        // `resolved`, keyed by that numeric string. The webhook handler (unlike the reconcile
        // cron, which cross-checks resolved ids against a known set of our own stuck orders) fed
        // every entry straight into applyAgentPortalOutcome's uuid-typed `.eq('id', orderId)`,
        // so Postgres rejected it with "invalid input syntax for type uuid" on every delivery —
        // marked retryable, so the webhook 500'd and AgentPortal redelivered the identical
        // payload forever. Skipping it here is safe and correct: the row still participates as a
        // SIBLING for other rows' resolution below (the sibling filter never reads `.reference`),
        // which is exactly how a retry that delivered is supposed to resolve the original order.
        if (/^\d+$/.test(row.reference)) continue
        const ourOrderId = row.reference

        let outcome: AgentPortalTerminalOutcome | null = null
        let failedReason: string | null = null

        const ownOutcome = terminalOutcome(row)
        if (ownOutcome) {
            outcome = ownOutcome
            failedReason = row.failed_reason ?? null
        } else {
            const siblings = rows.filter(r =>
                r !== row &&
                r.batch_id != null && row.batch_id != null && r.batch_id === row.batch_id &&
                r.msisdn === row.msisdn &&
                (row.data_mb == null || r.data_mb == null || r.data_mb === row.data_mb) &&
                terminalOutcome(r) !== null
            )

            if (siblings.length === 0) continue // still in flight — not resolved, not an error

            const success = siblings.find(r => terminalOutcome(r) === 'completed')
            if (success) {
                outcome = 'completed'
                failedReason = null
                ambiguous.delete(ourOrderId)
            } else {
                outcome = 'failed'
                failedReason = siblings[0].failed_reason ?? null
                // Repeated failures across attempts — resolved, but worth a human's eyes.
                if (siblings.length > 1) ambiguous.add(ourOrderId)
            }
        }

        if (!outcome) continue

        // A previously resolved `completed` is final; never let a stale failed row undo it.
        const existing = resolved.get(ourOrderId)
        if (existing?.outcome === 'completed' && outcome === 'failed') continue
        if (outcome === 'completed') ambiguous.delete(ourOrderId)

        resolved.set(ourOrderId, { outcome, failedReason })
    }

    return { resolved, ambiguous: Array.from(ambiguous) }
}

export interface FetchItemsResult {
    rows: AgentPortalItemRow[]
    /** Set only on a network/API failure. Never thrown — callers decide whether to retry. */
    error?: string
}

/**
 * Fetches ALL item rows for one AgentPortal order_id (paginating as needed) WITHOUT
 * resolving them. Callers that need retry-awareness must accumulate rows from several
 * orders and resolve the union once — a retry's terminal row lives in a different
 * AgentPortal order and is only reachable through its shared batch_id.
 */
export async function fetchAgentPortalOrderItems(agentPortalOrderId: string): Promise<FetchItemsResult> {
    if (!AGENTPORTAL_API_KEY) {
        return { rows: [], error: 'AGENTPORTAL_API_KEY not configured' }
    }
    if (!agentPortalOrderId) {
        return { rows: [], error: 'Missing AgentPortal order_id' }
    }

    const rows: AgentPortalItemRow[] = []

    try {
        for (let page = 1; page <= MAX_ITEMS_PAGES; page++) {
            const response = await fetch(
                `${AGENTPORTAL_API_BASE_URL}/api/beneficiaries/orders/${encodeURIComponent(agentPortalOrderId)}/items?page=${page}&page_size=${ITEMS_PAGE_SIZE}`,
                { headers: { 'X-API-Key': AGENTPORTAL_API_KEY } }
            )

            if (!response.ok) {
                return { rows: [], error: `Items fetch failed for order_id=${agentPortalOrderId}: HTTP ${response.status}` }
            }

            const contentType = response.headers.get('content-type') || ''
            if (!contentType.includes('application/json')) {
                return { rows: [], error: `Items fetch for order_id=${agentPortalOrderId} returned non-JSON (HTTP ${response.status})` }
            }

            const data = await response.json()
            const pageRows: AgentPortalItemRow[] = Array.isArray(data?.data) ? data.data : []
            rows.push(...pageRows)

            const total = typeof data?.total === 'number' ? data.total : null
            const gotFullPage = pageRows.length === ITEMS_PAGE_SIZE
            const knownComplete = total !== null && rows.length >= total

            if (!gotFullPage || knownComplete) break

            if (page === MAX_ITEMS_PAGES) {
                console.warn(`[AgentPortalStatus] Hit MAX_ITEMS_PAGES=${MAX_ITEMS_PAGES} for order_id=${agentPortalOrderId} — there may be more item rows beyond what was fetched.`)
            }
        }
    } catch (err: any) {
        return { rows: [], error: err?.message || 'Items fetch exception' }
    }

    return { rows }
}

/**
 * Single-order convenience wrapper: fetch + resolve one AgentPortal order's items.
 *
 * NOTE the deliberate blind spot — this only ever sees ONE AgentPortal order, so it cannot
 * observe a retry that delivered under a different order id (see the RETRIES note at the top
 * of this file). It is therefore safe for spotting a `success`, but a `failed` it reports may
 * still be superseded by a retry. lib/agentportal-apply-outcome.ts is what enforces that
 * asymmetry; do not add a refund or a status flip on `failed` at this layer.
 */
export async function resolveAgentPortalOrderItems(agentPortalOrderId: string): Promise<ResolveItemsResult> {
    const { rows, error } = await fetchAgentPortalOrderItems(agentPortalOrderId)
    if (error) return { resolved: new Map(), ambiguous: [], error }
    return matchItemsToOutcomes(rows)
}

// ─── Targeted per-order lookup by phone number ──────────────────────────────────
//
// ROOT CAUSE THIS FIXES: the reconcile poller (lib/agentportal-reconcile.ts) only ever finds
// an order by paging AgentPortal's global recent-orders feed, bounded to a small time/page
// window. That window is sized for "resolve orders that just got stuck a few minutes ago" —
// it cannot reach an order whose original AgentPortal submission is older than the window,
// which is exactly the shape of an admin manually re-opening an old order and hitting Sync.
// Confirmed live 2026-08-25: `/api/beneficiaries/orders?search=<msisdn>` is a REAL filter
// (unlike `?reference=`, `?msisdn=`, `?phone=`, `?q=`, which are silently ignored no-ops) and
// reaches arbitrarily far back — a single search returned a phone number's full order history
// back to 2026-07-26. It matches on MSISDN only, never on our own order id/reference.
const SEARCH_PAGE_SIZE = 50
const MAX_SEARCH_PAGES_PER_PHONE = 3
// Hard ceiling across an entire resolveAgentPortalOrdersByPhone() call — protects a large
// admin selection (or a big cron fallback batch) from turning into an unbounded fan-out of
// HTTP calls, mirroring MAX_ITEM_FETCHES_PER_RUN in lib/agentportal-reconcile.ts.
const MAX_PHONE_ITEM_FETCHES_PER_CALL = 150
const MAX_UNIQUE_PHONES_PER_CALL = 60

function normalizePhoneKey(phone: string): string {
    const digits = String(phone ?? '').replace(/\D/g, '')
    return digits.startsWith('233') ? '0' + digits.slice(3) : digits
}

async function fetchAgentPortalOrdersByPhone(phoneNumber: string): Promise<{ orderIds: string[]; error?: string }> {
    if (!AGENTPORTAL_API_KEY) return { orderIds: [], error: 'AGENTPORTAL_API_KEY not configured' }

    const orderIds: string[] = []
    try {
        for (let page = 1; page <= MAX_SEARCH_PAGES_PER_PHONE; page++) {
            const response = await fetch(
                `${AGENTPORTAL_API_BASE_URL}/api/beneficiaries/orders?search=${encodeURIComponent(phoneNumber)}&page=${page}&page_size=${SEARCH_PAGE_SIZE}`,
                { headers: { 'X-API-Key': AGENTPORTAL_API_KEY } }
            )
            if (!response.ok) return { orderIds, error: `Phone search failed for ${phoneNumber}: HTTP ${response.status}` }

            const contentType = response.headers.get('content-type') || ''
            if (!contentType.includes('application/json')) {
                return { orderIds, error: `Phone search for ${phoneNumber} returned non-JSON (HTTP ${response.status})` }
            }

            const data = await response.json()
            const rows: any[] = Array.isArray(data?.data) ? data.data : []
            for (const row of rows) {
                const id = row?.id || row?.order_id
                if (id) orderIds.push(id)
            }
            if (rows.length < SEARCH_PAGE_SIZE) break
        }
    } catch (err: any) {
        return { orderIds, error: `Phone search exception for ${phoneNumber}: ${err?.message || 'unknown error'}` }
    }
    return { orderIds }
}

/**
 * Pure resolution step, separated from the network I/O above so it stays unit-testable (see
 * scripts/test-agentportal-status.ts) the same way matchItemsToOutcomes is.
 *
 * `stillInFlight` replaces the old, confirmed-broken `/api/queue?status=pending|processing`
 * heuristic (those literal status values don't exist in AgentPortal's real vocabulary —
 * verified live, both always return `total: 0`) with a signal derived from data this lookup
 * already fetched: an unresolved order whose own reference DOES appear among the pooled item
 * rows is confirmed present and still moving on AgentPortal's side, just not finished yet.
 *
 * It is deliberately PER-ORDER, not per-phone: it only fires when one of the
 * pooled item rows carries THIS order's own reference (i.e. AgentPortal genuinely has a row
 * for it, just not yet terminal) — never merely because the same phone number has some OTHER,
 * unrelated live order. A per-phone signal would let one customer's unrelated in-flight order
 * mask a DIFFERENT, genuinely lost order for the same phone from ever being alerted on — since
 * `reference` is always our own order UUID (see fulfillOrder in lib/agentportal-service.ts,
 * `reference: orderId`), a row's reference matching order.id is an unambiguous, order-specific
 * signal, not a phone-level heuristic.
 */
export function resolvePhoneLookup(
    orders: Array<{ id: string; phone_number: string }>,
    itemRows: AgentPortalItemRow[]
): { resolved: Map<string, ResolvedOutcome>; ambiguous: string[]; stillInFlight: Set<string> } {
    const { resolved, ambiguous } = matchItemsToOutcomes(itemRows)
    const referencedOrderIds = new Set(itemRows.map(r => r.reference).filter((r): r is string => !!r))
    const stillInFlight = new Set<string>()
    for (const order of orders) {
        if (resolved.has(order.id)) continue
        if (referencedOrderIds.has(order.id)) {
            stillInFlight.add(order.id)
        }
    }
    return { resolved, ambiguous, stillInFlight }
}

export interface PhoneLookupResult {
    /** OUR order id -> resolved terminal outcome. */
    resolved: Map<string, ResolvedOutcome>
    /** OUR order id(s) resolved as `failed` after more than one failed attempt — see matchItemsToOutcomes. */
    ambiguous: string[]
    /** OUR order id(s) confirmed present and still moving on AgentPortal's side — do not alert as lost. */
    stillInFlight: Set<string>
    /**
     * OUR order id(s) NOT resolved, NOT stillInFlight, AND the lookup that would have found
     * them ran to completion with NO errors and NO caps hit — i.e. AgentPortal genuinely has
     * zero record of the order for its phone number, not merely "we couldn't check". Callers
     * (app/api/admin/orders/sync-selection) use this to decide it is safe to release the order
     * back to `pending`/no-supplier — see the ALL-OR-NOTHING note below for why this is only
     * ever populated when the whole call was clean.
     */
    confirmedAbsent: Set<string>
    errors: string[]
}

/**
 * Targeted alternative to the reconcile poller's blind chronological sweep: looks each order
 * up by ITS OWN phone number instead of hoping it falls inside a bounded recent-orders window.
 * Used both as a fallback for orders the sweep couldn't reach (lib/agentportal-reconcile.ts)
 * and directly by the admin selection-sync route (app/api/admin/orders/sync-selection) for an
 * immediate, precise re-check of specific orders.
 *
 * Same retry-safety as the sweep: every AgentPortal order returned by every searched phone
 * number contributes its item rows to ONE pooled array before resolution, so a retry's
 * terminal row (a different AgentPortal order, linked only by batch_id) is still found even
 * though it did not itself match any of our references.
 */
export async function resolveAgentPortalOrdersByPhone(
    orders: Array<{ id: string; phone_number: string }>
): Promise<PhoneLookupResult> {
    const errors: string[] = []
    if (orders.length === 0) return { resolved: new Map(), ambiguous: [], stillInFlight: new Set(), confirmedAbsent: new Set(), errors }

    // ALL-OR-NOTHING completeness tracking: confirmedAbsent below is only ever populated when
    // the ENTIRE call ran clean (every order had a searchable phone, every phone searched,
    // every item fetched, nothing capped). Cheaper/simpler than tracking completeness per
    // order, and correct in the direction that matters: this feeds a decision (release an
    // order back to pending/no-supplier) that must never fire on a false negative caused by a
    // partial/failed lookup rather than a genuine absence. A capped or errored run just means
    // "try again" (e.g. a smaller selection).
    let complete = true

    const phoneToOrderIds = new Map<string, string[]>()
    for (const order of orders) {
        const key = normalizePhoneKey(order.phone_number)
        if (!key) {
            // An order with no usable phone number is never searched at all — it must not be
            // able to ride an otherwise-clean batch to a false "confirmed absent". Security
            // review finding (2026-08-25): callers already filter on `phone_number` being
            // truthy, but this pure/impure boundary must not depend on that — a garbage,
            // non-empty value that normalizes to '' would otherwise slip through.
            complete = false
            continue
        }
        if (!phoneToOrderIds.has(key)) phoneToOrderIds.set(key, [])
        phoneToOrderIds.get(key)!.push(order.id)
    }

    const uniquePhones = Array.from(phoneToOrderIds.keys())
    if (uniquePhones.length > MAX_UNIQUE_PHONES_PER_CALL) {
        console.warn(`[AgentPortalStatus] resolveAgentPortalOrdersByPhone: ${uniquePhones.length} unique phone numbers requested, capping at ${MAX_UNIQUE_PHONES_PER_CALL}.`)
        complete = false
    }
    const phonesToSearch = uniquePhones.slice(0, MAX_UNIQUE_PHONES_PER_CALL)

    const agentPortalOrderIds = new Set<string>()

    for (const phone of phonesToSearch) {
        const { orderIds: apOrderIds, error } = await fetchAgentPortalOrdersByPhone(phone)
        if (error) { errors.push(error); complete = false }
        for (const apOrderId of apOrderIds) {
            agentPortalOrderIds.add(apOrderId)
        }
    }

    const allRows: AgentPortalItemRow[] = []
    let itemFetches = 0
    for (const apOrderId of agentPortalOrderIds) {
        if (itemFetches >= MAX_PHONE_ITEM_FETCHES_PER_CALL) {
            console.warn(`[AgentPortalStatus] resolveAgentPortalOrdersByPhone: hit MAX_PHONE_ITEM_FETCHES_PER_CALL=${MAX_PHONE_ITEM_FETCHES_PER_CALL} — stopping item fetches for this call.`)
            complete = false
            break
        }
        const { rows, error } = await fetchAgentPortalOrderItems(apOrderId)
        itemFetches++
        if (error) { errors.push(error); complete = false; continue }
        allRows.push(...rows)
    }

    const { resolved, ambiguous, stillInFlight } = resolvePhoneLookup(orders, allRows)
    const confirmedAbsent = computeConfirmedAbsent(orders, resolved, stillInFlight, complete)

    return { resolved, ambiguous, stillInFlight, confirmedAbsent, errors }
}

/**
 * Pure decision step, separated out for the same reason resolvePhoneLookup is: an order is
 * `confirmedAbsent` only when it wasn't resolved, isn't stillInFlight, AND the lookup that
 * would have found it ran to completion with no errors/caps (`complete`). See
 * resolveAgentPortalOrdersByPhone's doc comment for why a partial/errored lookup must never
 * produce a false "confirmed absent" — that result drives releasing an order back to
 * pending/no-supplier (app/api/admin/orders/sync-selection), so a false positive here risks
 * re-dispatching (and re-charging for) an order AgentPortal may actually still hold.
 */
export function computeConfirmedAbsent(
    orders: Array<{ id: string; phone_number: string }>,
    resolved: Map<string, ResolvedOutcome>,
    stillInFlight: Set<string>,
    complete: boolean
): Set<string> {
    const confirmedAbsent = new Set<string>()
    if (!complete) return confirmedAbsent
    for (const order of orders) {
        if (!resolved.has(order.id) && !stillInFlight.has(order.id)) {
            confirmedAbsent.add(order.id)
        }
    }
    return confirmedAbsent
}
