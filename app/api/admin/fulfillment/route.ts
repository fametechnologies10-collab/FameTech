import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { cookies } from 'next/headers'
import { resolveSupplier } from '@/lib/order-supplier'

export async function GET(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Check if user is admin
        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin' && userData?.role !== 'sub-admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const { searchParams } = new URL(request.url)
        const network = searchParams.get('network')
        const status = searchParams.get('status')
        const channel = searchParams.get('channel')
        const startDate = searchParams.get('startDate')
        const endDate = searchParams.get('endDate')
        const search = searchParams.get('search')
        const limit = parseInt(searchParams.get('limit') || '1000')

        // Use service role client to bypass RLS
        const supabase = createServerClient()

        let query = supabase
            .from('orders')
            .select(`
                id, created_at, phone_number, network, size, price, status, user_id, shop_name, shop_order_id, cost_price_at_time, source, refunded_at, download_batch_id, fulfillment_method,
                retry_count, retry_from_status, retry_of_order_id, retried_by_role, self_completed_at, self_completed_by_role,
                users!orders_user_id_fkey (
                    first_name,
                    last_name,
                    role,
                    email
                ),
                shop_orders (
                    cost_price,
                    admin_cost_at_time
                ),
                mtn_fulfillment_tracking (
                    status,
                    api_response,
                    retry_count,
                    created_at
                )
            `)

        // DATA PACKAGES ONLY. Exclude Special MTN Mashup reliably by category
        // (fulfilled on /admin/mtn-mashup), and airtime mirrors — which carry
        // category='data' but an "... Airtime" size — via the size heuristic.
        query = (query as any)
            .neq('category', 'mtn_mashup')
            .not('size', 'ilike', '%Airtime%')
            .not('size', 'ilike', '%Mashup%')

        // Filter by pertinent statuses for fulfillment center
        if (status === 'refunded') {
            // Match refunded_at, not status — an order whose status later drifted away from
            // 'refunded' (e.g. a sync route overwriting it) must still surface here. refunded_at
            // is the permanent record of the refund; current status is not.
            query = query.not('refunded_at', 'is', null)
        } else if (status && status !== 'All') {
            query = query.eq('status', status)
        } else {
            // 'refunded' is terminal like 'completed' — include it so the fulfillment page can
            // show refund stats + a client-side Refunded filter without a separate fetch.
            // 'queued' = held for MTN number registration; include it so the page shows the
            // queued stats card + filter (it is NOT dispatchable until released to 'pending').
            query = query.in('status', ['processing', 'failed', 'completed', 'pending', 'queued', 'refunded'])
        }

        if (network && network !== 'All') {
            query = query.eq('network', network)
        }

        // Channel (origin) — mirrors the classification the fulfillment page used to
        // apply client-side only (over the first `limit` rows). Applying it at the DB
        // level means it now reflects the full matching set, not just the first page.
        if (channel === 'ussd') {
            query = query.in('source', ['ussd', 'ussd_shop'])
        } else if (channel === 'shop') {
            query = query.or('shop_order_id.not.is.null,source.eq.shop')
        } else if (channel === 'web') {
            query = query
                .not('source', 'in', '("ussd","ussd_shop","shop")')
                .is('shop_order_id', null)
        }

        if (startDate) {
            query = query.gte('created_at', startDate)
        }
        if (endDate) {
            query = query.lte('created_at', endDate)
        }

        if (search) {
            query = query.ilike('phone_number', `%${search}%`)
        }

        const { data: rawOrders, error: fetchError } = await query
            .order('created_at', { ascending: false })
            .limit(limit)

        if (fetchError) {
            console.error('[FulfillmentFetch] Error:', fetchError)
            throw fetchError
        }

        // Transform data to match expected frontend structure (extracting transaction_id)
        const orders = (rawOrders || []).map((order: any) => {
            const tracking = order.mtn_fulfillment_tracking && order.mtn_fulfillment_tracking[0]
                ? order.mtn_fulfillment_tracking
                : []

            // Map tracking info to include extracted transaction_id
            const mappedTracking = tracking.map((t: any) => ({
                ...t,
                transaction_id: t.api_response?.data?.transaction_id || t.api_response?.transactionId || null
            }))

            const isShopOrder = order.shop_order_id && order.shop_orders
            
            const adminRevenue = isShopOrder 
                ? order.shop_orders.cost_price         // What the shop owner paid the admin
                : order.price                          // What the direct customer paid the admin

            const adminTrueCost = isShopOrder
                ? order.shop_orders.admin_cost_at_time // Admin's supplier cost for the shop order
                : order.cost_price_at_time             // Admin's supplier cost for the direct order

            return {
                ...order,
                original_shop_price: order.price,
                price: adminRevenue,
                cost_price: adminTrueCost,
                mtn_fulfillment_tracking: mappedTracking,
                supplier: resolveSupplier(tracking, order.download_batch_id, order.fulfillment_method, order.status),
            }
        })

        return NextResponse.json({
            orders: orders
        })
    } catch (error: any) {
        console.error('Fulfillment Orders Fetch Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
