'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { WebsiteRequestPromo } from '@/components/website-request-promo'
import {
    Smartphone,
    Zap,
    GraduationCap,
    Shield,
    Clock,
    ArrowRight,
    CreditCard,
    CheckCircle2,
    Store,
    ExternalLink,
    Wallet,
    Code2,
    BadgeCheck,
    Users,
    Boxes,
    MessageSquare,
    Send,
    LifeBuoy,
    Star,
    Quote,
    Crown,
    Gem,
    ChevronDown,
    Download,
    Apple,
    Laptop,
} from 'lucide-react'
import { LandingFooter } from '@/components/landing-footer'
import { WhatsAppCommunityButtons } from '@/components/whatsapp-community-buttons'
import { NetworkIcon } from '@/components/network-icon'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import dynamic from 'next/dynamic'
const PWAInstallPrompt = dynamic(() => import('@/components/pwa-install-prompt').then(m => ({ default: m.PWAInstallPrompt })), { ssr: false })
const PWAInstallButton = dynamic(() => import('@/components/pwa-install-prompt').then(m => ({ default: m.PWAInstallButton })), { ssr: false })
import { BrandLogo, BrandTitle } from '@/components/ui/brand'

const Android = (props: React.SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M17 18a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10z" />
        <path d="M9 18v3M15 18v3M4 10v4M20 10v4" />
        <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
        <circle cx="9.5" cy="11.5" r="0.5" fill="currentColor" />
        <circle cx="14.5" cy="11.5" r="0.5" fill="currentColor" />
    </svg>
)

interface LandingDataPackage {
    network: string
    volume: string
    price: string
}

interface LandingAgentPlan {
    key: string
    title: string
    duration: string
    price: string
    oldPrice?: string
    badge?: string
}

interface LandingReview {
    name: string
    role: string
    rating: number
    quote: string
}

interface FaqItem {
    question: string
    answer: React.ReactNode
}

type PackagesByNetwork = Record<string, LandingDataPackage[]>

const DEFAULT_GUEST_URL = 'https://kingflexygh.com/shop/felix-s-shop'
const DEFAULT_CUSTOMER_COUNT_LABEL = '5,000+'
const DEFAULT_CUSTOMER_COUNT_TARGET = 5000

const DEFAULT_AGENT_PLANS: LandingAgentPlan[] = [
    { key: '3d', title: 'Starter', duration: '3 Days Access', price: '9.99', badge: 'Quick Start' },
    { key: '14d', title: 'Most Popular', duration: '14 Days Access', price: '49.99', badge: 'Best Value' },
    { key: '30d', title: 'Premium', duration: '30 Days Access', price: '99.99', badge: 'Business Ready' },
    { key: 'permanent', title: 'Lifetime', duration: 'Permanent Access', price: '149.99', badge: 'One Time' },
]

const DEFAULT_TESTIMONIALS: LandingReview[] = [
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
                Your wallet is your personal spending account on KiNG FLEXY GH. You top it up once using Mobile Money or Bank Transfer, and your funds are securely stored. You can then use your wallet balance to buy data, airtime, or register as an AFA agent instantly without having to enter payment details every time.
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

const DATA_NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime']
const AIRTIME_NETWORKS = ['MTN', 'Telecel', 'AT']
const POPULAR_NETWORK_ORDER = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'AT']

function parseCustomerCountTarget(rawCount: string): number {
    const digitsOnly = rawCount.replace(/[^\d]/g, '')
    if (!digitsOnly) return DEFAULT_CUSTOMER_COUNT_TARGET
    const parsed = parseInt(digitsOnly, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CUSTOMER_COUNT_TARGET
    // M-4: Hard cap at 10 million to prevent render loops even if DB is poisoned
    return Math.min(parsed, 10_000_000)
}

function isSafeHref(url: string): boolean {
    if (!url || !url.trim()) return false
    try {
        const { protocol } = new URL(url.trim())
        return protocol === 'https:' || protocol === 'http:'
    } catch {
        return false
    }
}

function isValidPlan(plan: unknown): plan is LandingAgentPlan {
    if (typeof plan !== 'object' || plan === null) return false
    const candidate = plan as Record<string, unknown>
    return (
        typeof candidate.key === 'string' &&
        typeof candidate.title === 'string' &&
        typeof candidate.duration === 'string' &&
        typeof candidate.price === 'string'
    )
}

function isValidReview(review: unknown): review is LandingReview {
    if (typeof review !== 'object' || review === null) return false
    const candidate = review as Record<string, unknown>
    return (
        typeof candidate.name === 'string' &&
        typeof candidate.role === 'string' &&
        typeof candidate.quote === 'string' &&
        typeof candidate.rating === 'number'
    )
}

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
    const [headerScrolled, setHeaderScrolled] = useState(false)
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
        const handleHeaderScroll = () => {
            setHeaderScrolled(window.scrollY > 50)
        }
        window.addEventListener('scroll', handleHeaderScroll, { passive: true })
        return () => window.removeEventListener('scroll', handleHeaderScroll)
    }, [])

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

    const [currentSlide, setCurrentSlide] = useState(0)
    const [direction, setDirection] = useState(1)
    const [isHovered, setIsHovered] = useState(false)
    const [isHeroVisible, setIsHeroVisible] = useState(true)
    const heroRef = useRef<HTMLElement>(null)
    const touchStartX = useRef<number>(0)
    // Links come from SSR props — no client-side fetch needed
    const communityLinks = {
        group: whatsappGroupLink,
        channel: whatsappChannelLink,
        community: whatsappCommunityLink,
    }

    useEffect(() => {
        if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return
        const observer = new IntersectionObserver(
            ([entry]) => {
                setIsHeroVisible(entry.isIntersecting)
            },
            { threshold: 0.05 }
        )
        const currentHero = heroRef.current
        if (currentHero) {
            observer.observe(currentHero)
        }
        return () => {
            if (currentHero) {
                observer.unobserve(currentHero)
            }
        }
    }, [])

    useEffect(() => {
        if (isHovered || !isHeroVisible) return
        const timer = setInterval(() => {
            setDirection(1)
            setCurrentSlide(prev => (prev + 1) % 4)
        }, 10000)
        return () => clearInterval(timer)
    }, [isHovered, isHeroVisible])

    const slides = [
        {
            subhead: "WELCOME TO",
            title: <BrandTitle variant="hero" className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-black block tracking-tight leading-none text-slate-900 dark:text-white" />,
            description: "Ghana's all-in-one platform for mobile data, airtime, Results Checkers, and business growth. Instant delivery, always.",
            ctas: (
                <div className="flex flex-wrap items-center gap-3">
                    <Link href="/auth" className="w-full sm:w-auto">
                        <Button className="w-full rounded-full bg-[#FFCC00] hover:bg-[#E6B800] text-black font-bold h-12 px-6 shadow-md transition-all duration-300 hover:scale-105 active:scale-95 border-none">
                            Sign In
                        </Button>
                    </Link>
                    <Link href="/auth?tab=signup" className="w-full sm:w-auto">
                        <Button className="w-full rounded-full bg-slate-200 hover:bg-slate-300 dark:bg-white dark:hover:bg-slate-100 text-slate-900 font-bold h-12 px-6 shadow-md transition-all duration-300 hover:scale-105 active:scale-95 border-none">
                            Create Account
                        </Button>
                    </Link>
                    <a href={guestUrl} className="w-full sm:w-auto">
                        <Button variant="outline" className="w-full rounded-full border-slate-300/80 text-slate-700 bg-slate-50 hover:bg-slate-100 dark:border-white/20 dark:text-white dark:bg-white/5 dark:hover:bg-white/10 font-bold h-12 px-6 transition-all duration-300 hover:scale-105 active:scale-95 backdrop-blur-sm">
                            Buy as Guest
                        </Button>
                    </a>
                    <Link href="/download" className="w-full sm:w-auto">
                        <Button variant="outline" className="w-full rounded-full border-[#FFCC00]/40 hover:border-[#FFCC00] text-slate-700 bg-slate-50 hover:bg-slate-100 dark:border-white/20 dark:text-white dark:bg-white/5 dark:hover:bg-white/10 font-bold h-12 px-6 transition-all duration-300 hover:scale-105 active:scale-95 backdrop-blur-sm flex items-center justify-center gap-2">
                            <Download className="w-4 h-4 text-[#FFCC00]" />
                            <span>Download App</span>
                            <div className="flex items-center gap-1 ml-1 text-slate-400 dark:text-slate-500">
                                <Apple className="w-3.5 h-3.5" />
                                <Android className="w-3.5 h-3.5" />
                                <Laptop className="w-3.5 h-3.5" />
                            </div>
                        </Button>
                    </Link>
                </div>
            )
        },
        {
            subhead: "START YOUR BUSINESS",
            title: <span className="text-slate-900 dark:text-white text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-black block tracking-tight leading-none">Branded Reseller Shop</span>,
            description: "Create your own branded storefront under 5 minutes. Set your own profit margins, share your unique link, and earn daily passive income.",
            ctas: (
                <div className="flex flex-wrap items-center gap-3">
                    <Link href="/auth?tab=signup" className="w-full sm:w-auto">
                        <Button className="w-full rounded-full bg-[#FFCC00] hover:bg-[#E6B800] text-black font-bold h-12 px-6 shadow-md transition-all duration-300 hover:scale-105 active:scale-95 border-none">
                            Open Your Shop
                        </Button>
                    </Link>
                    <a href={guestUrl} className="w-full sm:w-auto">
                        <Button variant="outline" className="w-full rounded-full border-slate-300/80 text-slate-700 bg-slate-50 hover:bg-slate-100 dark:border-white/20 dark:text-white dark:bg-white/5 dark:hover:bg-white/10 font-bold h-12 px-6 transition-all duration-300 hover:scale-105 active:scale-95 backdrop-blur-sm">
                            View Shop Demo
                        </Button>
                    </a>
                </div>
            )
        },
        {
            subhead: "AUTOMATION & UPGRADES",
            title: <span className="text-slate-900 dark:text-white text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-black block tracking-tight leading-none">Developer API Access</span>,
            description: "Automate purchases directly from your custom website or app. Upgrade your account role to unlock developer pricing and reseller margins.",
            ctas: (
                <div className="flex flex-wrap items-center gap-3">
                    <Link href="/developers" className="w-full sm:w-auto">
                        <Button className="w-full rounded-full bg-[#FFCC00] hover:bg-[#E6B800] text-black font-bold h-12 px-6 shadow-md transition-all duration-300 hover:scale-105 active:scale-95 border-none">
                            View Docs
                        </Button>
                    </Link>
                    <Link href="/auth?tab=signup" className="w-full sm:w-auto">
                        <Button className="w-full rounded-full bg-slate-200 hover:bg-slate-300 dark:bg-white dark:hover:bg-slate-100 text-slate-900 font-bold h-12 px-6 shadow-md transition-all duration-300 hover:scale-105 active:scale-95 border-none">
                            Get Started
                        </Button>
                    </Link>
                </div>
            )
        },
        {
            subhead: "SUPPORT & RESOURCES",
            title: <span className="text-slate-900 dark:text-white text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-black block tracking-tight leading-none">Help & Live Community</span>,
            description: "Get direct support, track transactional complaints, and connect with other resellers inside our community chat.",
            ctas: (
                <div className="flex flex-wrap items-center gap-3">
                    <a href={whatsappHref} target="_blank" rel="noopener noreferrer" className="w-full sm:w-auto">
                        <Button className="w-full rounded-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold h-12 px-6 shadow-md transition-all duration-300 hover:scale-105 active:scale-95 border-none">
                            Contact Support
                        </Button>
                    </a>
                    {communityLinks.community && (
                        <a href={communityLinks.community} target="_blank" rel="noopener noreferrer" className="w-full sm:w-auto">
                            <Button className="w-full rounded-full bg-[#FFCC00] hover:bg-[#E6B800] text-black font-bold h-12 px-6 shadow-md transition-all duration-300 hover:scale-105 active:scale-95 border-none">
                                Join Community Group
                            </Button>
                        </a>
                    )}
                    {communityLinks.channel && (
                        <a href={communityLinks.channel} target="_blank" rel="noopener noreferrer" className="w-full sm:w-auto">
                            <Button variant="outline" className="w-full rounded-full border-slate-300/80 text-slate-700 bg-slate-50 hover:bg-slate-100 dark:border-white/20 dark:text-white dark:bg-white/5 dark:hover:bg-white/10 font-bold h-12 px-6 transition-all duration-300 hover:scale-105 active:scale-95 backdrop-blur-sm">
                                Follow Channel
                            </Button>
                        </a>
                    )}
                </div>
            )
        }
    ]

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 overflow-x-hidden transition-colors duration-300">
            <PWAInstallPrompt />
            {/* 1. Navigation */}
            <nav className={cn(
                'fixed top-0 w-full z-50 transition-all duration-300',
                headerScrolled
                    ? 'bg-white/80 dark:bg-slate-900/80 backdrop-blur-md shadow-sm border-b border-slate-200 dark:border-slate-800'
                    : 'bg-transparent border-transparent'
            )}>
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex items-center justify-between h-16">
                        <Link href="/" className="flex items-center gap-1.5 sm:gap-3 flex-shrink-0">
                            <BrandLogo width={40} height={40} className="w-8 h-8 sm:w-10 sm:h-10" />
                            <BrandTitle className="text-xs sm:text-xl md:text-2xl font-black tracking-tight text-slate-900 dark:text-white" />
                        </Link>

                        <div className="hidden lg:flex items-center gap-5">
                            <a href="#products" className="text-sm font-semibold text-slate-700 dark:text-slate-200 hover:text-[#0056B3] dark:hover:text-[#4da6ff] transition-colors">Products</a>
                            <a href="#wallet" className="text-sm font-semibold text-slate-700 dark:text-slate-200 hover:text-[#0056B3] dark:hover:text-[#4da6ff] transition-colors">Wallet</a>
                            <a href="#resell" className="text-sm font-semibold text-slate-700 dark:text-slate-200 hover:text-[#0056B3] dark:hover:text-[#4da6ff] transition-colors">Resell</a>
                            <a href="#afa" className="text-sm font-semibold text-slate-700 dark:text-slate-200 hover:text-[#0056B3] dark:hover:text-[#4da6ff] transition-colors">AFA</a>
                            <a href="#community" className="text-sm font-semibold text-slate-700 dark:text-slate-200 hover:text-[#0056B3] dark:hover:text-[#4da6ff] transition-colors">Community</a>
                            <Link href="/sms" className="text-sm font-semibold text-slate-700 dark:text-slate-200 hover:text-[#0056B3] dark:hover:text-[#4da6ff] transition-colors">SMS</Link>
                            <Link href="/dashboard/utilities" className="text-sm font-semibold text-slate-700 dark:text-slate-200 hover:text-[#0056B3] dark:hover:text-[#4da6ff] transition-colors">Utilities</Link>
                            <Link href="/dashboard/recruit" className="text-sm font-semibold text-slate-700 dark:text-slate-200 hover:text-[#0056B3] dark:hover:text-[#4da6ff] transition-colors">Sub-Agent</Link>
                        </div>

                        <div className="flex items-center space-x-1 sm:space-x-3 flex-shrink-0">
                            <div className="hidden sm:block">
                                <PWAInstallButton />
                            </div>
                            <a
                                href={whatsappHref}
                                target={adminPhone ? '_blank' : undefined}
                                rel={adminPhone ? 'noopener noreferrer' : undefined}
                                className="hidden sm:inline-flex text-sm font-semibold text-[#25D366] hover:text-[#1ea955] transition-colors"
                            >
                                Contact
                            </a>
                            <Link href="/auth">
                                <Button variant="ghost" className={cn('font-semibold px-2 text-xs h-8 sm:h-10 sm:px-3 sm:text-sm', headerScrolled ? 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800' : 'text-slate-800 dark:text-slate-100 hover:bg-white/20 dark:hover:bg-white/10')}>
                                    Login
                                </Button>
                            </Link>
                            <Link href="/auth?tab=signup">
                                <Button className="bg-[#0056B3] hover:bg-[#004494] text-white font-bold px-3 text-xs h-8 sm:h-10 sm:px-4 sm:text-sm whitespace-nowrap">Get Started</Button>
                            </Link>
                        </div>
                    </div>
                </div>
            </nav>

                        {/* 2. Hero */}
            <section ref={heroRef} className="relative pt-24 pb-16 sm:pt-28 sm:pb-24 px-4 sm:px-6 lg:px-8 overflow-hidden bg-slate-50 dark:bg-slate-950">
                {/* Hero blobs — CSS-only animation, no JS frame loop */}
                <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden" aria-hidden="true">
                    <div className="hero-blob-a absolute top-1/4 left-1/4 w-72 h-72 sm:w-96 sm:h-96 rounded-full bg-blue-500/30 dark:bg-blue-600/15 blur-[40px] sm:blur-[60px] will-change-transform" />
                    <div className="hero-blob-b absolute top-1/3 right-1/4 w-80 h-80 sm:w-[420px] sm:h-[420px] rounded-full bg-[#FFCC00]/25 dark:bg-[#FFCC00]/8 blur-[40px] sm:blur-[65px] will-change-transform" />
                    <div className="hero-blob-c absolute bottom-10 left-1/3 w-72 h-72 sm:w-96 sm:h-96 rounded-full bg-purple-500/30 dark:bg-purple-600/15 blur-[40px] sm:blur-[60px] will-change-transform" />
                </div>

                <div className="max-w-7xl mx-auto relative z-10">
                    {/* Centered Brand Identity Header */}
                    <div className="flex flex-col items-center justify-center mb-8">
                        <div className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-full overflow-hidden flex items-center justify-center bg-white/10 backdrop-blur-md border border-white/20 shadow-xl transition-transform hover:scale-110 duration-300">
                            <BrandLogo width={112} height={112} className="object-contain w-full h-full" />
                        </div>
                        <BrandTitle className="text-xl sm:text-2xl font-black mt-3 tracking-wide drop-shadow-sm" />
                    </div>

                    {/* Trust Strip Badge */}
                    <div className="flex justify-center mb-8">
                        <div className="inline-flex items-center px-4 py-2 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm transition-all duration-300 hover:scale-105">
                            <Zap className="w-4 h-4 text-yellow-500 mr-2" />
                            <span className="text-xs sm:text-sm text-slate-700 dark:text-slate-200 font-semibold tracking-wide">Ultra Fast Instant Delivery</span>
                        </div>
                    </div>

                    {/* Hero Carousel Card — pure CSS transitions, zero Framer Motion */}
                    <div
                        onMouseEnter={() => setIsHovered(true)}
                        onMouseLeave={() => setIsHovered(false)}
                        onTouchStart={(e) => {
                            touchStartX.current = e.touches[0].clientX
                            setIsHovered(true)
                        }}
                        onTouchEnd={(e) => {
                            const delta = e.changedTouches[0].clientX - touchStartX.current
                            if (delta < -50) { setDirection(1); setCurrentSlide(prev => (prev + 1) % slides.length) }
                            else if (delta > 50) { setDirection(-1); setCurrentSlide(prev => (prev - 1 + slides.length) % slides.length) }
                            setIsHovered(false)
                        }}
                        className="w-full max-w-4xl mx-auto rounded-3xl border border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900/80 p-6 sm:p-10 md:p-12 shadow-[0_4px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)] relative overflow-hidden"
                    >
                        {/* Slide Content — CSS cross-fade transition */}
                        <div className="min-h-[300px] sm:min-h-[260px] flex flex-col justify-between relative z-10">
                            <div className="relative overflow-hidden">
                                {slides.map((slide, index) => (
                                    <div
                                        key={index}
                                        aria-hidden={index !== currentSlide}
                                        className={cn(
                                            'w-full space-y-6 select-none transition-all duration-300',
                                            index === currentSlide
                                                ? 'opacity-100 translate-x-0 relative'
                                                : index < currentSlide
                                                    ? 'opacity-0 -translate-x-4 absolute inset-0 pointer-events-none'
                                                    : 'opacity-0 translate-x-4 absolute inset-0 pointer-events-none'
                                        )}
                                    >
                                        <span className="text-xs sm:text-sm font-bold tracking-[0.2em] text-[#0056B3] dark:text-[#FFCC00]/90 uppercase block">
                                            {slide.subhead}
                                        </span>
                                        <h1 className="leading-tight text-slate-900 dark:text-white">
                                            {slide.title}
                                        </h1>
                                        <p className="text-base sm:text-lg md:text-xl text-slate-700 dark:text-slate-200 font-medium max-w-3xl leading-relaxed">
                                            {slide.description}
                                        </p>
                                        <div className="pt-4">
                                            {slide.ctas}
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Carousel Indicators / Dots & Controls */}
                            <div className="flex items-center justify-between pt-8 border-t border-slate-200/50 dark:border-white/10 mt-8">
                                {/* Dots */}
                                <div className="flex items-center space-x-2">
                                    {slides.map((_, index) => (
                                        <button
                                            key={index}
                                            onClick={() => {
                                                setDirection(index > currentSlide ? 1 : -1)
                                                setCurrentSlide(index)
                                            }}
                                            className="p-3 -m-2 flex items-center justify-center focus:outline-none"
                                            aria-label={`Go to slide ${index + 1}`}
                                        >
                                            <div className={cn(
                                                "h-2 rounded-full transition-all duration-300",
                                                index === currentSlide 
                                                    ? "w-6 bg-[#FFCC00] shadow-[0_0_8px_rgba(255,204,0,0.5)]" 
                                                    : "w-2 bg-slate-900/20 dark:bg-white/30 hover:bg-slate-900/30 dark:hover:bg-white/50"
                                            )} />
                                        </button>
                                    ))}
                                </div>

                                {/* Slide Index Label */}
                                <span className="text-xs font-semibold text-slate-500 dark:text-white/50 tracking-wider">
                                    0{currentSlide + 1} / 0{slides.length}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Sub-Hero Brand Section */}
            <section className="py-12 px-4 sm:px-6 lg:px-8 text-center bg-slate-100/50 dark:bg-slate-900/20">
                <div className="max-w-4xl mx-auto space-y-4">
                    <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight">
                        Ghana&apos;s All-In-One Mobile Data & Reseller Platform
                    </h2>
                    <p className="text-base sm:text-lg text-slate-600 dark:text-slate-300 leading-relaxed max-w-3xl mx-auto">
                        Buy data bundles, airtime, AFA orders, and MTN Mashup. Fund your wallet, open your own shop, or integrate via our Developer API — all in one place. Instant delivery, always.
                    </p>
                </div>
            </section>

            {/* Website/App request promo — funnels landing visitors to the website-request flow */}
            <WebsiteRequestPromo />

            {/* Top Services Grid Section */}
            <section id="products" className="py-16 px-4 sm:px-6 lg:px-8 bg-slate-50 dark:bg-slate-950">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-12">
                        <span className="text-xs sm:text-sm font-bold tracking-[0.2em] text-[#0056B3] dark:text-[#FFCC00]/90 uppercase block mb-2">PROVEN PRODUCTS</span>
                        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white tracking-tight">Our Top Services</h2>
                        <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto mt-2">Explore the fully automated features and instant digital services powering our ecosystem.</p>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6">
                        {[
                            {
                                title: "Data Bundles",
                                desc: "High-speed MTN, Telecel, and AT data packages at wholesale reseller rates.",
                                link: "/dashboard/data-packages",
                                bg: "from-green-500/10 to-emerald-500/5 dark:from-green-500/20 dark:to-emerald-500/10",
                                border: "border-green-200 dark:border-green-900/30",
                                icon: <Boxes className="w-6 h-6 text-green-600 dark:text-green-400" />
                            },
                            {
                                title: "Airtime Topup",
                                desc: "Instant VTU airtime recharge for all networks with direct phone delivery.",
                                link: "/dashboard/airtime",
                                bg: "from-blue-500/10 to-indigo-500/5 dark:from-blue-500/20 dark:to-indigo-500/10",
                                border: "border-blue-200 dark:border-blue-900/30",
                                icon: <Smartphone className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                            },
                            {
                                title: "AFA Services",
                                desc: "Seamless MTN AFA registration and renewals for community field agents.",
                                link: "/dashboard/upgrade",
                                bg: "from-purple-500/10 to-fuchsia-500/5 dark:from-purple-500/20 dark:to-fuchsia-500/10",
                                border: "border-purple-200 dark:border-purple-900/30",
                                icon: <BadgeCheck className="w-6 h-6 text-purple-600 dark:text-purple-400" />
                            },
                            {
                                title: "Result Checker",
                                desc: "Purchase WAEC BECE and WASSCE results check vouchers instantly.",
                                link: "/dashboard/results-checker",
                                bg: "from-amber-500/10 to-yellow-500/5 dark:from-amber-500/20 dark:to-yellow-500/10",
                                border: "border-amber-200 dark:border-amber-900/30",
                                icon: <GraduationCap className="w-6 h-6 text-amber-600 dark:text-amber-400" />
                            },
                            {
                                title: "MTN Mashup",
                                desc: "Activate custom voice & data combination bundles directly on any MTN line.",
                                link: "/dashboard/data-packages",
                                bg: "from-yellow-500/10 to-orange-500/5 dark:from-yellow-500/20 dark:to-orange-500/10",
                                border: "border-yellow-200 dark:border-yellow-900/30",
                                icon: <Crown className="w-6 h-6 text-yellow-600 dark:text-yellow-400" />
                            },
                            {
                                title: "Reseller Shops",
                                desc: "Setup your own customized, branded online shop under 5 minutes.",
                                link: "/dashboard/shop",
                                bg: "from-pink-500/10 to-rose-500/5 dark:from-pink-500/20 dark:to-rose-500/10",
                                border: "border-pink-200 dark:border-pink-900/30",
                                icon: <Store className="w-6 h-6 text-pink-600 dark:text-pink-400" />
                            },
                            {
                                title: "Developer API",
                                desc: "Automate and scale transactional flows via our REST API endpoints.",
                                link: "/developers",
                                bg: "from-teal-500/10 to-cyan-500/5 dark:from-teal-500/20 dark:to-cyan-500/10",
                                border: "border-teal-200 dark:border-teal-900/30",
                                icon: <Code2 className="w-6 h-6 text-teal-600 dark:text-teal-400" />
                            },
                            {
                                title: "Send & Claim",
                                desc: "Secure wallet-to-wallet funds transfer to instantly share platform balance.",
                                link: "/dashboard/wallet",
                                bg: "from-indigo-500/10 to-violet-500/5 dark:from-indigo-500/20 dark:to-violet-500/10",
                                border: "border-indigo-200 dark:border-indigo-900/30",
                                icon: <Wallet className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                            },
                            {
                                title: "SMS",
                                desc: "Bulk & transactional SMS for OTPs, alerts, and campaigns — sent in seconds.",
                                link: "/sms",
                                bg: "from-cyan-500/10 to-sky-500/5 dark:from-cyan-500/20 dark:to-sky-500/10",
                                border: "border-cyan-200 dark:border-cyan-900/30",
                                icon: <MessageSquare className="w-6 h-6 text-cyan-600 dark:text-cyan-400" />
                            },
                            {
                                title: "Bill Pay",
                                desc: "Pay ECG, Ghana Water, and other utility bills instantly from your wallet.",
                                link: "/dashboard/utilities",
                                bg: "from-orange-500/10 to-red-500/5 dark:from-orange-500/20 dark:to-red-500/10",
                                border: "border-orange-200 dark:border-orange-900/30",
                                icon: <Zap className="w-6 h-6 text-orange-600 dark:text-orange-400" />
                            },
                            {
                                title: "Sub-Agent Program",
                                desc: "Recruit and manage your own network of sub-agents, and earn from their sales.",
                                link: "/dashboard/recruit",
                                bg: "from-emerald-500/10 to-lime-500/5 dark:from-emerald-500/20 dark:to-lime-500/10",
                                border: "border-emerald-200 dark:border-emerald-900/30",
                                icon: <Users className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
                            }
                        ].map((srv) => (
                            <div
                                key={srv.title}
                                className="group relative flex flex-col justify-between rounded-2xl border border-black dark:border-white bg-white dark:bg-slate-900 p-5 sm:p-6 transition-all duration-300 hover:-translate-y-1.5 hover:shadow-[0_12px_24px_-10px_rgba(0,0,0,0.1)] hover:border-black dark:hover:border-white overflow-hidden"
                            >
                                <div className={`absolute inset-0 bg-gradient-to-br ${srv.bg} opacity-30 group-hover:opacity-50 transition-opacity duration-300 pointer-events-none`} />
                                <div className="relative z-10">
                                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center border bg-white dark:bg-slate-900 shadow-sm transition-transform duration-300 group-hover:scale-110 ${srv.border}`}>
                                        {srv.icon}
                                    </div>
                                    <div className="mt-4">
                                        <div className="flex items-center gap-1.5">
                                            <h3 className="font-bold text-base text-slate-900 dark:text-white tracking-tight">{srv.title}</h3>

                                        </div>
                                        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1.5 leading-relaxed">{srv.desc}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* 7. How It Works */}
            <section className="py-16 px-4 sm:px-6 lg:px-8">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-12">
                        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">How It Works</h2>
                        <p className="text-slate-600 dark:text-slate-400 max-w-xl mx-auto">Start in minutes, buy in seconds.</p>
                    </div>

                    <div className="grid md:grid-cols-3 gap-8 md:gap-6">
                        {[
                            { step: '01', title: 'Create Account', description: 'Sign up with your phone and basic details.', icon: Smartphone },
                            { step: '02', title: 'Fund Your Wallet', description: 'Top up once and stay ready to buy any time.', icon: CreditCard },
                            { step: '03', title: 'Buy Data Bundle', description: 'Choose bundle, enter number, and receive delivery instantly.', icon: CheckCircle2 },
                        ].map((item) => (
                            <div key={item.title} className="relative rounded-xl border border-black dark:border-white bg-white dark:bg-slate-900 p-5 sm:p-6">
                                <div className="text-6xl font-bold text-slate-200 dark:text-slate-700 absolute -top-4 left-0">{item.step}</div>
                                <div className="relative z-10 pt-8">
                                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#0056B3] to-[#00B4D8] flex items-center justify-center mb-4"><item.icon className="w-6 h-6 text-white" /></div>
                                    <h3 className="text-xl font-semibold text-slate-900 dark:text-white mb-3">{item.title}</h3>
                                    <p className="text-slate-600 dark:text-slate-400">{item.description}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="mt-10 rounded-2xl border border-dashed border-[#0056B3]/40 dark:border-[#4da6ff]/40 bg-[#0056B3]/5 dark:bg-[#4da6ff]/5 p-5 sm:p-6">
                        <p className="text-sm font-bold uppercase tracking-wide text-[#0056B3] dark:text-[#4da6ff] mb-3">Reseller mini flow</p>
                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-sm">
                            {['Create Shop', 'Set Prices', 'Share Your Link', 'Earn Profit'].map((step) => (
                                <div key={step} className="rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-3 py-2 font-semibold text-slate-700 dark:text-slate-200 text-center">{step}</div>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            {/* 6. Wallet */}
            <section id="wallet" className="py-16 px-4 sm:px-6 lg:px-8 bg-white/50 dark:bg-slate-900/50">
                <div className="max-w-6xl mx-auto">
                    <div className="text-center mb-10">
                        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">Pay With Your Wallet</h2>
                        <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">Keep your balance ready, checkout faster, and enjoy smooth purchases any time of day.</p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        {[
                            { title: 'Top Up', icon: CreditCard, description: 'Add funds quickly with trusted payment options.' },
                            { title: 'Store Balance', icon: Wallet, description: 'Your wallet stays ready for anytime purchases.' },
                            { title: 'Buy Instantly', icon: Zap, description: 'Checkout in seconds for data and airtime.' }
                        ].map((item) => (
                            <div key={item.title} className="rounded-xl border border-black dark:border-white bg-white dark:bg-slate-900 p-5">
                                <div className="w-10 h-10 rounded-lg bg-[#0056B3]/10 text-[#0056B3] flex items-center justify-center mb-4"><item.icon className="w-5 h-5" /></div>
                                <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">{item.title}</h3>
                                <p className="text-sm text-slate-600 dark:text-slate-400">{item.description}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* 3. Trust Strip */}
            <section className="pb-10 px-4 sm:px-6 lg:px-8">
                <div className="max-w-7xl mx-auto grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                    {[`${landingCustomerCountRaw} Happy Customers`, 'Instant Delivery', 'MTN - Telecel - AirtelTigo', 'Available 24/7'].map((item) => (
                        <div key={item} className="rounded-xl border border-black dark:border-white bg-white/90 dark:bg-slate-900/70 px-4 py-3 text-center text-sm sm:text-base font-semibold text-slate-700 dark:text-slate-200">{item}</div>
                    ))}
                </div>
            </section>

            {/* 13. Features Grid */}
            <section className="py-16 px-4 sm:px-6 lg:px-8 bg-white/50 dark:bg-slate-900/50">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-12">
                        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">Why Choose KiNG FLEXY GH?</h2>
                    </div>

                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                        {[
                            { icon: Zap, title: 'Ultra Fast Delivery', description: 'Data and airtime orders are processed in seconds.', gradient: 'from-yellow-500 to-orange-500' },
                            { icon: Shield, title: 'Secure Wallet Payments', description: 'Pay from wallet with a clear transaction trail.', gradient: 'from-green-500 to-emerald-500' },
                            { icon: Code2, title: 'Developer API', description: 'Integrate automated data and airtime purchases directly into your app.', gradient: 'from-blue-500 to-indigo-500' },
                            { icon: Boxes, title: 'Product Sales', description: 'Access a wide range of everyday mobile products in one place.', gradient: 'from-fuchsia-500 to-pink-500' },
                            { icon: MessageSquare, title: 'Complaint Filing', description: 'Report order issues and track resolution directly from your dashboard.', gradient: 'from-rose-400 to-red-500' },
                            { icon: Store, title: 'Reseller Tools', description: 'Launch your branded shop and set your own profit margins.', gradient: 'from-violet-500 to-purple-600' },
                            { icon: CheckCircle2, title: 'Order Tracking', description: 'Track order statuses and detailed history easily.', gradient: 'from-indigo-500 to-blue-600' },
                            { icon: BadgeCheck, title: 'Agent Program', description: 'Apply for AFA registration with quick wallet funding.', gradient: 'from-sky-500 to-blue-500' },
                            { icon: Clock, title: '24/7 Available', description: 'Buy, manage, and track your orders at any time of day.', gradient: 'from-teal-400 to-emerald-500' },
                        ].map((feature) => (
                            <div key={feature.title} className="group p-6 rounded-2xl bg-white dark:bg-slate-900 border border-black dark:border-white shadow-sm">
                                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${feature.gradient} flex items-center justify-center mb-4`}>
                                    <feature.icon className="w-6 h-6 text-white" />
                                </div>
                                <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">{feature.title}</h3>
                                <p className="text-slate-600 dark:text-slate-400 text-sm">{feature.description}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* 8. Reseller / Shop */}
            <section id="resell" className="py-16 px-4 sm:px-6 lg:px-8 bg-white/50 dark:bg-slate-900/50">
                <div className="max-w-6xl mx-auto grid lg:grid-cols-[1.2fr_1fr] gap-8 items-center">
                    <div>
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white mb-4">Start Your Own Data Shop</h2>
                        <p className="text-slate-600 dark:text-slate-400 mb-6">Create a branded storefront, set your own prices, share your link, and earn on every order.</p>
                        <div className="space-y-3 mb-8">
                            {['Your own branded shop link', 'Set your own profit margins', 'Track earnings and withdrawals'].map((item) => (
                                <div key={item} className="flex items-center gap-3">
                                    <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                                    <span className="text-slate-700 dark:text-slate-300 font-medium">{item}</span>
                                </div>
                            ))}
                        </div>
                        <Link href="/auth?tab=signup">
                            <Button size="xl" className="bg-[#0056B3] hover:bg-[#004494] text-white font-bold">Open Your Shop<ArrowRight className="w-5 h-5 ml-2" /></Button>
                        </Link>
                    </div>
                    <div className="rounded-2xl border border-black dark:border-white bg-white dark:bg-slate-900 p-6 shadow-sm">
                        <div className="w-12 h-12 rounded-xl bg-[#0056B3]/10 text-[#0056B3] flex items-center justify-center mb-4"><Store className="w-6 h-6" /></div>
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Built for Growth</h3>
                        <p className="text-slate-600 dark:text-slate-400">Share your storefront with customers and grow daily recurring sales from data and airtime orders.</p>
                    </div>
                </div>
            </section>

            {/* 9. Storefront Preview */}
            <section className="py-16 px-4 sm:px-6 lg:px-8">
                <div className="max-w-7xl mx-auto grid lg:grid-cols-[1fr_1.2fr] gap-8 items-center">
                    <div>
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white mb-4">Premium Storefront Preview</h2>
                        <p className="text-slate-600 dark:text-slate-400 mb-6">
                            Your shop can look clean, branded, and professional with banner, logo, custom colors, and clear buy actions.
                        </p>
                        <div className="space-y-3">
                            {['Upload logo and banner', 'Customize brand colors', 'Preview before publishing', 'Share one clean shop link'].map((point) => (
                                <div key={point} className="flex items-center gap-3">
                                    <CheckCircle2 className="w-5 h-5 text-[#0056B3]" />
                                    <span className="font-medium text-slate-700 dark:text-slate-300">{point}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-2xl overflow-hidden border border-black dark:border-white bg-white dark:bg-slate-900 shadow-xl">
                        <div className="relative h-32 sm:h-40 bg-gradient-to-r from-[#0056B3] to-[#00B4D8]">
                            <div className="absolute inset-0 bg-black/10" />
                            <div className="absolute left-4 right-4 bottom-3 flex items-center gap-3">
                                <div className="w-14 h-14 rounded-xl bg-white flex items-center justify-center shadow-md">
                                    <Store className="w-7 h-7 text-[#0056B3]" />
                                </div>
                                <div className="min-w-0">
                                    <p className="font-black text-white text-lg leading-tight truncate">Felix&apos;s Data Hub</p>
                                    <p className="text-white/90 text-xs">Fast data bundles and airtime, trusted by daily buyers.</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {[
                                { network: 'MTN', size: '1GB', price: '4.30' },
                                { network: 'Telecel', size: '2GB', price: '9.00' }
                            ].map((pkg) => (
                                <div key={`${pkg.network}-${pkg.size}`} className="rounded-xl border border-black dark:border-white p-3 bg-slate-50 dark:bg-slate-800/50">
                                    <div className="flex items-center gap-2 mb-2">
                                        <NetworkIcon network={pkg.network} size={30} />
                                        <p className="font-bold text-slate-900 dark:text-white">{pkg.size}</p>
                                    </div>
                                    <p className="text-xs text-slate-600 dark:text-slate-400">from <span className="font-bold text-[#0056B3]">GHS {pkg.price}</span></p>
                                </div>
                            ))}
                        </div>
                        <div className="p-4 sm:px-5 sm:pb-5">
                            <Button className="w-full bg-[#0056B3] hover:bg-[#004494] text-white font-bold">Buy Now</Button>
                        </div>
                    </div>
                </div>
            </section>

            {/* 10. Developer API */}
            <section className="py-16 px-4 sm:px-6 lg:px-8">
                <div className="max-w-5xl mx-auto rounded-2xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/20 p-6 sm:p-8">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="w-10 h-10 rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 flex items-center justify-center"><Code2 className="w-5 h-5" /></div>
                        <div className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-emerald-200 dark:bg-emerald-500/20 text-emerald-900 dark:text-emerald-200">Live</div>
                    </div>
                    <h2 className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white mb-3">Developer API</h2>
                    <p className="text-slate-700 dark:text-slate-300 mb-6 max-w-3xl">Integrate KiNG FLEXY GH directly into your website or app. Automate data and airtime purchases for your customers via our API.</p>
                    <Link href="/developers">
                        <Button variant="outline" className="border-emerald-500 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 font-bold">View Docs<ExternalLink className="w-4 h-4 ml-2" /></Button>
                    </Link>
                </div>
            </section>

            {/* 10b. KFT SMS — Bulk & Transactional Messaging */}
            <section id="sms" className="py-16 px-4 sm:px-6 lg:px-8 bg-white/50 dark:bg-slate-900/50">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-12">
                        <span className="text-xs sm:text-sm font-bold tracking-[0.2em] text-[#0056B3] dark:text-[#FFCC00]/90 uppercase block mb-2">New · KFT SMS</span>
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white tracking-tight">Send SMS to your customers — at scale</h2>
                        <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto mt-3">Bulk and transactional SMS for Ghana businesses. Campaigns, OTPs, and order alerts — under your own sender ID, with a delivery report on every number.</p>
                    </div>

                    <div className="grid lg:grid-cols-[1.05fr_1fr] gap-8 lg:gap-10 items-center mb-10">
                        {/* Left: value + CTAs */}
                        <div>
                            <div className="flex flex-wrap gap-2 mb-6">
                                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-[#0056B3]/10 text-[#0056B3] dark:text-[#4da6ff] border border-[#0056B3]/20 dark:border-[#4da6ff]/25">
                                    <Shield className="w-3.5 h-3.5" /> Platform mode
                                </span>
                                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25">
                                    <BadgeCheck className="w-3.5 h-3.5" /> Business mode — your own sender ID
                                </span>
                            </div>
                            <div className="space-y-3 mb-8">
                                {[
                                    'Start on our shared trusted sender, or send under your own brand',
                                    'Per-recipient Sent → Delivered tracking on every message',
                                    'Buy SMS credits — 160 characters = 1 credit per recipient',
                                ].map((item) => (
                                    <div key={item} className="flex items-start gap-3">
                                        <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                                        <span className="text-slate-700 dark:text-slate-300 font-medium">{item}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="flex flex-col sm:flex-row gap-3">
                                <Link href="/sms" className="w-full sm:w-auto">
                                    <Button size="xl" className="w-full bg-[#0056B3] hover:bg-[#004494] text-white font-bold">
                                        Explore KFT SMS<ArrowRight className="w-5 h-5 ml-2" />
                                    </Button>
                                </Link>
                                <Link href="/developers" className="w-full sm:w-auto">
                                    <Button size="xl" variant="outline" className="w-full font-bold border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100">
                                        <Code2 className="w-5 h-5 mr-2" />Read the API docs
                                    </Button>
                                </Link>
                            </div>
                        </div>

                        {/* Right: delivery-report signature card */}
                        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
                            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/30">
                                <div className="flex items-center gap-2.5 min-w-0">
                                    <div className="w-9 h-9 rounded-xl bg-[#0056B3]/10 text-[#0056B3] dark:text-[#4da6ff] flex items-center justify-center shrink-0">
                                        <MessageSquare className="w-5 h-5" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-sm font-bold text-slate-900 dark:text-white truncate">Sender: AcmeGH</p>
                                        <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">Order updates · 1,204 recipients</p>
                                    </div>
                                </div>
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />Live
                                </span>
                            </div>
                            <div className="divide-y divide-slate-100 dark:divide-slate-800">
                                {[
                                    { phone: '024 •• •• 512', status: 'Delivered', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
                                    { phone: '055 •• •• 907', status: 'Delivered', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
                                    { phone: '020 •• •• 143', status: 'Sent', cls: 'bg-[#0056B3]/10 text-[#0056B3] dark:text-[#4da6ff] border-[#0056B3]/25 dark:border-[#4da6ff]/30' },
                                    { phone: '027 •• •• 668', status: 'Undelivered', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30' },
                                ].map((row) => (
                                    <div key={row.phone} className="flex items-center justify-between gap-3 px-5 py-3">
                                        <span className="font-mono text-xs text-slate-600 dark:text-slate-300 truncate">{row.phone}</span>
                                        <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold border tracking-wide', row.cls)}>{row.status}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="px-5 py-4 bg-slate-50/70 dark:bg-slate-800/30 border-t border-slate-100 dark:border-slate-800">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Delivery rate</span>
                                    <span className="text-sm font-black text-emerald-600 dark:text-emerald-400">98.7%</span>
                                </div>
                                <div className="h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                                    <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400" style={{ width: '98.7%' }} />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Feature highlights */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        {[
                            { icon: BadgeCheck, title: 'Your own sender ID', desc: 'Send under your brand name once your business is verified.' },
                            { icon: CheckCircle2, title: 'Delivery reports', desc: 'Track every number from Sent to Delivered or Undelivered.' },
                            { icon: Send, title: 'Bulk, scheduling & templates', desc: 'Message contact groups, schedule sends, and reuse templates.' },
                            { icon: Code2, title: 'Developer API', desc: 'Fire OTPs and order alerts from your app with kf_live_ keys.' },
                        ].map((f) => (
                            <div key={f.title} className="group rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-md">
                                <div className="w-11 h-11 rounded-xl bg-[#0056B3]/10 text-[#0056B3] dark:text-[#4da6ff] flex items-center justify-center transition-transform duration-300 group-hover:scale-110">
                                    <f.icon className="w-5 h-5" />
                                </div>
                                <h3 className="mt-4 font-bold text-slate-900 dark:text-white">{f.title}</h3>
                                <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{f.desc}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* 11. AFA Agent */}
            <section id="afa" className="py-16 px-4 sm:px-6 lg:px-8 bg-white/50 dark:bg-slate-900/50">
                <div className="max-w-6xl mx-auto grid lg:grid-cols-[1.2fr_1fr] gap-8 items-center">
                    <div>
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white mb-4">Become an Authorized Field Agent</h2>
                        <p className="text-slate-600 dark:text-slate-400 mb-6">Join the MTN AFA registration program through your dashboard. Submit your details, pay from wallet, and track your application status.</p>
                        <div className="space-y-3 mb-8">
                            {['Permanent agent membership', 'Wallet-funded application'].map((item) => (
                                <div key={item} className="flex items-center gap-3">
                                    <BadgeCheck className="w-5 h-5 text-[#0056B3] shrink-0" />
                                    <span className="text-slate-700 dark:text-slate-300 font-medium">{item}</span>
                                </div>
                            ))}
                        </div>
                        <Link href="/auth?tab=signup"><Button size="xl" className="bg-[#0056B3] hover:bg-[#004494] text-white font-bold">Apply Now<ArrowRight className="w-5 h-5 ml-2" /></Button></Link>
                    </div>
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-sm">
                        <div className="w-12 h-12 rounded-xl bg-[#0056B3]/10 text-[#0056B3] flex items-center justify-center mb-4"><BadgeCheck className="w-6 h-6" /></div>
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">AFA Pathway</h3>
                        <p className="text-slate-600 dark:text-slate-400">Designed for users who want field-level credibility and a clear registration process with permanent membership status.</p>
                    </div>
                </div>
            </section>

            {/* 12. Agent Membership Pricing */}
            <section className="py-16 px-4 sm:px-6 lg:px-8">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-12">
                        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#0056B3]/10 text-[#0056B3] dark:text-[#4da6ff] text-[11px] font-black uppercase tracking-widest mb-4">
                            <Crown className="w-3.5 h-3.5" />
                            AGENT MEMBERSHIP
                        </div>
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white mb-3">Agent Membership Plans</h2>
                        <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">Choose the plan that fits your journey. All plans include wholesale pricing, shop storefront, bulk orders, and <span className="font-bold text-slate-800 dark:text-slate-200">Developer API Key access</span>.</p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                        {landingAgentPlans.map((plan) => (
                            <div key={plan.key} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
                                {plan.badge && (
                                    <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wide bg-[#0056B3]/10 text-[#0056B3] mb-3">
                                        <Crown className="w-3 h-3" />
                                        {plan.badge}
                                    </div>
                                )}
                                <h3 className="font-bold text-slate-900 dark:text-white text-lg mb-1">{plan.title}</h3>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">{plan.duration}</p>
                                {plan.oldPrice && plan.oldPrice !== plan.price && (
                                    <p className="text-sm text-slate-400 dark:text-slate-500 line-through mb-1">GHS {plan.oldPrice}</p>
                                )}
                                <p className="text-3xl font-black text-[#0056B3] dark:text-[#4da6ff] mb-4">GHS {plan.price}</p>
                                <Link href="/auth?tab=signup">
                                    <Button className="w-full bg-[#0056B3] hover:bg-[#004494] text-white font-bold">Get Started</Button>
                                </Link>
                            </div>
                        ))}
                    </div>

                    {/* Dealer tier teaser */}
                    <div className="relative rounded-2xl overflow-hidden border border-violet-300 dark:border-violet-700 bg-gradient-to-br from-violet-950 via-purple-900 to-indigo-950 p-6 sm:p-8 shadow-xl mt-8">
                        <div className="absolute inset-0 bg-gradient-to-tr from-violet-600/10 via-transparent to-indigo-400/10 pointer-events-none" />
                        <div className="relative z-10 flex flex-col sm:flex-row items-start sm:items-center gap-6">
                            <div className="w-14 h-14 rounded-2xl bg-violet-500/20 border border-violet-500/40 flex items-center justify-center shrink-0">
                                <Gem className="w-7 h-7 text-violet-300 fill-violet-400/40" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-violet-500/20 border border-violet-500/30 text-[10px] font-black text-violet-300 uppercase tracking-widest mb-2">
                                    <Gem className="w-3 h-3" /> DEALER TIER — EXCLUSIVE
                                </div>
                                <h3 className="text-xl font-black text-white mb-1">Become a Dealer</h3>
                                <p className="text-sm text-violet-200 max-w-xl">
                                    The highest reseller rank on KiNG FLEXY. Available exclusively to <span className="font-black text-white">Lifetime Agent</span> members — unlock more discounted prices, full Developer API access with high rate limits, priority order processing, and direct priority support.
                                </p>
                            </div>
                            <Link href="/auth?tab=signup" className="shrink-0">
                                <Button className="bg-gradient-to-r from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700 text-white font-black rounded-xl shadow-lg shadow-violet-900/50 whitespace-nowrap">
                                    <Gem className="w-4 h-4 mr-2" />
                                    Learn More
                                </Button>
                            </Link>
                        </div>
                    </div>
                </div>
            </section>

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

            {/* 15. Popular Data Packages */}
            {showPopularPackages && (
                <section className="py-16 px-4 sm:px-6 lg:px-8 bg-white/50 dark:bg-slate-900/50">
                    <div className="max-w-7xl mx-auto">
                        <div className="text-center mb-10">
                            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-3">Popular Data Packages</h2>
                            <p className="text-slate-600 dark:text-slate-400">Prices updated by our team - always competitive.</p>
                        </div>

                        <div className="space-y-8">
                            {groupedPackageEntries.map(([network, packages]) => (
                                <div key={network} className="flex flex-col items-center">
                                    <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-6 text-center">{network}</h3>
                                    <div className="flex flex-wrap justify-center gap-4 w-full max-w-4xl mx-auto">
                                        {packages.map((pkg, index) => (
                                            <div 
                                                key={`${network}-${pkg.volume}-${pkg.price}-${index}`} 
                                                
                                                className="w-full sm:w-[calc(50%-1rem)] lg:w-[calc(33.333%-1rem)] min-w-[250px] max-w-[320px] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 flex flex-col items-center text-center shadow-sm hover:shadow-md transition-shadow"
                                            >
                                                <div className="flex flex-col items-center mb-4">
                                                    <div className="mb-3">
                                                        <NetworkIcon network={network} size={48} />
                                                    </div>
                                                    <p className="text-lg font-black text-slate-900 dark:text-white">{pkg.volume}</p>
                                                </div>
                                                <p className="text-sm text-slate-600 dark:text-slate-400">
                                                    for as low as <br />
                                                    <span className="text-xl font-black text-[#0056B3] block mt-1">GHS {pkg.price}</span>
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>
            )}

            {/* 16. Social Proof */}
            <section className="py-16 px-4 sm:px-6 lg:px-8">
                <div className="max-w-4xl mx-auto text-center">
                    <div className="w-14 h-14 mx-auto rounded-full bg-[#0056B3]/10 text-[#0056B3] flex items-center justify-center mb-4"><Users className="w-7 h-7" /></div>
                    <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-3">Join Thousands of Ghanaians Who Trust KiNG FLEXY GH</h2>
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
