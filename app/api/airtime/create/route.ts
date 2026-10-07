import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { generateReferenceCode } from '@/lib/utils'
import { cookies } from 'next/headers'
import { sendAirtimeBeneficiarySMS, sendAdminAirtimeAlertSMS } from '@/lib/sms-service'
import { sendAdminAirtimeOrderEmail } from '@/lib/email-service'
import { waitUntil } from '@vercel/functions'
import { effectiveRoleFromExpiry } from '@/lib/effective-role'
import { quoteAirtime } from '@/lib/airtime-pricing'

const NETWORK_KEY_MAP: Record<string, string> = {
    MTN: 'mtn',
    Telecel: 'telecel',
    AT: 'at',
}

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id
        const supabase = createServerClient()

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { beneficiaryPhone, network, amount, useExactAmount, referenceCode: clientReferenceCode, type, bundle_preference } = body

        // Derive the order type and validate
        const orderType: 'airtime' | 'mashup' = type === 'mashup' ? 'mashup' : 'airtime'
        const bundlePreference: 'balanced' | 'data' | 'voice' | null = 
            orderType === 'mashup' 
                ? (['balanced', 'data', 'voice'].includes(bundle_preference) ? bundle_preference : 'balanced')
                : null

        // ── Validate required fields ──────────────────────────────────────────
        if (!beneficiaryPhone || !network || !amount) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
        }
        if (!['MTN', 'Telecel', 'AT'].includes(network)) {
            return NextResponse.json({ error: 'Invalid network' }, { status: 400 })
        }
        // Mashup is MTN-only
        if (orderType === 'mashup' && network !== 'MTN') {
            return NextResponse.json({ error: 'MTN Mashup is only available for MTN numbers' }, { status: 400 })
        }

        // ── Tier 1 phone validation (hard) ────────────────────────────────────
        const cleanPhone = String(beneficiaryPhone).replace(/\s+/g, '')
        if (!/^0\d{9}$/.test(cleanPhone)) {
            return NextResponse.json({
                error: 'Invalid phone number. Use Ghana format: 0XXXXXXXXX (10 digits starting with 0)'
            }, { status: 400 })
        }

        // ── Fetch user role + check idempotency ────────────────────────────────
        const [userResult, settingsResult] = await Promise.all([
            (supabase.from('users') as any).select('role, first_name, last_name, email, phone_number, dealer_expires_at, agent_expires_at').eq('id', userId).single(),
            (supabase.from('admin_settings') as any).select('key, value').in('key', [
                `airtime_enabled_${NETWORK_KEY_MAP[network]}`,
                `mashup_enabled_${NETWORK_KEY_MAP[network]}`,
                `${orderType}_fee_${NETWORK_KEY_MAP[network]}_customer`,
                `${orderType}_fee_${NETWORK_KEY_MAP[network]}_agent`,
                `${orderType}_fee_${NETWORK_KEY_MAP[network]}_dealer`,
                `${orderType}_min_amount_customer`, `${orderType}_min_amount_agent`, `${orderType}_min_amount_dealer`,
                `${orderType}_max_amount_customer`, `${orderType}_max_amount_agent`, `${orderType}_max_amount_dealer`,
                'dashboard_mashup_enabled',
            ])
        ])

        if (userResult.error || !userResult.data) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        const userData = userResult.data as any
        // Expiry-aware. This route previously priced off the raw users.role, so a lapsed
        // dealer/agent kept their discount on airtime indefinitely — while data/purchase,
        // the storefront and USSD all already treated them as a customer. Same account,
        // different price depending on the surface. See lib/effective-role.ts.
        const userRole = effectiveRoleFromExpiry(
            userData.role,
            (userData as any).agent_expires_at ?? null,
            (userData as any).dealer_expires_at ?? null,
        )

        const settingsMap: Record<string, string> = {}
        for (const s of (settingsResult.data || [])) {
            settingsMap[s.key] = s.value
        }

        // ── Check network availability ─────────────────────────────────────────
        const networkEnabledKey = `airtime_enabled_${NETWORK_KEY_MAP[network]}`
        if (settingsMap[networkEnabledKey] === 'false') {
            return NextResponse.json({ error: `${network} airtime is currently unavailable. Please try another network.` }, { status: 400 })
        }

        // ── Mashup availability (dashboard) ────────────────────────────────────
        if (orderType === 'mashup' && settingsMap['dashboard_mashup_enabled'] !== 'true') {
            return NextResponse.json({ error: 'Mashup purchases are currently disabled' }, { status: 503 })
        }
        // Mashup carries its own per-network kill-switch (mashup_enabled_<net>), independent of
        // airtime_enabled_<net> checked above — an admin can disable Mashup on a network without
        // touching plain airtime on that same network.
        if (orderType === 'mashup' && settingsMap[`mashup_enabled_${NETWORK_KEY_MAP[network]}`] === 'false') {
            return NextResponse.json({ error: `${network} Mashup is currently unavailable. Please try again later.` }, { status: 400 })
        }

        // ── Limits + fee calculation (always server-side, per-product/per-role) ──
        // Shared with app/api/v2/airtime/purchase via lib/airtime-pricing.ts so
        // the dashboard and the developer API cannot drift apart on fee maths or
        // fallback constants (review finding I6). orderType is passed through
        // because mashup uses its own settings keys and its own GHS 5 minimum.
        const parsedAmount = parseFloat(amount)
        if (isNaN(parsedAmount)) {
            return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
        }

        const quoted = quoteAirtime({
            settings: settingsMap,
            network,
            role: userRole,
            amount: parsedAmount,
            useExactAmount: !!useExactAmount,
            orderType,
        })
        if (!quoted.ok) {
            return NextResponse.json({ error: quoted.message }, { status: 400 })
        }
        const { airtimeAmount, feeAmount, totalPaid, feeRate } = quoted.quote

        // ── 30-second idempotency guard ───────────────────────────────────────
        const thirtySecondsAgo = new Date(Date.now() - 30000).toISOString()
        const { data: recentOrder } = await (supabase.from('airtime_orders') as any)
            .select('id, reference_code')
            .eq('user_id', userId)
            .eq('beneficiary_phone', cleanPhone)
            .eq('total_paid', totalPaid)
            .gte('created_at', thirtySecondsAgo)
            .maybeSingle()

        if (recentOrder) {
            return NextResponse.json({
                error: 'Duplicate order detected. Please wait 30 seconds before placing the same order again.',
                isDuplicate: true
            }, { status: 409 })
        }

        // ── Client-side idempotency (referenceCode) ───────────────────────────
        if (clientReferenceCode) {
            const { data: existingOrder } = await (supabase.from('airtime_orders') as any)
                .select('id, reference_code, status')
                .eq('reference_code', clientReferenceCode)
                .maybeSingle()

            if (existingOrder) {
                return NextResponse.json({
                    success: true,
                    isDuplicate: true,
                    order: { id: existingOrder.id, reference_code: existingOrder.reference_code, status: existingOrder.status }
                })
            }
        }

        // ── Atomic wallet deduction ───────────────────────────────────────────
        const { data: deductResult, error: deductError } = await (supabase as any)
            .rpc('deduct_wallet_balance', {
                p_user_id: userId,
                p_amount: totalPaid,
            })

        if (deductError) {
            if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
                return NextResponse.json({ error: 'Insufficient balance. Please top up your wallet.' }, { status: 400 })
            }
            console.error('[Airtime] Wallet deduction error:', deductError)
            return NextResponse.json({ error: 'Failed to process payment' }, { status: 500 })
        }

        const walletRow = deductResult?.[0] || deductResult
        const walletId = walletRow?.wallet_id
        const newBalance = walletRow?.new_balance

        if (!walletId) {
            // deduct_wallet_balance returned no error → the debit was already applied
            // (the RPC raises INSUFFICIENT_BALANCE otherwise; it never succeeds without
            // moving money). If we can't resolve wallet_id from its result shape, refund
            // before failing so the user is never debited without an order. Atomic
            // compensating credit — mirrors the orderError refund path below.
            const { error: refundError } = await (supabase as any).rpc('credit_wallet_balance', {
                p_user_id: userId,
                p_amount: totalPaid,
            })
            if (refundError) {
                console.error('[Airtime] CRITICAL: refund failed after missing wallet_id post-deduct; manual reconciliation required:', refundError)
            }
            return NextResponse.json({ error: 'Failed to process payment' }, { status: 500 })
        }

        const referenceCode = clientReferenceCode || generateReferenceCode()

        // ── Create airtime/mashup order ────────────────────────────────────────
        const { data: order, error: orderError } = await (supabase.from('airtime_orders') as any)
            .insert({
                user_id: userId,
                user_role: userRole,
                beneficiary_phone: cleanPhone,
                network,
                airtime_amount: airtimeAmount,
                fee_rate: feeRate,
                fee_amount: feeAmount,
                admin_fee_amount: feeAmount,
                shop_fee_amount: 0,
                total_paid: totalPaid,
                use_exact_amount: useExactAmount || false,
                status: 'pending',
                // Explicit rather than leaning on the column DEFAULT, so all four
                // writers (dashboard/web, USSD, shop, API) state their own source and
                // the default is only a safety net for a writer nobody remembered.
                source: 'web',
                reference_code: referenceCode,
                type: orderType,
                bundle_preference: bundlePreference,
            })
            .select()
            .single()

        if (orderError) {
            console.error('[Airtime] Order creation error:', orderError)
            // Atomic compensating refund (balance = balance + amount). Never a raw absolute write from
            // a cached snapshot — that races with concurrent deductions. Mirrors orders/purchase + the developer-API routes.
            const { error: refundError } = await (supabase as any).rpc('credit_wallet_balance', {
                p_user_id: userId,
                p_amount: totalPaid,
            })
            if (refundError) {
                console.error('[Airtime] CRITICAL: refund failed after order-insert failure; manual reconciliation required:', refundError)
            }
            return NextResponse.json({ error: 'Failed to create order' }, { status: 500 })
        }

        // ── Wallet transaction record (fire-and-forget) ───────────────────────
        ;(supabase.from('wallet_transactions') as any).insert({
            wallet_id: walletId,
            user_id: userId,
            type: 'debit',
            amount: totalPaid,
            description: orderType === 'mashup'
                ? `Mashup: GHS ${airtimeAmount.toFixed(2)} bundle for ${cleanPhone} (MTN)`
                : `Airtime: GHS ${airtimeAmount.toFixed(2)} for ${cleanPhone} (${network})`,
            reference: referenceCode,
            source: 'airtime',
            status: 'completed',
        }).then(() => {}).catch((e: any) => console.error('[Airtime] Tx insert error:', e))

        // ── In-app notification (fire-and-forget) ─────────────────────────────
        ;(supabase.from('notifications') as any).insert({
            user_id: userId,
            title: orderType === 'mashup' ? 'Mashup Bundle Order Placed' : 'Airtime Order Placed',
            message: orderType === 'mashup'
                ? `GHS ${airtimeAmount.toFixed(2)} Mashup bundle for ${cleanPhone} (MTN) is pending. Ref: ${referenceCode}`
                : `GHS ${airtimeAmount.toFixed(2)} airtime for ${cleanPhone} (${network}) is pending. Ref: ${referenceCode}`,
            type: 'order_update',
            action_url: '/dashboard/airtime',
        }).then(() => {}).catch((e: any) => console.error('[Airtime] Notification error:', e))

        // ── Auto-fulfill via Hubtel Commission Services (no-op if kill-switch off) ──
        waitUntil((async () => {
            try {
                const { dispatchAirtimeFulfillment } = await import('@/lib/airtime-fulfillment')
                await dispatchAirtimeFulfillment((order as any).id)
            } catch (e) {
                console.error('[Airtime] auto-dispatch failed:', e)
            }
        })())

        // ── Post-order notifications (wrapped in waitUntil to prevent Vercel from killing) ──
        waitUntil((async () => {
            try {
                // 1. Beneficiary SMS — sent immediately on wallet deduction
                await sendAirtimeBeneficiarySMS(cleanPhone, airtimeAmount)
                    .catch((err: any) => console.error('[Airtime] Beneficiary SMS failed:', err))

                // 2. Admin email alert
                await sendAdminAirtimeOrderEmail({
                    referenceCode,
                    userName: `${userData.first_name} ${userData.last_name}`.trim(),
                    userEmail: userData.email,
                    userRole,
                    beneficiaryPhone: cleanPhone,
                    network,
                    airtimeAmount,
                    feeRate,
                    feeAmount,
                    totalPaid,
                    walletBalanceAfter: newBalance,
                    useExactAmount: useExactAmount || false,
                    type: orderType,
                    bundle_preference: bundlePreference,
                }).catch((err: any) => console.error('[Airtime] Admin email failed:', err))

                // 3. Admin SMS alert — MASHUP ONLY. Airtime auto-fulfills via Hubtel now, so the per-order
                // admin SMS is just noise; admins still get the email above + a web-push on fulfillment failure.
                if (orderType === 'mashup') {
                    try {
                        const { data: admins } = await (supabase.from('users') as any)
                            .select('phone_number')
                            .eq('role', 'admin')
                        const adminPhones = admins?.map((a: any) => a.phone_number).filter(Boolean) || []

                        if (adminPhones.length > 0) {
                            await sendAdminAirtimeAlertSMS(adminPhones, {
                                source: `${userData.first_name || ''} ${userData.last_name || ''}`.trim() || 'Guest',
                                receiver: cleanPhone,
                                amount: airtimeAmount,
                                network: network,
                                type: orderType,
                                bundle_preference: bundlePreference,
                            })
                        }
                    } catch (smsErr) {
                        console.error('[Mashup] Admin SMS failed:', smsErr)
                    }
                }
            } catch (postOrderErr) {
                console.error('[Airtime] Post-order processing error:', postOrderErr)
            }
        })())

        return NextResponse.json({
            success: true,
            order: {
                id: (order as any).id,
                reference_code: referenceCode,
                status: 'pending',
                network,
                beneficiary_phone: cleanPhone,
                airtime_amount: airtimeAmount,
                fee_amount: feeAmount,
                total_paid: totalPaid,
                new_balance: newBalance,
            }
        })
    } catch (error) {
        console.error('[Airtime] Unexpected error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
