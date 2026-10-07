import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)

    const shopSlug = searchParams.get('shop')

    // If no shop slug, return the main platform manifest
    if (!shopSlug) {
        return NextResponse.json({
            name: 'KiNGFLEXYGH - Data Bundles & Airtime',
            short_name: 'KiNGFLEXYGH',
            description: 'Buy affordable MTN, Telecel, and AirtelTigo data bundles & airtime online in Ghana.',
            start_url: '/',
            display: 'standalone',
            background_color: '#0f172a',
            theme_color: '#0f172a',
            orientation: 'portrait-primary',
            scope: '/',
            icons: [
                { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
                { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
                { src: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
            ],
            categories: ['finance', 'utilities', 'shopping'],
        })
    }

    // Fetch shop details for dynamic manifest
    try {
        const supabase = createServerClient()
        const { data: shop } = await (supabase
            .from('shop_profiles')
            .select('shop_name, shop_slug, logo_url, brand_color, description')
            .eq('shop_slug', shopSlug)
            .single() as any)

        if (!shop) {
            return NextResponse.json({ error: 'Shop not found' }, { status: 404 })
        }

        // Smart name truncation for home screen (max ~12 characters)
        const shortName = shop.shop_name.length > 12
            ? shop.shop_name.substring(0, 11) + '…'
            : shop.shop_name

        const themeColor = shop.brand_color || '#0f172a'
        const startUrl = `/${shop.shop_slug}`

        // Build dynamic icon list. Opaque logos are stored as JPEG (see
        // app/api/shop/upload/route.ts), so the declared type follows the file.
        const logoPath = (shop.logo_url || '').split('?')[0].toLowerCase()
        const logoType = /\.jpe?g$/.test(logoPath) ? 'image/jpeg' : logoPath.endsWith('.webp') ? 'image/webp' : 'image/png'
        const icons = shop.logo_url
            ? [
                { src: shop.logo_url, sizes: '192x192', type: logoType, purpose: 'any' },
                { src: shop.logo_url, sizes: '512x512', type: logoType, purpose: 'any' },
            ]
            : [
                // Use the dynamic fallback icon generator
                { src: `/api/icon?name=${encodeURIComponent(shop.shop_name)}&color=${encodeURIComponent(themeColor)}&size=192`, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
                { src: `/api/icon?name=${encodeURIComponent(shop.shop_name)}&color=${encodeURIComponent(themeColor)}&size=512`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
            ]

        return NextResponse.json({
            name: `${shop.shop_name} - Data & Airtime`,
            short_name: shortName,
            description: shop.description || `Buy data bundles and airtime from ${shop.shop_name}`,
            start_url: startUrl,
            display: 'standalone',
            background_color: themeColor,
            theme_color: themeColor,
            orientation: 'portrait-primary',
            scope: startUrl,
            icons,
            categories: ['finance', 'utilities', 'shopping'],
        })
    } catch {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
