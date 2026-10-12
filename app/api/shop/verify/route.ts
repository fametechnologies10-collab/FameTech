import { getGuestIp } from '@/lib/client-ip'
import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { creditShopProfit } from '@/lib/shop-service'
import { sendOrderSuccessSMS } from '@/lib/sms-service'

// 5 verify attempts per IP per minute — prevents Paystack API quota exhaustion
// from spam attacks on random/forged references
const rateLimitCache = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(ip: string): boolean {
    const now = Date.now()
    const entry = rateLimitCache.get(ip) || { count: 0, resetAt: now + 60_000 }
    if (entry.resetAt < now) { entry.count = 0; entry.resetAt = now + 60_000 }
    entry.count++
    rateLimitCache.set(ip, entry)
    return entry.count <= 5
}

// Same shape the checkout routes enforce (computeShopCheckout) — anything else is never a real shop.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/
// Card checkouts mint SHOP-<8 hex shop id>-<ms>-<8 hex>; the loose class keeps older refs working.
const REF_RE = /^SHOP-[A-Za-z0-9-]{1,90}$/

export async function GET(request: NextRequest) {
    const ip = getGuestIp(request)
    // slug/ref are interpolated into redirect URLs below — validate before use so a crafted
    // link cannot inject path segments or extra query params into our own redirect.
    const { searchParams } = new URL(request.url)
    const rawSlug = searchParams.get('slug') || ''
    const slug = SLUG_RE.test(rawSlug) ? rawSlug : null
    if (!checkRateLimit(ip)) {
        // Redirect to error rather than exposing the rate limit in JSON
        return NextResponse.redirect(new URL(`https://shop.fametechgh.com/${slug || ''}?error=too_many_requests`))
    }
    const ref = searchParams.get('ref')

    const protocol = request.headers.get('x-forwarded-proto') || 'https'
    const host = request.headers.get('host') || ''
    
    // Determine the correct base URL for the shop storefront
    let targetBaseUrl = ''
    if (host.includes('localhost') || host.includes('127.0.0.1')) {
        targetBaseUrl = host.startsWith('shop.') ? `${protocol}://${host}` : `${protocol}://shop.${host}`
    } else {
        targetBaseUrl = 'https://shop.fametechgh.com'
    }

    if (!ref || !slug || !REF_RE.test(ref)) {
        return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug || ''}?error=invalid_ref`))
    }

    try {
        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) {
            return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug}?error=payment_error`))
        }

        // 1. Verify payment with Paystack
        const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` },
        })
        const verifyData = await verifyRes.json()

        const supabase = await createRouteClient()
        const db = supabase as any

        // 2. Extract order data from metadata
        const metadata = verifyData.data?.metadata
        if (!metadata || !metadata.shop_id) {
            console.error('[Shop Verify] Missing metadata in Paystack response:', verifyData)
            return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug}?error=payment_error`))
        }

        if (verifyData.data?.status !== 'success') {
            console.error('[Shop Verify] Payment not successful:', verifyData.data?.status)
            return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug}?error=payment_failed`))
        }

        // 3. Process the order using the shared logic (Idempotent)
        const { processShopOrder } = await import('@/lib/shop-order-processor')
        const result = await processShopOrder(
            ref,
            metadata,
            verifyData.data?.amount || 0,
            slug!
        )

        if (!result.success) {
            const errorType = result.error === 'Payment amount mismatch' ? 'payment_mismatch' : 'payment_error'
            return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug}?error=${errorType}`))
        }

        return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug}/success?ref=${encodeURIComponent(ref)}`))

    } catch (error) {
        console.error('[Shop Verify] Error:', error)
        return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug}?error=server_error`))
    }
}

