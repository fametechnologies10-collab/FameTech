import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

const activateSchema = z.object({
    paidFrom: z.enum(['wallet', 'profit']),
})

// POST — one-time paid activation of the SMS feature.
// All money movement happens inside the activate_shop_sms RPC (atomic,
// service-role-only) — this route only authenticates and translates errors.
export async function POST(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-activate:${user.id}`, 5, 60 * 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many attempts. Try again later.' }, { status: 429 })
        }

        const body = await req.json()
        const parsed = activateSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'Invalid payment source' }, { status: 400 })
        }

        // Feature must be enabled by admin — read with the service role so
        // an RLS misconfiguration can't silently hide the row, and fail
        // CLOSED when the flag row is missing.
        const adminDb = createServerClient()
        const { data: flagRow } = await adminDb
            .from('shop_global_settings')
            .select('value')
            .eq('key', 'sms_feature_enabled')
            .maybeSingle()
        if (!flagRow || String((flagRow as any).value) !== 'true') {
            return NextResponse.json({ success: false, error: 'SMS feature is currently unavailable' }, { status: 503 })
        }
        const { data, error } = await (adminDb as any).rpc('activate_shop_sms', {
            p_owner_id: user.id,
            p_paid_from: parsed.data.paidFrom,
        })

        if (error) {
            const msg = error.message || ''
            if (msg.includes('INSUFFICIENT_BALANCE')) {
                return NextResponse.json({ success: false, error: `Insufficient ${parsed.data.paidFrom === 'wallet' ? 'wallet' : 'profit'} balance` }, { status: 402 })
            }
            if (msg.includes('ALREADY_ACTIVATED')) {
                return NextResponse.json({ success: false, error: 'SMS is already activated for your shop' }, { status: 409 })
            }
            if (msg.includes('SHOP_NOT_FOUND')) {
                return NextResponse.json({ success: false, error: 'Create your shop first' }, { status: 404 })
            }
            console.error('[ShopSMS] Activation RPC error:', error)
            return NextResponse.json({ success: false, error: 'Activation failed. Please try again.' }, { status: 500 })
        }

        return NextResponse.json({ success: true, data })
    } catch (err) {
        console.error('[ShopSMS] Activate error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
