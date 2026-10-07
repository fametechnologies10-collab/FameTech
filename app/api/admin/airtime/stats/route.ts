import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

async function verifyAdmin(supabaseUserClient: any) {
    const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
    if (error || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    return ['admin', 'sub-admin'].includes((user as any)?.role) ? { userId: authUser.id } : null
}

// GET /api/admin/airtime/stats?network=&type=&start=&end=
// Server-side aggregate over the FULL airtime_orders set under the network/type/date filters
// (the panel used to sum a 500-row client window, which understated past 500 orders). Money
// figures are completed-scoped; pending_value is at-risk money; counts break down the set.
export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const sp = request.nextUrl.searchParams
        // Coerce to a known-safe value or null (no filter) — invalid input never reaches the RPC as-is.
        const VALID_NET = ['MTN', 'Telecel', 'AT']
        const VALID_TYPE = ['airtime', 'mashup']
        const ISO = /^\d{4}-\d{2}-\d{2}/
        const networkRaw = sp.get('network')
        const typeRaw = sp.get('type')
        const startRaw = sp.get('start')
        const endRaw = sp.get('end')

        const supabase = createServerClient()
        const { data, error } = await (supabase as any).rpc('admin_airtime_stats', {
            p_network: networkRaw && VALID_NET.includes(networkRaw) ? networkRaw : null,
            p_type: typeRaw && VALID_TYPE.includes(typeRaw) ? typeRaw : null,
            p_start: startRaw && ISO.test(startRaw) ? startRaw : null,
            p_end: endRaw && ISO.test(endRaw) ? endRaw : null,
        })
        if (error) {
            console.error('[AirtimeStats] rpc error:', error.message)
            return NextResponse.json({ error: 'Failed to load stats' }, { status: 500 })
        }
        const row = Array.isArray(data) ? data[0] : data
        return NextResponse.json({ stats: row || null }, { status: 200 })
    } catch (e: any) {
        console.error('[AirtimeStats] error:', e?.message || e)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
