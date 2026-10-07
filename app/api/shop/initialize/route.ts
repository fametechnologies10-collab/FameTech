import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { computeShopCheckout, sanitizeForPaystack, buildGuestEmail } from '@/lib/shop-checkout'

// In-memory rate limiter — best-effort per lambda instance (not distributed)
// The real duplicate-order guard is the DB UNIQUE constraint on paystack_reference
const rateLimitCache = new Map<string, { count: number; resetTime: number }>()
// In-memory idempotency cache — best-effort within one lambda instance
// Cross-instance deduplication is handled by the DB UNIQUE constraint
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
        const rlKey = `${ip}`
        const rlEntry = rateLimitCache.get(rlKey) || { count: 0, resetTime: Date.now() + 60000 }
        if (rlEntry.count >= 10 && rlEntry.resetTime > Date.now()) {
            return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
        }
        rlEntry.count++
        rateLimitCache.set(rlKey, rlEntry)

        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any
        const checkout = await computeShopCheckout(db, body)
        if (!checkout.ok) {
            return NextResponse.json(
                { error: checkout.error, ...(checkout.contact ? { contact: checkout.contact } : {}) },
                { status: checkout.status }
            )
        }
        const { shop, cleanPhone, validatedGuestEmail, totalAmountPesewas, metadataPayload, pkgNetwork, pkgSize } = checkout

        const { shopSlug } = body

        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) return NextResponse.json({ error: 'Payment service unavailable' }, { status: 503 })

        // Empty/invalid email → white-labelled gmail.com synthetic (shop + phone +
        // random), shared with the MoMo charge route so card + MoMo behave identically.
        const paystackEmail = validatedGuestEmail || buildGuestEmail(shop.shop_name, cleanPhone)
        const paystackRef = `SHOP-${shop.id.slice(0, 8)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
        const protocol = request.headers.get('x-forwarded-proto') || 'https'
        const host = request.headers.get('host') || 'kingflexygh.com'
        const callbackUrl = `${protocol}://${host}/api/shop/verify?ref=${paystackRef}&slug=${shopSlug}`

        // In-memory idempotency (same lambda instance)
        // SEC-020: include product identity (network:size) so two different packages
        // at the same price within the 60s window don't collide on one cache entry.
        const idemKey = `${shop.id}-${cleanPhone}-${totalAmountPesewas}-${validatedGuestEmail || 'guest'}-${pkgNetwork}:${pkgSize}`
        const cachedIdem = idempotencyCache.get(idemKey)
        if (cachedIdem && cachedIdem.expireAt > Date.now()) {
            return NextResponse.json({ success: true, authorization_url: cachedIdem.authUrl, reference: cachedIdem.ref })
        }

        // DB-backed idempotency — check for a pending order from same phone at this shop
        // within the last 5 minutes (handles cross-lambda duplicates)
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
        const { data: existingPending } = await db
            .from('shop_orders')
            .select('id, paystack_reference')
            .eq('shop_id', shop.id)
            .eq('guest_phone', cleanPhone)
            .eq('status', 'pending')
            .gte('created_at', fiveMinutesAgo)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

        if (existingPending) {
            // Re-verify with Paystack to get the authorization URL for this reference
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

        // Sanitize shop name: strip emojis before sending to Paystack.
        // Paystack's DB is 3-byte UTF-8 — 4-byte emoji characters silently
        // truncate the entire JSON payload from that point, which causes
        // the verify callback to fail even though payment was collected.
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
                    fulfillment_mode: shop.fulfillment_mode,
                    ...metadataPayload,
                    custom_fields: [
                        { display_name: 'Shop', variable_name: 'shop', value: safeShopName },
                        { display_name: 'Phone', variable_name: 'phone', value: cleanPhone },
                        { display_name: 'Order', variable_name: 'package', value: `${pkgNetwork} ${pkgSize}` },
                        ...(validatedGuestEmail ? [{ display_name: 'Email', variable_name: 'email', value: validatedGuestEmail }] : []),
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
        console.error('[Shop Initialize] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
