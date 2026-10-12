import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { z } from 'zod'
import { resolveNameSingle } from '@/lib/momo-verify'
import { normalizeGhanaPhone } from '@/lib/sms-service'
import { phoneSchema } from '@/lib/validation'
import { WITHDRAW_NETWORKS } from '@/lib/shop-withdraw-validation'
import { consumeNameLookupQuota } from '@/lib/payout-name-lookup-quota'

// Payouts are mobile-money only (bank payouts removed), so this resolves MoMo
// holder names only.
const validateSchema = z.object({
    phone: phoneSchema,
    network: z.enum(WITHDRAW_NETWORKS),
})

export async function POST(req: NextRequest) {
    try {
        // 1. Auth check — an authenticated shop-wallet owner (any role) can validate their payout account
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        // Only wallet owners can look names up (a plain customer has no payout to verify,
        // so letting them in would make this a phone-number -> name oracle).
        const { data: ownWallet } = await supabase
            .from('shop_wallets')
            .select('id')
            .eq('owner_id', user.id)
            .maybeSingle()

        if (!ownWallet) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        // 2. Validate input shape
        const body = await req.json().catch(() => null)
        const parsed = validateSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { error: 'Invalid request', details: parsed.error.errors.map(e => e.message) },
                { status: 400 }
            )
        }

        const { phone, network } = parsed.data

        // 2b. Per-user daily cap (A8). Counts valid-shape attempts so probing
        //     burns quota too. Shared with /api/shop/payment-details.
        if (!(await consumeNameLookupQuota(user.id))) {
            return NextResponse.json(
                { success: false, error: 'Daily account-verification limit reached. Please try again tomorrow or contact support.' },
                { status: 429 }
            )
        }

        // 2c. Attributable audit trail — who resolved which number (masked).
        //     Makes any abuse detectable and tied to a specific account.
        console.info('[validate-account][audit]', JSON.stringify({
            userId: user.id,
            network,
            phoneLast4: phone.slice(-4),
            at: new Date().toISOString(),
        }))

        // 3. Multi-provider resolution (Paystack first, Moolre as fallback).
        const normalized = normalizeGhanaPhone(phone)
        if (normalized) {
            const resolved = await resolveNameSingle(normalized)
            if (resolved?.fullName) {
                // Return only the verified name — never the raw provider response
                return NextResponse.json({ success: true, name: resolved.fullName })
            }
        }
        return NextResponse.json(
            { success: false, error: 'Could not verify account name. Please check the number and try again.' },
            { status: 200 } // Return 200 so client handles it as a validation failure, not a crash
        )
    } catch (error: any) {
        console.error('[validate-account API]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
