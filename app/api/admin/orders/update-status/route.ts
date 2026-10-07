import { cookies } from 'next/headers'
import { createRouteClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'

// Create a service role client to bypass RLS for admin updates functions
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
)

export async function POST(request: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user: authUser } } = await supabase.auth.getUser()

        if (!authUser) {
            return NextResponse.json(
                { error: 'Unauthorized' },
                { status: 401 }
            )
        }

        // Verify admin role
        const { data: user } = await supabase
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (!user || (user.role !== 'admin' && user.role !== 'sub-admin')) {
            return NextResponse.json(
                { error: 'Forbidden: Admin access required' },
                { status: 403 }
            )
        }

        const body = await request.json()
        const { orderIds, batchId, status } = body

        if (!status) {
            return NextResponse.json(
                { error: 'Status is required' },
                { status: 400 }
            )
        }

        // 'refunded' MUST go through the refund RPC (which credits the wallet and sets
        // refunded_at). Allowing it here would write status='refunded' with refunded_at=null,
        // which makes isRefundable() treat the order as already-refunded and permanently
        // blocks any subsequent wallet-credit refund. 'queued' is managed by the MTN
        // registration system, not by manual admin updates.
        const ALLOWED_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const
        if (!(ALLOWED_STATUSES as readonly string[]).includes(status)) {
            return NextResponse.json(
                { error: `Invalid status '${status}': must be one of ${ALLOWED_STATUSES.join(', ')}` },
                { status: 400 }
            )
        }

        if ((!orderIds || !Array.isArray(orderIds)) && !batchId) {
            return NextResponse.json(
                { error: 'Invalid request body: orderIds array or batchId is required' },
                { status: 400 }
            )
        }

        let targetOrderIds: string[] = []

        if (batchId) {
            // Only touch orders still in 'processing' — a batch can contain orders that
            // already failed or were refunded, and those must be left alone rather than
            // force-overwritten to whatever status the admin picked for the batch.
            const { data: batchOrders, error: fetchError } = await supabaseAdmin
                .from('orders')
                .select('id')
                .eq('download_batch_id', batchId)
                .eq('status', 'processing')
                .neq('payment_status', 'refunded')

            if (fetchError) {
                console.error('Error fetching batch orders:', fetchError)
                return NextResponse.json({ error: fetchError.message }, { status: 500 })
            }
            targetOrderIds = (batchOrders || []).map(o => o.id)
        } else {
            targetOrderIds = orderIds
        }

        if (targetOrderIds.length === 0) {
            return NextResponse.json({ success: true, count: 0 })
        }

        // Refunded orders are permanently terminal — skip them here too so a direct
        // orderIds call (no batchId) can never un-refund an order by overwriting its status.
        const { data: refundCheckRows, error: refundCheckError } = await supabaseAdmin
            .from('orders')
            .select('id')
            .in('id', targetOrderIds)
            .not('refunded_at', 'is', null)

        if (refundCheckError) {
            console.error('Error checking refund state:', refundCheckError)
            return NextResponse.json({ error: refundCheckError.message }, { status: 500 })
        }
        const refundedIds = new Set((refundCheckRows || []).map(o => o.id))
        targetOrderIds = targetOrderIds.filter(id => !refundedIds.has(id))

        if (targetOrderIds.length === 0) {
            return NextResponse.json({ success: true, count: 0 })
        }

        // Use service role client to update orders. The refund check above is a separate
        // query with no row lock, so a refund can still land in the gap between it and this
        // write — .is('refunded_at', null) turns this into a single guarded write instead of
        // a check-then-write race. No financial risk either way (the RPC's own row lock is
        // what actually protects the wallet credit), this just closes the status-drift window.
        // .select('id') added so the developer webhook below (and, ideally in a future
        // pass, the sync/push calls just below it) fires only for ids THIS call actually
        // transitioned — targetOrderIds alone can't tell that apart from an id that lost
        // the .is('refunded_at', null) race and was silently skipped by this same UPDATE.
        const { data: updatedRows, error } = await supabaseAdmin
            .from('orders')
            .update({ status, updated_at: new Date().toISOString() })
            .in('id', targetOrderIds)
            .is('refunded_at', null)
            .select('id')

        if (error) {
            console.error('Error updating orders:', error)
            return NextResponse.json(
                { error: error.message },
                { status: 500 }
            )
        }

        // Sync with shop_orders
        const results = await Promise.allSettled(targetOrderIds.map(id => syncShopOrderStatus(id, status)))
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                console.error(`[UpdateStatus] syncShopOrderStatus failed for order ${targetOrderIds[i]}:`, r.reason)
            }
        })

        // Send a push notification for any terminal status change except pending/processing —
        // completed already did this; failed now gets the same treatment for transparency.
        // Refunds are notified from lib/refund-service.ts instead (that's the only path that
        // actually sets status='refunded').
        if (status === 'completed' || status === 'failed') {
            try {
                const { sendOrderCompletedPushNotification, sendOrderFailedPushNotification } = await import('@/lib/push-service')
                const sendPush = status === 'completed' ? sendOrderCompletedPushNotification : sendOrderFailedPushNotification
                targetOrderIds.forEach(id => {
                    sendPush(id).catch(e => console.error('[UpdateStatus] Push error:', e))
                })
            } catch (err) {
                console.error('[UpdateStatus] Failed to import push service:', err)
            }

            // Developer webhook — admin-triggered resolution is exactly when a developer
            // most needs to hear about their order, since it means automated resolution
            // didn't happen on its own. waitUntil since a batchId update can cover many
            // orders in one call. Uses updatedRows (not targetOrderIds) so an id that lost
            // the refunded_at race above and was silently skipped by the UPDATE never
            // fires a webhook claiming a status change that didn't happen.
            const event = status === 'completed' ? 'order.completed' : 'order.failed'
            for (const row of (updatedRows || [])) {
                waitUntil(notifyDataOrderWebhook(supabaseAdmin, (row as any).id, event))
            }
        }

        return NextResponse.json({ success: true, count: targetOrderIds.length })
    } catch (error: any) {
        console.error('Error in update status route:', error)
        return NextResponse.json(
            { error: error.message || 'Internal server error' },
            { status: 500 }
        )
    }
}
