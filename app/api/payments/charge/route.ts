import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { calculatePaystackFee, generateReferenceCode } from '@/lib/utils'
import { resolvePaystackFeePercent, resolveTopupLimits } from '@/lib/paystack-fees'
import { checkChargePhoneLimit } from '@/lib/charge-phone-ratelimit'

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

        const { amount: rawAmount, phone, provider, client_request_id: rawClientRequestId } = await request.json()

        // Strict type check: a string amount would make `amount + fee` below
        // concatenate instead of add, corrupting the charged total. The
        // configurable min/max band is enforced after admin settings load.
        if (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount) || rawAmount <= 0) {
            return NextResponse.json({ error: 'Enter a valid amount' }, { status: 400 })
        }

        // Round to 2 dp (pesewas) so fee/total math and the stored row never carry
        // sub-pesewa fractions; everything below uses the rounded value.
        const amount = Math.round(rawAmount * 100) / 100
        if (amount < 0.01) {
            return NextResponse.json({ error: 'Enter a valid amount' }, { status: 400 })
        }

        // Optional client-supplied idempotency key (UUID). Anything else is ignored.
        const clientRequestId: string | null =
            typeof rawClientRequestId === 'string' && /^[0-9a-fA-F-]{36}$/.test(rawClientRequestId)
                ? rawClientRequestId
                : null

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

        const { data: userData, error: userDataError } = await supabaseAdmin
            .from('users')
            .select('email, role, status, dealer_expires_at, agent_expires_at')
            .eq('id', userId)
            .single()

        // Fail closed: without the row we can't verify account status or the
        // correct fee tier, so don't start a charge.
        if (userDataError || !userData) {
            console.error('[ChargeInit] User lookup failed:', userDataError?.message)
            return NextResponse.json({ error: 'Please try again' }, { status: 503 })
        }

        // Checked BEFORE the phone limiter so a non-active account can't burn a
        // third party's global per-phone rate-limit slot.
        if ((userData as any).status !== 'active') {
            return NextResponse.json(
                { error: 'Your account is not active. Contact support.' },
                { status: 403 }
            )
        }

        // ── Anti-abuse: cap charges per TARGET PHONE, across all accounts ──
        // The middleware limiter is keyed per-user+IP, so one account could
        // still fire its full per-minute budget at someone else's number
        // indefinitely over time. This caps prompts to any single phone
        // regardless of who is initiating them.
        if (!(await checkChargePhoneLimit(phone))) {
            return NextResponse.json(
                { error: 'Too many payment requests to this number. Please try again later.' },
                { status: 429 }
            )
        }

        // The anti-abuse cap on simultaneous pending charges per user is enforced
        // atomically inside create_pending_wallet_payment (see below).

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
        // Pesewa-rounded so the RPC, Paystack payload and responses all agree
        // (a raw float sum like 10.1 + 0.15 can carry binary artefacts).
        const totalAmount = Math.round((amount + fee) * 100) / 100

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

        // Atomic create: a per-user advisory lock inside the RPC enforces the pending
        // cap (5 / 15 min) and client_request_id replay without a check-then-insert
        // race. A duplicate reference raises unique_violation (23505) — retry with a
        // fresh reference.
        let created: any = null
        let reference = ''
        for (let attempt = 0; attempt < 3; attempt++) {
            reference = `WAL-${generateReferenceCode()}`
            const { data: rpcData, error: rpcError } = await (supabaseAdmin as any).rpc('create_pending_wallet_payment', {
                p_user_id: userId,
                p_wallet_id: (wallet as any)!.id,
                p_amount: amount,
                p_fee: fee,
                p_total: totalAmount,
                p_reference: reference,
                p_client_request_id: clientRequestId,
            })

            if (!rpcError) {
                created = rpcData
                break
            }
            if (rpcError.code === '23505' && attempt < 2) {
                console.warn('[ChargeInit] Duplicate reference on create, retrying:', rpcError.message)
                continue
            }
            console.error('[ChargeInit] Payment record error:', rpcError)
            return NextResponse.json({ error: 'Failed to create payment record' }, { status: 500 })
        }

        if (!created) {
            console.error('[ChargeInit] Payment record RPC returned no data')
            return NextResponse.json({ error: 'Failed to create payment record' }, { status: 500 })
        }

        if (created.error === 'too_many_pending') {
            return NextResponse.json(
                { error: 'You have too many pending payments. Finish or wait for them to expire before starting a new one.' },
                { status: 429 }
            )
        }

        if (created.error) {
            console.error('[ChargeInit] Payment record RPC error:', created.error)
            return NextResponse.json({ error: 'Failed to create payment record' }, { status: 500 })
        }

        // Replay of a request we already accepted: return its stored state and never
        // fire a second Paystack charge. Use the stored fee/total (the RPC ignores
        // the amount passed on replay).
        if (created.existing) {
            const replayBase = {
                reference: created.reference,
                fee: created.fee,
                total_amount: created.total_amount,
            }
            // Terminal rows: honour the stored status (the wallet page treats
            // 'failed' as an error and confirms 'success' via check-pending).
            if (created.status === 'failed') {
                return NextResponse.json({
                    status: 'failed',
                    display_text: 'This payment could not be completed. Please start a new top-up.',
                    ...replayBase,
                })
            }
            if (created.status === 'completed') {
                return NextResponse.json({ status: 'success', display_text: '', ...replayBase })
            }
            return NextResponse.json({
                status: created.charge_status ?? 'pending',
                display_text: created.display_text ?? 'Check your phone to approve the payment',
                ...replayBase,
            })
        }

        const paymentId: string = created.id

        let paystackData: any
        try {
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
                signal: AbortSignal.timeout(25_000),
            })

            paystackData = await paystackRes.json()
        } catch (fetchError: any) {
            if (fetchError?.name === 'TimeoutError' || fetchError?.name === 'AbortError') {
                // Outcome unknown (the prompt may already be on the customer's phone).
                // Leave the row pending so check-pending / the webhook can settle it.
                console.warn('[ChargeInit] Paystack charge timed out; leaving payment pending:', reference)
                return NextResponse.json({
                    status: 'pending',
                    reference,
                    display_text: 'Check your phone to approve the payment',
                    fee,
                    total_amount: totalAmount,
                })
            }
            throw fetchError
        }

        if (!paystackData.status) {
            console.error('[ChargeInit] Paystack charge failed:', paystackData)
            await (supabaseAdmin.from('wallet_payments') as any)
                .update({ status: 'failed' })
                .eq('id', paymentId)
            return NextResponse.json({ error: 'Failed to initiate charge' }, { status: 500 })
        }

        if (!paystackData.data) {
            console.error('[ChargeInit] Paystack charge response missing data:', paystackData)
            await (supabaseAdmin.from('wallet_payments') as any)
                .update({ status: 'failed' })
                .eq('id', paymentId)
            return NextResponse.json({ error: 'Unexpected response from payment processor' }, { status: 500 })
        }

        const chargeStatus: string = paystackData.data.status
        const displayText: string = paystackData.data.display_text || paystackData.data.message || ''

        await (supabaseAdmin.from('wallet_payments') as any)
            .update({
                provider_reference: paystackData.data.reference || reference,
                metadata: { ...(created.metadata ?? {}), charge_status: chargeStatus, display_text: displayText },
            })
            .eq('id', paymentId)

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
