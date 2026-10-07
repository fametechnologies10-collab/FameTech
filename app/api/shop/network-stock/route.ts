import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { DATA_NETWORKS, isDataNetwork, parseShopStock } from '@/lib/network-stock'

// POST — shop owner hides/shows one data network on THEIR store (storefront + shop USSD).
// Owner-scoped by owner_id (no IDOR). Instant; does NOT reset pricing_status.
export async function POST(request: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const rl = consumeRateLimit(`shop-network-stock:${user.id}`, 30, 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many requests. Try again shortly.' }, { status: 429 })
        }

        const body = await request.json().catch(() => ({}))
        const { network, outOfStock } = body as { network?: unknown; outOfStock?: unknown }
        if (!isDataNetwork(network)) {
            return NextResponse.json({ success: false, error: 'Invalid network' }, { status: 400 })
        }
        if (typeof outOfStock !== 'boolean') {
            return NextResponse.json({ success: false, error: 'outOfStock must be a boolean' }, { status: 400 })
        }

        const admin = createServerClient() as any
        const { data: shop, error: readErr } = await admin
            .from('shop_profiles').select('id, oos_networks').eq('owner_id', user.id).maybeSingle()
        if (readErr) {
            console.error('[ShopNetworkStock] read error:', readErr)
            return NextResponse.json({ success: false, error: 'Failed to load shop' }, { status: 500 })
        }
        if (!shop) {
            return NextResponse.json({ success: false, error: 'Create your shop first' }, { status: 404 })
        }

        const set = parseShopStock(shop.oos_networks)
        if (outOfStock) set.add(network); else set.delete(network)
        // Normalize: allowlisted, deduped, stable order.
        const next = DATA_NETWORKS.filter((n) => set.has(n))

        const { error: updErr } = await admin
            .from('shop_profiles')
            .update({ oos_networks: next, updated_at: new Date().toISOString() })
            .eq('owner_id', user.id)
        if (updErr) {
            console.error('[ShopNetworkStock] update error:', updErr)
            return NextResponse.json({ success: false, error: 'Failed to update setting' }, { status: 500 })
        }

        return NextResponse.json({ success: true, oosNetworks: next })
    } catch (err) {
        console.error('[ShopNetworkStock] Error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
