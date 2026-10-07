import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { cookies } from 'next/headers'
import { fulfillDataGodOrder } from '@/lib/datagod-service'

export async function POST(request: Request) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin' && userData?.role !== 'sub-admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const body = await request.json()
        const { orderIds } = body

        if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
            return NextResponse.json({ error: 'No order IDs provided' }, { status: 400 })
        }

        const supabase = createServerClient()
        
        let fulfilledCount = 0
        let failedCount = 0
        const results = []

        // Fetch selected orders that are pending and not mashup (defense-in-depth)
        const { data: ordersToProcess, error: fetchError } = await (supabase as any)
            .from('orders')
            .select('id, network, phone_number, size, status, user_id, category')
            .in('id', orderIds)
            .eq('status', 'pending')
            .neq('category', 'mtn_mashup')

        if (fetchError) {
            console.error('[DataGod Fulfill] Fetch error:', fetchError)
            return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 })
        }

        if (!ordersToProcess || ordersToProcess.length === 0) {
            return NextResponse.json({ error: 'No valid pending orders found for the given IDs.' }, { status: 400 })
        }

        interface PendingOrder {
            id: string;
            network: string;
            phone_number: string;
            size: string;
            status: string;
            user_id: string;
            category?: string;
        }

        // Process sequentially to respect potential rate limits
        for (const order of (ordersToProcess as PendingOrder[])) {
            // Defense-in-depth: reject mashup orders even if they somehow passed the query filter
            if (order.category === 'mtn_mashup') {
                console.warn(`[DataGod Fulfill] Skipping mashup order ${order.id} — manual fulfillment only`)
                results.push({ id: order.id, success: false, error: 'Mashup orders must be fulfilled manually' })
                failedCount++
                continue
            }
            console.log(`[DataGod Fulfill] Processing order: ${order.id} | ${order.network} | ${order.phone_number}`);
            
            // Generate unique reference (using our order ID)
            const reference = `dg_${order.id}_${Date.now().toString().slice(-6)}`

            // Make the API request
            const result = await fulfillDataGodOrder(
                order.network,
                order.phone_number,
                order.size,
                reference
            )

            if (result.success) {
                // Determine new status. Usually APIs return success but still need to be checked later,
                // so we mark as processing and let a status checker or admin confirm. The docs say 
                // standalone orders might complete immediately or go queued.
                const nextStatus: 'pending' | 'processing' | 'completed' | 'failed' = result.apiResponse?.status === 'success' || result.apiResponse?.data?.status === 'success' ? 'completed' : 'processing'

                // Stamps fulfillment_method alongside status — same convention as
                // lib/fulfillment-trigger.ts / lib/shop-order-processor.ts / the ghdata
                // fulfill route — so the Admin Fulfillment Center's supplier tag
                // (lib/order-supplier.ts's resolveSupplier) always reflects the latest
                // dispatch attempt, not a stale mtn_fulfillment_tracking row from an
                // earlier one.
                const { error: updateError } = await (supabase as any)
                    .from('orders')
                    .update({ status: nextStatus, fulfillment_method: 'datagod' })
                    .eq('id', order.id)

                if (updateError) {
                    // DataGod already delivered the bundle and charged us — do NOT treat
                    // this as a normal failure that a future manual re-fulfill retries
                    // (that would double-charge us for one delivery). Still log a tracking
                    // row (so the delivery is recorded) but surface it as a failed result
                    // so the admin sees it needs manual reconciliation instead of silently
                    // counting toward fulfilledCount while the order is stuck in 'pending'.
                    console.error(`[DataGod Fulfill] Order update failed after successful DataGod dispatch for ${order.id} — order left in its prior status, NOT counted as fulfilled. Needs manual reconciliation:`, updateError)
                    await (supabase as any)
                        .from('mtn_fulfillment_tracking')
                        .insert({
                            order_id: order.id,
                            status: nextStatus,
                            retry_count: 0,
                            api_response: {
                                supplier: 'datagod',
                                note: 'Manual DataGod Fulfillment Success, but orders row UPDATE failed — needs manual reconciliation',
                                datagod_response: result.apiResponse,
                                reference: result.reference,
                                orders_update_error: updateError.message,
                            }
                        })
                    failedCount++
                    results.push({ id: order.id, success: false, error: `DataGod delivered successfully but the order record could not be updated (${updateError.message}) — needs manual reconciliation, do not re-fulfill` })
                    continue
                }

                // Log into fulfillment tracking
                await (supabase as any)
                    .from('mtn_fulfillment_tracking')
                    .insert({
                        order_id: order.id,
                        status: nextStatus,
                        retry_count: 0,
                        api_response: {
                            supplier: 'datagod',
                            note: 'Manual DataGod Fulfillment Success',
                            datagod_response: result.apiResponse,
                            reference: result.reference
                        }
                    })

                fulfilledCount++
                results.push({ id: order.id, success: true, status: nextStatus, message: 'Processed' })
            } else {
                // Log failure into tracking but keep order status as pending
                await (supabase as any)
                    .from('mtn_fulfillment_tracking')
                    .insert({
                        order_id: order.id,
                        status: 'failed',
                        retry_count: 0,
                        api_response: {
                            supplier: 'datagod_failed',
                            note: 'Manual DataGod Fulfillment Failed',
                            error: result.error,
                            datagod_response: result.apiResponse,
                            reference: reference
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
            results
        })

    } catch (error: any) {
        console.error('DataGod Manual Fulfill Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
