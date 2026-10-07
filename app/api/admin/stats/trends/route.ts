import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'

const VALID_RANGES = ['today', '7d', '30d'] as const

export async function GET(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }

        const rangeParam = new URL(request.url).searchParams.get('range') || '7d'
        const range = (VALID_RANGES as readonly string[]).includes(rangeParam) ? rangeParam : '7d'

        // Service role to bypass RLS for cross-user aggregation.
        const supabase = createServerClient()
        const { data, error } = await supabase.rpc('get_admin_dashboard_trends', { p_range: range })

        if (error) {
            console.error('[AdminTrends] RPC error:', error.message)
            return NextResponse.json({ error: 'Failed to load trends' }, { status: 500 })
        }

        return NextResponse.json(data)
    } catch (error: any) {
        console.error('Admin Trends Fetch Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
