import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkOrderStatus, mapSpfastitStatus } from '@/lib/spfastit-service'
import { validateAdminAccess } from '@/lib/auth-utils'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'

const CONCURRENCY = 5

async function runInChunks<T>(items: T[], worker: (item: T) => Promise<void>) {
    for (let i = 0; i < items.length; i += CONCURRENCY) {
        await Promise.allSettled(items.slice(i, i + CONCURRENCY).map(worker))
    }
}

/**
 * Admin-triggered twin of app/api/cron/sync-spfastit-status/route.ts — same query, same
 * per-order lookup, same double-filtered UPDATE (status='processing' AND
 * fulfillment_method='spfastit'), same side-effect gating on rows actually affected. Per
 * kingflexy-fulfillment checklist item 23, a route and its cron twin must gate identically;
 * this is deliberately NOT a hand-rolled reimplementation of that logic, to keep the two from
 * drifting apart the way Bundle Portal's admin/cron pair once did.
 */
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
        const { data: processingOrders, error: ordersError } = await (supabase
            .from('orders') as any)
            .select('id, status, spfastit_reference')
            .eq('status', 'processing')
            .eq('fulfillment_method', 'spfastit')
            .not('spfastit_reference', 'is', null)
            .order('created_at', { ascending: true })
            .limit(100)

        if (ordersError) {
            console.error('[SyncSpfastit] Orders query failed:', ordersError.message)
            return NextResponse.json({ error: ordersError.message }, { status: 500 })
        }

        if (!processingOrders || processingOrders.length === 0) {
            return NextResponse.json({ checked: 0, updated: 0, failed: 0, errors: [] })
        }

        await runInChunks(processingOrders, async (order: any) => {
            totalChecked++
            try {
                const statusResult = await checkOrderStatus(order.spfastit_reference)

                if (!statusResult.success) {
                    console.warn(`[SyncSpfastit] Status check failed for order ${order.id} (ref: ${order.spfastit_reference}): ${statusResult.error}`)
                    return
                }

                const newStatus = mapSpfastitStatus(statusResult.orderStatus || '')
                if (newStatus === 'processing') return

                const { data: updatedRows, error: updateError } = await (supabase
                    .from('orders') as any)
                    .update({ status: newStatus, updated_at: new Date().toISOString() })
                    .eq('id', order.id)
                    .eq('status', 'processing')
                    .eq('fulfillment_method', 'spfastit')
                    .select('id')

                if (updateError) {
                    console.error(`[SyncSpfastit] DB update failed for ${order.id}:`, updateError.message)
                    errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                    totalFailed++
                    return
                }

                if (!updatedRows || updatedRows.length === 0) {
                    console.log(`[SyncSpfastit] Order ${order.id} was no longer 'processing' — a concurrent process already resolved it; skipping side effects`)
                    return
                }

                await syncShopOrderStatus(order.id, newStatus).catch(err =>
                    console.error(`[SyncSpfastit] syncShopOrderStatus failed for ${order.id}:`, err)
                )

                if (newStatus === 'completed') {
                    try {
                        const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                        sendOrderCompletedPushNotification(order.id).catch(e => console.error('[SyncSpfastit] Push error:', e))
                    } catch {
                        // Non-fatal
                    }
                } else {
                    const { error: trackingError } = await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                        order_id: order.id,
                        status: 'failed',
                        api_response: { supplier: 'spfastit', source: 'admin_sync', spfastit_status: statusResult.orderStatus, reference: order.spfastit_reference },
                    })
                    if (trackingError) console.error(`[SyncSpfastit] Tracking insert failed for ${order.id}:`, trackingError.message)
                }

                waitUntil(notifyDataOrderWebhook(
                    supabase, order.id,
                    newStatus === 'completed' ? 'order.completed' : 'order.failed',
                ))

                totalUpdated++
            } catch (orderErr: any) {
                errors.push(`Exception for ${order.id}: ${orderErr.message}`)
                totalFailed++
            }
        })
    } catch (err: any) {
        console.error('[SyncSpfastit] Fatal error:', err.message)
        errors.push(`Fatal: ${err.message}`)
    }

    return NextResponse.json({
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        errors,
    })
}
