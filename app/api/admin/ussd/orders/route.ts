import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

async function requireAdmin() {
    const supabaseUser = await createRouteClient()
    const { data: { user }, error } = await supabaseUser.auth.getUser()
    if (error || !user) return null
    const { data: userData } = await supabaseUser.from('users').select('role').eq('id', user.id).single()
    if ((userData as any)?.role !== 'admin') return null
    return user
}

export async function GET(request: NextRequest) {
    const user = await requireAdmin()
    if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '100'), 200)

    const db = createServerClient() as any
    let query = db
        .from('ussd_pending_orders')
        .select('id, session_id, mobile, service_type, price, status, hubtel_order_id, user_id, created_at, fulfilled_at, expires_at, order_payload')
        .order('created_at', { ascending: false })
        .limit(limit)

    if (status && status !== 'all') query = query.eq('status', status)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 })
    return NextResponse.json({ orders: data ?? [] })
}
