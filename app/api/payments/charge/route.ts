import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { calculatePaystackFee, generateReferenceCode } from '@/lib/utils'
import { resolvePaystackFeePercent, resolveTopupLimits } from '@/lib/paystack-fees'

const GHANA_NETWORK_MAP: Record<string, string> = {
    '024': 'MTN', '025': 'MTN', '053': 'MTN', '054': 'MTN', '055': 'MTN', '059': 'MTN',
    '020': 'VOD', '050': 'VOD',
    '026': 'ATL', '027': 'ATL', '056': 'ATL', '057': 'ATL',
}

export async function POST(request: NextRequest) {
    try {
        if (process.env.NEXT_PUBLIC_PAYMENT_MAINTENANCE_MODE === 'true') {
            return NextResponse.json(
                { error: 'Payment system is currently under maintenance.' },
                { status: 503 }
            )
        }

        const supabase = await createRouteClient()
        const supabaseAdmin = createServerClient()

        const { data: { user: authUser } } = await supabase.auth.getUser()
        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { amount, phone, provider } = await request.json()

        // Strict type check: a string amount would make `amount + fee` below
        // concatenate instead of add, corrupting the charged total. The
        // configurable min/max band is enforced after admin settings load.
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
            return NextResponse.json({ error: 'Enter a valid amount' }, { status: 400 })
        }

        if (!phone || !/^0[0-9]{9}$/.test(phone)) {
            return NextResponse.json(
                { error: 'Enter a valid Ghana mobile number (e.g. 0241234567)' },
                { status: 400 }
            )
        }

        const VALID_PROVIDERS = ['MTN', 'VOD', 'ATL']
        const providedProvider = provider && VALID_PROVIDERS.includes(provider) ? provider : null
        const detectedProvider = GHANA_NETWORK_MAP[phone.slice(0, 3)] ?? null
        const resolvedProvider = providedProvider ?? detectedProvider

        if (!resolvedProvider) {
            return NextResponse.json(
                { error: 'Could not detect network. Please select your network manually.', needsManualSelection: true },
                { status: 400 }
            )
        }

        const userId = authUser.id

        // ── Anti-abuse: cap simultaneous pending charges per user ──────────
        // Each charge fires a real MoMo prompt to an attacker-controlled phone
        // and inserts a wallet_payments row. Without a ceiling, the endpoint can
        // be used to spam prompts at arbitrary numbers and flood the table.
        // Legitimate users almost never have more than one charge in flight.
        const pendingSince = new Date(Date.now() - 15 * 60 * 1000).toISOString()
        const { count: pendingCount } = await (supabaseAdmin.from('wallet_payments') as any)
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('status', 'pending')
            .gte('created_at', pendingSince)

        if ((pendingCount || 0) >= 5) {
            return NextResponse.json(
                { error: 'You have too many pending payments. Finish or wait for them to expire before starting a new one.' },
                { status: 429 }
            )
        }

        const { data: userData, error: userDataError } = await supabaseAdmin
            .from('users')
            .select('email, role, dealer_expires_at, agent_expires_at')
            .eq('id', userId)
            .single()

        if (userDataError) {
            console.error('[ChargeInit] User lookup failed:', userDataError.message)
            // non-blocking — continue with authUser.email and base fee
        }

        const email = (userData as any)?.email || authUser.email

        // Fix 6: guard against undefined email
        if (!email) {
            return NextResponse.json({ error: 'Account email is required for payment' }, { status: 400 })
        }

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

        let { data: wallet } = await (supabaseAdmin.from('wallets') as any)
            .select('id')
            .eq('user_id', userId)
            .single()

        if (!wallet) {
            const { data: newWallet, error: walletCreateError } = await (supabaseAdmin.from('wallets') as any)
                .insert({ user_id: userId })
                .select()
                .single()
            if (walletCreateError || !newWallet) {
                console.error('[ChargeInit] Failed to create wallet:', walletCreateError)
                return NextResponse.json({ error: 'Failed to setup wallet' }, { status: 500 })
            }
            wallet = newWallet
        }

        const { data: payment, error: paymentError } = await (supabaseAdmin.from('wallet_payments') as any)
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
            console.error('[ChargeInit] Payment record error:', paymentError)
            return NextResponse.json({ error: 'Failed to create payment record' }, { status: 500 })
        }

        const paystackRes = await fetch('https://api.paystack.co/charge', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                email,
                amount: Math.round(totalAmount * 100),
                currency: 'GHS',
                reference,
                mobile_money: { phone, provider: resolvedProvider },
            }),
        })

        const paystackData = await paystackRes.json()

        if (!paystackData.status) {
            console.error('[ChargeInit] Paystack charge failed:', paystackData)
            await (supabaseAdmin.from('wallet_payments') as any)
                .update({ status: 'failed' })
                .eq('id', (payment as any).id)
            return NextResponse.json({ error: 'Failed to initiate charge' }, { status: 500 })
        }

        if (!paystackData.data) {
            console.error('[ChargeInit] Paystack charge response missing data:', paystackData)
            await (supabaseAdmin.from('wallet_payments') as any)
                .update({ status: 'failed' })
                .eq('id', payment.id)
            return NextResponse.json({ error: 'Unexpected response from payment processor' }, { status: 500 })
        }

        const chargeStatus: string = paystackData.data.status
        const displayText: string = paystackData.data.display_text || paystackData.data.message || ''

        await (supabaseAdmin.from('wallet_payments') as any)
            .update({ provider_reference: paystackData.data.reference || reference })
            .eq('id', (payment as any).id)

        return NextResponse.json({
            status: chargeStatus,
            reference,
            display_text: displayText,
            fee,
            total_amount: totalAmount,
        })
    } catch (error) {
        console.error('[ChargeInit] Unhandled error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
