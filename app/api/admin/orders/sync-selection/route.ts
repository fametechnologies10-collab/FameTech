import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { syncAgentPortalOrdersById } from '@/lib/agentportal-reconcile'
import { fetchAllOrderHistory, applyHendyLinksHistoryMatch } from '@/lib/hendylinks-service'
import { checkOrderStatus, mapSpfastitStatus } from '@/lib/spfastit-service'
import { syncShopOrderStatus } from '@/lib/shop-service'

/**
 * POST /api/admin/orders/sync-selection
 * Admin (or sub-admin) selection-scoped supplier re-check, from the bulk-update orders page's
 * "Sync" button. Every selected order must share ONE fulfillment_method — a mixed selection
 * has no single lookup endpoint to check against, so it is rejected rather than silently
 * syncing a subset. Currently supports agentportal and hendylinks (the two suppliers with a
 * usable order-lookup/history mechanism); any other supplier returns a clear "not supported"
 * error instead of a silent no-op.
 *
 * For AgentPortal specifically, this is a TARGETED phone-number lookup
 * (lib/agentportal-status.ts resolveAgentPortalOrdersByPhone), not the account-wide sweep the
 * cron/full "Sync AgentPortal" button runs — that sweep is bounded to a recent window and
 * cannot reach an order an admin is manually re-opening (confirmed live 2026-08-25). This
 * route is precisely the case that bounded sweep cannot serve.
 *
 * SPFastIT is simpler than either: it has a direct per-reference status lookup
 * (lib/spfastit-service.ts checkOrderStatus), so its branch here is a plain per-order check
 * scoped to the selection, no history walk or phone search needed.
 *
 * JSON body: { orderIds: string[] }
 */

const MAX_SELECTION = 200
const SUPPORTED_SUPPLIERS = new Set(['agentportal', 'hendylinks', 'spfastit'])
const HISTORY_PAGE_SIZE = 100

export async function POST(request: NextRequest) {
    const authResult = await validateAdminAccess(true, request)
    if (authResult.error !== null) {
        return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status })
    }

    // Tighter than a typical admin read/write limit — an agentportal selection can fan out to
    // ~180 phone-search requests + ~150 item fetches to a THIRD-PARTY API per call (bounded by
    // MAX_UNIQUE_PHONES_PER_CALL/MAX_PHONE_ITEM_FETCHES_PER_CALL in lib/agentportal-status.ts),
    // so repeated large selections could otherwise generate thousands of outbound calls/minute.
    const rl = consumeRateLimit(`admin-sync-selection:${authResult.user.id}`, 5, 60_000)
    if (!rl.allowed) {
        return NextResponse.json({ success: false, error: 'Too many sync requests, slow down.' }, { status: 429 })
    }

    let body: any
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
    }

    const orderIds: string[] = Array.isArray(body?.orderIds)
        ? Array.from(new Set(body.orderIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)))
        : []

    if (orderIds.length === 0) {
        return NextResponse.json({ success: false, error: 'No orders selected' }, { status: 400 })
    }
    if (orderIds.length > MAX_SELECTION) {
        return NextResponse.json({ success: false, error: `At most ${MAX_SELECTION} orders per sync — split into batches` }, { status: 400 })
    }

    const supabase = createServerClient()

    const { data: orderRows, error: lookupError } = await (supabase.from('orders') as any)
        .select('id, status, fulfillment_method')
        .in('id', orderIds)

    if (lookupError) {
        console.error('[SyncSelection] Order lookup failed:', lookupError.message)
        return NextResponse.json({ success: false, error: 'Order lookup failed — please retry' }, { status: 500 })
    }
    if (!orderRows || orderRows.length === 0) {
        return NextResponse.json({ success: false, error: 'No matching orders found', notFoundIds: orderIds }, { status: 404 })
    }

    // Requested ids that don't exist in `orders` at all (typo, already deleted, wrong id) —
    // surfaced so the admin isn't left guessing why a selection came back smaller than expected.
    const foundIds = new Set((orderRows as Array<{ id: string }>).map(o => o.id))
    const notFoundInDbIds = orderIds.filter(id => !foundIds.has(id))

    const methods = new Set((orderRows as Array<{ fulfillment_method: string | null }>).map(o => o.fulfillment_method).filter(Boolean))
    if (methods.size > 1) {
        return NextResponse.json({
            success: false,
            error: `Selected orders use ${methods.size} different suppliers (${Array.from(methods).join(', ')}) — select orders from a single supplier to sync.`,
        }, { status: 400 })
    }
    const supplier = Array.from(methods)[0] as string | undefined
    if (!supplier) {
        return NextResponse.json({ success: false, error: 'Selected orders have no fulfillment supplier recorded — nothing to sync' }, { status: 400 })
    }
    if (!SUPPORTED_SUPPLIERS.has(supplier)) {
        return NextResponse.json({ success: false, error: `Sync isn't supported yet for supplier "${supplier}"` }, { status: 400 })
    }

    try {
        if (supplier === 'agentportal') {
            const result = await syncAgentPortalOrdersById(orderIds)
            return NextResponse.json({
                success: true,
                checked: result.checked,
                updated: result.updated,
                stillInFlight: result.stillInFlight,
                wiped: result.wipedIds.length,
                wipedIds: result.wipedIds,
                notFoundInDbIds,
                errors: result.errors,
            })
        }

        if (supplier === 'spfastit') {
            const targets = (orderRows as Array<{ id: string; status: string; fulfillment_method: string }>)
                .filter(o => o.fulfillment_method === 'spfastit')

            const { data: withRefs, error: refLookupError } = await (supabase.from('orders') as any)
                .select('id, status, spfastit_reference')
                .in('id', targets.map(o => o.id))
                .eq('status', 'processing')
                .not('spfastit_reference', 'is', null)

            if (refLookupError) {
                console.error('[SyncSelection] SPFastIT reference lookup failed:', refLookupError.message)
                return NextResponse.json({ success: false, error: 'Order lookup failed — please retry' }, { status: 500 })
            }

            const checked = (withRefs || []).length
            if (checked === 0) {
                return NextResponse.json({ success: true, checked: 0, updated: 0, failed: 0, notFoundInDbIds, errors: [] })
            }

            const errors: string[] = []
            let updated = 0
            let failed = 0

            await Promise.allSettled((withRefs as Array<{ id: string; spfastit_reference: string }>).map(async (order) => {
                try {
                    const statusResult = await checkOrderStatus(order.spfastit_reference)
                    if (!statusResult.success) return

                    const newStatus = mapSpfastitStatus(statusResult.orderStatus || '')
                    if (newStatus === 'processing') return

                    // Same double-filtered guard as the cron/admin sweep routes for this
                    // supplier — status='processing' AND fulfillment_method='spfastit'.
                    const { data: updatedRows, error: updateError } = await (supabase.from('orders') as any)
                        .update({ status: newStatus, updated_at: new Date().toISOString() })
                        .eq('id', order.id)
                        .eq('status', 'processing')
                        .eq('fulfillment_method', 'spfastit')
                        .select('id')

                    if (updateError) {
                        errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                        failed++
                        return
                    }
                    if (!updatedRows || updatedRows.length === 0) return

                    await syncShopOrderStatus(order.id, newStatus).catch(err =>
                        console.error(`[SyncSelection] syncShopOrderStatus failed for ${order.id}:`, err)
                    )
                    if (newStatus === 'completed') {
                        const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                        sendOrderCompletedPushNotification(order.id).catch(e => console.error('[SyncSelection] Push error:', e))
                    }
                    updated++
                } catch (orderErr: any) {
                    errors.push(`Exception for ${order.id}: ${orderErr.message}`)
                    failed++
                }
            }))

            return NextResponse.json({ success: true, checked, updated, failed, notFoundInDbIds, errors })
        }

        // hendylinks — same full-history-then-match approach as
        // app/api/admin/fulfillment/sync-hendylinks, scoped to exactly the selected ids.
        const targets = (orderRows as Array<{ id: string; status: string; fulfillment_method: string }>)
            .filter(o => o.fulfillment_method === 'hendylinks')

        // status eligibility filter — same as both sibling routes (sync-hendylinks admin route,
        // sync-hendylinks-status cron). Without this, a refunded/completed order (whose
        // hendylinks_order_id is never cleared on refund) would still be a valid row here, and
        // applyHendyLinksHistoryMatch's own guard is only an optimistic-concurrency check
        // (`.eq('status', order.status)`) against whatever status THIS query just read — not an
        // eligibility gate — so it would happily flip an already-settled order's status.
        const { data: withIds, error: idLookupError } = await (supabase.from('orders') as any)
            .select('id, status, hendylinks_order_id')
            .in('id', targets.map(o => o.id))
            .in('status', ['pending', 'processing'])
            .not('hendylinks_order_id', 'is', null)

        if (idLookupError) {
            console.error('[SyncSelection] HendyLinks id lookup failed:', idLookupError.message)
            return NextResponse.json({ success: false, error: 'Order lookup failed — please retry' }, { status: 500 })
        }

        const checked = (withIds || []).length
        if (checked === 0) {
            return NextResponse.json({ success: true, checked: 0, updated: 0, skippedDuplicateId: 0, wiped: 0, wipedIds: [], notFoundInDbIds, errors: [] })
        }

        const historyResult = await fetchAllOrderHistory(HISTORY_PAGE_SIZE)
        if (!historyResult.success) {
            return NextResponse.json({ success: false, error: historyResult.error || 'fetchAllOrderHistory failed' }, { status: 502 })
        }
        const historyById = new Map(historyResult.orders.map(o => [String(o.id), o]))

        // Same collision guard as the account-wide sync — a hendylinks_order_id shared by more
        // than one order in THIS selection cannot be resolved safely.
        const idCounts = new Map<string, number>()
        for (const o of withIds as Array<{ hendylinks_order_id: string }>) {
            const key = String(o.hendylinks_order_id)
            idCounts.set(key, (idCounts.get(key) || 0) + 1)
        }
        const duplicateIds = new Set(Array.from(idCounts.entries()).filter(([, count]) => count > 1).map(([id]) => id))

        const errors: string[] = []
        let updated = 0
        let skippedDuplicateId = 0
        const wipedIds: string[] = []

        for (const order of withIds as Array<{ id: string; status: string; hendylinks_order_id: string }>) {
            if (duplicateIds.has(String(order.hendylinks_order_id))) {
                skippedDuplicateId++
                continue
            }
            const match = historyById.get(order.hendylinks_order_id)
            if (!match) {
                // WIPE ON CONFIRMED ABSENCE — mirrors the AgentPortal branch (see
                // syncAgentPortalOrdersById's doc comment for the full reasoning): a stuck
                // `processing` order whose hendylinks_order_id doesn't appear anywhere in
                // fetchAllOrderHistory's fetch is released back to `pending` with no supplier,
                // exactly like an order no supplier ever took. Scoped to `processing` only — a
                // `pending` HendyLinks order with an id already stamped would be a different,
                // unexpected situation not to guess about here.
                //
                // Gated on historyResult.complete (security review finding, 2026-08-25): a
                // "not found" from a PARTIAL fetch (a mid-walk page failure, or hitting
                // HISTORY_MAX_PAGES before reaching the true end of history) is not the same as
                // a genuine absence — it may just mean the order sits past whatever page this
                // particular walk happened to stop at. Only a `complete` walk (reached a short
                // final page or satisfied `total`) can be trusted to mean "genuinely absent".
                if (order.status === 'processing' && historyResult.complete) {
                    const { data: wipedRows, error: wipeError } = await (supabase.from('orders') as any)
                        .update({ status: 'pending', fulfillment_method: null, hendylinks_order_id: null, updated_at: new Date().toISOString() })
                        .eq('id', order.id)
                        .eq('status', 'processing')
                        .eq('fulfillment_method', 'hendylinks')
                        .select('id')
                    if (wipeError) {
                        errors.push(`Wipe failed for order ${order.id}: ${wipeError.message}`)
                    } else if (wipedRows && wipedRows.length > 0) {
                        console.warn(`[SyncSelection] Order ${order.id} confirmed absent from HendyLinks history (selection sync) — released back to pending, no supplier assigned.`)
                        wipedIds.push(order.id)
                    }
                }
                continue
            }

            const applyResult = await applyHendyLinksHistoryMatch(supabase, order, match, 'admin-reconciliation-selection')
            if (applyResult.error) {
                errors.push(`DB update failed for ${order.id}: ${applyResult.error}`)
                continue
            }
            if (applyResult.updated) updated++
        }

        return NextResponse.json({ success: true, checked, updated, skippedDuplicateId, wiped: wipedIds.length, wipedIds, notFoundInDbIds, errors })
    } catch (err: any) {
        console.error('[SyncSelection] Unexpected error:', err)
        return NextResponse.json({ success: false, error: err.message || 'Internal server error' }, { status: 500 })
    }
}
