import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { manualRefulfillAirtime } from '@/lib/airtime-fulfillment'

async function verifyAdmin(supabaseUserClient: any) {
    const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
    if (error || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    return ['admin', 'sub-admin'].includes((user as any)?.role) ? { userId: authUser.id } : null
}

// POST { orderId } — manually (re)dispatch an airtime order to Hubtel Commission Services.
export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let body: any
        try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }
        const orderId = body?.orderId
        if (!orderId || typeof orderId !== 'string') return NextResponse.json({ error: 'orderId is required' }, { status: 400 })

        const result = await manualRefulfillAirtime(orderId)
        return NextResponse.json(result, { status: result.ok ? 200 : 409 })
    } catch (e: any) {
        console.error('[AirtimeRefulfill] error:', e?.message || e)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
