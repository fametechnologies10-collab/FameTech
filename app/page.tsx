import type { Metadata } from 'next'
import { getAdminSettings } from '@/lib/admin-settings-cache'
import HomeClient from '@/components/home-client'

// Canonical lives here, not in the root layout, which every page inherits.
export const metadata: Metadata = {
    alternates: { canonical: 'https://kingflexygh.com' },
}

// Rebuild from DB at most every 5 minutes; served from Vercel Edge CDN between rebuilds.
// This replaces force-dynamic so the Edge Network can actually cache this page.
export const revalidate = 300

export default async function LandingPage() {
    // EGRESS: this is the marketing landing page — every visitor hits it. It was
    // previously an uncached admin_settings round-trip per view (on top of the
    // 300s ISR cache existing per-region, a cache MISS still re-ran this query
    // fresh every time). See lib/admin-settings-cache.ts. 5-minute TTL (product
    // decision, 2026-09-24) — every key here is pure display copy an admin
    // changes rarely, and it matches this page's own 300s ISR cadence exactly.
    const adminSettings = await getAdminSettings([
        'guest_storefront_url',
        'whatsapp_admin_number',
        'landing_customer_count',
        'landing_data_packages',
        'landing_agent_pricing',
        'landing_testimonials',
        'footer_copyright_text',
        'footer_branding_text',
        'whatsapp_group_link',
        'whatsapp_channel_link',
        'whatsapp_community_link',
    ], 5 * 60 * 1000)

    let guestUrl = 'https://kingflexygh.com/shop/felix-s-shop'
    let adminPhone = ''
    let whatsappGroupLink = 'https://chat.whatsapp.com/FC6jYV3VDEQ4MmdTXiFqDV?mode=gi_t'
    let whatsappChannelLink = 'https://whatsapp.com/channel/0029Vb7HTfx47XeIZz7ht232'
    let whatsappCommunityLink = 'https://chat.whatsapp.com/FC6jYV3VDEQ4MmdTXiFqDV?mode=gi_t'
    let landingCustomerCountRaw = '5,000+'
    let landingDataPackagesByNetwork: Record<string, any[]> = {}
    let showPopularPackages = false
    let landingAgentPlans: any[] = [
        { key: '3d', title: 'Starter', duration: '3 Days Access', price: '9.99', badge: 'Quick Start' },
        { key: '14d', title: 'Most Popular', duration: '14 Days Access', price: '49.99', badge: 'Best Value' },
        { key: '30d', title: 'Premium', duration: '30 Days Access', price: '99.99', badge: 'Business Ready' },
        { key: 'permanent', title: 'Lifetime', duration: 'Permanent Access', price: '149.99', badge: 'One Time' },
    ]
    let landingTestimonials: any[] = [
        {
            name: 'Efua A.',
            role: 'Retail Buyer - Accra',
            rating: 5,
            quote: 'Very easy to use. I buy MTN data in seconds and always get delivery fast.',
        },
        {
            name: 'Kojo M.',
            role: 'Reseller - Kumasi',
            rating: 5,
            quote: 'Setting up my shop was simple. The branded shop link helped me grow repeat customers.',
        },
        {
            name: 'Nana Y.',
            role: 'Student - Cape Coast',
            rating: 4,
            quote: 'Wallet payments are smooth, and support replies quickly when I need help.',
        },
        {
            name: 'Abena K.',
            role: 'Agent Member',
            rating: 5,
            quote: 'Agent plans are clear, and I like that I can manage everything from one dashboard.',
        },
    ]

    if (adminSettings.guest_storefront_url) {
        guestUrl = adminSettings.guest_storefront_url
    }
    if (adminSettings.whatsapp_admin_number) {
        adminPhone = adminSettings.whatsapp_admin_number
    }
    if (adminSettings.landing_customer_count) {
        const rawCount = adminSettings.landing_customer_count.trim()
        if (rawCount) {
            landingCustomerCountRaw = isNaN(Number(rawCount)) ? rawCount : `${Number(rawCount).toLocaleString()}+`
        }
    }
    if (adminSettings.landing_data_packages) {
        try {
            const parsed = JSON.parse(adminSettings.landing_data_packages)
            if (Array.isArray(parsed) && parsed.length > 0) {
                const safeItems = parsed.filter((item: any) =>
                    item && typeof item === 'object' && item.network && item.volume && item.price
                )
                if (safeItems.length > 0) {
                    const grouped: Record<string, any[]> = {}
                    for (const item of safeItems) {
                        if (!grouped[item.network]) grouped[item.network] = []
                        grouped[item.network].push(item)
                    }
                    landingDataPackagesByNetwork = grouped
                    showPopularPackages = true
                }
            }
        } catch { }
    }
    if (adminSettings.landing_agent_pricing) {
        try {
            const parsed = JSON.parse(adminSettings.landing_agent_pricing)
            if (Array.isArray(parsed) && parsed.length > 0) {
                const safePlans = parsed.filter((plan: any) =>
                    plan && typeof plan === 'object' && plan.key && plan.title && plan.duration && plan.price
                )
                if (safePlans.length > 0) {
                    landingAgentPlans = safePlans
                }
            }
        } catch { }
    }
    if (adminSettings.landing_testimonials) {
        try {
            const parsed = JSON.parse(adminSettings.landing_testimonials)
            if (Array.isArray(parsed) && parsed.length > 0) {
                const safeReviews = parsed.filter((review: any) =>
                    review && typeof review === 'object' && review.name && review.role && review.quote && typeof review.rating === 'number'
                )
                if (safeReviews.length >= 3) {
                    landingTestimonials = safeReviews.slice(0, 6)
                }
            }
        } catch { }
    }
    if (adminSettings.whatsapp_group_link) whatsappGroupLink = adminSettings.whatsapp_group_link
    if (adminSettings.whatsapp_channel_link) whatsappChannelLink = adminSettings.whatsapp_channel_link
    if (adminSettings.whatsapp_community_link) whatsappCommunityLink = adminSettings.whatsapp_community_link

    return (
        <HomeClient
            guestUrl={guestUrl}
            adminPhone={adminPhone}
            landingCustomerCountRaw={landingCustomerCountRaw}
            landingDataPackagesByNetwork={landingDataPackagesByNetwork}
            showPopularPackages={showPopularPackages}
            landingAgentPlans={landingAgentPlans}
            landingTestimonials={landingTestimonials}
            adminSettings={adminSettings}
            whatsappGroupLink={whatsappGroupLink}
            whatsappChannelLink={whatsappChannelLink}
            whatsappCommunityLink={whatsappCommunityLink}
        />
    )
}
