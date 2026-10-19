import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { getAdminSmsBroadcastStatus } from '@/lib/admin-sms-broadcast'

/**
 * GET /api/admin/sms-broadcast/[id]
 *
 * Returns the current status/progress of a queued broadcast, without
 * claiming or sending anything — used by the admin frontend to poll
 * progress between dispatch calls.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await validateAdminAccess()
        if (auth.error !== null) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const { id } = await params
        const supabase = createServerClient()

        const status = await getAdminSmsBroadcastStatus(supabase, id)
        if (!status) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

        return NextResponse.json({ success: true, data: status })
    } catch (e: any) {
        console.error('[SMSBroadcast Status] Error:', e)
        return NextResponse.json({ error: e.message || 'Internal server error' }, { status: 500 })
    }
}
