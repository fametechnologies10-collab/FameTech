import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'

export async function GET(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }

        const limitParam = parseInt(new URL(request.url).searchParams.get('limit') || '12', 10)
        const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 12

        const supabase = createServerClient()
        const { data, error } = await supabase.rpc('get_admin_recent_activity', { p_limit: limit })

        if (error) {
            console.error('[AdminActivity] RPC error:', error.message)
            return NextResponse.json({ error: 'Failed to load activity' }, { status: 500 })
        }

        return NextResponse.json(data)
    } catch (error: any) {
        console.error('Admin Activity Fetch Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
