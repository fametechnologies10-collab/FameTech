import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'

export async function POST(req: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
        if (user?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

        // release_expired_rc_reservations is service_role-only (see supabase/migrations
        // rc_fulfillment_hardening) — the RLS client 403s with "permission denied for
        // function". Auth/role check above already gates this to real admins.
        const admin = createAdminClient()
        const { data, error } = await admin.rpc('release_expired_rc_reservations')

        if (error) throw error

        return NextResponse.json({ success: true, releasedCount: data || 0 })
    } catch (error) {
        console.error('[Admin RC Release API] Error:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
