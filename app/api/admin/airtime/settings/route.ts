import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

const AIRTIME_SETTING_KEYS = [
    // Airtime fees — customer / agent / dealer per network
    'airtime_fee_mtn_customer',    'airtime_fee_mtn_agent',    'airtime_fee_mtn_dealer',
    'airtime_fee_telecel_customer','airtime_fee_telecel_agent','airtime_fee_telecel_dealer',
    'airtime_fee_at_customer',     'airtime_fee_at_agent',     'airtime_fee_at_dealer',
    // Airtime per-role limits
    'airtime_min_amount_customer', 'airtime_min_amount_agent', 'airtime_min_amount_dealer',
    'airtime_max_amount_customer', 'airtime_max_amount_agent', 'airtime_max_amount_dealer',
    // Airtime per-network enable toggles
    'airtime_enabled_mtn', 'airtime_enabled_telecel', 'airtime_enabled_at',
    // Mashup fees — customer / agent / dealer per network
    'mashup_fee_mtn_customer',    'mashup_fee_mtn_agent',    'mashup_fee_mtn_dealer',
    'mashup_fee_telecel_customer','mashup_fee_telecel_agent','mashup_fee_telecel_dealer',
    'mashup_fee_at_customer',     'mashup_fee_at_agent',     'mashup_fee_at_dealer',
    // Mashup per-role limits
    'mashup_min_amount_customer', 'mashup_min_amount_agent', 'mashup_min_amount_dealer',
    'mashup_max_amount_customer', 'mashup_max_amount_agent', 'mashup_max_amount_dealer',
    // Mashup per-network enable toggles
    'mashup_enabled_mtn', 'mashup_enabled_telecel', 'mashup_enabled_at',
    // Dashboard master toggles
    'dashboard_airtime_enabled', 'dashboard_mashup_enabled',
    // Storefront toggles
    'storefront_airtime_enabled', 'storefront_mashup_enabled',
    // Hubtel Commission auto-fulfillment controls
    'airtime_auto_fulfillment_enabled', 'hubtel_airtime_networks', 'hubtel_commission_paused',
]

async function verifyAdmin(supabaseUserClient: any) {
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    const role = (user as any)?.role
    if (!['admin', 'sub-admin'].includes(role)) return null
    return { userId: authUser.id }
}

export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const supabase = createServerClient()
        const { data, error } = await (supabase.from('admin_settings') as any)
            .select('key, value')
            .in('key', AIRTIME_SETTING_KEYS)

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        const settings: Record<string, string> = {}
        for (const row of (data || [])) settings[row.key] = row.value

        return NextResponse.json({ settings })
    } catch (error) {
        console.error('[Admin Airtime Settings] GET error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const supabase = createServerClient()
        let body: any
        try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

        const updates = Object.entries(body)
            .filter(([key]) => AIRTIME_SETTING_KEYS.includes(key))
            .map(([key, value]) => ({ key, value: (typeof value === 'object' && value !== null) ? JSON.stringify(value) : String(value) }))

        if (updates.length === 0) return NextResponse.json({ error: 'No valid settings provided' }, { status: 400 })

        const { error } = await (supabase.from('admin_settings') as any)
            .upsert(updates, { onConflict: 'key' })

        if (error) {
            console.error('[Admin Airtime Settings] Save error:', error)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('[Admin Airtime Settings] POST error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
