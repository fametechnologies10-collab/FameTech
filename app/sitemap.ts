import { MetadataRoute } from 'next'
import { createServerClient } from '@/lib/supabase'
import { DEVELOPER_PRODUCTS } from '@/lib/developer-products'

export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const mainDomain = 'https://kingflexygh.com'
    const shopDomain = 'https://shop.kingflexygh.com'

    // Static pages for the main domain
    const staticPages: MetadataRoute.Sitemap = [
        {
            url: mainDomain,
            lastModified: new Date(),
            changeFrequency: 'weekly',
            priority: 1.0,
        },
        {
            url: `${mainDomain}/developers`,
            lastModified: new Date(),
            changeFrequency: 'weekly',
            priority: 0.9,
        },
        ...DEVELOPER_PRODUCTS.map(p => ({
            url: `${mainDomain}/developers/${p.slug}`,
            lastModified: new Date(),
            changeFrequency: 'monthly' as const,
            priority: 0.8,
        })),
        {
            url: `${mainDomain}/terms`,
            lastModified: new Date(),
            changeFrequency: 'monthly',
            priority: 0.4,
        },
        {
            url: `${mainDomain}/privacy`,
            lastModified: new Date(),
            changeFrequency: 'monthly',
            priority: 0.4,
        },
        // Storefront landing page (shop discovery)
        {
            url: shopDomain,
            lastModified: new Date(),
            changeFrequency: 'daily',
            priority: 0.9,
        },
    ]

    // Fetch all live, approved shops — read-only, public data only (slug + updated_at)
    let shopPages: MetadataRoute.Sitemap = []
    try {
        const supabase = createServerClient()
        const { data: shops } = await supabase
            .from('shop_profiles')
            .select('shop_slug, updated_at')
            .eq('approval_status', 'approved')
            .eq('is_active', true)

        if (shops && shops.length > 0) {
            shopPages = shops.map((shop: { shop_slug: string; updated_at: string | null }) => ({
                url: `${shopDomain}/${shop.shop_slug}`,
                lastModified: new Date(shop.updated_at ?? Date.now()),
                changeFrequency: 'weekly' as const,
                priority: 0.8,
            }))
        }
    } catch (err) {
        // If DB is unreachable, return static pages only — never crash the sitemap
        console.error('[sitemap] Failed to fetch shop list:', err)
    }

    return [...staticPages, ...shopPages]
}
