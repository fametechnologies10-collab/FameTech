import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { phoneSchema } from '@/lib/validation'
import { resolveNameSingle } from '@/lib/momo-verify'
import { normalizeGhanaPhone } from '@/lib/sms-service'
import { consumeNameLookupQuota } from '@/lib/payout-name-lookup-quota'

// Saved payout accounts are trusted by /api/shop/withdraw as ALREADY name-verified
// (it skips the provider lookup for a savedDetailId). So they may only be created
// here, server-side, with the name resolved by the provider — never written by the
// browser (client INSERT/UPDATE on shop_payment_details is revoked). Owners may
// still delete their own rows directly.
const MAX_SAVED_DETAILS = 5
const MOMO_NETWORKS = ['MTN MoMo', 'Telecel Cash', 'AirtelTigo Money'] as const

const addSchema = z.object({
    momoNumber: phoneSchema,
    network: z.enum(MOMO_NETWORKS),
})

const setDefaultSchema = z.object({
    id: z.string().uuid(),
})

// ─── POST — verify and save a MoMo payout account ────────────────────────────
export async function POST(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const parsed = addSchema.safeParse(await req.json().catch(() => ({})))
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: parsed.error.errors[0]?.message || 'Invalid input' },
                { status: 400 }
            )
        }
        const momoNumber = parsed.data.momoNumber.trim()
        const { network } = parsed.data

        const admin = createServerClient() as any
        const { count } = await admin
            .from('shop_payment_details')
            .select('id', { count: 'exact', head: true })
            .eq('shop_owner_id', user.id)
        if ((count ?? 0) >= MAX_SAVED_DETAILS) {
            return NextResponse.json(
                { success: false, error: `Maximum of ${MAX_SAVED_DETAILS} saved details reached` },
                { status: 400 }
            )
        }

        if (!(await consumeNameLookupQuota(user.id))) {
            return NextResponse.json(
                { success: false, error: 'Daily account-verification limit reached. Please try again tomorrow or contact support.' },
                { status: 429 }
            )
        }

        const normalized = normalizeGhanaPhone(momoNumber)
        const resolved = normalized ? await resolveNameSingle(normalized) : null
        const accountName = resolved?.fullName?.trim()
        if (!accountName) {
            return NextResponse.json(
                { success: false, error: 'Could not verify account name. Please check the number and try again.' },
                { status: 400 }
            )
        }

        // Atomic count-and-insert (per-owner lock, hard cap) inside the RPC. It returns
        // false when a concurrent add filled the last slot after the pre-check above.
        const { data: inserted, error } = await admin.rpc('save_shop_payment_detail_if_under_limit', {
            p_owner_id: user.id,
            p_account_name: accountName,
            p_momo_number: momoNumber,
            p_account_number: null,
            p_network: network,
            p_payment_type: 'momo',
            p_bank_id: null,
            p_limit: MAX_SAVED_DETAILS,
        })
        if (error) {
            console.error('[PaymentDetails] save error:', error)
            return NextResponse.json({ success: false, error: 'Failed to save payment method' }, { status: 500 })
        }
        // Only an explicit false means "not inserted"; null is the pre-migration void
        // RPC (this code deploys before 20260925c), which always inserted under the cap.
        if (inserted === false) {
            return NextResponse.json(
                { success: false, error: `Maximum of ${MAX_SAVED_DETAILS} saved details reached` },
                { status: 400 }
            )
        }

        return NextResponse.json({ success: true, data: { account_name: accountName } })
    } catch (err) {
        console.error('[PaymentDetails] POST error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// ─── PATCH — make one saved account the default ──────────────────────────────
export async function PATCH(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const parsed = setDefaultSchema.safeParse(await req.json().catch(() => ({})))
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'A valid id is required' }, { status: 400 })
        }

        const admin = createServerClient() as any
        const { data: target } = await admin
            .from('shop_payment_details')
            .select('id')
            .eq('id', parsed.data.id)
            .eq('shop_owner_id', user.id)
            .maybeSingle()
        if (!target) {
            return NextResponse.json({ success: false, error: 'Payment method not found' }, { status: 404 })
        }

        // trg_single_default_payment clears the owner's other defaults automatically.
        const { error } = await admin
            .from('shop_payment_details')
            .update({ is_default: true })
            .eq('id', parsed.data.id)
            .eq('shop_owner_id', user.id)
        if (error) {
            console.error('[PaymentDetails] set-default error:', error)
            return NextResponse.json({ success: false, error: 'Failed to update default' }, { status: 500 })
        }

        return NextResponse.json({ success: true, data: {} })
    } catch (err) {
        console.error('[PaymentDetails] PATCH error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
