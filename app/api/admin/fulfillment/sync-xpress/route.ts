import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkOrderStatus } from '@/lib/xpress-service'
import { validateAdminAccess } from '@/lib/auth-utils'
import { syncShopOrderStatus } from '@/lib/shop-service'

// Maps Xpress item status → our internal status
// Returns null when no action is needed (item still pending/processing)
function mapItemStatus(xpressStatus: string): 'completed' | 'failed' | null {
    const s = (xpressStatus || '').toLowerCase()
    if (s === 'completed') return 'completed'
    if (s === 'failed' || s === 'refunded') return 'failed'
    return null
}

export async function POST(request: NextRequest) {
    const authResult = await validateAdminAccess(true, request)
    if (authResult.error) {
        return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    const supabase = createServerClient()
    let totalChecked = 0
    let totalUpdated = 0
    let totalFailed = 0
    const errors: string[] = []

    try {
        // ── Step 1: get recent completed tracking records ─────────────────────
        // Xpress tracking entries have note = "... via xpress" and api_response.order_id
        const { data: trackingRecords, error: trackingError } = await (supabase
            .from('mtn_fulfillment_tracking') as any)
            .select('order_id, api_response')
            .eq('status', 'completed')
            .order('created_at', { ascending: false })
            .limit(300)

        if (trackingError) {
            return NextResponse.json({ error: `Tracking query failed: ${trackingError.message}` }, { status: 500 })
        }

        // ── Step 2: build map of internalOrderId → xpressOrderId (most recent) ─
        const xpressTrackingMap = new Map<string, string>()
        for (const t of trackingRecords || []) {
            if (xpressTrackingMap.has(t.order_id)) continue // keep most recent (DESC order)
            const note: string = t.api_response?.note || ''
            const xpressOrderId: string = t.api_response?.order_id || ''
            if (note.includes('via xpress') && xpressOrderId) {
                xpressTrackingMap.set(t.order_id, xpressOrderId)
            }
        }

        if (xpressTrackingMap.size === 0) {
            return NextResponse.json({ checked: 0, updated: 0, failed: 0, errors: [] })
        }

        // ── Step 3: filter to only orders still in processing ─────────────────
        const internalOrderIds = Array.from(xpressTrackingMap.keys())
        const { data: processingOrders, error: ordersError } = await (supabase
            .from('orders') as any)
            .select('id, status, shop_order_id')
            .in('id', internalOrderIds)
            .eq('status', 'processing')
            .limit(100)

        if (ordersError) {
            return NextResponse.json({ error: `Orders query failed: ${ordersError.message}` }, { status: 500 })
        }

        if (!processingOrders || processingOrders.length === 0) {
            return NextResponse.json({ checked: 0, updated: 0, failed: 0, errors: [] })
        }

        // ── Step 4: call Xpress API for each and update ───────────────────────
        for (const order of processingOrders) {
            const xpressOrderId = xpressTrackingMap.get(order.id)
            if (!xpressOrderId) continue

            totalChecked++
            try {
                const result = await checkOrderStatus(xpressOrderId)
                if (!result.success || !result.items) {
                    console.warn(`[SyncXpress] Could not fetch status for Xpress order ${xpressOrderId}: ${result.error}`)
                    continue
                }

                // Xpress item.reference = our internal order ID (set when we placed the order)
                const item = result.items.find(i => i.reference === order.id)
                if (!item) {
                    console.warn(`[SyncXpress] No item matching order ${order.id} in Xpress order ${xpressOrderId}`)
                    continue
                }

                const newStatus = mapItemStatus(item.status)
                if (!newStatus) {
                    console.log(`[SyncXpress] Order ${order.id} item status "${item.status}" — no change yet`)
                    continue
                }

                // Update internal order (guard against race condition)
                const { error: updateError } = await (supabase
                    .from('orders') as any)
                    .update({ status: newStatus, updated_at: new Date().toISOString() })
                    .eq('id', order.id)
                    .eq('status', 'processing')

                if (updateError) {
                    errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                    totalFailed++
                    continue
                }

                // Sync shop storefront status
                await syncShopOrderStatus(order.id, newStatus).catch(err =>
                    console.error(`[SyncXpress] syncShopOrderStatus failed for ${order.id}:`, err)
                )

                // Push notification on delivery
                if (newStatus === 'completed') {
                    try {
                        const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                        sendOrderCompletedPushNotification(order.id).catch(e =>
                            console.error('[SyncXpress] Push error:', e)
                        )
                    } catch {
                        // Non-fatal — notification failure should not affect sync count
                    }
                }

                console.log(`[SyncXpress] Order ${order.id} updated to ${newStatus}`)
                totalUpdated++
            } catch (orderErr: any) {
                errors.push(`Exception for order ${order.id}: ${orderErr.message}`)
                totalFailed++
            }
        }
    } catch (err: any) {
        errors.push(`Sync failed: ${err.message}`)
    }

    return NextResponse.json({
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        errors,
    })
}
