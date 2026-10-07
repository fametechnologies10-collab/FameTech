import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { checkGhDataOrderStatus } from '@/lib/ghdata-service'

export async function POST(request: NextRequest) {
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

        // Fetch orders that have a GhData tracking record
        const { data: ordersWithTracking, error: fetchError } = await (supabase as any)
            .from('orders')
            .select(`
                id, status,
                mtn_fulfillment_tracking!inner ( id, api_response )
            `)
            .in('id', orderIds)
            .contains('mtn_fulfillment_tracking.api_response', { supplier: 'ghdata' })

        if (fetchError) return NextResponse.json({ error: 'Failed to fetch tracking details' }, { status: 500 })
        if (!ordersWithTracking || ordersWithTracking.length === 0) {
            return NextResponse.json({ error: 'No valid GhData orders found to sync.' }, { status: 400 })
        }

        let updatedCount = 0
        let failedCount = 0
        const results = []

        for (const order of (ordersWithTracking as any[])) {
            const trackingRecord = order.mtn_fulfillment_tracking.find(
                (t: any) => t.api_response?.supplier === 'ghdata' && t.api_response?.ghdata_order_id
            )

            if (!trackingRecord) {
                failedCount++
                results.push({ id: order.id, error: 'No GhData order_id found in tracking history' })
                continue
            }

            const ghdataOrderId = trackingRecord.api_response.ghdata_order_id
            console.log(`[GhData Sync] Checking order: ${order.id} | GhData ID: ${ghdataOrderId}`)

            const result = await checkGhDataOrderStatus(ghdataOrderId)

            if (result.success) {
                updatedCount++
                results.push({ id: order.id, success: true, status: result.status, raw: result.data })
            } else {
                failedCount++
                results.push({ id: order.id, success: false, error: result.message })
            }
        }

        return NextResponse.json({
            success: true,
            message: `Sync complete: ${updatedCount} fetched, ${failedCount} failed`,
            updated: updatedCount,
            failed: failedCount,
            results,
        })
    } catch (error: any) {
        console.error('[GhData Sync] Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
