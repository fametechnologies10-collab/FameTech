import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// POST — claim welcome bonus SMS credits after first activation.
// All three operations (check, credit, mark) run atomically inside
// claim_sms_welcome_bonus() — no double-claim window.
export async function POST() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        // Verify shop ownership via RLS-enforced client
        const { data: shop } = await supabase
            .from('shop_profiles')
            .select('id')
            .eq('owner_id', user.id)
            .maybeSingle()
        if (!shop) return NextResponse.json({ success: false, error: 'Shop not found' }, { status: 404 })
        const shopId = (shop as any).id

        const adminDb = createServerClient()

        // Atomic RPC: reads credit count from settings, marks bonus_claimed,
        // and upserts the SMS wallet — all in one transaction.
        const { data, error } = await (adminDb as any).rpc('claim_sms_welcome_bonus', {
            p_shop_id: shopId,
        })

        if (error) {
            if (error.message?.includes('ALREADY_CLAIMED')) {
                return NextResponse.json({ success: false, error: 'Welcome bonus already claimed' }, { status: 409 })
            }
            console.error('[ClaimBonus] RPC error:', error)
            return NextResponse.json({ success: false, error: 'Failed to apply bonus credits' }, { status: 500 })
        }

        return NextResponse.json({
            success: true,
            data: { creditsAdded: (data as any)?.credits_added ?? 10 },
        })
    } catch (err) {
        console.error('[ClaimBonus] Error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
