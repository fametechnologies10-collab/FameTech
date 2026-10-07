// app/api/shop/afa/initialize/route.ts
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { computeShopAfaCheckout } from '@/lib/shop-afa-checkout'
import { sanitizeForPaystack, buildGuestEmail } from '@/lib/shop-checkout'

// Mirrors app/api/shop/initialize/route.ts's rate-limit + idempotency shape exactly —
// the real duplicate guard is the DB UNIQUE constraint on afa_orders.paystack_reference.
const rateLimitCache = new Map<string, { count: number; resetTime: number }>()
const idempotencyCache = new Map<string, { authUrl: string; ref: string; expireAt: number }>()

function cleanupCaches() {
    const now = Date.now()
    for (const [key, val] of rateLimitCache.entries()) if (val.resetTime < now) rateLimitCache.delete(key)
    for (const [key, val] of idempotencyCache.entries()) if (val.expireAt < now) idempotencyCache.delete(key)
}

export async function POST(request: NextRequest) {
    try {
        cleanupCaches()
        const ip = request.headers.get('x-forwarded-for') || 'unknown'
        const body = await request.json()

        // Rate limit: 10 initialize attempts per IP per minute
        const rlEntry = rateLimitCache.get(ip) || { count: 0, resetTime: Date.now() + 60000 }
        if (rlEntry.count >= 10 && rlEntry.resetTime > Date.now()) {
            return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
        }
        rlEntry.count++
        rateLimitCache.set(ip, rlEntry)

        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any
        const checkout = await computeShopAfaCheckout(db, body)
        if (!checkout.ok) {
            return NextResponse.json(
                { error: checkout.error, ...(checkout.contact ? { contact: checkout.contact } : {}) },
                { status: checkout.status }
            )
        }
        const { shop, cleanPhone, totalAmountPesewas, metadataPayload } = checkout
        const { shopSlug, guestEmail } = body

        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) return NextResponse.json({ error: 'Payment service unavailable' }, { status: 503 })

        let validatedGuestEmail: string | null = null
        if (guestEmail && typeof guestEmail === 'string' && guestEmail.trim()) {
            const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
            if (emailRegex.test(guestEmail.trim()) && guestEmail.trim().length <= 254) {
                validatedGuestEmail = guestEmail.trim().toLowerCase()
            }
        }

        const paystackEmail = validatedGuestEmail || buildGuestEmail(shop.shop_name, cleanPhone)
        const paystackRef = `SHOPAFA-${shop.id.slice(0, 8)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
        const protocol = request.headers.get('x-forwarded-proto') || 'https'
        const host = request.headers.get('host') || 'kingflexygh.com'
        const callbackUrl = `${protocol}://${host}/api/shop/afa/verify?ref=${paystackRef}&slug=${shopSlug}`

        // Registrant identity (id_number, already validated by computeShopAfaCheckout)
        // must be part of the idempotency key — mirrors app/api/shop/initialize/route.ts:60
        // folding product identity (pkgNetwork:pkgSize) into its key. Without it, two
        // different Ghana Cards submitted against the same contact phone at the same
        // shop would collide and the second registrant would silently receive the
        // first registrant's payment link/reference.
        const registrantIdNumber = metadataPayload.form_data?.id_number
        const idemKey = `${shop.id}-${cleanPhone}-${registrantIdNumber}-afa`
        const cachedIdem = idempotencyCache.get(idemKey)
        if (cachedIdem && cachedIdem.expireAt > Date.now()) {
            return NextResponse.json({ success: true, authorization_url: cachedIdem.authUrl, reference: cachedIdem.ref })
        }

        // A staged-or-paid attempt by the SAME registrant at this shop in the last
        // 5 minutes means they are retrying — hand back that transaction rather
        // than charging for one registration twice. Scoped by id_number so a
        // different applicant using the same contact phone gets their own charge.
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
        const { data: existingPending } = await db
            .from('shop_afa_pending_orders')
            .select('id, paystack_reference')
            .eq('shop_id', shop.id)
            .eq('guest_phone', cleanPhone)
            .eq('order_payload->>id_number', registrantIdNumber)
            .gte('created_at', fiveMinutesAgo)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

        if (existingPending?.paystack_reference) {
            try {
                const reVerify = await fetch(
                    `https://api.paystack.co/transaction/verify/${encodeURIComponent(existingPending.paystack_reference)}`,
                    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
                )
                const reVerifyData = await reVerify.json()
                if (reVerifyData.data?.authorization_url) {
                    return NextResponse.json({
                        success: true,
                        authorization_url: reVerifyData.data.authorization_url,
                        reference: existingPending.paystack_reference,
                    })
                }
            } catch { /* fall through — create a new transaction */ }
        }

        // Persist the KYC payload server-side. Paystack receives only paystackRef —
        // the applicant's legal name, Ghana Card number and DOB never leave our
        // systems, mirroring the USSD path's opaque Hubtel ItemName
        // (lib/ussd/utils.ts:55-74). Task 4's processor resolves the payload back
        // by paystack_reference at verify time.
        const { error: pendingError } = await db
            .from('shop_afa_pending_orders')
            .insert({
                paystack_reference: paystackRef,
                shop_id: shop.id,
                guest_phone: cleanPhone,
                guest_email: validatedGuestEmail,
                order_payload: checkout.metadataPayload.form_data,
                cost_price: checkout.costPrice,
                selling_price: checkout.sellingPrice,
                profit: checkout.profit,
                // Freeze the Paystack fee quoted at checkout time — see the same
                // note in app/api/shop/afa/charge/route.ts.
                paystack_fee: checkout.metadataPayload.paystack_fee,
                status: 'awaiting_payment',
            })

        if (pendingError) {
            // Never log the whole PostgrestError — on a NOT NULL/CHECK violation,
            // Postgres puts "Failing row contains (…)" into `.details`, which would
            // put the applicant's legal name, Ghana Card number and DOB into logs.
            console.error('[Shop AFA Initialize] Failed to stage pending order:', {
                code: pendingError.code,
                message: pendingError.message,
            })
            return NextResponse.json({ error: 'Could not start registration. Please try again.' }, { status: 500 })
        }

        // Paystack's metadata DB is 3-byte UTF-8; 4-byte emoji silently truncate the
        // JSON from that point and break the verify callback.
        const safeShopName = sanitizeForPaystack(shop.shop_name)

        const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: paystackEmail,
                amount: totalAmountPesewas,
                reference: paystackRef,
                callback_url: callbackUrl,
                metadata: {
                    shop_id: shop.id,
                    shop_name: safeShopName,
                    shop_slug: shopSlug,
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
        if (!paystackData.status) return NextResponse.json({ error: 'Payment initialization failed' }, { status: 500 })

        idempotencyCache.set(idemKey, { authUrl: paystackData.data.authorization_url, ref: paystackRef, expireAt: Date.now() + 60000 })

        return NextResponse.json({
            success: true,
            authorization_url: paystackData.data.authorization_url,
            access_code: paystackData.data.access_code,
            reference: paystackRef,
        })
    } catch (error) {
        console.error('[Shop AFA Initialize] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
