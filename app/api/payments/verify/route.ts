import { NextRequest, NextResponse } from 'next/server'
import { processCompletedWalletPayment } from '@/lib/payments'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!

// Light-weight gate: reject obviously bogus references before doing any
// auth/DB/Paystack work. References we issue are alphanumeric + dashes,
// 6-64 chars. Anything outside that shape can't possibly be ours.
const REFERENCE_SHAPE = /^[A-Za-z0-9_-]{6,64}$/

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url)
        const reference = searchParams.get('reference')
        const isInline = request.headers.get('accept')?.includes('application/json')

        if (!reference || !REFERENCE_SHAPE.test(reference)) {
            if (isInline) {
                return NextResponse.json({ success: false, error: 'No reference provided' }, { status: 400 })
            }
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=no_reference`)
        }

        // === AUTH GATE ===
        // Only the authenticated user who owns this payment can trigger
        // verification. The webhook (signed, server-to-server) is the
        // authoritative path — this route exists for the return-from-Paystack
        // page only. Without this gate, anyone could enumerate references and
        // burn Paystack quota.
        const supabase = await createRouteClient()
        const { data: { user: authUser } } = await supabase.auth.getUser()
        if (!authUser) {
            if (isInline) {
                return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
            }
            return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/auth/login?error=session_expired`)
        }

        // Confirm the reference belongs to this user. We use the service-role
        // client so RLS doesn't get in the way of the lookup. Shop and RC
        // references skip this check (they live in different tables and have
        // their own verify endpoints).
        const isWalletReference = !reference.startsWith('SHOP-') && !reference.startsWith('RC-')
        if (isWalletReference) {
            const admin = createServerClient()
            const { data: paymentRow } = await (admin
                .from('wallet_payments') as any)
                .select('user_id')
                .eq('reference', reference)
                .maybeSingle()

            if (paymentRow && paymentRow.user_id !== authUser.id) {
                if (isInline) {
                    return NextResponse.json({ success: false, error: 'Reference does not belong to this account' }, { status: 403 })
                }
                return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=invalid_reference`)
            }
            // If paymentRow is null we still proceed — the webhook may not have
            // created the row yet, and `processCompletedWalletPayment` handles
            // the not-found case safely.
        }

        // Verify with Paystack
        const paystackResponse = await fetch(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                },
            }
        )

        const paystackData = await paystackResponse.json()

        if (!paystackData.status || paystackData.data.status !== 'success') {
            console.error('[PaymentVerify] Paystack verification failed:', paystackData)
            if (isInline) {
                return NextResponse.json({ success: false, error: 'Payment verification failed' }, { status: 400 })
            }
            return NextResponse.redirect(
                `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=payment_failed`
            )
        }

        // SEC-007: route agent/dealer upgrade payments to the role-grant processor
        // (matching the webhook in app/api/webhooks/paystack). Without this, the
        // return-from-Paystack verify path credits the upgrade fee to the wallet
        // and never grants the agent/dealer role.
        const upgradeType = paystackData.data?.metadata?.upgrade_type
        let result
        if (upgradeType === 'dealer') {
            const { processCompletedDealerUpgradePayment } = await import('@/lib/dealer-payments')
            result = await processCompletedDealerUpgradePayment(reference, paystackData.data)
        } else if (upgradeType === 'agent') {
            const { processCompletedUpgradePayment } = await import('@/lib/payments')
            result = await processCompletedUpgradePayment(reference, paystackData.data)
        } else {
            result = await processCompletedWalletPayment(reference, paystackData.data)
        }

        if (!result.success) {
            if (isInline) {
                return NextResponse.json({ success: false, error: result.error || 'Processing failed' }, { status: 500 })
            }
            return NextResponse.redirect(
                `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=${result.error || 'processing_failed'}`
            )
        }

        if (isInline) {
            return NextResponse.json({ success: true, message: 'Payment successful' })
        }
        return NextResponse.redirect(
            `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?success=true`
        )
    } catch (error) {
        console.error('[PaymentVerify] Verification error:', error)
        const isInline = request.headers.get('accept')?.includes('application/json')
        if (isInline) {
            return NextResponse.json({ success: false, error: 'Verification failed' }, { status: 500 })
        }
        return NextResponse.redirect(
            `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet?error=verification_failed`
        )
    }
}
