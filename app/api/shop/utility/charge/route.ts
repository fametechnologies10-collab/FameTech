import { NextRequest, NextResponse } from 'next/server'
import { getClientIp } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { computeShopCheckout, buildGuestEmail, sanitizeForPaystack } from '@/lib/shop-checkout'
import { makeUtilityPaystackReference, makeUtilityVerifyReference, UTILITY_BILLERS, UtilityBiller } from '@/lib/hubtel-utility/billers'
import { runHubtelUtilityCharge } from '@/lib/hubtel-checkout'
import { toMsisdn233 } from '@/lib/hubtel-commission-service'
import { channelForMsisdn } from '@/lib/hubtel-receive-money'
import { isNumberVerified, sendVerificationOtp } from '@/lib/hubtel-receive/number-verification'
import { sanitizeForStorage } from '@/lib/sanitize-for-storage'

export const dynamic = 'force-dynamic'

const MAX_SNAPSHOT_BYTES = 8 * 1024
const MAX_ACCOUNT_NAME_LEN = 80

// Storefront network name (ServiceChargeSheet's own detector) → Paystack mobile_money provider code.
const PAYSTACK_PROVIDER_MAP: Record<string, 'MTN' | 'VOD' | 'ATL'> = { MTN: 'MTN', Telecel: 'VOD', AT: 'ATL' }

/**
 * POST /api/shop/utility/charge
 *
 * Dual-rail in-app charge for utility bill purchases via shop storefront, gated by
 * admin_settings.hubtel_receive_enabled_utility:
 *   - ON  -> Hubtel Direct Receive Money (unchanged from the original single-rail
 *            implementation — server-initiated MoMo prompt, no Paystack fee, since
 *            utility bills are commission-based/zero-markup: see lib/hubtel-checkout.ts).
 *   - OFF -> Paystack mobile_money Charge API, the SAME rail every other storefront
 *            product (data/airtime/mashup/RC/AFA) already uses via ServiceChargeSheet.
 *            The customer bears the Paystack fee on top of face value, matching every
 *            other product's convention — this is what keeps the economics sane without
 *            Hubtel (see lib/hubtel-checkout.ts's header comment for the zero-margin concern).
 *
 * Both branches return the SAME flat response shape ServiceChargeSheet/useChargePolling
 * expect ({ reference, status, display_text, total } on success; { error } otherwise) —
 * neither branch uses the general `{success,data}` envelope, matching every sibling
 * charge route (app/api/shop/charge, app/api/shop/results-checker/charge, ...).
 *
 * Money-safety ordering — IDENTICAL insert-before-charge discipline in both branches:
 * anti-fraud gate (Hubtel only — Paystack's charge always requires an explicit customer
 * approval step, same as every other product, so it doesn't need a pre-verified number)
 * -> enable-toggle/config gate BEFORE any insert (dark seam stays row-free) -> insert
 * utility_orders (source of truth for the price the customer must pay — provider metadata
 * is NEVER trusted for that) -> initiate the charge -> on init failure mark the order
 * failed (no orphan pending row survives a failed prompt/init call).
 */
export async function POST(request: NextRequest) {
    try {
        const ip = getClientIp(request) || 'unknown'
        const rl = consumeRateLimit(`util-sf-charge:${ip}`, 4, 60_000)
        if (!rl.allowed) {
            return NextResponse.json(
                { error: `Too many requests. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` },
                { status: 429 },
            )
        }

        const body = await request.json().catch(() => null)
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }
        const { shopSlug, biller, account, phone, email, amount, accountName, lookupSnapshot, momoNumber, momoProvider } = body

        // Payer's MoMo number — the number that will receive the payment prompt.
        // `phone` (below, unchanged) stays the CONTACT/lookup phone for computeShopCheckout
        // (ECG/Ghana Water customer phone) — the two are allowed to differ.
        if (typeof momoNumber !== 'string' || !/^0\d{9}$/.test(momoNumber)) {
            return NextResponse.json({ error: 'Invalid MoMo number. Use format: 0XXXXXXXXX' }, { status: 400 })
        }
        const momo233 = toMsisdn233(momoNumber)

        let trimmedAccountName: string | null = null
        if (accountName !== undefined && accountName !== null) {
            if (typeof accountName !== 'string') {
                return NextResponse.json({ error: 'Invalid account name' }, { status: 400 })
            }
            trimmedAccountName = accountName.trim().slice(0, MAX_ACCOUNT_NAME_LEN) || null
        }

        let snapshot: Record<string, unknown> | null = null
        if (lookupSnapshot !== undefined && lookupSnapshot !== null) {
            if (typeof lookupSnapshot !== 'object' || Array.isArray(lookupSnapshot)) {
                return NextResponse.json({ error: 'Invalid lookup snapshot' }, { status: 400 })
            }
            if (Buffer.byteLength(JSON.stringify(lookupSnapshot), 'utf8') > MAX_SNAPSHOT_BYTES) {
                return NextResponse.json({ error: 'Lookup snapshot too large' }, { status: 400 })
            }
            // Defense-in-depth: never persist a client-supplied sessionId, forged or otherwise —
            // the dispatch pipeline always fetches its own fresh Ghana Water session at pay-time.
            const { sessionId: _sessionId, ...rest } = lookupSnapshot as Record<string, unknown>
            snapshot = rest
        }

        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any

        // Server is authoritative for price/validity — gates, biller, account, amount and
        // the ecg/ghana_water phone requirement are all enforced inside computeShopCheckout's
        // 'utility' branch (lib/shop-checkout.ts). This is the FACE VALUE — zero markup by
        // design — before any Paystack fee (added below, only on the Paystack branch).
        const checkout = await computeShopCheckout(db, {
            shopSlug,
            orderType: 'utility',
            utilityBiller: biller,
            utilityAccount: account,
            utilityPhone: phone,
            amount,
            guestPhone: phone ?? '',
            guestEmail: email,
        })
        if (!checkout.ok) {
            return NextResponse.json(
                { error: checkout.error, ...(checkout.contact ? { contact: checkout.contact } : {}) },
                { status: checkout.status },
            )
        }
        const { shop, cleanPhone, validatedGuestEmail, totalAmountPesewas, metadataPayload } = checkout
        const paystackEmail = validatedGuestEmail || buildGuestEmail(shop.shop_name, cleanPhone)

        // ── Toggle gate BEFORE any insert (dark seam) ────────────────────────────────
        const { data: toggleRow } = await db
            .from('admin_settings')
            .select('value')
            .eq('key', 'hubtel_receive_enabled_utility')
            .maybeSingle()
        const hubtelEnabled = toggleRow?.value === true || toggleRow?.value === 'true'

        const billerLabel = UTILITY_BILLERS[metadataPayload.biller as UtilityBiller]?.label || 'Utility bill'

        // ══════════════════════════════════════════════════════════════════════════
        // BRANCH 1 — Hubtel Direct Receive Money (unchanged logic, flattened response)
        // ══════════════════════════════════════════════════════════════════════════
        if (hubtelEnabled) {
            const channel = channelForMsisdn(momo233)
            if (!channel) {
                return NextResponse.json({ error: 'Unsupported mobile network' }, { status: 400 })
            }

            const chargeParams = {
                shop: { id: shop.id }, momo233, trimmedAccountName, metadataPayload,
                totalAmountPesewas, paystackEmail, validatedGuestEmail, snapshot, billerLabel,
            }

            // A server-initiated MoMo debit has no checkoutUrl for the customer to confirm
            // on, so a first-time payer number must clear a pre-charge OTP gate first
            // (lib/hubtel-receive/number-verification.ts). Reuses ServiceChargeSheet's
            // existing generic 'otp' step (built for Paystack's send_otp) via a transient
            // UTLV- reference — submit-otp's UTLV- branch confirms the code and replays
            // this exact charge (see runHubtelUtilityCharge / app/api/shop/charge/submit-otp).
            if (!(await isNumberVerified(db, momo233))) {
                const verifyReference = makeUtilityVerifyReference()
                const otpResult = await sendVerificationOtp(db, momo233, ip, { verifyReference, pendingCharge: chargeParams })

                if (otpResult.alreadyVerified) {
                    // Race: the number cleared verification between the check above and here
                    // (e.g. a concurrent charge from the same payer) — just charge now instead
                    // of sending a pointless OTP.
                    const result = await runHubtelUtilityCharge(db, chargeParams)
                    return NextResponse.json(result.body, { status: result.httpStatus })
                }
                if (!otpResult.ok) {
                    return NextResponse.json({ error: otpResult.error || 'Could not send verification code' }, { status: otpResult.status || 500 })
                }
                return NextResponse.json({
                    reference: verifyReference,
                    status: 'send_otp',
                    display_text: 'Enter the verification code sent to your Mobile Money number to confirm this payment',
                    total: totalAmountPesewas / 100,
                })
            }

            const result = await runHubtelUtilityCharge(db, chargeParams)
            return NextResponse.json(result.body, { status: result.httpStatus })
        }

        // ══════════════════════════════════════════════════════════════════════════
        // BRANCH 2 — Paystack mobile_money Charge API (customer bears the fee)
        // ══════════════════════════════════════════════════════════════════════════
        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) {
            return NextResponse.json({ error: 'Utility payments are coming soon' }, { status: 503 })
        }

        const provider = (typeof momoProvider === 'string' && PAYSTACK_PROVIDER_MAP[momoProvider]) || null
        if (!provider) {
            return NextResponse.json({ error: 'Select your mobile money network', needsManualSelection: true }, { status: 400 })
        }

        // Fee resolution: per-shop override -> flat global setting -> 1.95% default.
        // Utility bills have no per-role pricing tier (everyone pays the same face
        // value), so this mirrors only the shop-override/global tiers of the same
        // chain computeShopCheckout's data branch uses, not the per-role tier.
        let paystackFeePercent = 1.95
        if (shop.paystack_fee_percent !== null && shop.paystack_fee_percent !== undefined) {
            paystackFeePercent = parseFloat(String(shop.paystack_fee_percent))
        } else {
            const { data: globalFeeRow } = await db
                .from('shop_global_settings')
                .select('value')
                .eq('key', 'shop_paystack_fee_percent')
                .maybeSingle()
            if (globalFeeRow?.value != null) paystackFeePercent = parseFloat(String(globalFeeRow.value))
        }
        const faceValueGhs = totalAmountPesewas / 100
        const paystackFeeGhs = Math.round(faceValueGhs * (paystackFeePercent / 100) * 100) / 100
        const totalWithFeePesewas = Math.round((faceValueGhs + paystackFeeGhs) * 100)

        const clientReference = makeUtilityPaystackReference(metadataPayload.biller as UtilityBiller)

        const { data: order, error: orderError } = await db
            .from('utility_orders')
            .insert({
                source: 'storefront',
                shop_id: shop.id,
                user_id: null,
                biller: metadataPayload.biller,
                account_number: metadataPayload.account_number,
                account_name: trimmedAccountName,
                destination_phone: metadataPayload.destination_phone,
                customer_email: paystackEmail,
                // `amount` MUST stay face value only — dispatchUtilityCore
                // (lib/utility-fulfillment.ts) reads this SAME column and sends it verbatim
                // as the Amount charged to Hubtel Commission Services for the actual bill
                // payment. If this were fee-inclusive, the customer's meter/account would be
                // over-credited by the fee and the platform's Hubtel float would silently
                // absorb it on every order. The fee actually collected (face value + fee) is
                // tracked separately in `paystack_fee` for refund/accounting purposes.
                amount: faceValueGhs,
                paystack_fee: paystackFeeGhs,
                payment_method: 'paystack',
                payment_reference: null,
                payment_status: 'unpaid',
                status: 'pending',
                reference_code: clientReference,
                lookup_snapshot: snapshot,
                // Payer's MoMo number/network — already known as first-class request input
                // here (unlike shop_orders' data-purchase flow, which has to reverse-engineer
                // this after the fact via a Paystack transaction verify), so no external
                // lookup is needed to power the admin "View MoMo" refund-details button
                // (app/api/admin/utility-orders/[id]/momo-details). Only the payer's NAME
                // needs on-demand resolution — see that route.
                payer_momo_number: momoNumber,
                payer_momo_network: provider ? String(momoProvider).toUpperCase() : null,
            })
            .select('id, reference_code')
            .single()

        if (orderError || !order) {
            console.error('[Shop Utility Charge] Order creation error:', orderError)
            return NextResponse.json({ error: 'Failed to create order record' }, { status: 500 })
        }

        const safeShopName = sanitizeForPaystack(shop.shop_name)
        const paystackRes = await fetch('https://api.paystack.co/charge', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: paystackEmail,
                amount: totalWithFeePesewas,
                currency: 'GHS',
                reference: clientReference,
                mobile_money: { phone: momoNumber, provider },
                metadata: {
                    order_type: 'utility',
                    shop_id: shop.id, shop_name: safeShopName, shop_slug: shop.shop_slug, slug: shop.shop_slug,
                    utility_order_id: order.id, biller: metadataPayload.biller,
                    custom_fields: [
                        { display_name: 'Shop', variable_name: 'shop', value: safeShopName },
                        { display_name: 'Bill', variable_name: 'bill', value: `${billerLabel} — ${metadataPayload.account_number}` },
                    ],
                },
            }),
        })
        const paystackData = await paystackRes.json().catch(() => ({}))

        if (!paystackData.status || !paystackData.data) {
            console.error('[Shop Utility Charge] Paystack charge failed:', paystackData)
            // Never reached Hubtel — record WHY at the checkout step itself so admin isn't
            // left with a blank 'failed' row (see docs/superpowers/specs for the utility
            // transparency fix): stable reason code + sanitized provider text, admin-only
            // (fulfillment_metadata, never a customer-facing column).
            const markError = (await db.from('utility_orders').update({
                status: 'failed',
                fulfillment_metadata: {
                    stage: 'checkout',
                    reason: 'paystack_init_rejected',
                    provider_message: sanitizeForStorage(paystackData.message),
                    at: new Date().toISOString(),
                },
            }).eq('id', order.id)).error
            if (markError) console.error('[Shop Utility Charge] mark-failed (paystack init) error:', markError)
            const safeMessage = typeof paystackData.message === 'string' && paystackData.message.length > 0 && paystackData.message.length < 200
                ? paystackData.message
                : 'Failed to initiate charge'
            return NextResponse.json({ error: safeMessage }, { status: 502 })
        }

        return NextResponse.json({
            status: paystackData.data.status, // pay_offline | send_otp | pending | success | failed | ...
            reference: clientReference,
            display_text: paystackData.data.display_text || paystackData.data.message || '',
            total: totalWithFeePesewas / 100,
        })
    } catch (error) {
        console.error('[Shop Utility Charge] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
