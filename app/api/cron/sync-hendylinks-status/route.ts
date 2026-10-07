import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { fetchAllOrderHistory, applyHendyLinksHistoryMatch } from '@/lib/hendylinks-service'
import { validateCronAuth } from '@/lib/cron-utils'

// Safety-net only — HendyLinks orders are primarily resolved by the webhook
// (app/api/webhooks/hendylinks/route.ts). This sweep only touches orders old enough that a
// webhook should have already arrived.
//
// 10 minutes, NOT 30, and the reason is scheduling, not webhook latency:
// app/api/cron/auto-complete-data runs every 10 minutes and flips ANY 'processing' order older
// than admin setting `auto_complete_data_threshold_mins` (default 30) to 'completed',
// regardless of supplier. At an equal 30-minute threshold auto-complete usually won the race,
// so a genuinely FAILED HendyLinks order was silently auto-completed instead of reconciled
// here. This threshold MUST stay comfortably below auto_complete_data_threshold_mins — if that
// admin setting is ever lowered, lower this with it.
const STUCK_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes — must beat auto-complete-data's threshold
const HISTORY_PAGE_SIZE = 100

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    const supabase = createServerClient()
    let totalChecked = 0
    let totalUpdated = 0
    let totalFailed = 0
    let totalSkippedDuplicateId = 0
    const errors: string[] = []

    try {
        const cutoffIso = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString()

        const { data: processingOrders, error: ordersError } = await (supabase
            .from('orders') as any)
            .select('id, status, hendylinks_order_id')
            .eq('status', 'processing')
            .eq('fulfillment_method', 'hendylinks')
            .not('hendylinks_order_id', 'is', null)
            .lt('updated_at', cutoffIso)
            .order('created_at', { ascending: true })
            .limit(100)

        if (ordersError) {
            console.error('[CronSyncHendyLinks] Orders query failed:', ordersError.message)
            return NextResponse.json({ error: ordersError.message }, { status: 500 })
        }

        if (!processingOrders || processingOrders.length === 0) {
            console.log('[CronSyncHendyLinks] No stuck processing HendyLinks orders to check.')
            return NextResponse.json({ success: true, checked: 0, updated: 0, failed: 0, skippedDuplicateId: 0, errors: [] })
        }

        console.log(`[CronSyncHendyLinks] Checking ${processingOrders.length} stuck processing HendyLinks orders...`)

        // Walk the FULL history, not just the first page — a stuck order is by definition an
        // older one, so it is exactly the row a single-page fetch drops first.
        const historyResult = await fetchAllOrderHistory(HISTORY_PAGE_SIZE)
        if (!historyResult.success) {
            console.warn(`[CronSyncHendyLinks] fetchAllOrderHistory failed: ${historyResult.error} — skipping this run`)
            return NextResponse.json({ success: true, checked: 0, updated: 0, failed: 0, skippedDuplicateId: 0, errors: [historyResult.error || 'fetchAllOrderHistory failed'] })
        }

        const historyById = new Map(historyResult.orders.map(o => [String(o.id), o]))

        // Collision guard: any hendylinks_order_id held by MORE THAN ONE row in this batch
        // cannot be resolved. The map below is keyed by supplier id, so applying an external
        // status would force BOTH local rows to one external order's outcome. Skip those rows
        // entirely, log loudly, and count them separately from successes/failures so the run
        // summary stays honest. This needs a human.
        const idCounts = new Map<string, number>()
        for (const o of processingOrders as Array<{ hendylinks_order_id: string }>) {
            const key = String(o.hendylinks_order_id)
            idCounts.set(key, (idCounts.get(key) || 0) + 1)
        }
        const duplicateIds = new Set(
            Array.from(idCounts.entries()).filter(([, count]) => count > 1).map(([id]) => id)
        )
        if (duplicateIds.size > 0) {
            const msg = `DUPLICATE-SUPPLIER-ID: ${duplicateIds.size} hendylinks_order_id value(s) are held by more than one order in this batch (${Array.from(duplicateIds).join(', ')}) — those orders are SKIPPED, no status applied. MANUAL RECONCILIATION REQUIRED.`
            console.error(`[CronSyncHendyLinks] ${msg}`)
            errors.push(msg)
        }

        for (const order of processingOrders as Array<{ id: string; status: string; hendylinks_order_id: string }>) {
            totalChecked++
            try {
                if (duplicateIds.has(String(order.hendylinks_order_id))) {
                    console.error(`[CronSyncHendyLinks] Order ${order.id} skipped — its hendylinks_order_id=${order.hendylinks_order_id} is shared with another order in this batch.`)
                    totalSkippedDuplicateId++
                    continue
                }

                const match = historyById.get(order.hendylinks_order_id)
                if (!match) {
                    // Not in the most recent page — logged and skipped, not treated as failure.
                    console.log(`[CronSyncHendyLinks] Order ${order.id} (hendylinks_order_id=${order.hendylinks_order_id}) not found in recent history — skipping`)
                    continue
                }

                // Applies the match through the SAME path as the admin sync and the
                // selection-scoped sync — see lib/hendylinks-service.ts for why. `status:
                // 'processing'` is passed explicitly (not order.status) since this sweep's
                // SELECT is already scoped to status='processing' — see the guard comment on
                // applyHendyLinksHistoryMatch for the fulfillment_method race this repeats.
                const applyResult = await applyHendyLinksHistoryMatch(supabase, { id: order.id, status: 'processing' }, match, 'cron-reconciliation')
                if (applyResult.error) {
                    console.error(`[CronSyncHendyLinks] DB update failed for ${order.id}:`, applyResult.error)
                    errors.push(`DB update failed for ${order.id}: ${applyResult.error}`)
                    totalFailed++
                    continue
                }
                if (!applyResult.updated) {
                    console.log(`[CronSyncHendyLinks] Order ${order.id} still ${match.status} — skipping`)
                    continue
                }

                console.log(`[CronSyncHendyLinks] Order ${order.id} → ${match.status} (hendylinks_order_id=${order.hendylinks_order_id})`)
                totalUpdated++
            } catch (orderErr: any) {
                console.error(`[CronSyncHendyLinks] Exception for order ${order.id}:`, orderErr.message)
                errors.push(`Exception for ${order.id}: ${orderErr.message}`)
                totalFailed++
            }
        }
    } catch (err: any) {
        console.error('[CronSyncHendyLinks] Fatal error:', err.message)
        errors.push(`Fatal: ${err.message}`)
    }

    console.log(`[CronSyncHendyLinks] Done. checked=${totalChecked}, updated=${totalUpdated}, failed=${totalFailed}, skippedDuplicateId=${totalSkippedDuplicateId}`)
    return NextResponse.json({
        success: true,
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        skippedDuplicateId: totalSkippedDuplicateId,
        errors,
    })
}
