// app/api/shop/ussd-code/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { generateUssdCode, normalizeCustomCode } from '@/lib/ussd/code-generator'

// In-memory rate limiter — best-effort per lambda instance (same pattern as
// app/api/shop/initialize/route.ts). The DB UNIQUE(ussd_code) is the real guard.
const rateLimitCache = new Map<string, { count: number; resetTime: number }>()
function rateLimited(userId: string): boolean {
    const now = Date.now()
    for (const [k, v] of rateLimitCache.entries()) if (v.resetTime < now) rateLimitCache.delete(k)
    const entry = rateLimitCache.get(userId) || { count: 0, resetTime: now + 60_000 }
    if (entry.count >= 5 && entry.resetTime > now) return true
    entry.count++
    rateLimitCache.set(userId, entry)
    return false
}

// =============================================================================
// POST /api/shop/ussd-code
// Body: { mode: 'rotate' } | { mode: 'custom', code: string }
// Rotates to a fresh random code, or assigns an owner-chosen custom code.
// Requires: authenticated owner of an ACTIVATED shop. Code changes are free.
// =============================================================================
export async function POST(request: NextRequest) {
    const supabaseAuth = await createRouteClient()
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()
    if (authError || !user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (rateLimited(user.id)) {
        return NextResponse.json({ error: 'Too many code changes. Try again in a minute.' }, { status: 429 })
    }

    let body: { mode?: string; code?: string }
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    if (body.mode !== 'rotate' && body.mode !== 'custom') {
        return NextResponse.json({ error: 'Invalid mode' }, { status: 400 })
    }

    const db = supabaseAuth as any

    // Confirm the user owns an activated shop.
    const { data: shop, error: shopError } = await db
        .from('shop_profiles')
        .select('id, ussd_active, ussd_code')
        .eq('owner_id', user.id)
        .maybeSingle()

    if (shopError || !shop) {
        return NextResponse.json({ error: 'Shop not found' }, { status: 404 })
    }
    if (!shop.ussd_active) {
        return NextResponse.json({ error: 'Activate your USSD code first' }, { status: 403 })
    }

    // Resolve the target code.
    if (body.mode === 'custom') {
        const target = normalizeCustomCode(body.code)
        if (!target) {
            return NextResponse.json({ error: 'Use exactly 4 letters or numbers (A–Z, 0–9).' }, { status: 400 })
        }
        if (target === shop.ussd_code) {
            return NextResponse.json({ success: true, code: target }) // no-op
        }
        const { error: updErr } = await db
            .from('shop_profiles')
            .update({ ussd_code: target, updated_at: new Date().toISOString() })
            .eq('id', shop.id)
            .eq('owner_id', user.id)
        if (updErr) {
            if (updErr.code === '23505') {
                return NextResponse.json({ error: 'That code is already taken. Try another.' }, { status: 409 })
            }
            console.error('[USSD Code] custom update failed:', updErr)
            return NextResponse.json({ error: 'Could not set code' }, { status: 500 })
        }
        return NextResponse.json({ success: true, code: target })
    }

    if (body.mode === 'rotate') {
        // Try fresh random codes; the UNIQUE constraint rejects collisions.
        for (let attempt = 0; attempt < 6; attempt++) {
            const candidate = generateUssdCode()
            const { error: updErr } = await db
                .from('shop_profiles')
                .update({ ussd_code: candidate, updated_at: new Date().toISOString() })
                .eq('id', shop.id)
                .eq('owner_id', user.id)
            if (!updErr) return NextResponse.json({ success: true, code: candidate })
            if (updErr.code !== '23505') {
                console.error('[USSD Code] rotate update failed:', updErr)
                return NextResponse.json({ error: 'Could not rotate code' }, { status: 500 })
            }
            // else: collision — loop and try a new candidate
        }
        return NextResponse.json({ error: 'Could not generate a unique code. Try again.' }, { status: 503 })
    }
}
