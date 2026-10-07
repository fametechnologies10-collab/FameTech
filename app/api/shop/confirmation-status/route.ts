import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// GET — feeds the shop-overview confirmation-status warning banner
// (components/shop/confirmation-status-banner.tsx). Task F3 made shop
// order-confirmation SMS suppress-until-ready: it only sends once the shop
// has (a) SMS activated, (b) an admin-approved sender ID, and (c) enough
// credits. This route reports those three gates plus the shop's own
// confirmations toggle so the banner can tell an owner exactly why their
// customers are (or will be) getting silence instead of a text.
//
// Read-only, cheap: one shop_profiles read, then activation + wallet reads
// batched with Promise.all.
export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const adminDb = createServerClient()

        const { data: shop } = await adminDb
            .from('shop_profiles')
            .select('id, sms_sender_status, sms_order_confirmation_enabled')
            .eq('owner_id', user.id)
            .maybeSingle()

        if (!shop) return NextResponse.json({ success: false, error: 'Create your shop first' }, { status: 404 })

        const s = shop as any
        const shopId = s.id as string

        const [activationRes, walletRes] = await Promise.all([
            adminDb.from('shop_sms_activations').select('id, sms_suspended').eq('shop_id', shopId).maybeSingle(),
            adminDb.from('shop_sms_wallets').select('credits').eq('shop_id', shopId).maybeSingle(),
        ])

        const activation = activationRes.data as any
        const activated = !!activation && activation.sms_suspended !== true
        const senderStatus: string | null = s.sms_sender_status ?? null
        const hasApprovedSender = senderStatus === 'approved'
        const credits: number = (walletRes.data as any)?.credits ?? 0
        const lowCredits = credits < 10
        const confirmationsEnabled = s.sms_order_confirmation_enabled !== false

        return NextResponse.json({
            success: true,
            data: { activated, senderStatus, hasApprovedSender, credits, lowCredits, confirmationsEnabled },
        })
    } catch (err) {
        console.error('[ShopSMS ConfirmationStatus] GET error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
