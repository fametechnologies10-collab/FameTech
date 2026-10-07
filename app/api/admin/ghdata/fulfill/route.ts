import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { fulfillGhDataOrder } from '@/lib/ghdata-service'
import { claimBulkForDispatch, acceptBulkDispatch, releaseBulkClaims } from '@/lib/dispatch-claim'

export async function POST(request: Request) {
    try {
        const authResult = await validateAdminAccess(true, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }

        const body = await request.json()
        const { orderIds } = body

        if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
            return NextResponse.json({ error: 'No order IDs provided' }, { status: 400 })
        }

        const supabase = createServerClient()

        const { data: ordersToProcess, error: fetchError } = await (supabase as any)
            .from('orders')
            .select('id, network, phone_number, size, status, user_id, category')
            .in('id', orderIds)
            .eq('status', 'pending')
            .neq('category', 'mtn_mashup') // mashup orders are fulfilled manually only

        if (fetchError) return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 })
        if (!ordersToProcess || ordersToProcess.length === 0) {
            return NextResponse.json({ error: 'No valid pending orders found for the given IDs.' }, { status: 400 })
        }

        // Claim (NOT a status flip — see lib/dispatch-claim.ts) so a concurrent call
        // (double-click, retry) cannot pick up the same order twice. orders.status stays
        // 'pending' through the whole dispatch attempt; fulfillment_method is still
        // stamped at claim time — same convention as lib/fulfillment-trigger.ts /
        // lib/shop-order-processor.ts — so the Admin Fulfillment Center's supplier tag
        // (lib/order-supplier.ts's resolveSupplier) always reflects the latest dispatch
        // attempt, not a stale mtn_fulfillment_tracking row from an earlier one.
        const lockedIds = await claimBulkForDispatch(supabase, (ordersToProcess as any[]).map(o => o.id), 'ghdata')
        const lockedOrders = (ordersToProcess as { id: string; network: string; phone_number: string; size: string; status: string; user_id: string; category?: string }[])
            .filter(o => lockedIds.has(o.id))

        if (lockedOrders.length === 0) {
            return NextResponse.json({ error: 'All requested orders were locked by a concurrent process.' }, { status: 409 })
        }

        let fulfilledCount = 0
        let failedCount = 0
        const results = []

        for (const order of lockedOrders) {
            // Defense-in-depth: reject mashup orders even if they somehow passed the query filter
            if (order.category === 'mtn_mashup') {
                console.warn(`[GhData Fulfill] Skipping mashup order ${order.id} — manual fulfillment only`)
                await releaseBulkClaims(supabase, [order.id])
                results.push({ id: order.id, success: false, error: 'Mashup orders must be fulfilled manually' })
                failedCount++
                continue
            }
            console.log(`[GhData Fulfill] Processing order: ${order.id} | ${order.network} | ${order.phone_number}`)

            let result: Awaited<ReturnType<typeof fulfillGhDataOrder>>
            try {
                result = await fulfillGhDataOrder(order.network, order.phone_number, order.size, order.id)
            } catch (supplierErr: any) {
                console.error(`[GhData Fulfill] Supplier exception for order ${order.id}:`, supplierErr)
                await releaseBulkClaims(supabase, [order.id])
                failedCount++
                results.push({ id: order.id, success: false, error: supplierErr?.message || 'Supplier exception' })
                continue
            }

            if (result.success) {
                const acceptedIds = await acceptBulkDispatch(supabase, [order.id])
                if (!acceptedIds.has(order.id)) {
                    console.log(`[GhData Fulfill] Accept was a no-op for order ${order.id} — a webhook already resolved it before this bookkeeping ran`)
                    results.push({ id: order.id, success: false, error: 'Order was already resolved by a concurrent process' })
                    continue
                }

                await (supabase as any)
                    .from('mtn_fulfillment_tracking')
                    .insert({
                        order_id: order.id,
                        status: 'completed', // 'completed' so cron can find and poll it
                        retry_count: 0,
                        api_response: {
                            supplier: 'ghdata',
                            note: 'Manual GhData Fulfillment Success',
                            ghdata_order_id: result.ghdataOrderId,
                            ghdata_short_id: result.ghdataShortId,
                            ghdata_response: result.apiResponse,
                        }
                    })

                fulfilledCount++
                results.push({ id: order.id, success: true, status: 'processing' })
            } else {
                // Definite failure — release the claim so the order can be retried.
                // fulfillGhDataOrder never sets `ambiguous`, so every failure here is a
                // safe, definite one (no double-charge/double-deliver risk from releasing).
                await releaseBulkClaims(supabase, [order.id])

                await (supabase as any)
                    .from('mtn_fulfillment_tracking')
                    .insert({
                        order_id: order.id,
                        status: 'failed',
                        retry_count: 0,
                        api_response: {
                            supplier: 'ghdata',
                            note: 'Manual GhData Fulfillment Failed',
                            error: result.error,
                            ghdata_response: result.apiResponse,
                        }
                    })

                failedCount++
                results.push({ id: order.id, success: false, error: result.error })
            }
        }

        return NextResponse.json({
            success: true,
            message: `Processed ${fulfilledCount + failedCount} orders`,
            fulfilled: fulfilledCount,
            failed: failedCount,
            results,
        })
    } catch (error: any) {
        console.error('[GhData Manual Fulfill] Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
