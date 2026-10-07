import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'

export const dynamic = 'force-dynamic'

// GET /api/admin/support/counts — sidebar badge numbers.
// Replaces the client-side RLS count that always read ~0 for admins (B4).
export async function GET(request: Request) {
    try {
        const access = await validateAdminAccess(false, request)
        if (access.error) return NextResponse.json({ success: false, error: access.error }, { status: access.status })

        const supabase = createServerClient() as any

        const [openThreads, unreadMessages, legacyPending] = await Promise.all([
            supabase.from('support_threads')
                .select('id', { count: 'exact', head: true })
                .eq('status', 'open'),
            supabase.from('support_messages')
                .select('id', { count: 'exact', head: true })
                .eq('sender_role', 'user')
                .is('read_by_admin_at', null),
            supabase.from('complaints')
                .select('id', { count: 'exact', head: true })
                .in('status', ['pending', 'in_review']),
        ])

        return NextResponse.json({
            success: true,
            data: {
                openThreads: openThreads.count || 0,
                unreadMessages: unreadMessages.count || 0,
                legacyPending: legacyPending.count || 0,
            },
        })
    } catch (error) {
        console.error('[Admin Support] Error fetching counts:', error)
        return NextResponse.json({ success: false, error: 'Failed to fetch counts' }, { status: 500 })
    }
}
