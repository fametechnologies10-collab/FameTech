import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * GET /api/shop-domain/search?q=<query>
 *
 * Strict-match shop search rules:
 *  1. Shop Name  — case-insensitive, but must be a FULL exact match (not partial)
 *  2. Owner Phone — must be exactly 10 digits and an exact full match
 *  3. Shop Slug   — must be an exact full match (case-insensitive)
 *  4. USSD Code  — exactly 4 chars (A-Z0-9), case-insensitive exact match against
 *     shop_profiles.ussd_code, AND the shop's USSD must currently be active
 *     (ussd_active=true) — same gate the real USSD resolver enforces
 *     (lib/ussd/shop-resolver.ts), so disabling a shop's USSD also stops its
 *     code from resolving here.
 *
 * Partial matches (e.g. "KING" when shop is "KING FLEXY") are intentionally
 * rejected, treating them as "no results found". This prevents enumeration.
 */
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)
    const raw = searchParams.get('q')

    if (!raw || raw.trim().length < 2) {
        return NextResponse.json([], { status: 200 })
    }

    // Strip PostgREST wildcards / injection characters, cap length
    const q = raw.trim().replace(/[%_,()]/g, '').slice(0, 100)
    if (q.length < 2) {
        return NextResponse.json([], { status: 200 })
    }

    // ── Code validation: exactly 4 chars, A-Z0-9 (custom shop codes may be
    // all-digit, e.g. "5964" — checked BEFORE the phone-partial guard below so
    // a 4-digit code isn't mistaken for an incomplete phone number). ──
    const isCodeQuery = /^[A-Z0-9]{4}$/i.test(q)

    // ── Phone validation: only treat as phone query if exactly 10 digits ──
    const isPhoneQuery = /^\d{10}$/.test(q)

    // ── Reject phone-like inputs that are NOT exactly 10 digits and NOT a
    // 4-char code ── (prevents partial number fishing, e.g. "055161730" → no
    // results, while still letting an all-digit 4-char code through)
    const looksLikePhone = /^\d+$/.test(q)
    if (looksLikePhone && !isPhoneQuery && !isCodeQuery) {
        // Intentionally return empty — the number is incomplete
        return NextResponse.json([], { status: 200 })
    }

    const supabaseAdmin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Fetch only approved, active shops
    const { data, error } = await supabaseAdmin
        .from('shop_profiles')
        .select('shop_slug, shop_name, description, logo_url, owner_phone, ussd_code, ussd_active')
        .eq('approval_status', 'approved')
        .eq('is_active', true)

    if (error) {
        return NextResponse.json([], { status: 200 })
    }

    const normalise = (s: string) => s.trim().toLowerCase()
    const needle = normalise(q)
    const codeNeedle = q.toUpperCase()

    const matched = (data || []).filter((shop) => {
        const nameMatch = normalise(shop.shop_name) === needle
        const slugMatch = normalise(shop.shop_slug) === needle
        const phoneMatch = isPhoneQuery && shop.owner_phone === q
        const codeMatch = isCodeQuery && shop.ussd_active === true && shop.ussd_code === codeNeedle

        return nameMatch || slugMatch || phoneMatch || codeMatch
    })
    // ussd_code/ussd_active were only selected to evaluate codeMatch above —
    // never return them. Otherwise a search by name/slug/phone would hand back
    // a shop's USSD code for free (undermining the whole point of gating it),
    // including for a shop whose code is currently disabled.
    const publicResults = matched.map(({ ussd_code, ussd_active, ...publicFields }) => publicFields)

    const response = NextResponse.json(publicResults, { status: 200 })
    response.headers.set('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate')
    return response
}
