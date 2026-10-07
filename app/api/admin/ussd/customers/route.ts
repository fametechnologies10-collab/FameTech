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
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '100'), 200)

    const db = createServerClient() as any
    const { data, error } = await db
        .from('ussd_customers')
        .select('id, mobile, operator, first_seen, last_seen, total_orders, total_spent, last_service')
        .order('last_seen', { ascending: false })
        .limit(limit)

    if (error) return NextResponse.json({ error: 'Failed to fetch customers' }, { status: 500 })
    return NextResponse.json({ customers: data ?? [] })
}
