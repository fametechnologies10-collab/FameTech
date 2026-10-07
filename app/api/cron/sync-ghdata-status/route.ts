// app/api/cron/sync-ghdata-status/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkGhDataOrderStatus } from '@/lib/ghdata-service'
import { validateCronAuth } from '@/lib/cron-utils'
import { syncShopOrderStatus } from '@/lib/shop-service'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const CONCURRENCY = 5

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    const supabase = createServerClient()
    let totalChecked = 0
    let totalUpdated = 0
    let totalFailed = 0
    const errors: string[] = []

    try {
        // Query `orders` directly by fulfillment_method + ghdata_order_id — no more
        // reconstructing references from a shared, size-capped tracking-log window (that
        // window crowds out low-volume suppliers as total order volume grows, so orders
        // could silently lose their reference and never get checked again).
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
            console.error('[CronSyncGhData] Orders query failed:', ordersError.message)
            return NextResponse.json({ error: ordersError.message }, { status: 500 })
        }

        if (!processingOrders || processingOrders.length === 0) {
            console.log('[CronSyncGhData] No processing GhData orders to check.')
            return NextResponse.json({ success: true, checked: 0, updated: 0, failed: 0, errors: [] })
        }

        console.log(`[CronSyncGhData] Checking ${processingOrders.length} processing GhData orders...`)

        const checkOne = async (order: { id: string; status: string; ghdata_order_id: string }) => {
            totalChecked++
            try {
                const result = await checkGhDataOrderStatus(order.ghdata_order_id)

                if (!result.success) {
                    console.warn(`[CronSyncGhData] Status check failed for order ${order.id} (ghdata: ${order.ghdata_order_id}): ${result.message}`)
                    return
                }

                const newStatus = result.status

                if (newStatus === 'processing') {
                    console.log(`[CronSyncGhData] Order ${order.id} still processing — skipping`)
                    return
                }

                // Guard: only update if still processing (prevents race conditions)
                const { error: updateError } = await (supabase
                    .from('orders') as any)
                    .update({ status: newStatus, updated_at: new Date().toISOString() })
                    .eq('id', order.id)
                    .eq('status', 'processing')

                if (updateError) {
                    console.error(`[CronSyncGhData] DB update failed for ${order.id}:`, updateError.message)
                    errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                    totalFailed++
                    return
                }

                console.log(`[CronSyncGhData] Order ${order.id} → ${newStatus} (ghdata: ${order.ghdata_order_id})`)

                await syncShopOrderStatus(order.id, newStatus).catch(err =>
                    console.error(`[CronSyncGhData] syncShopOrderStatus failed for ${order.id}:`, err)
                )

                if (newStatus === 'completed') {
                    try {
                        const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                        sendOrderCompletedPushNotification(order.id).catch(e =>
                            console.error('[CronSyncGhData] Push error:', e)
                        )
                    } catch {
                        // Non-fatal
                    }
                }

                totalUpdated++
            } catch (orderErr: any) {
                console.error(`[CronSyncGhData] Exception for order ${order.id}:`, orderErr.message)
                errors.push(`Exception for ${order.id}: ${orderErr.message}`)
                totalFailed++
            }
        }

        // Chunked concurrency — a serial loop over many stuck orders can push total runtime
        // past the function timeout, leaving orders later in the list unchecked every run.
        for (let i = 0; i < processingOrders.length; i += CONCURRENCY) {
            const chunk = processingOrders.slice(i, i + CONCURRENCY)
            await Promise.allSettled(chunk.map(checkOne))
        }
    } catch (err: any) {
        console.error('[CronSyncGhData] Fatal error:', err.message)
        errors.push(`Fatal: ${err.message}`)
    }

    console.log(`[CronSyncGhData] Done. checked=${totalChecked}, updated=${totalUpdated}, failed=${totalFailed}`)
    return NextResponse.json({
        success: true,
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        errors,
    })
}
