'use client'

import { useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { WebsiteRequestPromo } from '@/components/website-request-promo'
import { LandingFooter } from '@/components/landing-footer'
import dynamic from 'next/dynamic'
const PWAInstallPrompt = dynamic(() => import('@/components/pwa-install-prompt').then(m => ({ default: m.PWAInstallPrompt })), { ssr: false })
import {
    DEFAULT_GUEST_URL,
    DEFAULT_CUSTOMER_COUNT_LABEL,
    DEFAULT_AGENT_PLANS,
    DEFAULT_TESTIMONIALS,
    POPULAR_NETWORK_ORDER,
    type LandingAgentPlan,
    type LandingReview,
    type PackagesByNetwork,
} from '@/components/landing/helpers'
import { LandingNav } from '@/components/landing/landing-nav'
import { Hero } from '@/components/landing/hero'
import { NetworkTrough } from '@/components/landing/network-trough'
import { ProductBento } from '@/components/landing/product-bento'
import { HowItWorks } from '@/components/landing/how-it-works'
import { WalletSection } from '@/components/landing/wallet'
import { ResellerPlans } from '@/components/landing/reseller-plans'
import { StorefrontPreview } from '@/components/landing/storefront-preview'
import { DeveloperApi } from '@/components/landing/developer-api'
import { SmsPromo } from '@/components/landing/sms-promo'
import { AfaPromo } from '@/components/landing/afa-promo'
import { PopularPackages } from '@/components/landing/popular-packages'
import { Reviews } from '@/components/landing/reviews'
import { Faq } from '@/components/landing/faq'
import { CtaBanner } from '@/components/landing/cta-banner'
import { Community } from '@/components/landing/community'

export default function HomeClient({
    guestUrl = DEFAULT_GUEST_URL,
    adminPhone = '',
    landingCustomerCountRaw = DEFAULT_CUSTOMER_COUNT_LABEL,
    landingDataPackagesByNetwork = {},
    showPopularPackages = false,
    landingAgentPlans = DEFAULT_AGENT_PLANS,
    landingTestimonials = DEFAULT_TESTIMONIALS,
    adminSettings = {},
    whatsappGroupLink = 'https://chat.whatsapp.com/FC6jYV3VDEQ4MmdTXiFqDV?mode=gi_t',
    whatsappChannelLink = 'https://whatsapp.com/channel/0029Vb7HTfx47XeIZz7ht232',
    // kept to preserve the props contract; WhatsAppCommunityButtons fetches its own links
    whatsappCommunityLink: _whatsappCommunityLink = 'https://chat.whatsapp.com/FC6jYV3VDEQ4MmdTXiFqDV?mode=gi_t',
}: {
    guestUrl?: string
    adminPhone?: string
    landingCustomerCountRaw?: string
    landingDataPackagesByNetwork?: PackagesByNetwork
    showPopularPackages?: boolean
    landingAgentPlans?: LandingAgentPlan[]
    landingTestimonials?: LandingReview[]
    adminSettings?: Record<string, string>
    whatsappGroupLink?: string
    whatsappChannelLink?: string
    whatsappCommunityLink?: string
}) {
    const router = useRouter()
    const whatsappHref = adminPhone ? `https://wa.me/${adminPhone}` : '#community'

    const groupedPackageEntries = useMemo(() => {
        const entries = Object.entries(landingDataPackagesByNetwork)
        return entries.sort((a, b) => {
            const indexA = POPULAR_NETWORK_ORDER.indexOf(a[0])
            const indexB = POPULAR_NETWORK_ORDER.indexOf(b[0])
            const safeA = indexA === -1 ? 999 : indexA
            const safeB = indexB === -1 ? 999 : indexB
            return safeA - safeB
        })
    }, [landingDataPackagesByNetwork])

    useEffect(() => {
        try {
            const slug = sessionStorage.getItem('shop_sticky_slug')
            if (slug) router.replace(`/shop/${slug}`)
        } catch {
            // ignore storage access errors
        }
    }, [router])

    // PWA (installed app) users should land on the auth page on a cold start,
    // but NOT when they explicitly navigate here (e.g. Home button from /auth).
    // sessionStorage flag distinguishes cold-open from in-app navigation.
    // Middleware will silently redirect them to /dashboard if they already have a valid session.
    // navigator.standalone covers iOS Safari; display-mode: standalone covers Chrome/Android PWA.
    useEffect(() => {
        const isStandalone =
            window.matchMedia('(display-mode: standalone)').matches ||
            (window.navigator as any).standalone === true
        if (isStandalone) {
            const hasVisited = sessionStorage.getItem('kf_pwa_visited')
            if (!hasVisited) {
                sessionStorage.setItem('kf_pwa_visited', '1')
                router.replace('/auth')
            }
        }
    }, [router])

    return (
        <div className="min-h-screen overflow-x-clip transition-colors duration-300">
            <PWAInstallPrompt />
            <LandingNav whatsappHref={whatsappHref} adminPhone={adminPhone} />
            <main id="main">
            <Hero customerCountLabel={landingCustomerCountRaw} guestUrl={guestUrl} packagesByNetwork={landingDataPackagesByNetwork} />
            <NetworkTrough />

            {/* Website/App request promo — funnels landing visitors to the website-request flow */}
            <WebsiteRequestPromo />

            <ProductBento />

            <HowItWorks />
            <WalletSection />
            <ResellerPlans plans={landingAgentPlans} />
            <StorefrontPreview guestUrl={guestUrl} />
            <DeveloperApi />
            <SmsPromo />
            <AfaPromo />
            {showPopularPackages && groupedPackageEntries.length > 0 && <PopularPackages entries={groupedPackageEntries} />}

            <Reviews customerCountRaw={landingCustomerCountRaw} testimonials={landingTestimonials} />
            <Faq guestUrl={guestUrl} />
            <CtaBanner whatsappHref={whatsappHref} adminPhone={adminPhone} />
            <Community />
            </main>

            <LandingFooter
                adminSettings={adminSettings}
                whatsappHref={whatsappHref}
                adminPhone={adminPhone}
                whatsappGroupLink={whatsappGroupLink}
                whatsappChannelLink={whatsappChannelLink}
            />
        </div>
    )
}
