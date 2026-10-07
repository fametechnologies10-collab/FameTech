import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

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

        const supabase = createServerClient()

        const { data: dealers, error } = await supabase
            .from('users')
            .select('id, email, first_name, last_name, phone_number, role, status, dealer_expires_at, agent_expires_at, auto_upgrade_enabled, auto_upgrade_plan, created_at, updated_at')
            .eq('role', 'dealer')
            .order('created_at', { ascending: false })

        if (error) throw error

        return NextResponse.json(dealers || [])
    } catch (error: any) {
        console.error('[AdminDealersFetch]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
