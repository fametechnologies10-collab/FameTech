import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/push/guest-subscribe
// Persists a Web Push subscription for an unauthenticated storefront visitor.
// No auth session exists for a guest, so this route uses service_role. A10
// hardening: because it is unauthenticated AND service-role, every field is
// strictly validated, the endpoint must be a real push-service URL, the shop
// must exist, and the number of subscriptions per shop is capped — otherwise an
// attacker could stuff the table with fabricated rows (storage drain) or
// register junk endpoints for later push-spam.
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Real Web Push service hosts (FCM/Chrome, Apple, Windows WNS, Mozilla).
// An endpoint must be HTTPS and resolve to one of these.
const PUSH_HOST_SUFFIXES = ['googleapis.com', 'push.apple.com', 'notify.windows.com', 'push.services.mozilla.com']
const MAX_SUBS_PER_SHOP = 5000

function isAllowedEndpoint(endpoint: string): boolean {
    try {
        const u = new URL(endpoint)
        return u.protocol === 'https:' &&
            PUSH_HOST_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith('.' + s))
    } catch {
        return false
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => null)
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }
        const { shopId, endpoint, p256dh, auth, guestPhone } = body as Record<string, unknown>

        // ── Strict field validation ────────────────────────────────────
        if (typeof shopId !== 'string' || !UUID_RE.test(shopId)) {
            return NextResponse.json({ error: 'Invalid shopId' }, { status: 400 })
        }
        if (typeof endpoint !== 'string' || endpoint.length > 1024 || !isAllowedEndpoint(endpoint)) {
            return NextResponse.json({ error: 'Invalid push endpoint' }, { status: 400 })
        }
        if (typeof p256dh !== 'string' || p256dh.length < 1 || p256dh.length > 256) {
            return NextResponse.json({ error: 'Invalid p256dh key' }, { status: 400 })
        }
        if (typeof auth !== 'string' || auth.length < 1 || auth.length > 256) {
            return NextResponse.json({ error: 'Invalid auth key' }, { status: 400 })
        }
        if (guestPhone != null && (typeof guestPhone !== 'string' || guestPhone.length > 20)) {
            return NextResponse.json({ error: 'Invalid guestPhone' }, { status: 400 })
        }

        const adminDb = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        // ── Shop must exist (don't create rows for fabricated shop ids) ──
        const { data: shop } = await (adminDb as any)
            .from('shop_profiles')
            .select('id')
            .eq('id', shopId)
            .maybeSingle()
        if (!shop) {
            return NextResponse.json({ error: 'Shop not found' }, { status: 404 })
        }

        // ── Per-shop cap — only enforced when this is a NEW (shop, endpoint);
        //    re-subscribing an existing endpoint just upserts in place.
        const { data: existing } = await (adminDb as any)
            .from('guest_push_subscriptions')
            .select('id')
            .eq('shop_id', shopId)
            .eq('endpoint', endpoint)
            .maybeSingle()

        if (!existing) {
            const { count } = await (adminDb as any)
                .from('guest_push_subscriptions')
                .select('id', { count: 'exact', head: true })
                .eq('shop_id', shopId)
            if ((count ?? 0) >= MAX_SUBS_PER_SHOP) {
                return NextResponse.json({ error: 'Subscription limit reached for this shop' }, { status: 429 })
            }
        }

        const { error } = await (adminDb as any)
            .from('guest_push_subscriptions')
            .upsert(
                {
                    shop_id: shopId,
                    endpoint,
                    p256dh,
                    auth,
                    guest_phone: guestPhone || null,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'shop_id,endpoint' }
            )

        if (error) {
            console.error('[guest-subscribe] Upsert error:', error)
            return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (err) {
        console.error('[guest-subscribe] Error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
