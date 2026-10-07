import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

export const dynamic = 'force-dynamic'

/**
 * GET /api/sms/my-customers — "My Customers" picker for KFT SMS compose.
 *
 * Mirrors the shop SMS feature's recipient source (shop_customers), but for
 * the KFT compose page. SECURITY: the shop is ALWAYS derived from the
 * authenticated session — never accepted from the client — and every read
 * is chained through it, so one user can never see another user's list:
 *
 *   auth.getUser() → shop_profiles WHERE owner_id = user.id  → shop.id
 *                  → shop_customers WHERE shop_id = shop.id
 *
 * A user with no shop (or someone else's shop) gets an empty list, never an
 * error and never another shop's data.
 */
export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-my-customers:${user.id}`, 30, 60_000)
        if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

        // Service-role read, but every query below is explicitly scoped by
        // the authenticated user.id — never by anything client-supplied.
        const db = createServerClient() as any

        const { data: shop, error: shopErr } = await db
            .from('shop_profiles')
            .select('id')
            .eq('owner_id', user.id)
            .maybeSingle()

        if (shopErr) {
            console.error('[SMS MyCustomers] shop lookup error:', shopErr)
            return NextResponse.json({ success: false, error: 'Failed to load customers' }, { status: 500 })
        }

        // No shop for this user — an empty list, not an error.
        if (!shop) {
            return NextResponse.json({ success: true, data: { customers: [] } })
        }

        const { data: customers, error } = await db
            .from('shop_customers')
            .select('id, phone, name')
            .eq('shop_id', shop.id)
            .order('last_order_at', { ascending: false })
            .limit(500)

        if (error) {
            console.error('[SMS MyCustomers] list error:', error)
            return NextResponse.json({ success: false, error: 'Failed to load customers' }, { status: 500 })
        }

        // Defensive de-dupe by phone (shop_customers already has a UNIQUE
        // (shop_id, phone) constraint, but never trust that alone downstream).
        const seen = new Set<string>()
        const deduped: Array<{ id: string; phone: string; name: string | null }> = []
        for (const c of (customers as any[]) || []) {
            if (seen.has(c.phone)) continue
            seen.add(c.phone)
            deduped.push({ id: c.id, phone: c.phone, name: c.name ?? null })
        }

        return NextResponse.json({ success: true, data: { customers: deduped } })
    } catch (err) {
        console.error('[SMS MyCustomers] GET error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
