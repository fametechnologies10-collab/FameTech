import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// Returns lifetime agents (role='agent', agent_expires_at=null) for dealer assignment search.
export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const { searchParams } = new URL(request.url)
        const q = searchParams.get('q')?.trim() || ''

        if (q && (q.length > 50 || !/^[\w\s@.+\-]+$/.test(q))) {
            return NextResponse.json({ error: 'Invalid search term' }, { status: 400 })
        }

        const supabase = createServerClient()

        let query = supabase
            .from('users')
            .select('id, email, first_name, last_name, phone_number, role, agent_expires_at')
            .eq('role', 'agent')
            .is('agent_expires_at', null)
            .order('first_name', { ascending: true })
            .limit(20)

        if (q) {
            query = query.or(`email.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%`)
        }

        const { data, error } = await query

        if (error) throw error

        return NextResponse.json(data || [])
    } catch (error: any) {
        console.error('[LifetimeAgentsFetch]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
