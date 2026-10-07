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
    const onlyInterrupted = searchParams.get('interrupted') === 'true'

    const db = createServerClient() as any
    let query = db
        .from('ussd_sessions')
        .select('id, session_id, mobile, operator, platform, steps, service_used, completed, interrupted_at, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(limit)

    if (onlyInterrupted) query = query.not('interrupted_state', 'is', null)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: 'Failed to fetch sessions' }, { status: 500 })
    return NextResponse.json({ sessions: data ?? [] })
}
