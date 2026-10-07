import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/supabase'

export async function GET(request: NextRequest) {
    try {
        const orderId = request.nextUrl.searchParams.get('orderId')
        if (!orderId) {
            return NextResponse.json({ error: 'orderId is required' }, { status: 400 })
        }

        // 1. Auth check — must be an admin
        const cookieStore = await cookies()
        const supabaseUser = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUser.auth.getUser()
        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: userData } = await supabaseUser.from('users').select('role').eq('id', authUser.id).single()
        if ((userData as any)?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        // 2. Use service role client to fetch the order's inventory_ids
        const db = createServerClient() as any

        const { data: order, error: orderError } = await db
            .from('results_checker_orders')
            .select('id, inventory_ids, type_name, quantity, customer_name, customer_email, customer_phone, reference_code')
            .eq('id', orderId)
            .single()

        if (orderError || !order) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 })
        }

        if (!order.inventory_ids || order.inventory_ids.length === 0) {
            return NextResponse.json({ success: true, vouchers: [], order })
        }

        // 3. Fetch the actual PIN/serial data for those inventory items
        const { data: vouchers, error: invError } = await db
            .from('results_checker_inventory')
            .select('id, pin, serial_number, expiry_date')
            .in('id', order.inventory_ids)

        if (invError) {
            console.error('[Admin RC Vouchers API] DB error:', invError)
            return NextResponse.json({ error: 'Failed to fetch vouchers' }, { status: 500 })
        }

        return NextResponse.json({ success: true, vouchers: vouchers || [], order })
    } catch (err) {
        console.error('[Admin RC Vouchers API] Error:', err)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
