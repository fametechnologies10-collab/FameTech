import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { calculatePaystackFee, generateReferenceCode } from '@/lib/utils'
import { resolvePaystackFeePercent, resolveTopupLimits } from '@/lib/paystack-fees'

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!


export async function POST(request: NextRequest) {
    try {
        // Check if payment system is under maintenance
        if (process.env.NEXT_PUBLIC_PAYMENT_MAINTENANCE_MODE === 'true') {
            return NextResponse.json(
                { error: 'Payment system is currently under maintenance. Please try again later.' },
                { status: 503 }
            )
        }

        const supabase = await createRouteClient()
        const supabaseAdmin = createServerClient() // For database operations
        const { amount } = await request.json()

        // Type/finite check only; the configurable band is enforced after
        // admin settings load below (server is authoritative).
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
            return NextResponse.json({ error: 'Enter a valid amount' }, { status: 400 })
        }

        // Get current user
        const { data: { user: authUser } } = await supabase.auth.getUser()
        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id

        // Get user details (email + role context in a single round-trip)
        const { data: userData, error: userDataError } = await supabaseAdmin
            .from('users')
            .select('email, role, status, dealer_expires_at, agent_expires_at')
            .eq('id', userId)
            .single()
        if (userDataError) {
            console.error('[PaymentInit] User lookup failed:', userDataError.message)
            // non-blocking — fall back to authUser.email and base fee
        }

        // Server-side suspension enforcement — suspended accounts cannot top up.
        if ((userData as any)?.status === 'suspended') {
            return NextResponse.json({ error: 'Your account is currently suspended. Please contact support.' }, { status: 403 })
        }

        const email = (userData as any)?.email || authUser.email
        if (!email) {
            return NextResponse.json({ error: 'Account email is required for payment' }, { status: 400 })
        }

        // Get or create wallet
        let { data: wallet } = await (supabaseAdmin
            .from('wallets') as any)
            .select('id')
            .eq('user_id', userId)
            .single()

        if (!wallet) {
            const { data: newWallet } = await (supabaseAdmin
                .from('wallets') as any)
                .insert({ user_id: userId })
                .select()
                .single()
            wallet = newWallet
        }

        // Load fee + limit settings (single source of truth resolver).
        const { data: settingsRows } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', [
                'paystack_fee_percent',
                'agent_paystack_fee_percent',
                'dealer_paystack_fee_percent',
                'paystack_min_topup',
                'paystack_max_topup',
            ])
        const settings: Record<string, unknown> = {}
        ;((settingsRows as any[]) || []).forEach((s: any) => { settings[s.key] = s.value })

        // Enforce admin-configured top-up band (server is authoritative).
        const { min, max } = resolveTopupLimits(settings)
        if (amount < min || amount > max) {
            return NextResponse.json(
                { error: `Amount must be between GHS ${min} and GHS ${max.toLocaleString()}` },
                { status: 400 },
            )
        }

        const feePercent = resolvePaystackFeePercent({
            role: (userData as any)?.role,
            agentExpiresAt: (userData as any)?.agent_expires_at,
            dealerExpiresAt: (userData as any)?.dealer_expires_at,
        }, settings)

        const fee = calculatePaystackFee(amount, feePercent)
        const totalAmount = amount + fee
        const reference = `WAL-${generateReferenceCode()}`

        // Create payment record
        const { data: payment, error: paymentError } = await (supabaseAdmin
            .from('wallet_payments') as any)
            .insert({
                user_id: userId,
                wallet_id: (wallet as any)!.id,
                amount: amount,
                fee: fee,
                total_amount: totalAmount,
                reference: reference,
                provider: 'paystack',
                status: 'pending',
            })
            .select()
            .single()

        if (paymentError) {
            console.error('Payment record error:', paymentError)
            return NextResponse.json({ error: 'Failed to create payment' }, { status: 500 })
        }

        // Initialize Paystack payment
        const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                email,
                amount: Math.round(totalAmount * 100), // Paystack uses kobo/pesewas
                currency: 'GHS',
                reference: reference,
                callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/payments/verify?reference=${reference}`,
                metadata: {
                    user_id: userId,
                    payment_id: payment.id,
                    amount: amount,
                    fee: fee,
                },
            }),
        })

        const paystackData = await paystackResponse.json()

        if (!paystackData.status) {
            console.error('Paystack error:', paystackData)
            await (supabaseAdmin
                .from('wallet_payments') as any)
                .update({ status: 'failed' })
                .eq('id', (payment as any).id)
            return NextResponse.json({ error: 'Failed to initialize payment' }, { status: 500 })
        }

        // Update payment with Paystack reference
        await (supabaseAdmin
            .from('wallet_payments') as any)
            .update({ provider_reference: paystackData.data.reference })
            .eq('id', (payment as any).id)

        return NextResponse.json({
            success: true,
            authorization_url: paystackData.data.authorization_url,
            access_code: paystackData.data.access_code,
            reference: reference,
        })
    } catch (error) {
        console.error('Payment initialization error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
