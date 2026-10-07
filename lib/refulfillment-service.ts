import { createAdminClient } from '@/lib/supabase-admin'
import { fulfillOrdersBulk } from '@/lib/fulfillment-service'
import type { OrderToFulfill, BulkOrderResult } from '@/lib/fulfillment-service'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { sendAdminNewOrderAlert } from '@/lib/email-service'
import { sanitizeForStorage } from '@/lib/sanitize-for-storage'
import { resolveEnabledSuppliers, type FulfillmentNetworkSettings } from '@/lib/order-supplier'
import { claimBulkForDispatch, acceptBulkDispatch, releaseBulkClaims, acceptDispatch, reclaimForFallback } from '@/lib/dispatch-claim'

const supabaseAdmin = createAdminClient()

// Matches app/api/webhooks/agentportal/route.ts's ITEM_CONCURRENCY — chosen there
// because it gives ~2x margin under a comparable per-invocation time budget. Confirmed
// root trigger of the 2026-08-23 20:06 timeout: 48 fallback candidates dispatched fully
// sequential inside one 60s cron invocation. Bounding concurrency here directly reduces
// how often a run can approach that budget in the first place — it does not replace the
// claim/expiry design (lib/dispatch-claim.ts), which remains the safety net for
// whatever residual risk remains (a slow individual supplier call, a cold start, etc.).
const FALLBACK_CONCURRENCY = 25

/**
 * Runs `dispatchOne` over every candidate in bounded slices of FALLBACK_CONCURRENCY,
 * awaiting each slice fully before starting the next — never more than
 * FALLBACK_CONCURRENCY outbound calls in flight at once, and never fully sequential
 * either. Returns results in the same order as `candidates`.
 */
async function dispatchBounded<T, R>(
    candidates: T[],
    dispatchOne: (candidate: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = []
    for (let i = 0; i < candidates.length; i += FALLBACK_CONCURRENCY) {
        const slice = candidates.slice(i, i + FALLBACK_CONCURRENCY)
        const sliceResults = await Promise.allSettled(slice.map(dispatchOne))
        results.push(...sliceResults)
    }
    return results
}

export async function processRefulfillment(isCron: boolean, orderIds?: string[]) {
    // ── 1. Fetch all required settings in one query ──────────────────────────
    const { data: settingsData } = await supabaseAdmin
        .from('admin_settings')
        .select('key, value')
        .in('key', [
            'auto_fulfillment_enabled',
            'fulfillment_settings',
            'auto_refulfill_enabled',
            'auto_refulfill_threshold_mins',
        ])

    const settingsMap = (settingsData || []).reduce((acc: any, curr: any) => {
        acc[curr.key] = curr.value
        return acc
    }, {})

    // Kill switch — cron only
    if (isCron && settingsMap.auto_refulfill_enabled !== 'true') {
        return { skipped: true, count: 0, fulfilled: 0, failed: 0, message: 'Auto-refulfill is disabled globally.' }
    }

    const dbFulfillmentSettings = typeof settingsMap.fulfillment_settings === 'string'
        ? JSON.parse(settingsMap.fulfillment_settings)
        : (settingsMap.fulfillment_settings || {})

    const networkSettings: Record<string, boolean> = dbFulfillmentSettings.networks || {}
    const codecraftNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.codecraft_networks || {}
    const xpressNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.xpress_networks || {}
    const ghdataNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.ghdata_networks || {}
    const agentportalNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.agentportal_networks || {}
    const bundleportalNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.bundleportal_networks || {}
    const hendylinksNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.hendylinks_networks || {}
    const atishareConsoleNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.atishare_console_networks || {}
    const spfastitNetworkSettings: Record<string, boolean> = dbFulfillmentSettings.spfastit_networks || {}
    const thresholdMins = parseInt(settingsMap.auto_refulfill_threshold_mins || '5', 10)

    // ── 2. Fetch pending data orders ─────────────────────────────────────────
    let query = (supabaseAdmin
        .from('orders')
        // retry_count is selected so it can be threaded into the DataKazina dispatch as
        // attemptNo — an admin-retried order must send a fresh incoming_api_ref or DataKazina
        // rejects it as a duplicate forever. See buildIncomingApiRef in lib/datakazina-request.ts.
        .select('id, network, phone_number, size, status, user_id, price, shop_order_id, reference_code, retry_count, created_at')
        .eq('status', 'pending')
        .not('size', 'ilike', '%Airtime%')
        .not('size', 'ilike', '%Mashup%')
        .neq('category', 'mtn_mashup') as any)
        .order('created_at', { ascending: true })

    if (orderIds && Array.isArray(orderIds) && orderIds.length > 0) {
        query = query.in('id', orderIds)
    }

    if (isCron) {
        // Skip orders created in the last 2 min to avoid racing active Paystack webhooks
        const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()
        query = query.lt('created_at', twoMinsAgo)
    }

    const { data: pendingOrders, error: fetchError } = await query
    if (fetchError) throw fetchError
    if (!pendingOrders || pendingOrders.length === 0) {
        return { success: true, count: 0, fulfilled: 0, skipped: 0, failed: 0, message: 'No pending orders found to fulfill' }
    }

    // ── 3. Bulk cooldown check (cron only) — ONE query for all pending orders ─
    const cooldownSet = new Set<string>()
    if (isCron) {
        const allIds = pendingOrders.map((o: any) => o.id)
        const { data: recentFailures } = await supabaseAdmin
            .from('mtn_fulfillment_tracking')
            .select('order_id, created_at')
            .in('order_id', allIds)
            .eq('status', 'failed')
            .order('created_at', { ascending: false })

        // Build map: orderId → most recent failure timestamp
        const lastFailureMap = new Map<string, number>()
        for (const row of (recentFailures || [])) {
            const t = new Date(row.created_at).getTime()
            if (!lastFailureMap.has(row.order_id) || t > lastFailureMap.get(row.order_id)!) {
                lastFailureMap.set(row.order_id, t)
            }
        }

        const cutoff = Date.now() - thresholdMins * 60 * 1000
        for (const [orderId, lastFailTime] of lastFailureMap) {
            if (lastFailTime > cutoff) {
                console.log(`[ProcessRefulfill] Skipping order ${orderId}: failed within ${thresholdMins}m cooldown`)
                cooldownSet.add(orderId)
            }
        }
    }

    // ── 4. Classify orders into supplier buckets ─────────────────────────────
    const datakazinaOrders: OrderToFulfill[] = []
    const codeCraftOrders: OrderToFulfill[] = []
    const xpressOrders: OrderToFulfill[] = []
    const ghdataOrders: OrderToFulfill[] = []
    const agentportalOrders: OrderToFulfill[] = []
    const bundleportalOrders: OrderToFulfill[] = []
    const hendylinksOrders: OrderToFulfill[] = []
    const atishareConsoleOrders: OrderToFulfill[] = []
    const spfastitOrders: OrderToFulfill[] = []
    let skipped = 0

    for (const order of pendingOrders as any[]) {
        if (cooldownSet.has(order.id)) {
            skipped++
            continue
        }

        const isDK = networkSettings[order.network] === true
        const isCC = codecraftNetworkSettings[order.network] === true
        const isXP = xpressNetworkSettings[order.network] === true
        const isGH = ghdataNetworkSettings[order.network] === true
        const isAP = agentportalNetworkSettings[order.network] === true
        const isBP = bundleportalNetworkSettings[order.network] === true
        const isHL = hendylinksNetworkSettings[order.network] === true
        const isAC = atishareConsoleNetworkSettings[order.network] === true
        const isSF = spfastitNetworkSettings[order.network] === true
        const enabledSuppliers = resolveEnabledSuppliers(
            dbFulfillmentSettings as FulfillmentNetworkSettings,
            order.network
        )
        const enabledCount = enabledSuppliers.length

        if (enabledCount === 0) {
            console.log(`[ProcessRefulfill] Skipping order ${order.id}: No active supplier for ${order.network}`)
            skipped++
            continue
        }

        if (enabledCount > 1) {
            console.error(`[ProcessRefulfill] CONFLICT: Multiple suppliers for ${order.network} on order ${order.id}. Skipping.`)
            await sendAdminNewOrderAlert({
                referenceCode: order.reference_code || order.id,
                phoneNumber: order.phone_number,
                network: order.network,
                size: order.size,
                price: order.price,
                customerName: 'Shop Guest',
                customerEmail: 'N/A',
                source: 'shop_storefront',
                shopName: isCron ? 'Auto Refulfill Cron' : 'Admin Refulfill',
                reason: `⚠️ FULFILLMENT_CONFLICT: Multiple suppliers active for ${order.network}. Order ${order.id} skipped. Fix in admin panel.`,
            }).catch((e: any) => console.error('[ProcessRefulfill] Alert error:', e))
            skipped++
            continue
        }

        const orderData: OrderToFulfill = {
            id: order.id,
            phone_number: order.phone_number,
            network: order.network,
            size: order.size,
            shop_order_id: order.shop_order_id || null,
            reference_code: order.reference_code,
            price: order.price,
            retry_count: order.retry_count ?? 0,
        }

        if (isDK) datakazinaOrders.push(orderData)
        else if (isCC) codeCraftOrders.push(orderData)
        else if (isXP) xpressOrders.push(orderData)
        else if (isGH) ghdataOrders.push(orderData)
        else if (isAP) agentportalOrders.push(orderData)
        else if (isBP) bundleportalOrders.push(orderData)
        else if (isHL) hendylinksOrders.push(orderData)
        else if (isAC) atishareConsoleOrders.push(orderData)
        else if (isSF) spfastitOrders.push(orderData)
    }

    const allEligible = [...datakazinaOrders, ...codeCraftOrders, ...xpressOrders, ...ghdataOrders, ...agentportalOrders, ...bundleportalOrders, ...hendylinksOrders, ...atishareConsoleOrders, ...spfastitOrders]
    if (allEligible.length === 0) {
        return { success: true, count: pendingOrders.length, fulfilled: 0, skipped, failed: 0, message: 'All orders skipped (no active supplier or cooldown)' }
    }

    // ── 5. Atomic per-supplier claim: claim each bucket's eligible orders ──────
    // orders.status stays 'pending' through the whole dispatch attempt now — see
    // lib/dispatch-claim.ts. fulfillment_method is still stamped at claim time so a
    // webhook landing mid-dispatch can resolve the order by fulfillment_method + status
    // IN ('pending','processing'). Splitting the single mixed-supplier claim into seven
    // supplier-scoped claims does not change who ends up counted as "claimed" vs "not
    // claimed due to a race with a concurrent process" — each bucket's claimedIds is
    // still narrowed to exactly the rows the claim actually matched.
    const lockBucket = async (bucket: OrderToFulfill[], label: string): Promise<Set<string>> =>
        claimBulkForDispatch(supabaseAdmin, bucket.map(o => o.id), label)

    const [lockedDKIds, lockedCCIds, lockedXPIds, lockedGHIds, lockedAPIds, lockedBPIds, lockedHLIds, lockedACIds, lockedSFIds] = await Promise.all([
        lockBucket(datakazinaOrders, 'datakazina'),
        lockBucket(codeCraftOrders, 'codecraft'),
        lockBucket(xpressOrders, 'xpress'),
        lockBucket(ghdataOrders, 'ghdata'),
        lockBucket(agentportalOrders, 'agentportal'),
        lockBucket(bundleportalOrders, 'bundleportal'),
        lockBucket(hendylinksOrders, 'hendylinks'),
        lockBucket(atishareConsoleOrders, 'atishare_console'),
        lockBucket(spfastitOrders, 'spfastit'),
    ])

    const lockedIds = new Set<string>([...lockedDKIds, ...lockedCCIds, ...lockedXPIds, ...lockedGHIds, ...lockedAPIds, ...lockedBPIds, ...lockedHLIds, ...lockedACIds, ...lockedSFIds])
    const notLocked = allEligible.length - lockedIds.size
    skipped += notLocked

    const lockedDK = datakazinaOrders.filter(o => lockedDKIds.has(o.id))
    const lockedCC = codeCraftOrders.filter(o => lockedCCIds.has(o.id))
    const lockedXP = xpressOrders.filter(o => lockedXPIds.has(o.id))
    const lockedGH = ghdataOrders.filter(o => lockedGHIds.has(o.id))
    const lockedAP = agentportalOrders.filter(o => lockedAPIds.has(o.id))
    const lockedBP = bundleportalOrders.filter(o => lockedBPIds.has(o.id))
    const lockedHL = hendylinksOrders.filter(o => lockedHLIds.has(o.id))
    const lockedAC = atishareConsoleOrders.filter(o => lockedACIds.has(o.id))
    const lockedSF = spfastitOrders.filter(o => lockedSFIds.has(o.id))

    if (lockedIds.size === 0) {
        return { success: true, count: pendingOrders.length, fulfilled: 0, skipped, failed: 0, message: 'All eligible orders were locked by a concurrent process' }
    }

    // ── 6. Set shop_orders.fulfilled_by only for locked orders ───────────────
    const setFulfilledBy = async (bucket: OrderToFulfill[], label: string) => {
        const ids = bucket.map(o => o.shop_order_id).filter((id): id is string => !!id)
        if (ids.length > 0) {
            await supabaseAdmin.from('shop_orders').update({ fulfilled_by: label }).in('id', ids)
        }
    }
    await Promise.allSettled([
        setFulfilledBy(lockedDK, 'datakazina'),
        setFulfilledBy(lockedCC, 'codecraft'),
        setFulfilledBy(lockedXP, 'xpress'),
        setFulfilledBy(lockedGH, 'ghdata'),
        setFulfilledBy(lockedAP, 'agentportal'),
        setFulfilledBy(lockedBP, 'bundleportal'),
        setFulfilledBy(lockedHL, 'hendylinks'),
        setFulfilledBy(lockedAC, 'atishare_console'),
        setFulfilledBy(lockedSF, 'spfastit'),
    ])

    // ── 7. Import bulk dispatch functions ────────────────────────────────────
    const { fulfillOrdersConcurrent: ccConcurrent } = await import('@/lib/codecraft-service')
    const { fulfillOrdersBulk: xpBulk } = await import('@/lib/xpress-service')
    const { fulfillGhDataOrdersSequential: ghSequential } = await import('@/lib/ghdata-service')
    const { fulfillOrdersBulk: apBulk } = await import('@/lib/agentportal-service')
    const { fulfillOrdersConcurrent: bpConcurrent } = await import('@/lib/bundleportal-service')
    const { fulfillOrdersConcurrent: hlConcurrent } = await import('@/lib/hendylinks-service')

    // ── 8. Dispatch all seven buckets in parallel ────────────────────────────
    const makeFailResults = (bucket: OrderToFulfill[], error: string): BulkOrderResult[] =>
        bucket.map(o => ({ orderId: o.id, success: false, error }))

    const [dkSettled, ccSettled, xpSettled, ghSettled, apSettled, bpSettled, hlSettled] = await Promise.allSettled([
        lockedDK.length > 0 ? fulfillOrdersBulk(lockedDK) : Promise.resolve([] as BulkOrderResult[]),
        lockedCC.length > 0 ? ccConcurrent(lockedCC) : Promise.resolve([] as BulkOrderResult[]),
        lockedXP.length > 0 ? xpBulk(lockedXP) : Promise.resolve([] as BulkOrderResult[]),
        lockedGH.length > 0 ? ghSequential(lockedGH) : Promise.resolve([] as BulkOrderResult[]),
        lockedAP.length > 0 ? apBulk(lockedAP) : Promise.resolve([] as BulkOrderResult[]),
        lockedBP.length > 0 ? bpConcurrent(lockedBP) : Promise.resolve([] as BulkOrderResult[]),
        lockedHL.length > 0 ? hlConcurrent(lockedHL) : Promise.resolve([] as BulkOrderResult[]),
    ])

    const dkResults: BulkOrderResult[] = dkSettled.status === 'fulfilled'
        ? dkSettled.value
        : makeFailResults(lockedDK, 'DataKazina dispatch threw an exception')

    const ccResults: BulkOrderResult[] = ccSettled.status === 'fulfilled'
        ? ccSettled.value
        : makeFailResults(lockedCC, 'CodeCraft dispatch threw an exception')

    const xpResults: BulkOrderResult[] = xpSettled.status === 'fulfilled'
        ? xpSettled.value
        : makeFailResults(lockedXP, 'Xpress dispatch threw an exception')

    const ghResults: BulkOrderResult[] = ghSettled.status === 'fulfilled'
        ? ghSettled.value
        : makeFailResults(lockedGH, 'GhData dispatch threw an exception')

    const apResults: BulkOrderResult[] = apSettled.status === 'fulfilled'
        ? apSettled.value
        : makeFailResults(lockedAP, 'AgentPortal dispatch threw an exception')

    const bpResults: BulkOrderResult[] = bpSettled.status === 'fulfilled'
        ? bpSettled.value
        : makeFailResults(lockedBP, 'Bundle Portal dispatch threw an exception')

    const hlResults: BulkOrderResult[] = hlSettled.status === 'fulfilled'
        ? hlSettled.value
        : makeFailResults(lockedHL, 'HendyLinks dispatch threw an exception')

    // ── 8b. Persist hendylinks_order_id IMMEDIATELY, before anything else ────
    // HendyLinks fires its order.status_changed webhook within a second of accepting an
    // order, and that webhook resolves the order SOLELY by hendylinks_order_id. Until this
    // column is written the webhook finds no row, logs "No order found", and acks 200 —
    // discarding the outcome permanently and leaving the order stuck in 'processing'.
    //
    // This used to be written in step 12b, at the very end of the run, after the fallback
    // blocks, tracking inserts, failure reverts and shop syncs. Measured live 2026-08-20:
    // HendyLinks order 1633587's webhook arrived at 20:15:17 and found nothing; the id was
    // not stored until 20:16:01 — a 44-second window in which the outcome could not land.
    // The single-order path (lib/fulfillment-trigger.ts) never had this problem because it
    // writes the id straight after dispatch, which is why manual single fulfilments worked
    // while bulk runs stranded orders.
    //
    // Writing it here shrinks that window to roughly the dispatch round-trip. Step 12b still
    // runs and re-writes the same value (it also stamps fulfillment_method and the other
    // suppliers' references) — this is an idempotent early write, not a replacement, so the
    // two cannot disagree. Guarded on status='processing' so it can never resurrect an order
    // a webhook has already resolved in the meantime.
    await Promise.allSettled(
        hlResults
            .filter(r => r.success && (r.transactionId || r.reference))
            .map(r =>
                supabaseAdmin.from('orders')
                    .update({ hendylinks_order_id: sanitizeForStorage(String(r.transactionId || r.reference), 200) })
                    .eq('id', r.orderId)
                    .eq('status', 'processing')
                    // Also gated on fulfillment_method, matching every other guard added for
                    // this same race (reclaimForFallback in lib/dispatch-claim.ts, the webhook
                    // route, both sync routes). Not strictly reachable today — 8b only touches r.success===true
                    // entries while the fallback blocks only touch r.success===false ones, so
                    // the sets are disjoint — but this file carries a lot of scar tissue from
                    // exactly this bug class, and an unenforced invariant here is how the next
                    // one starts.
                    .eq('fulfillment_method', 'hendylinks')
                    .then(({ error }) => {
                        if (error) console.error(`[ProcessRefulfill] Early hendylinks_order_id write failed for ${r.orderId}:`, error.message)
                    })
            )
    )

    // ── MTN CodeCraft unverified-number fallback (bulk path) ────────────────
    // Mirrors the single-order fallback in lib/fulfillment-trigger.ts: only
    // CodeCraft orders that failed with the 422 "number not verified" code,
    // on MTN, get retried — and only if an admin has configured a fallback
    // supplier. Every other ccResults entry (successes, non-422 failures,
    // non-MTN orders) is untouched. Must run before ccResults feeds into
    // allResults/successes/failures and before the supplierOf map is built,
    // since both of those are what every downstream write (tracking inserts,
    // shop_orders updates, orders reference updates) actually reads from.
    const { isUnverifiedNumberRejection, resolveFallbackSupplier, dispatchFallbackSupplier } =
        await import('@/lib/mtn-codecraft-fallback')

    const { data: fallbackSettingRow } = await supabaseAdmin
        .from('admin_settings')
        .select('value')
        .eq('key', 'mtn_codecraft_fallback')
        .maybeSingle()
    const fallbackSupplier = resolveFallbackSupplier((fallbackSettingRow as any)?.value)

    // ccResults carries orderId/success/error/apiResponse but not network —
    // look that up from the same lockedCC list used to build the CodeCraft bucket.
    const ccOrderById = new Map(lockedCC.map(o => [o.id, o]))
    const fallbackUsedOrderIds = new Set<string>()

    if (fallbackSupplier) {
        const fallbackCandidates = ccResults.filter(r => {
            if (r.success) return false
            const order = ccOrderById.get(r.orderId)
            return !!order && isUnverifiedNumberRejection(order.network, r.apiResponse)
        })

        if (fallbackCandidates.length > 0) {
            console.log(`[ProcessRefulfill] Retrying ${fallbackCandidates.length} unverified-number MTN order(s) via fallback supplier ${fallbackSupplier}`)

            const fallbackSettled = await dispatchBounded(fallbackCandidates, async (candidate) => {
                const order = ccOrderById.get(candidate.orderId)!
                if (!(await reclaimForFallback(supabaseAdmin, order.id, fallbackSupplier))) {
                    return { orderId: candidate.orderId, success: false, error: 'Skipped: claim no longer live (concurrent resolution)' }
                }
                const dispatched = await dispatchFallbackSupplier(
                    fallbackSupplier, order.network, order.phone_number, order.size, order.id, order.retry_count ?? 0
                )
                return { orderId: candidate.orderId, ...dispatched }
            })

            fallbackSettled.forEach((settled, i) => {
                if (settled.status !== 'fulfilled') return
                const candidate = fallbackCandidates[i]
                const idx = ccResults.findIndex(r => r.orderId === candidate.orderId)
                if (idx === -1) return
                const fb = settled.value
                if (fb.success) {
                    // Overwrite the failed CodeCraft entry in-place with the successful
                    // fallback result. supplierOf (built next) will attribute this order
                    // to fallbackSupplier instead of 'codecraft' via fallbackUsedOrderIds.
                    ccResults[idx] = {
                        orderId: candidate.orderId,
                        success: true,
                        reference: fb.reference,
                        transactionId: fb.transactionId,
                        apiResponse: {
                            ...(fb.apiResponse as object || {}),
                            via_fallback: true,
                            primary_supplier: 'codecraft',
                            fallback_supplier: fallbackSupplier,
                            ...(fb.ghdataOrderId ? { ghdataOrderId: fb.ghdataOrderId } : {}),
                            ...(fb.ghdataShortId ? { ghdataShortId: fb.ghdataShortId } : {}),
                        },
                        ...(fb.ghdataOrderId ? { ghdataOrderId: fb.ghdataOrderId } : {}),
                        ...(fb.ghdataShortId ? { ghdataShortId: fb.ghdataShortId } : {}),
                    } as any
                    fallbackUsedOrderIds.add(candidate.orderId)
                } else if ((fb as any).ambiguous) {
                    // The fallback dispatch itself may already have accepted/charged the order
                    // (only HendyLinks sets this — see lib/mtn-fallback-dispatch.ts) even though
                    // it reports failure. Without this branch, ccResults[idx] kept the ORIGINAL
                    // CodeCraft failure (definite, not ambiguous), so step 11 below would revert
                    // this order to 'pending' and the next cron run would re-dispatch it —
                    // paying and delivering it a second time. Only reachable once HendyLinks is
                    // registered as a fallback target (this was dormant before that).
                    ccResults[idx] = { ...ccResults[idx], error: `CodeCraft: ${ccResults[idx].error} | Fallback (${fallbackSupplier}): ${fb.error}`, ambiguous: true } as any
                }
                // else: fallback also definitely failed — leave ccResults[idx] as the
                // original CodeCraft failure, unchanged.
            })
        }
    }

    // ── MTN AgentPortal whitelist-rejection fallback (bulk path) ────────────
    // Mirrors the CodeCraft fallback block above: only AgentPortal orders that failed
    // because the MTN number isn't whitelisted yet get retried, and only if an admin has
    // configured a fallback supplier. Every other apResults entry (successes, other
    // failure reasons, non-MTN orders) is untouched.
    const { isWhitelistRejection, resolveFallbackSupplier: resolveAgentPortalFallback, dispatchFallbackSupplier: dispatchAgentPortalFallback } =
        await import('@/lib/mtn-agentportal-fallback')

    const { data: agentportalFallbackSettingRow } = await supabaseAdmin
        .from('admin_settings')
        .select('value')
        .eq('key', 'mtn_agentportal_fallback')
        .maybeSingle()
    const agentportalFallbackSupplier = resolveAgentPortalFallback((agentportalFallbackSettingRow as any)?.value)

    const apOrderById = new Map(lockedAP.map(o => [o.id, o]))
    const agentportalFallbackUsedOrderIds = new Set<string>()

    if (agentportalFallbackSupplier) {
        const fallbackCandidates = apResults.filter(r => {
            if (r.success) return false
            const order = apOrderById.get(r.orderId)
            return !!order && isWhitelistRejection(order.network, r.apiResponse)
        })

        if (fallbackCandidates.length > 0) {
            console.log(`[ProcessRefulfill] Retrying ${fallbackCandidates.length} not-yet-whitelisted MTN order(s) via fallback supplier ${agentportalFallbackSupplier}`)

            const fallbackSettled = await dispatchBounded(fallbackCandidates, async (candidate) => {
                const order = apOrderById.get(candidate.orderId)!
                if (!(await reclaimForFallback(supabaseAdmin, order.id, agentportalFallbackSupplier))) {
                    return { orderId: candidate.orderId, success: false, error: 'Skipped: claim no longer live (concurrent resolution)' }
                }
                const dispatched = await dispatchAgentPortalFallback(
                    agentportalFallbackSupplier, order.network, order.phone_number, order.size, order.id, order.retry_count ?? 0
                )
                return { orderId: candidate.orderId, ...dispatched }
            })

            fallbackSettled.forEach((settled, i) => {
                if (settled.status !== 'fulfilled') return
                const candidate = fallbackCandidates[i]
                const idx = apResults.findIndex(r => r.orderId === candidate.orderId)
                if (idx === -1) return
                const fb = settled.value
                if (fb.success) {
                    apResults[idx] = {
                        orderId: candidate.orderId,
                        success: true,
                        reference: fb.reference,
                        transactionId: fb.transactionId,
                        apiResponse: {
                            ...(fb.apiResponse as object || {}),
                            via_fallback: true,
                            primary_supplier: 'agentportal',
                            fallback_supplier: agentportalFallbackSupplier,
                            ...(fb.ghdataOrderId ? { ghdataOrderId: fb.ghdataOrderId } : {}),
                            ...(fb.ghdataShortId ? { ghdataShortId: fb.ghdataShortId } : {}),
                        },
                        ...(fb.ghdataOrderId ? { ghdataOrderId: fb.ghdataOrderId } : {}),
                        ...(fb.ghdataShortId ? { ghdataShortId: fb.ghdataShortId } : {}),
                    } as any
                    agentportalFallbackUsedOrderIds.add(candidate.orderId)
                } else if ((fb as any).ambiguous) {
                    // See the identical branch in the CodeCraft fallback block above — the
                    // fallback (possibly HendyLinks) may already have charged this order.
                    apResults[idx] = { ...apResults[idx], error: `AgentPortal: ${apResults[idx].error} | Fallback (${agentportalFallbackSupplier}): ${fb.error}`, ambiguous: true } as any
                }
            })
        }
    }

    // ── MTN Bundle Portal not-allowlisted fallback (bulk path) ──────────────
    // Mirrors the CodeCraft/AgentPortal fallback blocks above: only Bundle Portal orders
    // that failed with a not_allowlisted rejection on MTN get retried, and only if an admin
    // has configured a fallback supplier. Every other bpResults entry is untouched.
    const { isNotAllowlistedRejection, resolveFallbackSupplier: resolveBundlePortalFallback, dispatchFallbackSupplier: dispatchBundlePortalFallback } =
        await import('@/lib/mtn-bundleportal-fallback')

    const { data: bundleportalFallbackSettingRow } = await supabaseAdmin
        .from('admin_settings')
        .select('value')
        .eq('key', 'mtn_bundleportal_fallback')
        .maybeSingle()
    const bundleportalFallbackSupplier = resolveBundlePortalFallback((bundleportalFallbackSettingRow as any)?.value)

    const bpOrderById = new Map(lockedBP.map(o => [o.id, o]))
    const bundleportalFallbackUsedOrderIds = new Set<string>()

    if (bundleportalFallbackSupplier) {
        const fallbackCandidates = bpResults.filter(r => {
            if (r.success) return false
            const order = bpOrderById.get(r.orderId)
            return !!order && isNotAllowlistedRejection(order.network, r.apiResponse)
        })

        if (fallbackCandidates.length > 0) {
            console.log(`[ProcessRefulfill] Retrying ${fallbackCandidates.length} not-allowlisted MTN order(s) via fallback supplier ${bundleportalFallbackSupplier}`)

            const fallbackSettled = await dispatchBounded(fallbackCandidates, async (candidate) => {
                const order = bpOrderById.get(candidate.orderId)!
                if (!(await reclaimForFallback(supabaseAdmin, order.id, bundleportalFallbackSupplier))) {
                    return { orderId: candidate.orderId, success: false, error: 'Skipped: claim no longer live (concurrent resolution)' }
                }
                const dispatched = await dispatchBundlePortalFallback(
                    bundleportalFallbackSupplier, order.network, order.phone_number, order.size, order.id, order.retry_count ?? 0
                )
                return { orderId: candidate.orderId, ...dispatched }
            })

            fallbackSettled.forEach((settled, i) => {
                if (settled.status !== 'fulfilled') return
                const candidate = fallbackCandidates[i]
                const idx = bpResults.findIndex(r => r.orderId === candidate.orderId)
                if (idx === -1) return
                const fb = settled.value
                if (fb.success) {
                    bpResults[idx] = {
                        orderId: candidate.orderId,
                        success: true,
                        reference: fb.reference,
                        transactionId: fb.transactionId,
                        apiResponse: {
                            ...(fb.apiResponse as object || {}),
                            via_fallback: true,
                            primary_supplier: 'bundleportal',
                            fallback_supplier: bundleportalFallbackSupplier,
                            ...(fb.ghdataOrderId ? { ghdataOrderId: fb.ghdataOrderId } : {}),
                            ...(fb.ghdataShortId ? { ghdataShortId: fb.ghdataShortId } : {}),
                        },
                        ...(fb.ghdataOrderId ? { ghdataOrderId: fb.ghdataOrderId } : {}),
                        ...(fb.ghdataShortId ? { ghdataShortId: fb.ghdataShortId } : {}),
                    } as any
                    bundleportalFallbackUsedOrderIds.add(candidate.orderId)
                } else if ((fb as any).ambiguous) {
                    // See the identical branch in the CodeCraft fallback block above — the
                    // fallback (possibly HendyLinks) may already have charged this order.
                    bpResults[idx] = { ...bpResults[idx], error: `Bundle Portal: ${bpResults[idx].error} | Fallback (${bundleportalFallbackSupplier}): ${fb.error}`, ambiguous: true } as any
                }
            })
        }
    }

    // ── MTN HendyLinks 404 fallback (bulk path) ─────────────────────────────
    // Mirrors the CodeCraft/AgentPortal/BundlePortal fallback blocks above: only HendyLinks
    // orders that failed with HTTP 404 on MTN get retried, and only if an admin has
    // configured a fallback supplier. Every other hlResults entry is untouched. HTTP 402 is
    // deliberately excluded by isFallbackWorthyRejection's own logic (see
    // lib/mtn-hendylinks-fallback.ts) — not re-implemented here.
    const { isFallbackWorthyRejection, resolveFallbackSupplier: resolveHendyLinksFallback, dispatchFallbackSupplier: dispatchHendyLinksFallback } =
        await import('@/lib/mtn-hendylinks-fallback')

    const { data: hendylinksFallbackSettingRow } = await supabaseAdmin
        .from('admin_settings')
        .select('value')
        .eq('key', 'mtn_hendylinks_fallback')
        .maybeSingle()
    const hendylinksFallbackSupplier = resolveHendyLinksFallback((hendylinksFallbackSettingRow as any)?.value)

    const hlOrderById = new Map(lockedHL.map(o => [o.id, o]))
    const hendylinksFallbackUsedOrderIds = new Set<string>()

    if (hendylinksFallbackSupplier) {
        const fallbackCandidates = hlResults.filter(r => {
            if (r.success) return false
            const order = hlOrderById.get(r.orderId)
            return !!order && isFallbackWorthyRejection(order.network, r.apiResponse)
        })

        if (fallbackCandidates.length > 0) {
            console.log(`[ProcessRefulfill] Retrying ${fallbackCandidates.length} HTTP-404 MTN order(s) via fallback supplier ${hendylinksFallbackSupplier}`)

            const fallbackSettled = await dispatchBounded(fallbackCandidates, async (candidate) => {
                const order = hlOrderById.get(candidate.orderId)!
                if (!(await reclaimForFallback(supabaseAdmin, order.id, hendylinksFallbackSupplier))) {
                    return { orderId: candidate.orderId, success: false, error: 'Skipped: claim no longer live (concurrent resolution)' }
                }
                const dispatched = await dispatchHendyLinksFallback(
                    hendylinksFallbackSupplier, order.network, order.phone_number, order.size, order.id, order.retry_count ?? 0
                )
                return { orderId: candidate.orderId, ...dispatched }
            })

            fallbackSettled.forEach((settled, i) => {
                if (settled.status !== 'fulfilled') return
                const candidate = fallbackCandidates[i]
                const idx = hlResults.findIndex(r => r.orderId === candidate.orderId)
                if (idx === -1) return
                const fb = settled.value
                if (fb.success) {
                    hlResults[idx] = {
                        orderId: candidate.orderId,
                        success: true,
                        reference: fb.reference,
                        transactionId: fb.transactionId,
                        apiResponse: {
                            ...(fb.apiResponse as object || {}),
                            via_fallback: true,
                            primary_supplier: 'hendylinks',
                            fallback_supplier: hendylinksFallbackSupplier,
                            ...(fb.ghdataOrderId ? { ghdataOrderId: fb.ghdataOrderId } : {}),
                            ...(fb.ghdataShortId ? { ghdataShortId: fb.ghdataShortId } : {}),
                        },
                        ...(fb.ghdataOrderId ? { ghdataOrderId: fb.ghdataOrderId } : {}),
                        ...(fb.ghdataShortId ? { ghdataShortId: fb.ghdataShortId } : {}),
                    } as any
                    hendylinksFallbackUsedOrderIds.add(candidate.orderId)
                } else if ((fb as any).ambiguous) {
                    // Mirrors the identical branch in the CodeCraft/AgentPortal/BundlePortal
                    // fallback blocks above. This one was previously (safely) omitted because
                    // HendyLinks was the ONLY supplier that set `ambiguous` and it cannot fall
                    // back to itself — so no HendyLinks fallback target could ever produce the
                    // flag. That changed the moment DataKazina started setting `ambiguous` on a
                    // duplicate-reference rejection (lib/datakazina-request.ts), and datakazina
                    // IS a selectable mtn_hendylinks_fallback target. Without this branch, that
                    // combination keeps the original HendyLinks definite-failure result, so step
                    // 11 reverts a possibly-already-delivered order to 'pending' and the next
                    // cron run re-runs the same fallback chain — the exact double-delivery this
                    // flag exists to prevent.
                    hlResults[idx] = { ...hlResults[idx], error: `HendyLinks: ${hlResults[idx].error} | Fallback (${hendylinksFallbackSupplier}): ${fb.error}`, ambiguous: true } as any
                }
            })
        }
    }

    // ── 8c. AT-iShare Console bulk dispatch ──────────────────────────────────
    // The console has no bulk endpoint — one request per order, sequential, so a burst
    // cannot trip an undocumented rate limit. attemptNo comes from the order's OWN
    // retry_count (selected in step 2's query), never from a loop index: the cron must
    // replay the SAME client_reference so the console returns the existing transaction
    // rather than creating and charging for a second one. No MTN fallback applies here —
    // this supplier serves AT-iShare only, so none of the CodeCraft/AgentPortal/
    // BundlePortal/HendyLinks fallback blocks above ever touch this bucket.
    const atishareConsoleResults: BulkOrderResult[] = []
    if (lockedAC.length > 0) {
        const { sendBundle, buildClientReference, sizeToMb, assertAtIShareNetwork } =
            await import('@/lib/atishare-console-service')

        for (const order of lockedAC) {
            if (!assertAtIShareNetwork(order.network)) {
                atishareConsoleResults.push({ orderId: order.id, success: false, error: `AT-iShare Console cannot serve ${order.network}` })
                continue
            }
            const bundleMb = sizeToMb(order.size)
            if (bundleMb === null) {
                atishareConsoleResults.push({ orderId: order.id, success: false, error: `Unparseable size "${order.size}"` })
                continue
            }

            const clientReference = buildClientReference(order.id, order.retry_count ?? 0)
            const result = await sendBundle({ phone: order.phone_number, bundleMb, clientReference })

            if (result.success) {
                // Persist the supplier's id IMMEDIATELY, per order — never at the end of the
                // bulk run. A supplier outcome arriving before this write has stranded orders
                // on another supplier before (a measured 44-second window on HendyLinks — see
                // step 8b above). Guarded on status='processing' so it can never resurrect an
                // order a webhook has already resolved in the meantime.
                // transactionId is SPFastIT's own id — supplier-controlled, so it is
                // bounded/stripped before persisting, per the codebase convention
                // (lib/sanitize-for-storage.ts), same as hendylinks_order_id elsewhere here.
                const { error: earlyWriteError } = await supabaseAdmin.from('orders').update({
                    atishare_console_reference: clientReference,
                    atishare_console_transaction_id: result.transactionId != null ? sanitizeForStorage(result.transactionId, 200) : null,
                }).eq('id', order.id).eq('status', 'processing')
                if (earlyWriteError) console.error(`[ProcessRefulfill] Early atishare_console reference write failed for ${order.id}:`, earlyWriteError.message)
            }

            atishareConsoleResults.push({
                orderId: order.id,
                success: result.success,
                reference: clientReference,
                transactionId: result.transactionId,
                error: result.error,
                apiResponse: result.apiResponse,
            })
        }
    }

    // ── SPFastIT dispatch (per-order — single-order Place Order endpoint, no bulk API) ──
    // Same shape as the AT-iShare Console loop above: no MTN fallback applies (Telecel
    // only), and this supplier is never a fallback target or source (design spec scope).
    const spfastitResults: BulkOrderResult[] = []
    if (lockedSF.length > 0) {
        const { placeOrder, buildSpfastitReference, sizeToMb, assertTelecelNetwork } =
            await import('@/lib/spfastit-service')

        for (const order of lockedSF) {
            if (!assertTelecelNetwork(order.network)) {
                spfastitResults.push({ orderId: order.id, success: false, error: `SPFastIT cannot serve ${order.network}` })
                continue
            }
            const bundleMb = sizeToMb(order.size)
            if (bundleMb === null) {
                spfastitResults.push({ orderId: order.id, success: false, error: `Unsupported size "${order.size}"` })
                continue
            }

            const reference = buildSpfastitReference(order.id, order.retry_count ?? 0)
            const result = await placeOrder({ phone: order.phone_number, bundleMb, reference })

            if (result.success) {
                // Persist immediately, per order — never at the end of the bulk run (the
                // measured 44-second HendyLinks webhook race this codebase already fixed
                // once). Guarded on status='processing' so it can never resurrect an order a
                // webhook has already resolved in the meantime.
                const { error: earlyWriteError } = await supabaseAdmin.from('orders').update({
                    spfastit_reference: reference,
                }).eq('id', order.id).eq('status', 'processing')
                if (earlyWriteError) console.error(`[ProcessRefulfill] Early spfastit_reference write failed for ${order.id}:`, earlyWriteError.message)
            }

            spfastitResults.push({
                orderId: order.id,
                success: result.success,
                reference,
                error: result.error,
                apiResponse: result.apiResponse,
                ambiguous: result.transportFault === true,
            })
        }
    }

    const allResults: BulkOrderResult[] = [...dkResults, ...ccResults, ...xpResults, ...ghResults, ...apResults, ...bpResults, ...hlResults, ...atishareConsoleResults, ...spfastitResults]

    // ── 9. Segregate successes and failures ───────────────────────────────────
    const successes = allResults.filter(r => r.success)
    const failures = allResults.filter(r => !r.success)

    // Quick lookup maps
    const orderMap = new Map<string, OrderToFulfill>(allEligible.map(o => [o.id, o]))
    type KnownSupplier = 'datakazina' | 'codecraft' | 'xpress' | 'ghdata' | 'agentportal' | 'bundleportal' | 'hendylinks' | 'atishare_console' | 'spfastit'
    const supplierOf = new Map<string, KnownSupplier>([
        ...lockedDK.map(o => [o.id, 'datakazina'] as [string, KnownSupplier]),
        ...lockedCC.map(o => [o.id, fallbackUsedOrderIds.has(o.id) ? fallbackSupplier! : 'codecraft'] as [string, KnownSupplier]),
        ...lockedXP.map(o => [o.id, 'xpress'] as [string, KnownSupplier]),
        ...lockedGH.map(o => [o.id, 'ghdata'] as [string, KnownSupplier]),
        ...lockedAP.map(o => [o.id, agentportalFallbackUsedOrderIds.has(o.id) ? agentportalFallbackSupplier! : 'agentportal'] as [string, KnownSupplier]),
        ...lockedBP.map(o => [o.id, bundleportalFallbackUsedOrderIds.has(o.id) ? bundleportalFallbackSupplier! : 'bundleportal'] as [string, KnownSupplier]),
        ...lockedHL.map(o => [o.id, hendylinksFallbackUsedOrderIds.has(o.id) ? hendylinksFallbackSupplier! : 'hendylinks'] as [string, KnownSupplier]),
        ...lockedAC.map(o => [o.id, 'atishare_console'] as [string, KnownSupplier]),
        ...lockedSF.map(o => [o.id, 'spfastit'] as [string, KnownSupplier]),
    ])

    // ── 10. Bulk insert tracking rows (one INSERT for all results) ────────────
    const trackingInserts = allResults.map(r => {
        const supplier = supplierOf.get(r.orderId) || 'unknown'
        const apiResponseExtra: Record<string, any> = {}
        if (supplier === 'ghdata') {
            const ghResult = r as any
            if (ghResult.ghdataOrderId) apiResponseExtra.ghdata_order_id = ghResult.ghdataOrderId
            if (ghResult.ghdataShortId) apiResponseExtra.ghdata_short_id = ghResult.ghdataShortId
        }
        return {
            order_id: r.orderId,
            status: r.success ? 'completed' : 'failed',
            api_response: {
                ...(r.apiResponse || {}),
                ...apiResponseExtra,
                note: `${isCron ? 'Cron' : 'Manual'} Bulk Refulfill ${r.success ? 'Success' : 'Failed'} via ${supplier}`,
                supplier,
                ...(r.success ? {} : { error: r.error }),
            },
        }
    })
    if (trackingInserts.length > 0) {
        const { error: trackingError } = await supabaseAdmin
            .from('mtn_fulfillment_tracking').insert(trackingInserts)
        if (trackingError) console.error('[ProcessRefulfill] Tracking insert error:', trackingError)
    }

    // ── 11. Revert DEFINITE failures to pending; leave AMBIGUOUS ones alone ───
    // lib/agentportal-service.ts's fulfillOrdersBulk flags a result `ambiguous: true` when the
    // chunk's fetch() itself threw (network drop, timeout) rather than returning a definite
    // HTTP/business rejection. In that case AgentPortal may already have queued and charged
    // the chunk before the connection dropped — we genuinely don't know. Reverting an
    // ambiguous order to 'pending' would let the next cron run re-submit it, and since
    // AgentPortal exposes no idempotency key, that means paying and delivering it twice. Only
    // definite failures get reverted; ambiguous ones stay in 'processing' and raise an admin
    // alert so a human reconciles instead.
    const definiteFailures = failures.filter(r => !(r as any).ambiguous)
    const ambiguousFailures = failures.filter(r => (r as any).ambiguous)

    if (definiteFailures.length > 0) {
        const failedIds = definiteFailures.map(r => r.orderId)
        // ── 11. Revert DEFINITE failures: release the claim; leave AMBIGUOUS ones alone ─
        // status never left 'pending' for these orders (see lib/dispatch-claim.ts), so
        // there's nothing to revert there. releaseBulkClaims clears dispatch_claimed_at +
        // fulfillment_method. No supplier reference column needs nulling either — those
        // are only ever written in step 12b below, AFTER acceptBulkDispatch confirms the
        // order actually transitioned, so a released (never-accepted) order never had one.
        //
        // lib/agentportal-service.ts's fulfillOrdersBulk flags a result `ambiguous: true`
        // when the chunk's fetch() itself threw (network drop, timeout) rather than
        // returning a definite HTTP/business rejection. In that case AgentPortal may
        // already have queued and charged the chunk before the connection dropped — we
        // genuinely don't know. An ambiguous order is NOT released (see step 11b below):
        // releasing it would let the next cron run re-submit it, and since AgentPortal
        // exposes no idempotency key, that means paying and delivering it twice.
        const revertedIdSet = await releaseBulkClaims(supabaseAdmin, failedIds)
        const skippedCount = failedIds.length - revertedIdSet.size
        if (skippedCount > 0) {
            console.log(`[ProcessRefulfill] ${skippedCount} "definite failure" order(s) were no longer 'processing' when reverting — a concurrent webhook likely already resolved them; left untouched`)
        }

        const failedShopIds = failedIds
            .filter(id => revertedIdSet.has(id))
            .map(id => orderMap.get(id)?.shop_order_id)
            .filter((id): id is string => !!id)
        if (failedShopIds.length > 0) {
            // Also clear fulfilled_by so the next cron run sees a clean state
            await supabaseAdmin.from('shop_orders')
                .update({ status: 'pending', fulfilled_by: null })
                .in('id', failedShopIds)
        }
    }

    let ambiguousAcceptedIds = new Set<string>()
    if (ambiguousFailures.length > 0) {
        console.error(`[ProcessRefulfill] ${ambiguousFailures.length} order(s) hit an ambiguous transport failure during bulk dispatch — marking 'processing' (NOT releasing the claim) to avoid a possible double-charge/double-deliver. Manual reconciliation required.`)

        // Land ambiguous orders in 'processing' anyway — no reference columns (we don't
        // have a confirmed one). Mirrors the single-order path's ambiguous branch in
        // lib/fulfillment-trigger.ts. The returned set feeds step 13's shop_orders sync
        // below (Step 8 of this task) — previously ambiguous orders were deliberately
        // EXCLUDED from that sync (see the removed comment this replaces), which was
        // correct under the old design (status was already 'processing' from the claim,
        // nothing to sync) but is exactly the "admin sees processing, shop sees pending"
        // divergence bug once acceptBulkDispatch is what actually moves status here.
        ambiguousAcceptedIds = await acceptBulkDispatch(supabaseAdmin, ambiguousFailures.map(r => r.orderId))

        // SPFastIT is the one supplier whose reference we generate ourselves
        // (buildSpfastitReference), deterministically, BEFORE the dispatch call — so even a
        // transport-fault ambiguous outcome already has a known attempted reference.
        // acceptBulkDispatch (above) has no per-order extra-columns parameter, so this is a
        // follow-up per-order UPDATE, gated on the order actually having transitioned
        // (ambiguousAcceptedIds) and still being 'processing'. Persisting it here is what
        // makes the order pollable by app/api/cron/sync-spfastit-status, which only selects
        // orders with spfastit_reference IS NOT NULL — without this it's invisible to that
        // cron and stuck in 'processing' forever.
        const ambiguousSpfastitFailures = ambiguousFailures.filter(
            r => supplierOf.get(r.orderId) === 'spfastit' && r.reference && ambiguousAcceptedIds.has(r.orderId)
        )
        if (ambiguousSpfastitFailures.length > 0) {
            await Promise.allSettled(
                ambiguousSpfastitFailures.map(r =>
                    supabaseAdmin.from('orders')
                        .update({ spfastit_reference: r.reference })
                        .eq('id', r.orderId)
                        .eq('status', 'processing')
                        .then(({ error }: any) => {
                            if (error) console.error(`[ProcessRefulfill] Ambiguous spfastit_reference write failed for ${r.orderId}:`, error.message)
                        })
                )
            )
        }

        // Distinct dedup-key prefix: sendAdminNewOrderAlert suppresses re-alerts for 6h on
        // push:order_alert:${referenceCode} and silently returns success:true when
        // suppressed (a .catch() can't see it) — reusing an order's own reference_code here
        // would risk this alert being swallowed by an unrelated earlier alert for the same
        // order. Awaited (not fire-and-forget) so the cron/route doesn't return before the
        // alert attempt completes.
        await Promise.allSettled(
            ambiguousFailures.map(r => {
                const order = orderMap.get(r.orderId)
                return sendAdminNewOrderAlert({
                    referenceCode: `AMBIGUOUS-REFULFILL-${r.orderId}`,
                    phoneNumber: order?.phone_number || 'N/A',
                    network: order?.network || 'unknown',
                    size: order?.size || 'unknown',
                    price: order?.price ?? 0,
                    customerName: 'Shop Guest',
                    customerEmail: 'N/A',
                    source: 'shop_storefront',
                    shopName: isCron ? 'Auto Refulfill Cron' : 'Admin Refulfill',
                    reason: `⚠️ AMBIGUOUS_TRANSPORT_FAILURE: order ${r.orderId} left in 'processing' — the supplier request may have already been queued/charged before the connection dropped (${r.error || 'unknown error'}). Do NOT resubmit without confirming with the supplier first.`,
                }).catch((e: any) => console.error(`[ProcessRefulfill] Ambiguous-failure alert error for ${r.orderId}:`, e))
            })
        )
    }

    // ── 12b. Accept: flip status to 'processing' + store the supplier reference ─────
    // Runs BEFORE the shop_orders writes below (steps 12 and 13) — whether a given order's
    // shop_orders row should move to 'processing' depends on whether ITS OWN acceptDispatch
    // call actually flipped orders.status, not merely on whether the supplier call succeeded.
    // Under the old design this step only added reference columns — status had already
    // moved to 'processing' at claim time. Under the new claim/accept split
    // (lib/dispatch-claim.ts), THIS is the moment status actually transitions: nothing
    // upstream of this call has touched status since the claim (which left it 'pending').
    // acceptDispatch is guarded on status='pending', so if a webhook already resolved the
    // order in the meantime, this call is a safe no-op — logged, not treated as an error,
    // and (critically) that order's id is excluded from acceptedIds below so the shop_orders
    // writes in steps 12/13 don't force it to 'processing' either.
    //
    // This is also still the ONLY place that stamps orders.fulfillment_method for orders
    // dispatched by this cron/manual-refulfill path for suppliers with no per-order
    // reference column (e.g. AgentPortal) — previously it was never written here AT ALL,
    // so the AgentPortal webhook's `.eq('fulfillment_method','agentportal')` conditional
    // UPDATE matched zero rows for every order this cron fulfilled, permanently
    // stranding them. Fixed for ALL suppliers, not just AgentPortal.
    const acceptedIds = new Set<string>()
    await Promise.allSettled(
        successes
            .map(r => {
                const supplier = supplierOf.get(r.orderId)
                const update: Record<string, any> = {}
                if (supplier) update.fulfillment_method = supplier
                if (supplier === 'codecraft' && (r.transactionId || r.reference)) {
                    update.codecraft_reference = r.transactionId || r.reference
                } else if (supplier === 'ghdata') {
                    const ghdataOrderId = (r as any).ghdataOrderId
                    if (ghdataOrderId) update.ghdata_order_id = ghdataOrderId
                } else if (supplier === 'datakazina') {
                    if (r.sentApiRef) update.dakazina_reference = r.sentApiRef
                    else if (r.transactionId || r.reference) update.dakazina_reference = r.transactionId || r.reference
                    if (r.supplierOrderCode) update.dakazina_order_code = sanitizeForStorage(String(r.supplierOrderCode), 200)
                } else if (supplier === 'bundleportal' && (r.transactionId || r.reference)) {
                    update.bundleportal_reference = r.transactionId || r.reference
                } else if (supplier === 'hendylinks' && (r.transactionId || r.reference)) {
                    update.hendylinks_order_id = sanitizeForStorage(r.transactionId || r.reference, 200)
                } else if (supplier === 'atishare_console' && (r.transactionId || r.reference)) {
                    update.atishare_console_reference = r.reference
                    update.atishare_console_transaction_id = r.transactionId != null
                        ? sanitizeForStorage(r.transactionId, 200)
                        : r.transactionId
                } else if (supplier === 'spfastit' && r.reference) {
                    update.spfastit_reference = r.reference
                }
                const { fulfillment_method: fm, ...referenceColumns } = update
                return acceptDispatch(supabaseAdmin, r.orderId, fm ?? supplier ?? 'unknown', referenceColumns)
                    .then(accepted => {
                        if (accepted) acceptedIds.add(r.orderId)
                        else console.log(`[ProcessRefulfill] Accept was a no-op for ${r.orderId} — a webhook already resolved it before this bookkeeping ran`)
                    })
            })
    )

    // ── 12. Update succeeded shop_orders to processing + store supplier refs ──
    // Gated on acceptedIds (step 12b, just above) — an order whose acceptDispatch call
    // no-op'd (a webhook already resolved it) must not have its shop_orders row forced to
    // 'processing' either, or shop_orders and orders end up disagreeing again.
    await Promise.allSettled(
        successes
            .filter(r => acceptedIds.has(r.orderId))
            .map(r => {
                const order = orderMap.get(r.orderId)
                if (!order?.shop_order_id) return null
                const update: Record<string, any> = {
                    status: 'processing',
                    updated_at: new Date().toISOString(),
                }
                const supplier = supplierOf.get(r.orderId)
                if (supplier === 'codecraft' && (r.transactionId || r.reference)) {
                    update.codecraft_reference_id = r.transactionId || r.reference
                }
                return supabaseAdmin.from('shop_orders').update(update).eq('id', order.shop_order_id)
                    .then(({ error }) => { if (error) console.error(`[ProcessRefulfill] shop_orders update failed for ${r.orderId}:`, error) })
            })
            .filter((p): p is Promise<void> => p !== null)
    )

    // ── 13. Sync shop order statuses — capped at 10 concurrent ──────────────
    // successes is gated on acceptedIds (step 12b) — an order whose individual
    // acceptDispatch call no-op'd (a webhook already resolved it) must not have its
    // shop_orders row force-synced to 'processing' either. Ambiguous-but-accepted orders
    // sync to 'processing' too (their orders row already moved there via acceptBulkDispatch
    // in Step 9 above) — NOT excluded from sync the way they used to be. Under the old
    // design that exclusion was correct (status was already 'processing' from the claim, so
    // shop_orders and orders already agreed); under the new claim/accept split, skipping
    // this sync (or leaving it ungated) would recreate the exact "admin sees processing,
    // shop sees pending" divergence this whole plan exists to close.
    const syncAll = [
        ...successes
            .filter(r => acceptedIds.has(r.orderId))
            .map(r => () =>
                syncShopOrderStatus(r.orderId, 'processing').catch((e: any) =>
                    console.error(`[ProcessRefulfill] syncShopOrderStatus failed for ${r.orderId}:`, e)
                )
            ),
        ...ambiguousFailures
            .filter(r => ambiguousAcceptedIds.has(r.orderId))
            .map(r => () =>
                syncShopOrderStatus(r.orderId, 'processing').catch((e: any) =>
                    console.error(`[ProcessRefulfill] syncShopOrderStatus (ambiguous) failed for ${r.orderId}:`, e)
                )
            ),
        ...definiteFailures.map(r => () =>
            syncShopOrderStatus(r.orderId, 'pending').catch((e: any) =>
                console.error(`[ProcessRefulfill] syncShopOrderStatus revert failed for ${r.orderId}:`, e)
            )
        ),
    ]
    const SYNC_CONCURRENCY = 10
    for (let i = 0; i < syncAll.length; i += SYNC_CONCURRENCY) {
        await Promise.allSettled(syncAll.slice(i, i + SYNC_CONCURRENCY).map(fn => fn()))
    }

    console.log(`[ProcessRefulfill] Done. Fulfilled: ${successes.length}, Skipped: ${skipped}, Failed: ${failures.length}`)

    return {
        success: true,
        count: pendingOrders.length,
        fulfilled: successes.length,
        skipped,
        failed: failures.length,
    }
}
