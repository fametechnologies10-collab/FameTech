import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// Read-only mirror of app/api/admin/airtime/settings's key list, for any
// AUTHENTICATED user (not just admin/sub-admin).
//
// WHY THIS EXISTS: app/dashboard/airtime/page.tsx — the retail "Buy airtime &
// mashup" page every logged-in customer uses — was calling the admin-only
// /api/admin/airtime/settings, which 401s for a non-admin role. The fetch
// failure was silent (the page only checks `settingsRes.ok`), so `settings`
// stayed null for every ordinary customer. Airtime buying still rendered
// because it doesn't gate on that same object the same way, but the Mashup
// toggle button (`settings?.mashup_dashboard_enabled && (...)`) has no
// fallback and simply never appeared — reported as "mashup does not appear
// on the dashboard" while airtime worked fine.
//
// None of these values are sensitive: they are per-network fees, min/max
// limits, and on/off toggles a customer already sees reflected in the price
// they're quoted, and the storefront toggles are visible to anonymous guests
// on public shop pages. Exposing them to any authenticated user is not a new
// disclosure — only a session is required, not a specific role.
const AIRTIME_SETTING_KEYS = [
    'airtime_fee_mtn_customer',    'airtime_fee_mtn_agent',    'airtime_fee_mtn_dealer',
    'airtime_fee_telecel_customer','airtime_fee_telecel_agent','airtime_fee_telecel_dealer',
    'airtime_fee_at_customer',     'airtime_fee_at_agent',     'airtime_fee_at_dealer',
    'airtime_min_amount_customer', 'airtime_min_amount_agent', 'airtime_min_amount_dealer',
    'airtime_max_amount_customer', 'airtime_max_amount_agent', 'airtime_max_amount_dealer',
    'airtime_enabled_mtn', 'airtime_enabled_telecel', 'airtime_enabled_at',
    'mashup_fee_mtn_customer',    'mashup_fee_mtn_agent',    'mashup_fee_mtn_dealer',
    'mashup_fee_telecel_customer','mashup_fee_telecel_agent','mashup_fee_telecel_dealer',
    'mashup_fee_at_customer',     'mashup_fee_at_agent',     'mashup_fee_at_dealer',
    'mashup_min_amount_customer', 'mashup_min_amount_agent', 'mashup_min_amount_dealer',
    'mashup_max_amount_customer', 'mashup_max_amount_agent', 'mashup_max_amount_dealer',
    'mashup_enabled_mtn', 'mashup_enabled_telecel', 'mashup_enabled_at',
    'dashboard_airtime_enabled', 'dashboard_mashup_enabled',
]

export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Service-role read — bypasses RLS on admin_settings, same as the admin
        // route. Auth above already establishes a real session is required.
        const supabase = createServerClient()
        const { data, error } = await (supabase.from('admin_settings') as any)
            .select('key, value')
            .in('key', AIRTIME_SETTING_KEYS)

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        const settings: Record<string, string> = {}
        for (const row of (data || [])) settings[row.key] = String(row.value)

        return NextResponse.json(
            { settings },
            { headers: { 'Cache-Control': 'private, no-store' } },
        )
    } catch (error) {
        console.error('[User Airtime Settings] GET error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
