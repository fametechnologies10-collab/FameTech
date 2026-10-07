import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkGhDataOrderStatus } from '@/lib/ghdata-service'
import { validateAdminAccess } from '@/lib/auth-utils'
import { syncShopOrderStatus } from '@/lib/shop-service'

const CONCURRENCY = 5

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
        // Query `orders` directly by fulfillment_method + ghdata_order_id — no more
        // reconstructing references from a shared, size-capped tracking-log window.
        // Ordered oldest-first so the same stuck orders can't get starved run after run.
        const { data: processingOrders, error: ordersError } = await (supabase
            .from('orders') as any)
            .select('id, status, ghdata_order_id')
            .eq('status', 'processing')
            .eq('fulfillment_method', 'ghdata')
            .not('ghdata_order_id', 'is', null)
            .order('created_at', { ascending: true })
            .limit(100)

        if (ordersError) {
            return NextResponse.json({ error: `Orders query failed: ${ordersError.message}` }, { status: 500 })
        }

        if (!processingOrders || processingOrders.length === 0) {
            return NextResponse.json({ checked: 0, updated: 0, failed: 0, errors: [] })
        }

        const checkOne = async (order: { id: string; status: string; ghdata_order_id: string }) => {
            totalChecked++
            try {
                const result = await checkGhDataOrderStatus(order.ghdata_order_id)

                if (!result.success) {
                    console.warn(`[SyncGhData] Status check failed for order ${order.id} (ghdata: ${order.ghdata_order_id}): ${result.message}`)
                    return
                }

                const newStatus = result.status
                if (newStatus === 'processing') return

                const { error: updateError } = await (supabase
                    .from('orders') as any)
                    .update({ status: newStatus, updated_at: new Date().toISOString() })
                    .eq('id', order.id)
                    .eq('status', 'processing')

                if (updateError) {
                    errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                    totalFailed++
                    return
                }

                await syncShopOrderStatus(order.id, newStatus).catch(err =>
                    console.error(`[SyncGhData] syncShopOrderStatus failed for ${order.id}:`, err)
                )

                if (newStatus === 'completed') {
                    try {
                        const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                        sendOrderCompletedPushNotification(order.id).catch(e =>
                            console.error('[SyncGhData] Push error:', e)
                        )
                    } catch {
                        // Non-fatal — notification failure should not affect sync count
                    }
                }

                console.log(`[SyncGhData] Order ${order.id} updated to ${newStatus}`)
                totalUpdated++
            } catch (orderErr: any) {
                errors.push(`Exception for order ${order.id}: ${orderErr.message}`)
                totalFailed++
            }
        }

        for (let i = 0; i < processingOrders.length; i += CONCURRENCY) {
            const chunk = processingOrders.slice(i, i + CONCURRENCY)
            await Promise.allSettled(chunk.map(checkOne))
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
