'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { WebsiteRequestPromo } from '@/components/website-request-promo'
import {
    ArrowRight,
    Users,
    MessageSquare,
    LifeBuoy,
    Star,
    Quote,
    ChevronDown,
} from 'lucide-react'
import { LandingFooter } from '@/components/landing-footer'
import { WhatsAppCommunityButtons } from '@/components/whatsapp-community-buttons'
import { cn } from '@/lib/utils'
import dynamic from 'next/dynamic'
const PWAInstallPrompt = dynamic(() => import('@/components/pwa-install-prompt').then(m => ({ default: m.PWAInstallPrompt })), { ssr: false })
import {
    DEFAULT_GUEST_URL,
    DEFAULT_CUSTOMER_COUNT_LABEL,
    DEFAULT_CUSTOMER_COUNT_TARGET,
    DEFAULT_AGENT_PLANS,
    DEFAULT_TESTIMONIALS,
    POPULAR_NETWORK_ORDER,
    parseCustomerCountTarget,
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

interface FaqItem {
    question: string
    answer: React.ReactNode
}

const getFaqItems = (guestUrl: string): FaqItem[] => [
    {
        question: 'How do I buy data or airtime?',
        answer: (
            <span>
                Once you create an account and fund your wallet, you can purchase data or airtime directly from your dashboard in just three clicks. The process is fully automated, and your order will be delivered to the recipient number within seconds.
            </span>
        ),
    },
    {
        question: 'Can I buy without creating an account?',
        answer: (
            <span>
                Yes! If you prefer a quick one-time purchase without signing up, you can use our Guest Storefront option. Click <a href={guestUrl} className="text-[#0056B3] font-bold hover:underline">Here</a> to visit the guest store and buy instantly using Mobile Money or Card.
            </span>
        ),
    },
    {
        question: 'How does the wallet system work?',
        answer: (
            <span>
                Your wallet is your personal spending account on FameTech. You top it up once using Mobile Money or Bank Transfer, and your funds are securely stored. You can then use your wallet balance to buy data, airtime, or register as an AFA agent instantly without having to enter payment details every time.
            </span>
        ),
    },
    {
        question: 'How do I create an account?',
        answer: (
            <span>
                Creating an account is completely free. Simply click on the <strong>Get Started Free</strong> button, provide your basic details (Name, Email, Phone Number, and Password), and your account will be ready instantly. You will be redirected to your dashboard where you can start buying and reselling.
            </span>
        ),
    },
    {
        question: 'How can I get my Developer API?',
        answer: (
            <span>
                The Developer API allows you to automate data and airtime purchases directly from your own website or mobile app. You can view our comprehensive API documentation by clicking the <strong>View Docs</strong> button or generate your API key directly from your dashboard under the Developer API tab once approved.
            </span>
        ),
    },
    {
        question: 'How do I report a failed or delayed order?',
        answer: (
            <span>
                We have a dedicated <strong>Complaints</strong> section built directly into your dashboard. If an order is delayed, simply click the &quot;Report Issue&quot; button next to the transaction. Our system will track it, and our support team will resolve it rapidly, providing updates right on your dashboard.
            </span>
        ),
    },
    {
        question: 'Can I create my own reseller storefront?',
        answer: (
            <span>
                Absolutely. As a registered user, you can launch your own branded data shop. You set your own profit margins on top of our wholesale prices, upload your logo, and share your unique shop link with your customers. You earn a profit every time someone buys from your shop.
            </span>
        ),
    },
]

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
    whatsappCommunityLink = 'https://chat.whatsapp.com/FC6jYV3VDEQ4MmdTXiFqDV?mode=gi_t',
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
    const [activeFaqIndex, setActiveFaqIndex] = useState<number | null>(0)
    const [countTarget, setCountTarget] = useState(DEFAULT_CUSTOMER_COUNT_TARGET)
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

    // Customer count animation logic
    useEffect(() => {
        setCountTarget(parseCustomerCountTarget(landingCustomerCountRaw))
    }, [landingCustomerCountRaw])

    // Links come from SSR props — no client-side fetch needed
    const communityLinks = {
        group: whatsappGroupLink,
        channel: whatsappChannelLink,
        community: whatsappCommunityLink,
    }

    return (
        <div className="min-h-screen overflow-x-clip transition-colors duration-300">
            <PWAInstallPrompt />
            <LandingNav whatsappHref={whatsappHref} adminPhone={adminPhone} />
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

            {/* 14. Support + Complaints */}
            <section className="py-16 px-4 sm:px-6 lg:px-8">
                <div className="max-w-6xl mx-auto">
                    <div className="text-center mb-10">
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white mb-3">Easy Support and Complaint Resolution</h2>
                        <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">Need help or issue resolution? We built direct channels so you can get answers and track outcomes quickly.</p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
                            <div className="w-12 h-12 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center mb-4">
                                <LifeBuoy className="w-6 h-6" />
                            </div>
                            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Easy Support System</h3>
                            <p className="text-slate-600 dark:text-slate-400 mb-5">Get support through WhatsApp and in-app help channels whenever you need guidance.</p>
                            <a href={whatsappHref} target={adminPhone ? '_blank' : undefined} rel={adminPhone ? 'noopener noreferrer' : undefined}>
                                <Button variant="outline" className="border-emerald-500 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 font-bold">Talk to Support</Button>
                            </a>
                        </div>

                        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
                            <div className="w-12 h-12 rounded-lg bg-[#0056B3]/10 text-[#0056B3] flex items-center justify-center mb-4">
                                <MessageSquare className="w-6 h-6" />
                            </div>
                            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Complaint Tracking System</h3>
                            <p className="text-slate-600 dark:text-slate-400 mb-5">Report order issues, monitor complaint status, and get transparent updates from the dashboard.</p>
                            <Link href="/auth">
                                <Button variant="outline" className="border-[#0056B3] dark:border-[#4da6ff] text-[#0056B3] dark:text-[#4da6ff] hover:bg-[#0056B3]/10 dark:hover:bg-[#4da6ff]/10 font-bold">Track Complaints</Button>
                            </Link>
                        </div>
                    </div>
                </div>
            </section>

            {/* 16. Social Proof */}
            <section className="py-16 px-4 sm:px-6 lg:px-8">
                <div className="max-w-4xl mx-auto text-center">
                    <div className="w-14 h-14 mx-auto rounded-full bg-[#0056B3]/10 text-[#0056B3] flex items-center justify-center mb-4"><Users className="w-7 h-7" /></div>
                    <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-3">Join Thousands of Ghanaians Who Trust FameTech</h2>
                    <p className="text-4xl sm:text-5xl md:text-6xl font-black text-[#0056B3] mb-3">{countTarget.toLocaleString()}{landingCustomerCountRaw.includes('+') ? '+' : ''}</p>
                    <p className="text-slate-600 dark:text-slate-400">Customers across Ghana rely on our speed, reliability, and reseller support.</p>
                </div>
            </section>

            {/* 17. Testimonials */}
            <section className="py-16 px-4 sm:px-6 lg:px-8 bg-white/50 dark:bg-slate-900/50">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-10">
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white mb-3">What Customers Are Saying</h2>
                        <p className="text-slate-600 dark:text-slate-400">Live customer-style reviews on how easy and reliable the platform feels day to day.</p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {landingTestimonials.slice(0, 6).map((review, index) => (
                            <article key={`${review.name}-${index}`} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
                                <div className="flex items-start justify-between mb-4">
                                    <div>
                                        <p className="font-bold text-slate-900 dark:text-white">{review.name}</p>
                                        <p className="text-xs text-slate-500 dark:text-slate-400">{review.role}</p>
                                    </div>
                                    <Quote className="w-5 h-5 text-[#0056B3]/40" />
                                </div>
                                <div className="flex items-center gap-1 mb-3">
                                    {Array.from({ length: 5 }).map((_, i) => (
                                        <Star key={`${review.name}-star-${i}`} className={cn('w-4 h-4', i < review.rating ? 'text-amber-500 fill-amber-500' : 'text-slate-300 dark:text-slate-600')} />
                                    ))}
                                </div>
                                <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">{review.quote}</p>
                            </article>
                        ))}
                    </div>
                </div>
            </section>

            {/* 18. FAQ */}
            <section className="py-16 px-4 sm:px-6 lg:px-8">
                <div className="max-w-4xl mx-auto">
                    <div className="text-center mb-10">
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white mb-3">Frequently Asked Questions</h2>
                        <p className="text-slate-600 dark:text-slate-400">Quick answers about delivery speed, support, wallet use, and reseller growth.</p>
                    </div>
                    <div className="space-y-3">
                        {getFaqItems(guestUrl).map((item, index) => {
                            const open = activeFaqIndex === index
                            return (
                                <div key={item.question} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setActiveFaqIndex(open ? null : index)}
                                        className="w-full flex items-center justify-between px-5 py-4 text-left"
                                    >
                                        <span className="font-semibold text-slate-900 dark:text-white">{item.question}</span>
                                        <ChevronDown className={cn('w-5 h-5 text-slate-500 transition-transform', open && 'rotate-180')} />
                                    </button>
                                    <div className={cn('grid transition-all duration-300 ease-out', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
                                        <div className="overflow-hidden">
                                            <div className="px-5 pb-4 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">{item.answer}</div>
                                        </div>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </div>
            </section>

            {/* 19. CTA Banner */}
            <section className="py-16 px-4 sm:px-6 lg:px-8">
                <div className="max-w-4xl mx-auto">
                    <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-[#0056B3] to-[#00B4D8] p-8 lg:p-12 text-center shadow-lg lg:shadow-2xl">
                        <div className="absolute inset-0 bg-grid-white/10 [mask-image:linear-gradient(0deg,transparent,rgba(255,255,255,0.5))]" />
                        <div className="relative z-10">
                            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">Ready to Buy, Resell, or Register as an Agent?</h2>
                            <p className="text-white/90 max-w-xl mx-auto mb-8">Join one platform for instant purchases, reseller growth, and agent opportunities.</p>
                            <div className="flex flex-col sm:flex-row justify-center gap-3">
                                <Link href="/auth?tab=signup">
                                    <Button size="xl" className="bg-white text-[#0056B3] hover:bg-white/90 text-lg px-8 font-bold shadow-lg w-full sm:w-auto">Create Free Account<ArrowRight className="ml-2 w-5 h-5" /></Button>
                                </Link>
                                <a href={whatsappHref} target={adminPhone ? '_blank' : undefined} rel={adminPhone ? 'noopener noreferrer' : undefined}>
                                    <Button size="xl" className="w-full sm:w-auto bg-[#25D366] hover:bg-[#20bd5a] text-white border-none text-lg px-8 font-bold shadow-lg">Contact Us on WhatsApp</Button>
                                </a>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* 20. Community */}
            <section id="community" className="py-12 px-4 sm:px-6 lg:px-8">
                <div className="max-w-4xl mx-auto">
                    <div className="text-center mb-8">
                        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-4">Join Our Community</h2>
                        <p className="text-slate-600 dark:text-slate-400">Stay updated with exclusive offers and news on our WhatsApp platforms.</p>
                    </div>
                    <WhatsAppCommunityButtons />
                </div>
            </section>

            {/* 21. Footer */}
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
