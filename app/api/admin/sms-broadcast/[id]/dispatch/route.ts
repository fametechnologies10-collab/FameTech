import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { dispatchAdminSmsBroadcastChunk } from '@/lib/admin-sms-broadcast'

/**
 * POST /api/admin/sms-broadcast/[id]/dispatch
 *
 * Claims and sends the next small batch of still-queued recipients for this
 * broadcast. Safe to call repeatedly — the admin frontend polls this to drive
 * the broadcast to completion in chunks.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await validateAdminAccess()
        if (auth.error !== null) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const { id } = await params
        const supabase = createServerClient()

        const status = await dispatchAdminSmsBroadcastChunk(supabase, id)
        if (!status) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

        return NextResponse.json({ success: true, data: status })
    } catch (e: any) {
        console.error('[SMSBroadcast Dispatch] Error:', e)
        return NextResponse.json({ error: e.message || 'Internal server error' }, { status: 500 })
    }
}
