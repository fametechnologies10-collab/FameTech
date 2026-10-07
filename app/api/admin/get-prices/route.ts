import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

// Keys safe to return to unauthenticated (public) callers
const PUBLIC_KEYS = [
    'guest_storefront_url',
    'whatsapp_group_link',
    'whatsapp_channel_link',
    'whatsapp_admin_number',
    'whatsapp_community_link',
] as const

// Keys that require an authenticated session
const PRIVATE_KEYS = [
    'agent_upgrade_price_3d',
    'agent_upgrade_price_14d',
    'agent_upgrade_price_30d',
    'agent_upgrade_price_permanent',
    'agent_upgrade_price_3d_old',
    'agent_upgrade_price_14d_old',
    'agent_upgrade_price_30d_old',
    'agent_upgrade_price_permanent_old',
    'show_price_strikethrough',
    'dealer_upgrade_price_1m',
    'dealer_upgrade_price_3m',
    'dealer_upgrade_price_6m',
] as const

export async function GET(request: NextRequest) {
    try {
        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } }
        )

        // ── Determine caller auth status ───────────────────────────
        let isAuthenticated = false
        try {
            const cookieStore = await cookies()
            const supabaseUser = await createRouteClient()
            const { data: { user } } = await supabaseUser.auth.getUser()
            isAuthenticated = !!user
        } catch {
            // Treat auth errors as unauthenticated — do not leak data
            isAuthenticated = false
        }

        // ── Fetch keys based on auth status ───────────────────────
        const keysToFetch = isAuthenticated
            ? [...PUBLIC_KEYS, ...PRIVATE_KEYS]
            : [...PUBLIC_KEYS]

        const { data, error } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', keysToFetch)

        if (error) {
            console.error('[get-prices] DB error:', { code: error.code, message: error.message })
            return NextResponse.json({ error: 'Failed to fetch pricing' }, { status: 500 })
        }

        const find = (key: string): string => data?.find(s => s.key === key)?.value ?? ''

        // ── Public fields (always returned) ───────────────────────
        const publicPayload = {
            guestStorefrontUrl: find('guest_storefront_url') || 'https://kingflexygh.com/shop/felix-s-shop',
            whatsappGroupLink: find('whatsapp_group_link'),
            whatsappChannelLink: find('whatsapp_channel_link'),
            whatsappAdminNumber: find('whatsapp_admin_number'),
            whatsappCommunityLink: find('whatsapp_community_link'),
        }

        if (!isAuthenticated) {
            // Unauthenticated — only return public link data
            return NextResponse.json({
                ...publicPayload,
                prices: null,
                oldPrices: null,
                showStrikethrough: false,
            }, {
                headers: { 'Cache-Control': 'no-store' }
            })
        }

        // ── Private fields (authenticated callers only) ────────────
        const prices = {
            '3d': parseFloat(find('agent_upgrade_price_3d') || '9.99'),
            '14d': parseFloat(find('agent_upgrade_price_14d') || '49.99'),
            '30d': parseFloat(find('agent_upgrade_price_30d') || '99.99'),
            'permanent': parseFloat(find('agent_upgrade_price_permanent') || '149.99'),
        }
        const oldPrices = {
            '3d': parseFloat(find('agent_upgrade_price_3d_old') || '0'),
            '14d': parseFloat(find('agent_upgrade_price_14d_old') || '0'),
            '30d': parseFloat(find('agent_upgrade_price_30d_old') || '0'),
            'permanent': parseFloat(find('agent_upgrade_price_permanent_old') || '0'),
        }
        const showStrikethrough = find('show_price_strikethrough') === 'true'
        const dealerPrice1m = parseFloat(find('dealer_upgrade_price_1m') || '99.99')
        const dealerPrice3m = parseFloat(find('dealer_upgrade_price_3m') || '199.99')
        const dealerPrice6m = parseFloat(find('dealer_upgrade_price_6m') || '299.99')

        return NextResponse.json({
            ...publicPayload,
            prices,
            oldPrices,
            showStrikethrough,
            dealerPrice: dealerPrice6m,
            dealerPrice1m,
            dealerPrice3m,
        }, {
            headers: { 'Cache-Control': 'private, no-store' }
        })

    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Unknown error'
        console.error('[get-prices] Unexpected error:', msg)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

