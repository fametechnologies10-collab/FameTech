import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'

/**
 * GET /api/admin/users/stats
 * Segment counts over the FULL user base for the stat/filter cards.
 */
export async function GET(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }

        const supabase = createServerClient()
        const { data, error } = await (supabase as any).rpc('admin_user_stats')
        if (error) {
            console.error('[AdminUsersStats] RPC error:', error)
            throw new Error(error.message)
        }

        return NextResponse.json({ stats: data || {} })
    } catch (error: any) {
        console.error('Admin Users Stats Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
