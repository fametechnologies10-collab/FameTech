import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// IP-based rate limiter — 10 lookups per minute per IP
const rateLimitCache = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(ip: string): boolean {
    const now = Date.now()
    const entry = rateLimitCache.get(ip) || { count: 0, resetAt: now + 60_000 }
    if (entry.resetAt < now) { entry.count = 0; entry.resetAt = now + 60_000 }
    entry.count++
    rateLimitCache.set(ip, entry)
    return entry.count <= 10
}

// Clean up expired entries every 5 minutes
setInterval(() => {
    const now = Date.now()
    for (const [key, val] of rateLimitCache.entries()) {
        if (val.resetAt < now) rateLimitCache.delete(key)
    }
}, 5 * 60_000)

const supabaseAdmin = createServerClient()

export async function GET(req: NextRequest) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
    if (!checkRateLimit(ip)) {
        return NextResponse.json({ error: 'Too many requests. Please wait a minute.' }, { status: 429 })
    }

    const { searchParams } = new URL(req.url)
    const phone    = searchParams.get('phone')
    const shopSlug = searchParams.get('shopSlug')
    const limit    = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100)

    // Require both phone AND shopSlug — prevents cross-shop enumeration
    if (!phone || !shopSlug) {
        return NextResponse.json({ error: 'phone and shopSlug are required' }, { status: 400 })
    }

    // Validate slug format — only lowercase alphanumeric + hyphens
    if (!/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(shopSlug)) {
        return NextResponse.json({ error: 'Invalid shop identifier' }, { status: 400 })
    }

    // Validate phone — digits only, Ghana format
    const cleanPhone = phone.replace(/\s+/g, '')
    if (!/^(0\d{9}|233\d{9}|\+233\d{9})$/.test(cleanPhone)) {
        return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 })
    }

    try {
        // Resolve slug → shopId server-side (also confirms shop is real and active)
        const { data: shop, error: shopErr } = await (supabaseAdmin as any)
            .from('shop_profiles')
            .select('id, is_active, approval_status')
            .eq('shop_slug', shopSlug)
            .single()

        if (shopErr || !shop) {
            return NextResponse.json({ error: 'Shop not found' }, { status: 404 })
        }

        if (!shop.is_active || shop.approval_status !== 'approved') {
            return NextResponse.json({ error: 'Shop is not active' }, { status: 403 })
        }

        // Scope query to this shop only via p_shop_id parameter
        const { data, error } = await (supabaseAdmin as any)
            .rpc('get_shop_orders_by_phone', {
                p_phone_number: cleanPhone,
                p_limit_count:  limit,
                p_shop_id:      shop.id,
            })

        if (error) {
            console.error('[ShopOrdersLookup] RPC error:', error)
            return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 })
        }

        // Apply 48-hour window server-side
        const timeBoundary = Date.now() - 48 * 60 * 60 * 1000
        const recentOrders = (data || []).filter(
            (o: any) => new Date(o.created_at).getTime() >= timeBoundary
        )

        return NextResponse.json({ orders: recentOrders }, {
            headers: { 'Cache-Control': 'private, no-store' }
        })
    } catch (err: any) {
        console.error('[ShopOrdersLookup] Error:', err)
        return NextResponse.json({ error: 'Server error' }, { status: 500 })
    }
}
