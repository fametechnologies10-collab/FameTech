import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

// POST — toggle the per-shop customer order-confirmation SMS on/off.
// The update is scoped to the authenticated owner's own shop row (owner_id),
// so the service-role client can never be steered at another shop (no IDOR).
export async function POST(request: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const rl = consumeRateLimit(`shop-sms-settings:${user.id}`, 20, 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many requests. Try again shortly.' }, { status: 429 })
        }

        const body = await request.json().catch(() => ({}))
        const { enabled } = body as { enabled?: unknown }
        if (typeof enabled !== 'boolean') {
            return NextResponse.json({ success: false, error: 'enabled must be a boolean' }, { status: 400 })
        }

        const admin = createServerClient() as any
        const { data, error } = await admin
            .from('shop_profiles')
            .update({ sms_order_confirmation_enabled: enabled, updated_at: new Date().toISOString() })
            .eq('owner_id', user.id)
            .select('id')
            .maybeSingle()

        if (error) {
            console.error('[ShopSMSSettings] DB error:', error)
            return NextResponse.json({ success: false, error: 'Failed to update setting' }, { status: 500 })
        }
        if (!data) {
            return NextResponse.json({ success: false, error: 'Create your shop first' }, { status: 404 })
        }

        return NextResponse.json({ success: true, enabled })
    } catch (err) {
        console.error('[ShopSMSSettings] Error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
