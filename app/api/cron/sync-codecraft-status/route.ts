import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkOrderStatus } from '@/lib/codecraft-service'
import { validateCronAuth } from '@/lib/cron-utils'
import { syncShopOrderStatus } from '@/lib/shop-service'

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
        // Query `orders` directly by fulfillment_method + codecraft_reference — no more
        // reconstructing references from a shared, size-capped tracking-log window (that
        // window crowds out low-volume suppliers as total order volume grows, so orders
        // could silently lose their reference and never get checked again).
        // Ordered oldest-first so the same stuck orders can't get starved run after run.
        const { data: processingOrders, error: ordersError } = await (supabase
            .from('orders') as any)
            .select('id, status, codecraft_reference')
            .eq('status', 'processing')
            .eq('fulfillment_method', 'codecraft')
            .not('codecraft_reference', 'is', null)
            .order('created_at', { ascending: true })
            .limit(100)

        if (ordersError) {
            console.error('[CronSyncCodeCraft] Orders query failed:', ordersError.message)
            return NextResponse.json({ error: ordersError.message }, { status: 500 })
        }

        if (!processingOrders || processingOrders.length === 0) {
            console.log('[CronSyncCodeCraft] No processing CodeCraft orders to check.')
            return NextResponse.json({ success: true, checked: 0, updated: 0, failed: 0, errors: [] })
        }

        console.log(`[CronSyncCodeCraft] Checking ${processingOrders.length} processing CodeCraft orders...`)

        const checkOne = async (order: { id: string; status: string; codecraft_reference: string }) => {
            totalChecked++
            try {
                const statusResult = await checkOrderStatus(order.codecraft_reference)

                if (!statusResult.success) {
                    console.warn(`[CronSyncCodeCraft] Status check failed for order ${order.id} (ref: ${order.codecraft_reference}): ${statusResult.message}`)
                    return
                }

                const newStatus = statusResult.status

                if (newStatus === 'processing' || newStatus === order.status) {
                    console.log(`[CronSyncCodeCraft] Order ${order.id} still ${newStatus} — skipping`)
                    return
                }

                // Guard: only update if still processing (prevents race conditions)
                const { error: updateError } = await (supabase
                    .from('orders') as any)
                    .update({ status: newStatus, updated_at: new Date().toISOString() })
                    .eq('id', order.id)
                    .eq('status', 'processing')

                if (updateError) {
                    console.error(`[CronSyncCodeCraft] DB update failed for ${order.id}:`, updateError.message)
                    errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                    totalFailed++
                    return
                }

                console.log(`[CronSyncCodeCraft] Order ${order.id} → ${newStatus} (ref: ${order.codecraft_reference})`)

                await syncShopOrderStatus(order.id, newStatus).catch(err =>
                    console.error(`[CronSyncCodeCraft] syncShopOrderStatus failed for ${order.id}:`, err)
                )

                if (newStatus === 'completed') {
                    try {
                        const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                        sendOrderCompletedPushNotification(order.id).catch(e =>
                            console.error('[CronSyncCodeCraft] Push error:', e)
                        )
                    } catch {
                        // Non-fatal
                    }
                }

                totalUpdated++
            } catch (orderErr: any) {
                console.error(`[CronSyncCodeCraft] Exception for order ${order.id}:`, orderErr.message)
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
        console.error('[CronSyncCodeCraft] Fatal error:', err.message)
        errors.push(`Fatal: ${err.message}`)
    }

    console.log(`[CronSyncCodeCraft] Done. checked=${totalChecked}, updated=${totalUpdated}, failed=${totalFailed}`)
    return NextResponse.json({
        success: true,
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        errors,
    })
}
