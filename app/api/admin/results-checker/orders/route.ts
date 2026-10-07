import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/supabase'

export async function GET(request: NextRequest) {
    try {
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

        // 2. Use service role client to bypass RLS and see ALL orders
        const db = createServerClient() as any

        const { data: orders, error } = await db
            .from('results_checker_orders')
            .select(`
                id,
                reference_code,
                type_name,
                quantity,
                total_paid,
                status,
                payment_status,
                user_role,
                customer_name,
                customer_phone,
                customer_email,
                shop_name,
                shop_id,
                inventory_ids,
                source,
                created_at,
                fulfilled_at,
                user_id
            `)
            .order('created_at', { ascending: false })
            .limit(100)

        if (error) {
            console.error('[Admin RC Orders API] DB error:', error)
            return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 })
        }

        // 3. Enrich orders with user name from users table
        const userIds = [...new Set((orders || []).map((o: any) => o.user_id).filter(Boolean))]
        let userMap: Record<string, string> = {}
        if (userIds.length > 0) {
            const { data: users } = await db
                .from('users')
                .select('id, first_name, last_name, email')
                .in('id', userIds)
            for (const u of (users || [])) {
                userMap[u.id] = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email || 'Unknown'
            }
        }

        const enriched = (orders || []).map((o: any) => ({
            ...o,
            user_name: o.user_id ? (userMap[o.user_id] || 'Unknown User') : (o.customer_name || 'Guest'),
        }))

        return NextResponse.json({ success: true, orders: enriched })
    } catch (err) {
        console.error('[Admin RC Orders API] Error:', err)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
