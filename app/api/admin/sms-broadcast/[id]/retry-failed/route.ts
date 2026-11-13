import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { retryFailedAdminSmsBroadcast } from '@/lib/admin-sms-broadcast'

/**
 * POST /api/admin/sms-broadcast/[id]/retry-failed
 *
 * Requeues the broadcast's failed recipients (supplier-rejected or failed at
 * send time) and reopens it. The caller then drives the normal dispatch loop
 * and verify step again. Safe against double-clicks: the DB function locks the
 * broadcast, so a second call finds nothing to requeue (requeued: 0).
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await validateAdminAccess()
        if (auth.error !== null) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const { id } = await params
        const supabase = createServerClient()

        const result = await retryFailedAdminSmsBroadcast(supabase, id)
        if (!result) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

        return NextResponse.json({ success: true, data: result })
    } catch (e: any) {
        console.error('[SMSBroadcast Retry] Error:', e)
        return NextResponse.json({ error: e.message || 'Internal server error' }, { status: 500 })
    }
}
