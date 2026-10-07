import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkOrderStatus, mapSpfastitStatus } from '@/lib/spfastit-service'
import { validateCronAuth } from '@/lib/cron-utils'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'

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
        // Safety net for a dropped/never-sent webhook delivery — the webhook route (Task 8)
        // is the fast path, this cron is what guarantees an order never gets stuck forever.
        const { data: processingOrders, error: ordersError } = await (supabase
            .from('orders') as any)
            .select('id, status, spfastit_reference')
            .eq('status', 'processing')
            .eq('fulfillment_method', 'spfastit')
            .not('spfastit_reference', 'is', null)
            .order('created_at', { ascending: true })
            .limit(100)

        if (ordersError) {
            console.error('[CronSyncSpfastit] Orders query failed:', ordersError.message)
            return NextResponse.json({ error: ordersError.message }, { status: 500 })
        }

        if (!processingOrders || processingOrders.length === 0) {
            console.log('[CronSyncSpfastit] No processing SPFastIT orders to check.')
            return NextResponse.json({ success: true, checked: 0, updated: 0, failed: 0, errors: [] })
        }

        console.log(`[CronSyncSpfastit] Checking ${processingOrders.length} processing SPFastIT orders...`)

        const checkOne = async (order: { id: string; status: string; spfastit_reference: string }) => {
            totalChecked++
            try {
                const statusResult = await checkOrderStatus(order.spfastit_reference)

                if (!statusResult.success) {
                    console.warn(`[CronSyncSpfastit] Status check failed for order ${order.id} (ref: ${order.spfastit_reference}): ${statusResult.error}`)
                    return
                }

                const newStatus = mapSpfastitStatus(statusResult.orderStatus || '')

                if (newStatus === 'processing') {
                    console.log(`[CronSyncSpfastit] Order ${order.id} still processing — skipping`)
                    return
                }

                // Guard: only update if still processing (prevents a race with the webhook
                // or a concurrent cron run resolving it first).
                const { data: updatedRows, error: updateError } = await (supabase
                    .from('orders') as any)
                    .update({ status: newStatus, updated_at: new Date().toISOString() })
                    .eq('id', order.id)
                    .eq('status', 'processing')
                    .eq('fulfillment_method', 'spfastit')
                    .select('id')

                if (updateError) {
                    console.error(`[CronSyncSpfastit] DB update failed for ${order.id}:`, updateError.message)
                    errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                    totalFailed++
                    return
                }

                if (!updatedRows || updatedRows.length === 0) {
                    console.log(`[CronSyncSpfastit] Order ${order.id} was no longer 'processing' when applying ${newStatus} — a concurrent process already resolved it; skipping side effects`)
                    return
                }

                console.log(`[CronSyncSpfastit] Order ${order.id} → ${newStatus} (ref: ${order.spfastit_reference})`)

                await syncShopOrderStatus(order.id, newStatus).catch(err =>
                    console.error(`[CronSyncSpfastit] syncShopOrderStatus failed for ${order.id}:`, err)
                )

                if (newStatus === 'completed') {
                    try {
                        const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                        sendOrderCompletedPushNotification(order.id).catch(e =>
                            console.error('[CronSyncSpfastit] Push error:', e)
                        )
                    } catch {
                        // Non-fatal
                    }
                } else {
                    const { error: trackingError } = await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                        order_id: order.id,
                        status: 'failed',
                        api_response: { supplier: 'spfastit', source: 'cron_sweep', spfastit_status: statusResult.orderStatus, reference: order.spfastit_reference },
                    })
                    if (trackingError) console.error(`[CronSyncSpfastit] Tracking insert failed for ${order.id}:`, trackingError.message)
                }

                waitUntil(notifyDataOrderWebhook(
                    supabase, order.id,
                    newStatus === 'completed' ? 'order.completed' : 'order.failed',
                ))

                totalUpdated++
            } catch (orderErr: any) {
                console.error(`[CronSyncSpfastit] Exception for order ${order.id}:`, orderErr.message)
                errors.push(`Exception for ${order.id}: ${orderErr.message}`)
                totalFailed++
            }
        }

        for (let i = 0; i < processingOrders.length; i += CONCURRENCY) {
            const chunk = processingOrders.slice(i, i + CONCURRENCY)
            await Promise.allSettled(chunk.map(checkOne))
        }
    } catch (err: any) {
        console.error('[CronSyncSpfastit] Fatal error:', err.message)
        errors.push(`Fatal: ${err.message}`)
    }

    console.log(`[CronSyncSpfastit] Done. checked=${totalChecked}, updated=${totalUpdated}, failed=${totalFailed}`)
    return NextResponse.json({
        success: true,
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        errors,
    })
}
