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
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
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
            .select('shop_name, logo_url, owner_phone, owner_email, whatsapp_number, brand_color, is_active, approval_status, ussd_code, ussd_active')
            .eq('shop_slug', slug)
            .single()

        if (error || !data) {
            return NextResponse.json({ error: 'Shop not found' }, { status: 404 })
        }

        // Return only what is needed for public branding
        return NextResponse.json(data)
    } catch (err) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
