import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { isSupportActive } from '@/lib/admin-presence'

export const dynamic = 'force-dynamic'

// GET /api/support/presence — "is support active right now" badge for the
// customer chat. Authenticated users only (not a public endpoint); no PII,
// just a boolean, but no reason to expose it to anonymous traffic either.
export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const active = await isSupportActive()
        return NextResponse.json({ success: true, data: { active } })
    } catch (error) {
        console.error('[Support] Error checking presence:', error)
        return NextResponse.json({ success: false, error: 'Failed to check presence' }, { status: 500 })
    }
}
