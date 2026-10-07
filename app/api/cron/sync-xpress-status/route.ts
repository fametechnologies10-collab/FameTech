import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkOrderStatus } from '@/lib/xpress-service'
import { validateCronAuth } from '@/lib/cron-utils'
import { syncShopOrderStatus } from '@/lib/shop-service'

function mapItemStatus(xpressStatus: string): 'completed' | 'failed' | null {
    const s = (xpressStatus || '').toLowerCase()
    if (s === 'completed' || s === 'success') return 'completed'
    if (s === 'failed' || s === 'refunded') return 'failed'
    return null // pending / still processing — no change yet
}

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    const supabase = createServerClient()
    let totalChecked = 0
    let totalUpdated = 0
    let totalFailed = 0
    const errors: string[] = []

    try {
        // ── Step 1: get recent completed Xpress tracking records ──────────────
        const { data: trackingRecords, error: trackingError } = await (supabase
            .from('mtn_fulfillment_tracking') as any)
            .select('order_id, api_response')
            .eq('status', 'completed')
            .order('created_at', { ascending: false })
            .limit(300)

        if (trackingError) {
            console.error('[CronSyncXpress] Tracking query failed:', trackingError.message)
            return NextResponse.json({ error: trackingError.message }, { status: 500 })
        }

        // ── Step 2: build internalOrderId → xpressOrderId map ────────────────
        // Pass 1: record the most recent supplier per order (records are DESC, so first hit = newest).
        // Guards against re-polling a stale Xpress reference after an admin has reprocessed the
        // order via a different supplier — without this, the old Xpress result would overwrite
        // the in-progress re-attempt.
        const mostRecentSupplierMap = new Map<string, string>()
        for (const t of trackingRecords || []) {
            if (mostRecentSupplierMap.has(t.order_id)) continue
            const s = (t.api_response?.supplier || '').toLowerCase()
            const n = (t.api_response?.note || '').toLowerCase()
            mostRecentSupplierMap.set(
                t.order_id,
                s || (n.includes('via xpress') ? 'xpress' : n.includes('codecraft') ? 'codecraft' : n.includes('datakazina') ? 'datakazina' : '')
            )
        }

        // Pass 2: build the map, skipping any order whose most recent attempt used a different supplier
        const xpressTrackingMap = new Map<string, string>()
        for (const t of trackingRecords || []) {
            if (xpressTrackingMap.has(t.order_id)) continue // keep most recent (DESC order)

            // If this order was reprocessed by another supplier, its old Xpress reference is stale
            if (mostRecentSupplierMap.get(t.order_id) !== 'xpress') continue

            const supplier: string = t.api_response?.supplier || ''
            const note: string = t.api_response?.note || ''
            const isXpress = supplier === 'xpress' || note.toLowerCase().includes('via xpress')
            // order_id field is the Xpress batch order_id (set by both purchase and shop routes)
            const xpressOrderId: string = t.api_response?.order_id || ''
            if (isXpress && xpressOrderId) {
                xpressTrackingMap.set(t.order_id, xpressOrderId)
            }
        }

        if (xpressTrackingMap.size === 0) {
            console.log('[CronSyncXpress] No Xpress orders found in tracking records.')
            return NextResponse.json({ success: true, checked: 0, updated: 0, failed: 0, errors: [] })
        }

        // ── Step 3: filter to only orders currently in "processing" ───────────
        const internalOrderIds = Array.from(xpressTrackingMap.keys())
        const { data: processingOrders, error: ordersError } = await (supabase
            .from('orders') as any)
            .select('id, status, shop_order_id')
            .in('id', internalOrderIds)
            .eq('status', 'processing') // cron only touches processing orders
            .limit(50)

        if (ordersError) {
            console.error('[CronSyncXpress] Orders query failed:', ordersError.message)
            return NextResponse.json({ error: ordersError.message }, { status: 500 })
        }

        if (!processingOrders || processingOrders.length === 0) {
            console.log('[CronSyncXpress] No processing Xpress orders to check.')
            return NextResponse.json({ success: true, checked: 0, updated: 0, failed: 0, errors: [] })
        }

        console.log(`[CronSyncXpress] Checking ${processingOrders.length} processing Xpress orders...`)

        // ── Step 4: poll Xpress API for each and update ───────────────────────
        for (const order of processingOrders) {
            const xpressOrderId = xpressTrackingMap.get(order.id)
            if (!xpressOrderId) continue

            totalChecked++
            try {
                const result = await checkOrderStatus(xpressOrderId)

                if (!result.success || !result.items) {
                    console.warn(`[CronSyncXpress] Could not fetch status for Xpress order ${xpressOrderId}: ${result.error}`)
                    continue
                }

                // For main-site orders: reference = orders.id
                // For shop orders: reference = shop_orders.id (fulfillOrder was called with shopOrderId)
                // Fallback: single-item orders always have exactly one item
                const item = result.items.find(i =>
                    i.reference === order.id ||
                    (order.shop_order_id && i.reference === order.shop_order_id)
                ) ?? (result.items.length === 1 ? result.items[0] : undefined)
                if (!item) {
                    console.warn(`[CronSyncXpress] No item matching order ${order.id} in Xpress order ${xpressOrderId}`)
                    continue
                }

                const newStatus = mapItemStatus(item.status)
                if (!newStatus) {
                    console.log(`[CronSyncXpress] Order ${order.id} item status "${item.status}" — no change yet`)
                    continue
                }

                // Update internal order (guard: only change if still processing)
                const { error: updateError } = await (supabase
                    .from('orders') as any)
                    .update({ status: newStatus, updated_at: new Date().toISOString() })
                    .eq('id', order.id)
                    .eq('status', 'processing')

                if (updateError) {
                    console.error(`[CronSyncXpress] DB update failed for ${order.id}:`, updateError.message)
                    errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                    totalFailed++
                    continue
                }

                // Sync shop storefront
                await syncShopOrderStatus(order.id, newStatus).catch(err =>
                    console.error(`[CronSyncXpress] syncShopOrderStatus failed for ${order.id}:`, err)
                )

                // Push notification on delivery
                if (newStatus === 'completed') {
                    try {
                        const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                        sendOrderCompletedPushNotification(order.id).catch(e =>
                            console.error('[CronSyncXpress] Push error:', e)
                        )
                    } catch {
                        // Non-fatal
                    }
                }

                console.log(`[CronSyncXpress] Order ${order.id} → ${newStatus}`)
                totalUpdated++
            } catch (orderErr: any) {
                console.error(`[CronSyncXpress] Exception for order ${order.id}:`, orderErr.message)
                errors.push(`Exception for ${order.id}: ${orderErr.message}`)
                totalFailed++
            }
        }
    } catch (err: any) {
        console.error('[CronSyncXpress] Fatal error:', err.message)
        errors.push(`Fatal: ${err.message}`)
    }

    console.log(`[CronSyncXpress] Done. checked=${totalChecked}, updated=${totalUpdated}, failed=${totalFailed}`)
    return NextResponse.json({
        success: true,
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        errors,
    })
}
