// app/api/shop/afa/charge/route.ts
//
// Native in-app MoMo charge for storefront AFA registration — the ServiceChargeSheet
// counterpart to app/api/shop/afa/initialize/route.ts's redirect flow. Structurally
// mirrors app/api/shop/charge/route.ts (data/airtime/mashup's native charge), with the
// KYC-staging ordering rule carried over verbatim from afa/initialize: the payment must
// never exist without its staged payload, so shop_afa_pending_orders is written BEFORE
// the Paystack /charge call. Paystack metadata carries only the same non-sensitive
// fields afa/initialize sends today — no name, no Ghana Card number, no DOB.
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { computeShopAfaCheckout } from '@/lib/shop-afa-checkout'
import { sanitizeForPaystack, buildGuestEmail } from '@/lib/shop-checkout'

// Best-effort per-lambda IP rate limit (10/min). Real dup-guard is the DB UNIQUE
// constraint on shop_afa_pending_orders.paystack_reference. Mirrors shop/charge/route.ts.
const rateLimitCache = new Map<string, { count: number; resetTime: number }>()
function cleanup() { const now = Date.now(); for (const [k, v] of rateLimitCache.entries()) if (v.resetTime < now) rateLimitCache.delete(k) }

// Storefront network name → Paystack mobile_money provider code.
const PROVIDER_MAP: Record<string, 'MTN' | 'VOD' | 'ATL'> = { MTN: 'MTN', Telecel: 'VOD', AT: 'ATL' }
// MoMo wallet number prefix → provider (fallback detection).
const GHANA_NETWORK_MAP: Record<string, 'MTN' | 'VOD' | 'ATL'> = {
    '024': 'MTN', '025': 'MTN', '053': 'MTN', '054': 'MTN', '055': 'MTN', '059': 'MTN',
    '020': 'VOD', '050': 'VOD',
    '026': 'ATL', '027': 'ATL', '056': 'ATL', '057': 'ATL',
}

export async function POST(request: NextRequest) {
    try {
        cleanup()
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
        const rl = rateLimitCache.get(ip) || { count: 0, resetTime: Date.now() + 60000 }
        if (rl.count >= 10 && rl.resetTime > Date.now()) {
            return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
        }
        rl.count++; rateLimitCache.set(ip, rl)

        const body = await request.json().catch(() => null)
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }
        // MoMo wallet to charge — the payer, not necessarily the registrant's phone.
        let momoPhone: string = (body.momoPhone || '').replace(/\s+/g, '')
        if (/^233\d{9}$/.test(momoPhone)) momoPhone = '0' + momoPhone.slice(3)
        const momoProvider: string | undefined = typeof body.momoProvider === 'string' && body.momoProvider.length <= 12 ? body.momoProvider : undefined
        if (!/^0[0-9]{9}$/.test(momoPhone)) {
            return NextResponse.json({ error: 'Enter a valid Ghana mobile money number (e.g. 0241234567)' }, { status: 400 })
        }
        const provider = (momoProvider && PROVIDER_MAP[momoProvider]) || GHANA_NETWORK_MAP[momoPhone.slice(0, 3)] || null
        if (!provider) {
            return NextResponse.json({ error: 'Could not detect your mobile money network. Please select it.', needsManualSelection: true }, { status: 400 })
        }

        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any

        // Server is authoritative for price and for the KYC payload's validity — client
        // amount is ignored. computeShopAfaCheckout also validates formData shape/regions.
        const checkout = await computeShopAfaCheckout(db, body)
        if (!checkout.ok) {
            return NextResponse.json({ error: checkout.error, ...(checkout.contact ? { contact: checkout.contact } : {}) }, { status: checkout.status })
        }
        const { shop, cleanPhone, totalAmountPesewas, metadataPayload } = checkout
        const { guestEmail } = body

        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) return NextResponse.json({ error: 'Payment service unavailable' }, { status: 503 })

        let validatedGuestEmail: string | null = null
        if (guestEmail && typeof guestEmail === 'string' && guestEmail.trim()) {
            const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
            if (emailRegex.test(guestEmail.trim()) && guestEmail.trim().length <= 254) {
                validatedGuestEmail = guestEmail.trim().toLowerCase()
            }
        }

        // Empty/invalid email → white-labelled gmail.com synthetic (shop + phone +
        // random), same as every other shop charge path.
        const paystackEmail = validatedGuestEmail || buildGuestEmail(shop.shop_name, cleanPhone)
        // SHOPAFA- prefix is load-bearing: the Paystack webhook backstop
        // (app/api/webhooks/paystack/route.ts) routes on it to processShopAfaOrder.
        const reference = `SHOPAFA-${shop.id.slice(0, 8)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
        const safeShopName = sanitizeForPaystack(shop.shop_name)

        // 1. Persist the KYC payload server-side BEFORE calling Paystack — a payment must
        // never exist without its payload (same ordering rule afa/initialize documents).
        // The applicant's legal name, Ghana Card number and DOB never leave our systems;
        // lib/shop-afa-order-processor.ts resolves the payload back by paystack_reference
        // once payment is confirmed.
        const { error: pendingError } = await db
            .from('shop_afa_pending_orders')
            .insert({
                paystack_reference: reference,
                shop_id: shop.id,
                guest_phone: cleanPhone,
                guest_email: validatedGuestEmail,
                order_payload: metadataPayload.form_data,
                cost_price: checkout.costPrice,
                selling_price: checkout.sellingPrice,
                profit: checkout.profit,
                // Freeze the Paystack fee quoted at checkout time — the processor
                // uses this instead of re-deriving it live, so a shop's
                // paystack_fee_percent changing between checkout and payment
                // confirmation can never cause a false amount mismatch.
                paystack_fee: metadataPayload.paystack_fee,
                status: 'awaiting_payment',
            })

        if (pendingError) {
            // Never log the whole PostgrestError — on a NOT NULL/CHECK violation,
            // Postgres puts "Failing row contains (…)" into `.details`, which would
            // put the applicant's legal name, Ghana Card number and DOB into logs.
            console.error('[Shop AFA Charge] Failed to stage pending order:', {
                code: pendingError.code,
                message: pendingError.message,
            })
            return NextResponse.json({ error: 'Could not start registration. Please try again.' }, { status: 500 })
        }

        // 2. Only now call Paystack. Metadata is intentionally the SAME non-sensitive
        // field list afa/initialize sends today — shop id/name/slug, guest phone, guest
        // email, order_type. No KYC field is included.
        const paystackRes = await fetch('https://api.paystack.co/charge', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: paystackEmail,
                amount: totalAmountPesewas,
                currency: 'GHS',
                reference,
                mobile_money: { phone: momoPhone, provider },
                metadata: {
                    shop_id: shop.id,
                    shop_name: safeShopName,
                    shop_slug: shop.shop_slug,
                    guest_phone: cleanPhone,
                    guest_email: validatedGuestEmail,
                    order_type: 'afa',
                    custom_fields: [
                        { display_name: 'Shop', variable_name: 'shop', value: safeShopName },
                        { display_name: 'Order', variable_name: 'package', value: 'AFA Registration' },
                    ],
                },
            }),
        })
        const paystackData = await paystackRes.json()
        if (!paystackData.status || !paystackData.data) {
            console.error('[Shop AFA Charge] Paystack charge failed:', paystackData)
            const safeMessage = typeof paystackData.message === 'string' && paystackData.message.length > 0 && paystackData.message.length < 200
                ? paystackData.message
                : 'Failed to initiate charge'
            return NextResponse.json({ error: safeMessage }, { status: 502 })
        }

        return NextResponse.json({
            status: paystackData.data.status, // pay_offline | send_otp | pending | success | failed | ...
            reference,
            display_text: paystackData.data.display_text || paystackData.data.message || '',
            total: Math.round(totalAmountPesewas) / 100,
        })
    } catch (error) {
        console.error('[Shop AFA Charge] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
