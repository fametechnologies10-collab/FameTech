import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

const USSD_SETTING_KEYS = [
    'ussd_enabled',
    'ussd_data_enabled',
    'ussd_rc_enabled',
    'ussd_afa_enabled',
    // Surfaces "Buy Airtime" on BOTH the main USSD menu and every shop menu
    // (main-menu.ts reads it per request — no deploy needed to flip).
    'ussd_airtime_enabled',
    // Surfaces "Buy Mashup" on BOTH the main USSD menu and every shop menu — MANUAL
    // fulfillment only, never sent to Hubtel (main-menu.ts reads it per request too).
    'ussd_mashup_enabled',
    // Surfaces "Pay Utility Bill" on BOTH the main USSD menu and every shop menu —
    // ALSO gated by utility_bills_enabled + >=1 enabled biller in hubtel_utility_billers
    // (admin/utility-bills settings, not managed here).
    'ussd_utility_enabled',
    'afa_price_ussd',
    'ussd_fee_percent',
    'ussd_max_rc_quantity',
    'ussd_session_resume_minutes',
    'ussd_helpline',
    'ussd_storefront_mode',
    'ussd_shop_activation_fee',
    'ussd_shop_fee_percent',
]

async function requireAdmin() {
    const supabaseUser = await createRouteClient()
    const { data: { user }, error } = await supabaseUser.auth.getUser()
    if (error || !user) return null
    const { data: userData } = await supabaseUser.from('users').select('role').eq('id', user.id).single()
    if ((userData as any)?.role !== 'admin') return null
    return user
}

export async function GET() {
    const user = await requireAdmin()
    if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const db = createServerClient() as any
    const { data, error } = await db
        .from('admin_settings')
        .select('key, value')
        .in('key', USSD_SETTING_KEYS)

    if (error) return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 })

    const settings: Record<string, string> = {}
    for (const row of (data ?? []) as any[]) settings[row.key] = row.value
    return NextResponse.json({ settings })
}

export async function POST(request: NextRequest) {
    const user = await requireAdmin()
    if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const body = await request.json()
    const updates: { key: string; value: string }[] = []

    for (const key of USSD_SETTING_KEYS) {
        if (key in body) updates.push({ key, value: String(body[key]) })
    }

    if (updates.length === 0) return NextResponse.json({ error: 'No valid keys' }, { status: 400 })

    const db = createServerClient() as any
    const { error } = await db
        .from('admin_settings')
        .upsert(updates, { onConflict: 'key' })

    if (error) return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 })
    return NextResponse.json({ ok: true })
}
