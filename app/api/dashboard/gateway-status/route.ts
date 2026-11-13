import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { getGatewayStatus } from '@/lib/gateway-status'
import { checkGatewayStatusLimit } from '@/lib/gateway-status-ratelimit'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

// Per-network delivery speed for the dashboard. Global aggregates only —
// the response carries no per-user data.
export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
        }

        if (!(await checkGatewayStatusLimit(user.id))) {
            return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429, headers: NO_STORE })
        }

        const data = await getGatewayStatus()
        return NextResponse.json({ success: true, data }, { headers: NO_STORE })
    } catch (error) {
        console.error('[api/dashboard/gateway-status] GET failed', error)
        return NextResponse.json({ success: false, error: 'Unable to load delivery status' }, { status: 500, headers: NO_STORE })
    }
}
