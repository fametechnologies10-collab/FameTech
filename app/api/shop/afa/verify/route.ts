// app/api/shop/afa/verify/route.ts
import { NextRequest, NextResponse } from 'next/server'

// 5 verify attempts per IP per minute — prevents Paystack API quota exhaustion
// from spam on forged references. Mirrors app/api/shop/verify/route.ts.
const rateLimitCache = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(ip: string): boolean {
    const now = Date.now()
    const entry = rateLimitCache.get(ip) || { count: 0, resetAt: now + 60_000 }
    if (entry.resetAt < now) { entry.count = 0; entry.resetAt = now + 60_000 }
    entry.count++
    rateLimitCache.set(ip, entry)
    return entry.count <= 5
}

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url)
    const ref = searchParams.get('ref')
    const slug = searchParams.get('slug')

    const protocol = request.headers.get('x-forwarded-proto') || 'https'
    const host = request.headers.get('host') || ''
    let targetBaseUrl = ''
    if (host.includes('localhost') || host.includes('127.0.0.1')) {
        targetBaseUrl = host.startsWith('shop.') ? `${protocol}://${host}` : `${protocol}://shop.${host}`
    } else {
        targetBaseUrl = 'https://shop.kingflexygh.com'
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
    if (!checkRateLimit(ip)) {
        return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug || ''}?error=too_many_requests`))
    }

    if (!ref || !slug) {
        return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug || ''}?error=invalid_ref`))
    }

    try {
        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) {
            return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug}?error=payment_error`))
        }

        const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` },
        })
        const verifyData = await verifyRes.json()

        const metadata = verifyData.data?.metadata
        if (!metadata || !metadata.shop_id) {
            console.error('[Shop AFA Verify] Missing metadata:', verifyData)
            return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug}?error=payment_error`))
        }
        if (verifyData.data?.status !== 'success') {
            return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug}?error=payment_failed`))
        }

        const { processShopAfaOrder } = await import('@/lib/shop-afa-order-processor')
        const result = await processShopAfaOrder(ref, metadata, verifyData.data?.amount || 0, slug)

        if (!result.success) {
            const errorType = result.error === 'Payment amount mismatch' ? 'payment_mismatch' : 'payment_error'
            return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug}?error=${errorType}`))
        }

        return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug}/success?ref=${ref}`))
    } catch (error) {
        console.error('[Shop AFA Verify] Error:', error)
        return NextResponse.redirect(new URL(`${targetBaseUrl}/${slug}?error=server_error`))
    }
}
