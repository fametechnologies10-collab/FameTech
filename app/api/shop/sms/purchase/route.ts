import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

const purchaseSchema = z.object({
    bundleId: z.string().uuid(),
    paidFrom: z.enum(['wallet', 'profit']),
})

// POST — buy an SMS bundle. Price and credits come exclusively from the
// admin-configured bundle row inside the purchase_sms_bundle RPC; the client
// only chooses which bundle and which wallet pays.
export async function POST(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`shop-sms-purchase:${user.id}`, 10, 60 * 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many attempts. Try again later.' }, { status: 429 })
        }

        const body = await req.json()
        const parsed = purchaseSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'Invalid purchase request' }, { status: 400 })
        }

        const adminDb = createServerClient()
        const { data, error } = await (adminDb as any).rpc('purchase_sms_bundle', {
            p_owner_id: user.id,
            p_bundle_id: parsed.data.bundleId,
            p_paid_from: parsed.data.paidFrom,
        })

        if (error) {
            const msg = error.message || ''
            if (msg.includes('INSUFFICIENT_BALANCE')) {
                return NextResponse.json({ success: false, error: `Insufficient ${parsed.data.paidFrom === 'wallet' ? 'wallet' : 'profit'} balance` }, { status: 402 })
            }
            if (msg.includes('NOT_ACTIVATED')) {
                return NextResponse.json({ success: false, error: 'Activate the SMS feature first' }, { status: 403 })
            }
            if (msg.includes('BUNDLE_NOT_FOUND')) {
                return NextResponse.json({ success: false, error: 'This bundle is no longer available' }, { status: 404 })
            }
            if (msg.includes('SHOP_NOT_FOUND')) {
                return NextResponse.json({ success: false, error: 'Create your shop first' }, { status: 404 })
            }
            console.error('[ShopSMS] Purchase RPC error:', error)
            return NextResponse.json({ success: false, error: 'Purchase failed. Please try again.' }, { status: 500 })
        }

        return NextResponse.json({ success: true, data })
    } catch (err) {
        console.error('[ShopSMS] Purchase error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
