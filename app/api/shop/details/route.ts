import { getGuestIp } from '@/lib/client-ip'
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// 30 requests per minute per IP — prevents bulk scraping of shop owner PII
const rateLimitCache = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(ip: string): boolean {
    const now = Date.now()
    const entry = rateLimitCache.get(ip) || { count: 0, resetAt: now + 60_000 }
    if (entry.resetAt < now) { entry.count = 0; entry.resetAt = now + 60_000 }
    entry.count++
    rateLimitCache.set(ip, entry)
    return entry.count <= 30
}

export async function GET(request: NextRequest) {
    const ip = getGuestIp(request)
    if (!checkRateLimit(ip)) {
        return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const { searchParams } = new URL(request.url)
    const slug = searchParams.get('slug')

    if (!slug) {
        return NextResponse.json({ error: 'Slug is required' }, { status: 400 })
    }

    try {
        const supabase = createServerClient()
        const { data, error } = await supabase
            .from('shop_profiles')
            .select('shop_name, logo_url, owner_phone, owner_email, whatsapp_number, brand_color, is_active, approval_status')
            .eq('shop_slug', slug)
            .single()

        if (error || !data) {
            return NextResponse.json({ error: 'Shop not found' }, { status: 404 })
        }

        // Return only what the status page needs. Owner contact details are shown to the public
        // only for a live (approved + active) shop — an unapproved/suspended shop's phone and
        // email must not be enumerable by slug.
        const live = data.approval_status === 'approved' && data.is_active === true
        return NextResponse.json({
            shop_name: data.shop_name,
            logo_url: data.logo_url,
            brand_color: data.brand_color,
            owner_phone: live ? data.owner_phone : null,
            owner_email: live ? data.owner_email : null,
            whatsapp_number: live ? data.whatsapp_number : null,
        })
    } catch (err) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
