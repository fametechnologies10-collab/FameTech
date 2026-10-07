import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

// POST — toggle whether this shop sells utility bill payments (ECG / Ghana Water / DSTV /
// GOtv / StarTimes) on its storefront (shop_profiles.utilities_enabled). This is the D6
// per-shop opt-in checked by app/api/shop/utility/lookup, app/api/shop/utility/charge (via
// lib/shop-checkout.ts's 'utility' branch) and the server-computed `utilitiesEnabled` gate in
// app/shop/[shopSlug]/page.tsx. Mirrors app/api/shop/sms-settings/route.ts's toggle shape
// exactly — the established pattern for per-shop dashboard toggles (customer order SMS): a
// single boolean-validated column update scoped to the authenticated owner's own shop row
// (owner_id), via the service-role client. Chosen over PUT /api/shop/profile because that
// route's Zod schema requires the full profile payload (shop_name/slug/owner_phone) on every
// write — too heavy for a lightweight dashboard switch.
export async function POST(request: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const rl = consumeRateLimit(`shop-utility-settings:${user.id}`, 20, 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many requests. Try again shortly.' }, { status: 429 })
        }

        const body = await request.json().catch(() => ({}))
        const { enabled } = body as { enabled?: unknown }
        if (typeof enabled !== 'boolean') {
            return NextResponse.json({ success: false, error: 'enabled must be a boolean' }, { status: 400 })
        }

        const admin = createServerClient() as any

        // Enabling requires agent/dealer/subagent — this route is the SOLE enforcement
        // point for shop-attributed utility commission eligibility
        // (credit_utility_commission's shop_id branch deliberately carries no role
        // check). subagent added: sub-agent storefronts are allowed to sell utility
        // bills at zero required recruiter markup, same as any other shop owner (utility
        // bills have no per-role pricing tier at all — everyone pays face value, see
        // lib/shop-checkout.ts). Disabling stays open to everyone so a demoted owner can
        // always turn it back off.
        if (enabled) {
            const { data: userRow, error: roleError } = await admin.from('users').select('role').eq('id', user.id).single()
            if (roleError) {
                console.error('[ShopUtilitySettings] role lookup failed (denying enable):', roleError.message)
            }
            const role = userRow?.role
            if (role !== 'agent' && role !== 'dealer' && role !== 'subagent') {
                return NextResponse.json({ success: false, error: 'upgrade_required' }, { status: 403 })
            }
        }

        const { data, error } = await admin
            .from('shop_profiles')
            .update({ utilities_enabled: enabled, updated_at: new Date().toISOString() })
            .eq('owner_id', user.id)
            .select('id')
            .maybeSingle()

        if (error) {
            console.error('[ShopUtilitySettings] DB error:', error)
            return NextResponse.json({ success: false, error: 'Failed to update setting' }, { status: 500 })
        }
        if (!data) {
            return NextResponse.json({ success: false, error: 'Create your shop first' }, { status: 404 })
        }

        return NextResponse.json({ success: true, enabled })
    } catch (err) {
        console.error('[ShopUtilitySettings] Error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
