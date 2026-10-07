import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'

export async function GET(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(true, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }

        const { searchParams } = new URL(request.url)
        const network = searchParams.get('network')
        const search = searchParams.get('search')
        const limit = parseInt(searchParams.get('limit') || '500')

        const supabase = createServerClient()

        let query = supabase
            .from('orders')
            .select(`
                id, created_at, phone_number, network, size, price, status, user_id, shop_name, shop_order_id, cost_price_at_time,
                users!orders_user_id_fkey ( first_name, last_name, role, email ),
                shop_orders ( cost_price, admin_cost_at_time ),
                mtn_fulfillment_tracking ( status, api_response, retry_count )
            `)
            .eq('status', 'pending')
            .neq('category', 'mtn_mashup') // mashup orders are fulfilled manually only

        if (network && network !== 'All') query = query.eq('network', network)
        if (search) query = query.ilike('phone_number', `%${search}%`)

        const { data: rawOrders, error: fetchError } = await query
            .order('created_at', { ascending: false })
            .limit(limit)

        if (fetchError) throw fetchError

        const orders = (rawOrders || []).map((order: any) => {
            const isShopOrder = order.shop_order_id && order.shop_orders
            return {
                ...order,
                original_shop_price: order.price,
                price: isShopOrder ? order.shop_orders.cost_price : order.price,
                cost_price: isShopOrder ? order.shop_orders.admin_cost_at_time : order.cost_price_at_time,
                mtn_fulfillment_tracking: order.mtn_fulfillment_tracking || [],
            }
        })

        return NextResponse.json({ orders })
    } catch (error: any) {
        console.error('[GhData Pending Orders] Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
