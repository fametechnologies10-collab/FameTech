import { createAdminClient } from '@/lib/supabase-admin'
import { fetchAgentPortalOrderItems, matchItemsToOutcomes, resolveAgentPortalOrdersByPhone, type AgentPortalItemRow } from '@/lib/agentportal-status'
import { applyAgentPortalOutcome } from '@/lib/agentportal-apply-outcome'

const AGENTPORTAL_API_KEY = process.env.AGENTPORTAL_API_KEY || ''
const AGENTPORTAL_API_BASE_URL = process.env.AGENTPORTAL_API_BASE_URL || 'https://api.agentportalgh.com'

// `processing` is the state a dispatched-but-unresolved AgentPortal order sits in
// (`pending` means never dispatched — left to the re-fulfilment cron, not this job).
// `failed` orders are polled too, but only recent un-refunded ones: AgentPortal retries a
// retriable failure under a new order id and can still deliver, in which case
// applyAgentPortalOutcome moves the order back to completed. Once an admin refunds it the
// status becomes `refunded` and it drops out of this query for good.
const STUCK_QUERY_LIMIT = 200
const FAILED_RESCUE_WINDOW_HOURS = 24
// Every processing order is polled for a resolution regardless of age (a freshly-dispatched
// order may already have a terminal outcome ready). This threshold only gates ALERTING —
// an order that's been processing for a minute is normal and not yet alert-worthy; one
// that's still unresolved after an hour is.
const STUCK_THRESHOLD_MINS = 60

// AgentPortal's own recent-orders list, used to discover which AgentPortal order_id(s)
// might correspond to our stuck orders (we don't store AgentPortal's own order_id on our
// side — only the reverse mapping via `reference`, resolved through the items endpoint).
// Bounded pagination: page size mirrors the existing /deliveries convention in this file,
// capped at a handful of pages so a bad night never turns this into an unbounded fetch.
const ORDERS_PAGE_SIZE = 50
const MAX_ORDER_PAGES = 5

// Hard ceiling on items fetches per run, so a long order history can never turn the global
// sweep below into an unbounded fan-out of HTTP calls.
const MAX_ITEM_FETCHES_PER_RUN = 120
// How far back before our OLDEST stuck order to keep sweeping AgentPortal's order list. A
// retry order is always NEWER than the original, so this only needs to reach back far enough
// to include the original submission itself. This window is deliberately narrow (tuned for
// "resolve orders that just got stuck a few minutes ago") — it CANNOT reach an order whose
// original AgentPortal submission predates it. Phase 2b below (targeted phone-number lookup)
// exists specifically to catch what this window misses; do not "fix" this bug by just
// widening the window further — confirmed live 2026-08-25 that a phone-number search reaches
// arbitrarily far back on its own, which is the correct tool for that job.
const SWEEP_LOOKBACK_HOURS = 12
// Cap on how many orders survive the sweep and get the (more expensive, per-order) targeted
// phone-search fallback in ONE run — keeps a large backlog from turning every 10-minute cron
// tick into dozens of extra phone searches + item fetches. Oldest-first (the stuck-orders
// query is already ordered by updated_at ascending), since older orders are exactly the ones
// the sweep above structurally cannot reach.
const PHONE_FALLBACK_CAP_PER_RUN = 20

const DELIVERIES_PAGE_SIZE = 50
// Delivery row shape, VERIFIED live 2026-07-26 (it was previously undocumented to us and
// guessed at, which is why this used to misbehave — see below):
//   { id, user_id, order_id, url, payload, attempts, success, last_status_code, last_error,
//     next_attempt_at, created_at, updated_at }
// There is NO `status` field. The old filter read `delivery.status`, got undefined on every
// row, concluded nothing was delivered, and POSTed a resend for all 50 rows on every single
// run — including the ones AgentPortal had already delivered to us with a 200. Their API
// answered each with HTTP 400 "delivery not found, already delivered, or retry cap reached",
// producing 50 bogus errors per run. `success` is the authoritative boolean.
const RESEND_MAX_AGE_HOURS = 24
const RESEND_MAX_ATTEMPTS = 10

// How many order references a single stuck-order digest names before it says "…and N more".
// A digest is one alert regardless, so this only bounds the message length.
const MAX_STUCK_ALERTS_PER_RUN = 20

const supabaseAdmin = createAdminClient()

export interface ReconcileResult {
    /** Number of our orders found stuck in fulfillment_method='agentportal' + status='processing'. */
    checked: number
    /** Number of those stuck orders actually resolved (completed/failed) this run via polling. */
    resolved: number
    /** Number of undelivered webhook deliveries AgentPortal was asked to resend (secondary action). */
    resent: number
    /**
     * Unresolved orders that AgentPortal still has queued on their side. Perfectly normal —
     * they simply have not been processed into an order yet, so there is no outcome to read.
     * Counted separately from stillStuck and never alerted on.
     */
    queued: number
    /** Number of stuck orders unresolved AND not queued on AgentPortal — the alert-worthy ones. */
    stillStuck: number
    errors: string[]
}

/**
 * Recovers stuck AgentPortal orders two ways:
 *
 *  1. POLLING (primary mechanism — added because AgentPortal's webhook sometimes never
 *     fires at all, confirmed live: an order reached AgentPortal's terminal state with
 *     zero delivery records 45 minutes later). Queries our own `orders` stuck in
 *     'processing' under fulfillment_method='agentportal', fetches AgentPortal's recent
 *     orders, resolves each via the SAME lib/agentportal-status.ts matching algorithm the
 *     webhook uses, and applies any terminal outcome via the SAME
 *     lib/agentportal-apply-outcome.ts function the webhook uses — so this job and the
 *     webhook can never resolve the same order two different ways.
 *  1b. TARGETED FALLBACK — the sweep in (1) is bounded to a recent window and cannot reach
 *     an order whose original AgentPortal submission is older than it (confirmed live
 *     2026-08-25: this is why the admin "Sync" button appeared to do nothing for an old
 *     order). Whatever the sweep leaves unresolved gets looked up by its own phone number
 *     instead (resolveAgentPortalOrdersByPhone), which reaches arbitrarily far back.
 *  2. Secondary: asks AgentPortal to resend webhook deliveries it hasn't successfully
 *     delivered yet — recovers transient failures on our end.
 *
 * ABSOLUTE SAFETY RULES:
 *  - A status is resolved ONLY from an explicit terminal status on AgentPortal's EXTERNAL
 *    items endpoint (via matchItemsToOutcomes) — never from their internal queue state, never
 *    from elapsed time, a missing row, or a stuck-for-N-minutes heuristic.
 *  - A reported `failed` marks the order `failed` and alerts — it NEVER refunds. Refunding is an
 *    admin decision that moves the order on to `refunded`. Recently-failed un-refunded orders
 *    stay in the poll set for FAILED_RESCUE_WINDOW_HOURS, so a retry that delivers afterwards
 *    still moves the order back to `completed`.
 *  - An unresolved order confirmed STILL IN FLIGHT on AgentPortal (a live, non-terminal order
 *    found for its phone number in step 1b) is normal, not stuck: we wait for their delivery
 *    report however long it takes, and raise no alert. Only orders that are unresolved AND
 *    NOT confirmed in flight are flagged — and even then only via admin alert, never
 *    auto-resolved and never refunded.
 */
export async function reconcileAgentPortalDeliveries(): Promise<ReconcileResult> {
    const errors: string[] = []
    let resent = 0
    let resolvedCount = 0

    // ── Phase 1: fetch our stuck orders ─────────────────────────────────────────────────
    let stuckOrders: any[] = []
    const rescueCutoff = new Date(Date.now() - FAILED_RESCUE_WINDOW_HOURS * 60 * 60 * 1000).toISOString()
    try {
        const { data, error: stuckOrdersError } = await supabaseAdmin
            .from('orders')
            .select('id, reference_code, phone_number, network, size, price, status, updated_at')
            .eq('fulfillment_method', 'agentportal')
            .is('refunded_at', null)
            // Value is double-quoted so PostgREST treats the ISO timestamp as a literal inside and(...).
            .or(`status.eq.processing,and(status.eq.failed,updated_at.gte."${rescueCutoff}")`)
            .order('updated_at', { ascending: true })
            .limit(STUCK_QUERY_LIMIT)

        if (stuckOrdersError) {
            errors.push(`Stuck-order query failed: ${stuckOrdersError.message}`)
        } else {
            stuckOrders = data || []
        }
    } catch (err: any) {
        errors.push(`Stuck-order query exception: ${err.message}`)
    }

    const checked = stuckOrders.length
    const stuckById = new Map<string, any>(stuckOrders.map(o => [o.id, o]))
    const remainingOurOrderIds = new Set<string>(stuckOrders.map(o => o.id))
    const ambiguousOrderIds = new Set<string>()

    // ── Phase 2: poll AgentPortal's recent orders and resolve terminal outcomes ─────────
    //
    // GLOBAL SWEEP, not per-order. Item rows from every recent AgentPortal order are pooled
    // into one array and resolved ONCE, because a retriable failure is retried under a
    // DIFFERENT AgentPortal order whose rows carry AgentPortal's own numeric reference rather
    // than our uuid. The only thing linking the retry back to us is the batch_id it inherits
    // from the original row (which does carry our reference) — and matchItemsToOutcomes can
    // only see that link if both rows are in the same input array. Resolving order-by-order
    // made every retried delivery look like a permanent failure; that is exactly the bug that
    // caused refunds on data the customer had already received.
    if (remainingOurOrderIds.size > 0) {
        if (!AGENTPORTAL_API_KEY) {
            errors.push('AGENTPORTAL_API_KEY not configured — cannot poll for resolutions')
        } else {
            const allRows: AgentPortalItemRow[] = []
            let itemFetches = 0

            // Oldest stuck order sets how far back to sweep (orders are listed newest-first).
            const oldestStuckMs = stuckOrders.reduce((oldest, o) => {
                const t = new Date(o.updated_at).getTime()
                return Number.isNaN(t) ? oldest : Math.min(oldest, t)
            }, Date.now())
            const sweepCutoffMs = oldestStuckMs - SWEEP_LOOKBACK_HOURS * 60 * 60 * 1000

            try {
                pageLoop:
                for (let page = 1; page <= MAX_ORDER_PAGES; page++) {
                    const response = await fetch(
                        `${AGENTPORTAL_API_BASE_URL}/api/beneficiaries/orders?page=${page}&page_size=${ORDERS_PAGE_SIZE}`,
                        { headers: { 'X-API-Key': AGENTPORTAL_API_KEY } }
                    )

                    if (!response.ok) {
                        errors.push(`AgentPortal orders fetch failed: HTTP ${response.status}`)
                        break
                    }

                    const contentType = response.headers.get('content-type') || ''
                    if (!contentType.includes('application/json')) {
                        errors.push(`AgentPortal orders fetch returned non-JSON (HTTP ${response.status})`)
                        break
                    }

                    const data = await response.json()
                    const orderRows: any[] = Array.isArray(data?.data) ? data.data : []
                    if (orderRows.length === 0) break

                    for (const apOrder of orderRows) {
                        const apOrderId: string | undefined = apOrder?.id || apOrder?.order_id
                        if (!apOrderId) continue

                        // Newest-first ordering means the first too-old order ends the sweep.
                        const createdMs = new Date(apOrder?.created_at).getTime()
                        if (Number.isFinite(createdMs) && createdMs < sweepCutoffMs) break pageLoop

                        if (itemFetches >= MAX_ITEM_FETCHES_PER_RUN) {
                            console.warn(`[AgentPortalReconcile] Hit MAX_ITEM_FETCHES_PER_RUN=${MAX_ITEM_FETCHES_PER_RUN} — sweeping no further this run.`)
                            break pageLoop
                        }

                        const { rows: itemRows, error: itemsError } = await fetchAgentPortalOrderItems(apOrderId)
                        itemFetches++
                        if (itemsError) {
                            errors.push(`Items fetch failed for AgentPortal order ${apOrderId}: ${itemsError}`)
                            continue
                        }
                        allRows.push(...itemRows)
                    }

                    if (orderRows.length < ORDERS_PAGE_SIZE) break
                }
            } catch (err: any) {
                errors.push(`AgentPortal orders fetch exception: ${err.message}`)
            }

            // Resolve the pooled rows in one pass, so a retry's terminal row can be matched to
            // the original row that carries our reference via their shared batch_id.
            const itemsResult = matchItemsToOutcomes(allRows)

            for (const ambigId of itemsResult.ambiguous) {
                if (remainingOurOrderIds.has(ambigId)) {
                    ambiguousOrderIds.add(ambigId)
                }
            }

            for (const [ourOrderId, outcome] of itemsResult.resolved) {
                if (!remainingOurOrderIds.has(ourOrderId)) continue // not one of our stuck orders — ignore

                const result = await applyAgentPortalOutcome(ourOrderId, outcome.outcome, outcome.failedReason, 'AgentPortal Reconcile')
                if (result.retryable) {
                    errors.push(`Apply failed (transient) for order ${ourOrderId} — will retry next run`)
                    continue
                }
                if (result.applied) resolvedCount++
                // Settled for this run either way. applied=false + not retryable means someone
                // else got there first (the webhook, or an earlier run that already marked it
                // failed) — equally fine to stop tracking. An order that stays `failed` is
                // re-polled next run anyway via the rescue window in the query above, so a late
                // retry success is still caught without Phase 4 alerting it as unresolved.
                remainingOurOrderIds.delete(ourOrderId)
            }
        }
    }

    // ── Phase 2b: targeted phone-search fallback for whatever the sweep couldn't reach ──
    //
    // The sweep above is bounded to SWEEP_LOOKBACK_HOURS/MAX_ORDER_PAGES — sized for orders
    // that just got stuck recently. An order whose original AgentPortal submission is OLDER
    // than that window (e.g. an admin manually reopening a long-since-completed order) can
    // never be found by it. resolveAgentPortalOrdersByPhone looks each remaining order up by
    // its own phone number instead, which reaches arbitrarily far back (confirmed live
    // 2026-08-25). Bounded to PHONE_FALLBACK_CAP_PER_RUN, oldest-first, so a large backlog
    // doesn't turn every cron tick into dozens of extra searches.
    const stillInFlightIds = new Set<string>()
    if (remainingOurOrderIds.size > 0) {
        const fallbackTargets = Array.from(remainingOurOrderIds)
            .slice(0, PHONE_FALLBACK_CAP_PER_RUN)
            .map(id => ({ id, phone_number: stuckById.get(id)?.phone_number || '' }))
            .filter(o => o.phone_number)

        if (fallbackTargets.length > 0) {
            const phoneResult = await resolveAgentPortalOrdersByPhone(fallbackTargets)
            errors.push(...phoneResult.errors)

            for (const ambigId of phoneResult.ambiguous) {
                if (remainingOurOrderIds.has(ambigId)) ambiguousOrderIds.add(ambigId)
            }

            for (const [ourOrderId, outcome] of phoneResult.resolved) {
                if (!remainingOurOrderIds.has(ourOrderId)) continue

                const result = await applyAgentPortalOutcome(ourOrderId, outcome.outcome, outcome.failedReason, 'AgentPortal Reconcile (phone lookup)')
                if (result.retryable) {
                    errors.push(`Apply failed (transient) for order ${ourOrderId} — will retry next run`)
                    continue
                }
                if (result.applied) resolvedCount++
                remainingOurOrderIds.delete(ourOrderId)
            }

            for (const id of phoneResult.stillInFlight) {
                if (remainingOurOrderIds.has(id)) stillInFlightIds.add(id)
            }
        }
    }

    // ── Phase 3: secondary — resend undelivered webhook deliveries ──────────────────────
    try {
        const response = await fetch(`${AGENTPORTAL_API_BASE_URL}/api/webhooks/deliveries?page=1&page_size=${DELIVERIES_PAGE_SIZE}`, {
            headers: { 'X-API-Key': AGENTPORTAL_API_KEY },
        })

        if (response.ok) {
            const data = await response.json()
            const deliveries: any[] = Array.isArray(data.data) ? data.data : []

            // We only fetch page 1 — if it comes back full, there may be more undelivered
            // rows past this page that never get retried until older ones clear out. We
            // don't paginate (yet), so at least surface that a backlog may be forming.
            if (deliveries.length === DELIVERIES_PAGE_SIZE) {
                console.warn(`[AgentPortalReconcile] Deliveries page 1 came back full (${DELIVERIES_PAGE_SIZE} rows) — a backlog beyond page 1 may exist and won't be retried by this run.`)
            }

            let ageOrAttemptFieldSeen = false

            for (const delivery of deliveries) {
                if (!delivery.id) continue
                // `success === true` means AgentPortal already delivered it to us (its
                // last_status_code is our 200). Resending those is what generated the HTTP 400
                // storm. Only a row that is explicitly NOT successful is worth nudging; anything
                // where the flag is missing/unknown is left alone rather than blindly retried.
                if (delivery.success !== false) continue
                // A 2xx on the last attempt is the same signal by another name — belt and braces
                // in case `success` is ever absent on some rows.
                const lastCode = Number(delivery.last_status_code)
                if (Number.isFinite(lastCode) && lastCode >= 200 && lastCode < 300) continue

                // Skip rows that look permanently stale so a dead delivery (bad URL, 410,
                // etc.) doesn't get re-POSTed on every single run forever.
                const attempts = Number(delivery.attempts ?? delivery.attempt_count ?? delivery.retry_count ?? NaN)
                if (Number.isFinite(attempts)) {
                    ageOrAttemptFieldSeen = true
                    if (attempts >= RESEND_MAX_ATTEMPTS) {
                        console.warn(`[AgentPortalReconcile] Skipping delivery ${delivery.id}: ${attempts} attempts already made (max ${RESEND_MAX_ATTEMPTS}).`)
                        continue
                    }
                }

                const createdAtRaw = delivery.created_at || delivery.inserted_at || delivery.first_attempted_at
                if (createdAtRaw) {
                    const createdAt = new Date(createdAtRaw)
                    if (!Number.isNaN(createdAt.getTime())) {
                        ageOrAttemptFieldSeen = true
                        const ageHours = (Date.now() - createdAt.getTime()) / (60 * 60 * 1000)
                        if (ageHours > RESEND_MAX_AGE_HOURS) {
                            console.warn(`[AgentPortalReconcile] Skipping delivery ${delivery.id}: ${ageHours.toFixed(1)}h old (max ${RESEND_MAX_AGE_HOURS}h).`)
                            continue
                        }
                    }
                }

                try {
                    const resendResponse = await fetch(
                        `${AGENTPORTAL_API_BASE_URL}/api/webhooks/deliveries/${delivery.id}/resend`,
                        { method: 'POST', headers: { 'X-API-Key': AGENTPORTAL_API_KEY } }
                    )
                    if (resendResponse.ok) {
                        resent++
                    } else {
                        errors.push(`Resend failed for delivery ${delivery.id}: HTTP ${resendResponse.status}`)
                    }
                } catch (err: any) {
                    errors.push(`Resend exception for delivery ${delivery.id}: ${err.message}`)
                }
            }

            // Neither an attempts nor a created_at-like field was present on any row, so
            // nothing above could actually be bounded — surface that plainly rather than
            // silently resending everything forever.
            if (deliveries.length > 0 && !ageOrAttemptFieldSeen) {
                console.warn('[AgentPortalReconcile] No age/attempt field found on delivery rows — resend bounding is inactive; every undelivered row on this page will be re-nudged on every run.')
            }
        } else {
            errors.push(`Deliveries fetch failed: HTTP ${response.status}`)
        }
    } catch (err: any) {
        errors.push(`Deliveries fetch exception: ${err.message}`)
    }

    // ── Phase 4: alert on whatever is still unresolved (stuck) or ambiguous ─────────────
    // Only orders that have been processing for longer than STUCK_THRESHOLD_MINS are
    // alert-worthy — an order that's a minute into processing and simply hasn't resolved
    // yet this run is normal, not a problem. Ambiguous orders are always alert-worthy
    // regardless of age since they will never resolve on their own (never guessed).
    //
    // An order confirmed STILL IN FLIGHT (Phase 2b found a live, non-terminal AgentPortal
    // order for its phone number) is not stuck — it is waiting its turn, and there is simply
    // no terminal outcome to read yet. Those are counted as `queued` and never alerted on, no
    // matter how long they sit: we wait for the final success/failure and act on that (and
    // even then, never with a refund). This used to be checked via `/api/queue?status=pending|
    // processing`, which was confirmed live 2026-08-25 to be silently broken — those literal
    // status strings don't exist in AgentPortal's real vocabulary (both always return
    // `total: 0`), so it always returned an empty set. stillInFlightIds reuses the item/order
    // data Phase 2b already fetched instead of a second, unreliable lookup — but it is only
    // populated for orders Phase 2b actually looked at (bounded by PHONE_FALLBACK_CAP_PER_RUN),
    // so its ABSENCE is not itself a signal: an order outside that cap simply falls through to
    // the age-based check below, same as before this fix.
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINS * 60 * 1000)
    const unresolvedIds = Array.from(remainingOurOrderIds)
    const queued = unresolvedIds.filter(id => stillInFlightIds.has(id)).length

    const stillStuckIds = unresolvedIds.filter(id => {
        if (stillInFlightIds.has(id)) return false
        if (ambiguousOrderIds.has(id)) return true
        const order = stuckById.get(id)
        if (!order?.updated_at) return false
        const updatedAt = new Date(order.updated_at)
        return !Number.isNaN(updatedAt.getTime()) && updatedAt < cutoff
    })
    const stillStuck = stillStuckIds.length

    if (queued > 0) {
        console.log(`[AgentPortalReconcile] ${queued} unresolved order(s) confirmed still in flight on AgentPortal — waiting for their delivery report, no alert raised.`)
    }

    // ONE digest alert, not one per order. sendAdminNewOrderAlert fans out a web push to every
    // registered admin device, so the old per-order loop multiplied badly: an AgentPortal-side
    // queue stall on 2026-07-26 left 5 orders stuck and fired 5 alerts across 8 admin devices =
    // 40 push notifications for a single supplier problem. A stall is one event and reads as one.
    if (stillStuck > 0) {
        try {
            const { sendAdminNewOrderAlert } = await import('@/lib/email-service')
            const { createHash } = await import('crypto')

            const idsToList = stillStuckIds.slice(0, MAX_STUCK_ALERTS_PER_RUN)
            const listed = idsToList
                .map(id => {
                    const order = stuckById.get(id)
                    return `${order?.reference_code || id}${ambiguousOrderIds.has(id) ? ' (ambiguous)' : ''}`
                })
                .join(', ')
            const overflow = stillStuck > idsToList.length ? ` …and ${stillStuck - idsToList.length} more` : ''
            const ambiguousCount = stillStuckIds.filter(id => ambiguousOrderIds.has(id)).length

            // Dedup is keyed on WHICH orders are stuck, not just "something is stuck": the same
            // standing set stays quiet for 6h, but one more order joining the pile alerts again.
            const digestKey = createHash('sha1').update([...stillStuckIds].sort().join(',')).digest('hex').slice(0, 16)

            // The first order supplies the push's phone/size/price fields; the reason carries the
            // real payload. There is no per-order meaning to those fields in a digest.
            const first = stuckById.get(idsToList[0])

            await sendAdminNewOrderAlert({
                referenceCode: `AP-STUCK-DIGEST-${digestKey}`,
                phoneNumber: first?.phone_number || 'N/A',
                network: first?.network || 'MTN',
                size: first?.size || 'N/A',
                price: first?.price ?? 0,
                customerName: 'N/A',
                customerEmail: 'N/A',
                source: 'main_site',
                reason: `⚠️ ${stillStuck} AgentPortal order(s) unresolved for over ${STUCK_THRESHOLD_MINS} min and NOT confirmed still in flight${ambiguousCount > 0 ? ` (${ambiguousCount} with ambiguous supplier data)` : ''}: ${listed}${overflow}. These are unaccounted for — no live order found for them, and no delivery report. Nothing was changed automatically and nothing was refunded. Check AgentPortal's dashboard.`,
            }).catch((e: any) => console.error('[AgentPortalReconcile] Alert error:', e))
        } catch (err: any) {
            errors.push(`Stuck-order alert exception: ${err.message}`)
        }
    }

    return { checked, resolved: resolvedCount, resent, queued, stillStuck, errors }
}

export interface SelectionSyncResult {
    checked: number
    updated: number
    stillInFlight: number
    /** Order ids released back to pending/no-supplier — see the wipe note below. */
    wipedIds: string[]
    errors: string[]
}

/**
 * Admin-selection-scoped sync: re-checks EXACTLY the given order ids via the targeted
 * phone-search lookup (resolveAgentPortalOrdersByPhone), skipping the broader sweep/resend/
 * alert phases in reconcileAgentPortalDeliveries() entirely — an admin who selected specific
 * orders wants those checked NOW, not folded into the account-wide stuck-order digest. This is
 * also what makes the admin "Sync" button work for an OLD order the cron's bounded sweep can
 * never reach (see the file-level doc comment, step 1b).
 *
 * Used by app/api/admin/orders/sync-selection/route.ts. Only orders with
 * fulfillment_method='agentportal' are looked up; any other id in the input is ignored (the
 * route itself is expected to have already enforced single-supplier selections).
 *
 * WIPE ON CONFIRMED ABSENCE (2026-08-25, explicit product decision): a `processing` order that
 * resolveAgentPortalOrdersByPhone reports `confirmedAbsent` — AgentPortal genuinely has no
 * record of it at all, and the lookup ran with no errors/caps — is released back to `pending`
 * with `fulfillment_method: null`, i.e. made to look exactly like an order no supplier has
 * ever touched. This is deliberately scoped to `processing` only (not `pending` or `failed`,
 * which already have a defined meaning) and only ever fires on a `confirmedAbsent` result,
 * which resolveAgentPortalOrdersByPhone only populates when the ENTIRE lookup was clean — see
 * that function's doc comment for why a partial/errored lookup must never trigger this.
 */
export async function syncAgentPortalOrdersById(orderIds: string[]): Promise<SelectionSyncResult> {
    const errors: string[] = []
    if (orderIds.length === 0) return { checked: 0, updated: 0, stillInFlight: 0, wipedIds: [], errors }

    // Status filter mirrors syncAgentPortalOrdersById's HendyLinks sibling
    // (app/api/admin/orders/sync-selection/route.ts) — applyAgentPortalOutcome's own guard
    // already prevents a completed/refunded order from being mutated, but filtering here too
    // avoids a wasted external lookup and keeps `checked` meaning the same thing for both
    // suppliers this route supports (only orders actually eligible to change are counted).
    const { data, error } = await supabaseAdmin
        .from('orders')
        .select('id, phone_number, status')
        .in('id', orderIds)
        .eq('fulfillment_method', 'agentportal')
        .in('status', ['pending', 'processing', 'failed'])
        .is('refunded_at', null)

    if (error) {
        errors.push(`Order lookup failed: ${error.message}`)
        return { checked: 0, updated: 0, stillInFlight: 0, wipedIds: [], errors }
    }

    const targets = ((data || []) as Array<{ id: string; phone_number: string; status: string }>).filter(o => o.phone_number)
    const checked = targets.length
    if (checked === 0) return { checked: 0, updated: 0, stillInFlight: 0, wipedIds: [], errors }

    const statusById = new Map(targets.map(t => [t.id, t.status]))
    const result = await resolveAgentPortalOrdersByPhone(targets)
    errors.push(...result.errors)

    let updated = 0
    for (const [orderId, outcome] of result.resolved) {
        const applyResult = await applyAgentPortalOutcome(orderId, outcome.outcome, outcome.failedReason, 'AgentPortal Admin Sync (selection)')
        if (applyResult.retryable) {
            errors.push(`Apply failed (transient) for order ${orderId}`)
            continue
        }
        if (applyResult.applied) updated++
    }

    const wipedIds: string[] = []
    for (const orderId of result.confirmedAbsent) {
        if (statusById.get(orderId) !== 'processing') continue // only a stuck `processing` order is released this way
        const { data: wipedRows, error: wipeError } = await supabaseAdmin
            .from('orders')
            .update({ status: 'pending', fulfillment_method: null, updated_at: new Date().toISOString() })
            .eq('id', orderId)
            .eq('status', 'processing')
            .eq('fulfillment_method', 'agentportal')
            .select('id')
        if (wipeError) {
            errors.push(`Wipe failed for order ${orderId}: ${wipeError.message}`)
            continue
        }
        if (wipedRows && wipedRows.length > 0) {
            console.warn(`[AgentPortalReconcile] Order ${orderId} confirmed absent from AgentPortal (selection sync) — released back to pending, no supplier assigned.`)
            wipedIds.push(orderId)
        }
    }

    return { checked, updated, stillInFlight: result.stillInFlight.size, wipedIds, errors }
}
