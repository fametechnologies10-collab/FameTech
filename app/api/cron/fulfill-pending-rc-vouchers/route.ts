import { NextResponse } from 'next/server'
import { validateCronAuth } from '@/lib/cron-utils'
import { createServerClient } from '@/lib/supabase'
import { fulfillPendingRCOrders } from '@/lib/results-checker-service'
import { resendVouchers } from '@/lib/results-checker-notification-service'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
    try {
        const authError = validateCronAuth(request)
        if (authError) {
            return authError
        }

        const supabase = createServerClient()
        const db = supabase as any

        // 1. BACKORDER FULFILLMENT: Find all active RC types and process their pending queues
        const { data: types } = await db
            .from('results_checker_types')
            .select('id')
            .eq('is_active', true)

        let processedBackorders = 0
        if (types && types.length > 0) {
            for (const type of types) {
                // fulfillPendingRCOrders handles the querying, locking, and processing internally
                await fulfillPendingRCOrders(type.id).catch(e => {
                    console.error(`[Cron RC] Backorder Error for type ${type.id}:`, e)
                })
                processedBackorders++
            }
        }

        // 2. DELIVERY RETRY: Find completed orders with missing delivered_via
        const { data: undeliveredOrders } = await db
            .from('results_checker_orders')
            .select('id')
            .eq('status', 'completed')
            .is('delivered_via', null)
            .limit(50) // Batch limit to prevent timeouts

        let retriedDeliveries = 0
        if (undeliveredOrders && undeliveredOrders.length > 0) {
            for (const order of undeliveredOrders) {
                await resendVouchers(order.id).catch(e => {
                    console.error(`[Cron RC] Delivery Retry Error for order ${order.id}:`, e)
                })
                retriedDeliveries++
            }
        }

        return NextResponse.json({
            success: true,
            processedBackorders,
            retriedDeliveries
        })
    } catch (error: any) {
        console.error('[Cron] Fulfill Pending RC Orders Error:', error)
        return NextResponse.json(
            { error: error.message || 'Internal server error' },
            { status: 500 }
        )
    }
}
