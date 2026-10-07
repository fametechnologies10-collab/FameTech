import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { computeShopCheckout, sanitizeForPaystack, buildGuestEmail } from '@/lib/shop-checkout'

// Best-effort per-lambda IP rate limit (10/min). Real dup-guard is the DB +
// processShopOrder idempotency. Mirrors the initialize route.
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
        // MoMo wallet to charge (separate from the data recipient guestPhone).
        // Accept the 233XXXXXXXXX form too by normalizing it to local 0XXXXXXXXX.
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

        // Server is authoritative for price — client amount is ignored.
        const checkout = await computeShopCheckout(db, body)
        if (!checkout.ok) {
            return NextResponse.json({ error: checkout.error, ...(checkout.contact ? { contact: checkout.contact } : {}) }, { status: checkout.status })
        }
        const { shop, cleanPhone, validatedGuestEmail, totalAmountPesewas, metadataPayload, pkgNetwork, pkgSize } = checkout

        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) return NextResponse.json({ error: 'Payment service unavailable' }, { status: 503 })

        // Empty/invalid email → white-labelled gmail.com synthetic (shop + phone +
        // random). gmail has real MX so Paystack live accepts it; our own domains don't.
        const paystackEmail = validatedGuestEmail || buildGuestEmail(shop.shop_name, cleanPhone)
        const reference = `SHOP-${shop.id.slice(0, 8)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
        const safeShopName = sanitizeForPaystack(shop.shop_name)

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
                    shop_id: shop.id, shop_name: safeShopName, shop_slug: shop.shop_slug, slug: shop.shop_slug,
                    guest_phone: cleanPhone, guest_email: validatedGuestEmail,
                    fulfillment_mode: shop.fulfillment_mode, ...metadataPayload,
                    custom_fields: [
                        { display_name: 'Shop', variable_name: 'shop', value: safeShopName },
                        { display_name: 'Phone', variable_name: 'phone', value: cleanPhone },
                        { display_name: 'Order', variable_name: 'package', value: `${pkgNetwork} ${pkgSize}` },
                    ],
                },
            }),
        })
        const paystackData = await paystackRes.json()
        if (!paystackData.status || !paystackData.data) {
            console.error('[Shop Charge] Paystack charge failed:', paystackData)
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
        console.error('[Shop Charge] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
