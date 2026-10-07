'use client'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { formatCurrency } from '@/lib/utils'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { downloadResultsCheckerVouchers } from '@/lib/results-checker-utils'
import {
    Phone, Mail, MessageCircle, ShoppingCart, Loader2,
    CheckCircle2, AlertCircle, X, Zap, Smartphone, Check, Menu, Bell, BellPlus,
    History, TrendingUp, Coins, Calendar, CalendarRange, RefreshCw, Info, Clock, Copy, ArrowRight, AlertTriangle, Users, FileText, Download, GraduationCap, Lock, ShieldCheck, Eye, EyeOff, Receipt, IdCard
} from 'lucide-react'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { CopyrightFooter } from '@/components/CopyrightFooter'
import { PWAInstallPrompt } from '@/components/pwa-install-prompt'
import { StorefrontDataTab } from './components/StorefrontDataTab'
import { StorefrontUtilitiesTab } from './components/StorefrontUtilitiesTab'
import AfaRegistrationForm from './AfaRegistrationForm'
import { ServiceChargeSheet, type ChargeDescriptor } from './components/ServiceChargeSheet'
import type { UtilityBiller } from '@/lib/hubtel-utility/billers'
import { StorefrontTermsBoundary } from './components/StorefrontTermsBoundary'
import { NetworkIcon } from '@/components/network-icon'
import { AnnouncementCTAButtons } from '@/components/announcements/AnnouncementCTAButtons'
import { PromoCarousel } from '@/components/promo-carousel/PromoCarousel'
import { buildStorefrontSlides } from '@/lib/promo-carousel/storefront-slides'

// ─── Divider SVG paths (matching setup page) ──────────────────────────────────
const DIVIDER_PATHS: Record<string, string> = {
    'asymmetric-curve': 'M321.39,56.44c58-10.79,114.16-30.13,172-41.86,82.39-16.72,168.19-17.73,250.45-.39C823.78,31,906.67,72,985.66,92.83c70.05,18.48,146.53,26.09,214.34,3V120H0V0C0,0,0,0,0,0c0,0,0,0,0,0Q160.69,78,321.39,56.44Z',
    'angled': 'M0,0 L1200,80 L1200,120 L0,120 Z',
    'zigzag': 'M0,60 L100,0 L200,60 L300,0 L400,60 L500,0 L600,60 L700,0 L800,60 L900,0 L1000,60 L1100,0 L1200,60 L1200,120 L0,120 Z',
    'concave': 'M0,0 Q600,120 1200,0 L1200,120 L0,120 Z',
    'animated-wave': 'M0,64 C150,100 350,0 600,60 C850,120 1050,20 1200,64 L1200,120 L0,120 Z',
    'layered-waves': 'M0,80 C200,20 400,100 600,60 C800,20 1000,100 1200,80 L1200,120 L0,120 Z',
    'tilt': 'M0,40 L1200,0 L1200,120 L0,120 Z',
    'organic-blob': 'M0,80 C100,20 300,100 500,70 C700,40 900,110 1100,60 C1150,45 1180,50 1200,60 L1200,120 L0,120 Z',
    'paper-cut': 'M0,80 L120,40 L240,80 L360,40 L480,80 L600,40 L720,80 L840,40 L960,80 L1080,40 L1200,80 L1200,120 L0,120 Z',
    'torn-edge': 'M0,90 L30,70 L60,95 L90,65 L130,85 L170,60 L210,90 L260,55 L310,80 L370,50 L430,85 L490,58 L560,90 L640,55 L720,85 L800,50 L880,80 L960,45 L1040,75 L1120,50 L1200,70 L1200,120 L0,120 Z',
    'convex': 'M0,120 Q600,0 1200,120 L1200,120 L0,120 Z',
    'slant': 'M0,80 L1200,0 L1200,120 L0,120 Z',
    'skewed': 'M0,0 L900,0 L1200,120 L0,120 Z',
    'glassmorphic': 'M0,100 Q600,60 1200,100 L1200,120 L0,120 Z',
    'multi-step-wave': 'M0,60 C100,40 200,80 300,60 C400,40 500,80 600,60 C700,40 800,80 900,60 C1000,40 1100,80 1200,60 L1200,120 L0,120 Z',
}

function DividerSVG({ style, fillClass }: { style?: string | null; fillClass: string }) {
    const path = DIVIDER_PATHS[style || 'asymmetric-curve'] || DIVIDER_PATHS['asymmetric-curve']
    const isAnimated = style === 'animated-wave'
    return (
        <div className="absolute bottom-0 left-0 w-full overflow-hidden leading-none">
            <svg viewBox="0 0 1200 120" preserveAspectRatio="none" className={cn('relative block w-full h-[40px]', fillClass, isAnimated && 'animate-pulse')} aria-hidden="true">
                <title>Section divider</title>
                <path d={path} />
            </svg>
        </div>
    )
}

interface ShopData {
    id: string
    shop_name: string
    shop_slug: string
    description: string
    owner_phone: string
    owner_email: string | null
    whatsapp_number: string | null
    logo_url: string | null
    community_link?: string | null
    divider_style?: string | null
    brand_color: string
    brand_accent: string
    ownerRole: string
    airtime_fee_mtn?: number
    airtime_fee_telecel?: number
    airtime_fee_at?: number
    mashup_fee_percent?: number
    ussd_code?: string | null
    ussd_active?: boolean
    afa_selling_price?: number | null
    paystack_fee_percent?: number | null
}

interface Package {
    id: string
    network: string
    size: string
    description: string | null
    selling_price: number
}

interface Props {
    shop: ShopData
    packages: Package[]
    adminSettings: Record<string, string>
    initialAnnouncement?: { id: string; type: 'admin' | 'shop'; message: string; title?: string; cta_primary_label?: string | null; cta_primary_url?: string | null; cta_secondary_label?: string | null; cta_secondary_url?: string | null } | null
    rcTypes?: Array<{ id: string; name: string; customer_price: number; available_count?: number; bulk_pricing?: Array<{ min_qty: number; max_qty: number; unit_price: number }> }>
    rcMarkup?: number
    rcMarkups?: Record<string, number>
    oosNetworks?: string[]
    /**
     * Server-computed gate for the Utilities tab (global admin gates AND shop opt-in AND
     * ≥1 biller enabled AND NOT a sub-agent shop) — resolved once in
     * app/shop/[shopSlug]/page.tsx, mirroring the utility API routes' own gate chain. The
     * client never re-derives this; it only reads the prop. Optional/defaulted so pages that
     * haven't been updated yet (e.g. the white-label shop-domain route) keep compiling with
     * the tab simply hidden.
     */
    utilitiesEnabled?: boolean
    enabledUtilityBillers?: Partial<Record<UtilityBiller, boolean>>
    utilityMinAmount?: number
    utilityMaxAmount?: number
}

// Brand colors per network (used in Airtime tab)
const networkColors: Record<string, { bgClass: string; textClass: string; borderClass: string; gradient: string }> = {
    MTN: { bgClass: 'bg-[#FFCE00]', textClass: 'text-[#000000]', borderClass: 'border-[#e6b800]', gradient: 'from-yellow-400 to-yellow-500' },
    Telecel: { bgClass: 'bg-[#E60000]', textClass: 'text-[#ffffff]', borderClass: 'border-[#cc0000]', gradient: 'from-red-500 to-red-600' },
    'AT-iShare': { bgClass: 'bg-[#0056B3]', textClass: 'text-[#ffffff]', borderClass: 'border-[#004494]', gradient: 'from-blue-600 to-blue-700' },
    'AT-BigTime': { bgClass: 'bg-[#6f42c1]', textClass: 'text-[#ffffff]', borderClass: 'border-[#5a32a3]', gradient: 'from-purple-600 to-purple-700' },
    AT: { bgClass: 'bg-[#F97316]', textClass: 'text-[#ffffff]', borderClass: 'border-[#ea580c]', gradient: 'from-orange-500 to-orange-600' },
}

const QUICK_AMOUNTS = [1, 2, 5, 10, 20, 50, 100]


function UssdStorefrontGuide({ code, shortcode, shopName }: { code: string; shortcode: string; shopName: string }) {
    const [copied, setCopied] = useState(false)
    const steps = [
        <>Dial <span className="font-mono font-bold tracking-wide text-gray-900 dark:text-white">{shortcode}</span> on any phone</>,
        <>Enter shop code <span className="font-mono font-bold tracking-widest bg-[var(--brand-color)]/10 text-[var(--brand-color)] px-1.5 py-0.5 rounded">{code}</span></>,
        <>Choose <span className="font-semibold">Data Bundles</span> or <span className="font-semibold">Results Checker</span></>,
        <>Pay with <span className="font-semibold">Mobile Money</span> — instant delivery</>,
    ]

    return (
        <div className="mb-6 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-950 p-5 shadow-sm">
            <div className="flex items-center gap-2.5 mb-1">
                <div className="shrink-0 w-9 h-9 rounded-full bg-[var(--brand-color)]/10 flex items-center justify-center">
                    <Smartphone className="w-4 h-4 text-[var(--brand-color)]" />
                </div>
                <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-900 dark:text-white leading-tight">
                        No internet? Shop on USSD
                    </p>
                    <p className="text-xs text-muted-foreground leading-tight">
                        Buy from {shopName} on any phone — no app, no data.
                    </p>
                </div>
            </div>

            <ol className="mt-4 space-y-2.5">
                {steps.map((step, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-300">
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--brand-color)] text-white text-xs font-bold flex items-center justify-center">
                            {i + 1}
                        </span>
                        <span className="pt-0.5 leading-relaxed">{step}</span>
                    </li>
                ))}
            </ol>

            <button
                type="button"
                onClick={() => {
                    navigator.clipboard?.writeText(code)
                        .then(() => {
                            setCopied(true)
                            toast.success('Shop code copied')
                            setTimeout(() => setCopied(false), 1800)
                        })
                        .catch(() => toast.error('Could not copy — long-press the code to copy'))
                }}
                aria-label={`Copy shop USSD code ${code}`}
                className="mt-4 w-full flex items-center justify-center gap-2 rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-zinc-900 py-2.5 px-3 hover:bg-gray-100 dark:hover:bg-zinc-800 active:scale-[0.99] transition-all"
            >
                <span className="font-mono text-sm font-semibold text-gray-700 dark:text-gray-200">{shortcode}</span>
                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="font-mono text-sm font-bold tracking-widest text-[var(--brand-color)]">{code}</span>
                {copied
                    ? <Check className="w-4 h-4 text-green-600 ml-1 shrink-0" />
                    : <Copy className="w-4 h-4 text-muted-foreground ml-1 shrink-0" />}
            </button>
        </div>
    )
}

type BundlePreference = 'balanced' | 'data'

function calcMashupBundle(amount: number, pref: BundlePreference): { data: string; voice: string; exact: boolean } {
    const round1 = (n: number) => Math.round(n * 10) / 10
    if (amount <= 0) return { data: '0', voice: '0', exact: false }

    // ≥ GHS 10 — stable zone: fixed multipliers
    if (amount >= 10) {
        const BASE_DATA = 18     // MB per GHS
        const BASE_VOICE = 17.3  // mins per GHS
        let dataMult = BASE_DATA, voiceMult = BASE_VOICE
        if (pref === 'data')  { dataMult = BASE_DATA * 1.25; voiceMult = BASE_VOICE * 0.6 }
        return {
            data: round1(amount * dataMult).toFixed(1) + ' MB',
            voice: round1(amount * voiceMult).toFixed(1) + ' Mins',
            exact: true
        }
    }

    // < GHS 10 — variable zone: tier estimates
    let dataLow: number, dataHigh: number, voiceLow: number, voiceHigh: number
    if (amount <= 2)      { dataLow = 15;   dataHigh = 16;   voiceLow = 15;   voiceHigh = 16 }
    else if (amount <= 5) { dataLow = 15;   dataHigh = 17.5; voiceLow = 15;   voiceHigh = 17 }
    else                  { dataLow = 17;   dataHigh = 18;   voiceLow = 16.5; voiceHigh = 17.5 }

    // Preference skew for range display
    if (pref === 'data')  { dataHigh *= 1.2; voiceLow *= 0.7; voiceHigh *= 0.8 }

    return {
        data: `${round1(amount * dataLow).toFixed(0)}–${round1(amount * dataHigh).toFixed(0)} MB`,
        voice: `${round1(amount * voiceLow).toFixed(0)}–${round1(amount * voiceHigh).toFixed(0)} Mins`,
        exact: false
    }
}

export default function ShopStorefront({
    shop, packages, adminSettings, initialAnnouncement = null, rcTypes: rcTypesProp = [], rcMarkup: rcMarkupProp = 0, rcMarkups: rcMarkupsProp = {}, oosNetworks = [],
    utilitiesEnabled = false, enabledUtilityBillers = {}, utilityMinAmount = 1, utilityMaxAmount = 1000,
}: Props) {
    // RC pricing is SEEDED from the server-render snapshot, then re-pulled LIVE on the client
    // (mount + focus/visibility) so the browsed price always matches what the charge computes —
    // the snapshot alone goes stale when an admin/owner edits a price after the page rendered.
    const [rcTypes, setRcTypes] = useState(rcTypesProp)
    const [rcMarkups, setRcMarkups] = useState(rcMarkupsProp)
    const [rcMarkup, setRcMarkup] = useState(rcMarkupProp)

    // Per-exam markup wins; the legacy single markup is the fallback
    const markupFor = (typeId: string | undefined) =>
        (typeId && rcMarkups[typeId] !== undefined) ? rcMarkups[typeId] : rcMarkup

    const router = useRouter()
    const searchParams = useSearchParams()
    
    // Airtime State
    const [airtimePhone, setAirtimePhone] = useState('')
    const [airtimeEmail, setAirtimeEmail] = useState('')
    const [airtimeAmount, setAirtimeAmount] = useState('')
    const [detectedNetwork, setDetectedNetwork] = useState<'MTN' | 'Telecel' | 'AT' | null>(null)
    const [isManualSelection, setIsManualSelection] = useState(false)
    const [useExact, setUseExact] = useState(true)
    const airtimeRef = useRef<HTMLDivElement>(null)
    const heroRef = useRef<HTMLDivElement>(null)
    const productSectionRef = useRef<HTMLDivElement>(null)
    
    // Mashup State
    const [mashupPhone, setMashupPhone] = useState('')
    const [mashupEmail, setMashupEmail] = useState('')
    const [mashupAmount, setMashupAmount] = useState('')
    // Defaults to 'balanced' — matches the dashboard quick-buy and USSD mashup's default.
    const [mashupBundle, setMashupBundle] = useState<'balanced' | 'data' | null>('balanced')

    // Shared in-app MoMo charge sheet (airtime / mashup / results checker)
    const [chargeOpen, setChargeOpen] = useState(false)
    const [chargeDescriptor, setChargeDescriptor] = useState<ChargeDescriptor | null>(null)

    // Global State
    const [isSidebarOpen, setIsSidebarOpen] = useState(false)
    const [activeTab, setActiveTab] = useState<'data' | 'airtime' | 'mashup' | 'vouchers' | 'utilities' | 'afa'>('data')
    const [showAnnouncementModal, setShowAnnouncementModal] = useState(false)
    const [loading, setLoading] = useState(false)
    const [pageLoading, setPageLoading] = useState(false)
    const [errorMsg, setErrorMsg] = useState<string | null>(null)
    const [contactInfo, setContactInfo] = useState<{ phone?: string; whatsapp?: string; email?: string } | null>(null)
    const [announcement, setAnnouncement] = useState<{ id: string; type: 'admin' | 'shop'; message: string; title?: string; cta_primary_label?: string | null; cta_primary_url?: string | null; cta_secondary_label?: string | null; cta_secondary_url?: string | null } | null>(initialAnnouncement ?? null)
    // Dismissed state initialised from localStorage so guests only see each
    // unique announcement once. Resets automatically when admin posts/reposts.
    const [announcementDismissed, setAnnouncementDismissed] = useState(() => {
        if (!initialAnnouncement?.id || typeof window === 'undefined') return false
        return !!localStorage.getItem(`storefront_ann_${initialAnnouncement.id}`)
    })
    const [announcementCountdown, setAnnouncementCountdown] = useState(0)
    // Announcements must wait for the page-load terms gate: the boundary reports
    // when the agreement is out of the way (already accepted / not needed / accepted now).
    const [termsGateResolved, setTermsGateResolved] = useState(false)

    // ── Guest Push Notification ───────────────────────────────────────────────
    const [pushPermission, setPushPermission] = useState<'default' | 'granted' | 'denied' | 'unsupported'>('unsupported')
    const [isGuestSubscribed, setIsGuestSubscribed] = useState(false)
    const [showPushOptIn, setShowPushOptIn] = useState(false)
    const [isSubscribing, setIsSubscribing] = useState(false)

    const [scrolled, setScrolled] = useState(false)
    const [isStorefront, setIsStorefront] = useState(false)
    const [isPwaPromptVisible, setIsPwaPromptVisible] = useState(false)

    useEffect(() => {
        const handlePwaVisibility = (e: Event) => {
            const customEvent = e as CustomEvent
            setIsPwaPromptVisible(customEvent.detail?.isVisible || false)
        }
        window.addEventListener('pwa-prompt-visibility', handlePwaVisibility)
        return () => window.removeEventListener('pwa-prompt-visibility', handlePwaVisibility)
    }, [])

    // Bug-2: the displayed prices are a server-render snapshot held in props. When the
    // installed PWA / a backgrounded tab is restored from bfcache, the old DOM (old price)
    // is shown without a network round-trip while the checkout recomputes the price live
    // → "sees old, pays new". Re-pull the live RSC payload on restore so what the guest
    // sees matches what they'll be charged.
    useEffect(() => {
        const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) router.refresh() }
        const onVisible = () => { if (document.visibilityState === 'visible') router.refresh() }
        window.addEventListener('pageshow', onPageShow)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
            window.removeEventListener('pageshow', onPageShow)
            document.removeEventListener('visibilitychange', onVisible)
        }
    }, [router])

    // Bug fix: pull LIVE results-checker pricing on the client (mount + focus/visibility) so the
    // displayed base price + markups always match what /api/shop/results-checker/charge computes.
    // The server-rendered snapshot goes stale the moment a price changes while a tab is open or a
    // cached shell is shown; this uncached /api fetch (NetworkOnly in the SW) corrects it.
    useEffect(() => {
        let cancelled = false
        const loadRcPricing = async () => {
            try {
                const res = await fetch(`/api/shop/results-checker/pricing?shopSlug=${encodeURIComponent(shop.shop_slug)}`, { cache: 'no-store' })
                if (!res.ok) return
                const data = await res.json()
                if (cancelled || !data?.success) return
                if (Array.isArray(data.types)) setRcTypes(data.types)
                if (data.markups && typeof data.markups === 'object') setRcMarkups(data.markups)
                if (typeof data.legacyMarkup === 'number') setRcMarkup(data.legacyMarkup)
            } catch { /* keep the snapshot on network error */ }
        }
        loadRcPricing()
        const onVisible = () => { if (document.visibilityState === 'visible') loadRcPricing() }
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', loadRcPricing)
        return () => {
            cancelled = true
            document.removeEventListener('visibilitychange', onVisible)
            window.removeEventListener('focus', loadRcPricing)
        }
    }, [shop.shop_slug])

    // Auto-show announcement on load — only after the terms gate is resolved
    // (guest accepted / didn't need to) and only if the guest hasn't seen it yet.
    useEffect(() => {
        if (termsGateResolved && announcement && !announcementDismissed) {
            const timer = setTimeout(() => setShowAnnouncementModal(true), 100)
            return () => clearTimeout(timer)
        }
    }, [termsGateResolved, announcement, announcementDismissed])

    // 5-second countdown while announcement modal is open
    useEffect(() => {
        if (!showAnnouncementModal) { setAnnouncementCountdown(0); return }
        setAnnouncementCountdown(5)
    }, [showAnnouncementModal])
    useEffect(() => {
        if (announcementCountdown <= 0) return
        const t = setTimeout(() => setAnnouncementCountdown(c => c - 1), 1000)
        return () => clearTimeout(t)
    }, [announcementCountdown])

    // Detect push support and check if already subscribed to this shop
    useEffect(() => {
        if (typeof window === 'undefined') return
        const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
        if (!supported) return
        setPushPermission(Notification.permission as 'default' | 'granted' | 'denied')
        if (Notification.permission === 'granted' && localStorage.getItem(`guest_push_${shop.id}`)) {
            setIsGuestSubscribed(true)
        }
    }, [shop.id])

    const handleGuestSubscribe = async () => {
        if (isSubscribing) return
        setIsSubscribing(true)
        try {
            const result = await Notification.requestPermission()
            setPushPermission(result as 'default' | 'granted' | 'denied')
            if (result !== 'granted') {
                toast.error('Notifications blocked. Enable them in your browser settings.')
                setShowPushOptIn(false)
                return
            }

            const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
            if (!vapidKey) throw new Error('Push not configured')

            // serviceWorker.ready can hang if SW never activates — cap at 10s
            const registration = await Promise.race([
                navigator.serviceWorker.ready,
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SW timeout')), 10000)),
            ]) as ServiceWorkerRegistration

            const padding = '='.repeat((4 - (vapidKey.length % 4)) % 4)
            const base64 = (vapidKey + padding).replace(/-/g, '+').replace(/_/g, '/')
            const raw = window.atob(base64)
            const buf = new ArrayBuffer(raw.length)
            const arr = new Uint8Array(buf)
            for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)

            const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: arr })
            const subJson = sub.toJSON()

            const res = await fetch('/api/push/guest-subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shopId: shop.id,
                    endpoint: subJson.endpoint,
                    p256dh: subJson.keys?.p256dh,
                    auth: subJson.keys?.auth,
                }),
            })
            if (!res.ok) throw new Error('Server error saving subscription')

            localStorage.setItem(`guest_push_${shop.id}`, '1')
            setIsGuestSubscribed(true)
            setShowPushOptIn(false)
            toast.success("You're subscribed! We'll notify you of new announcements.")
        } catch (err: any) {
            console.error('[StorefrontPush] Subscribe error:', err)
            if (err?.message === 'SW timeout') {
                toast.error('Service worker not ready. Try refreshing the page.')
            } else {
                toast.error('Failed to enable notifications. Please try again.')
            }
        } finally {
            setIsSubscribing(false)
        }
    }

    const handleDismissAnnouncement = () => {
        if (announcementCountdown > 0) return
        setShowAnnouncementModal(false)
        setAnnouncementDismissed(true)
        if (announcement?.id) {
            localStorage.setItem(`storefront_ann_${announcement.id}`, '1')
        }
    }

    useEffect(() => {
        // Detect if we are on the subdomain storefront or the main domain
        const hostname = window.location.hostname
        // NOTE: a *.vercel.app preview is NOT a subdomain storefront — it serves the
        // storefront under /shop/<slug>, so links must keep the /shop prefix there.
        const isSub = hostname.startsWith('shop.') || (hostname !== 'kingflexygh.com' && hostname !== 'www.kingflexygh.com' && !hostname.includes('localhost') && !hostname.endsWith('.vercel.app'))
        setIsStorefront(isSub)
    }, [])

    // White-label toast notifications: show the shop's own name (not the platform brand)
    // on every error/success toast while a guest is on this storefront. Reset on unmount.
    useEffect(() => {
        toast.setBrand(shop.shop_name)
        return () => toast.setBrand(null)
    }, [shop.shop_name])

    // Derived base path for links
    const baseLinkPath = isStorefront ? '' : '/shop'
    const rcRetrieveHref = `${baseLinkPath}/${shop.shop_slug}/results-checker/retrieve`

    // Derived flags for Airtime
    const isGlobalAirtimeEnabled = adminSettings['storefront_airtime_enabled'] === 'true'
    
    const airtimeNetworks = [
        { id: 'MTN', fee: shop.airtime_fee_mtn || 0, enabled: adminSettings['airtime_enabled_mtn'] !== 'false' },
        { id: 'Telecel', fee: shop.airtime_fee_telecel || 0, enabled: adminSettings['airtime_enabled_telecel'] !== 'false' },
        { id: 'AT', fee: shop.airtime_fee_at || 0, enabled: adminSettings['airtime_enabled_at'] !== 'false' }
    ].filter(n => n.enabled)

    const isShopAirtimeEnabled = isGlobalAirtimeEnabled && airtimeNetworks.length > 0

    const isGlobalMashupEnabled = adminSettings['storefront_mashup_enabled'] === 'true'
    const isShopMashupEnabled = isGlobalMashupEnabled && adminSettings['airtime_enabled_mtn'] !== 'false'

    // Global RC enabled flag — no per-shop override possible
    const isRCEnabled = adminSettings['results_checker_storefront_enabled'] === 'true' && rcTypes.length > 0

    // AFA is offered when the platform toggle is on AND this shop has saved a selling
    // price greater than 0. Under the flat-amount model (Task 1) 0/null both mean
    // "not configured" — unlike the old percentage model, 0 is not a valid live value.
    const isShopAfaEnabled =
        String(adminSettings['storefront_afa_enabled']) === 'true' &&
        shop.afa_selling_price !== null && shop.afa_selling_price !== undefined &&
        parseFloat(String(shop.afa_selling_price)) > 0

    // Display-only price so the guest sees the total before paying. Mirrors
    // computeShopAfaCheckout exactly: the shop's saved flat selling price plus the
    // Paystack fee (per-shop override -> shop_global_settings role key -> legacy key
    // -> 1.95% default). computeShopAfaCheckout on the server remains the sole
    // authority on what is actually charged — if the two ever disagree the server wins.
    const afaDisplayPrice = (() => {
        if (!isShopAfaEnabled) return null
        const sellingPrice = Math.round(parseFloat(String(shop.afa_selling_price)) * 100) / 100
        if (sellingPrice <= 0) return null

        let paystackFeePercent = 1.95
        if (shop.paystack_fee_percent !== null && shop.paystack_fee_percent !== undefined) {
            paystackFeePercent = parseFloat(String(shop.paystack_fee_percent))
        } else if (adminSettings[`shop_paystack_fee_percent_${shop.ownerRole}`] != null) {
            paystackFeePercent = parseFloat(String(adminSettings[`shop_paystack_fee_percent_${shop.ownerRole}`]))
        } else if (adminSettings['shop_paystack_fee_percent'] != null) {
            paystackFeePercent = parseFloat(String(adminSettings['shop_paystack_fee_percent']))
        }
        const paystackFee = Math.round(sellingPrice * (paystackFeePercent / 100) * 100) / 100
        return Math.round((sellingPrice + paystackFee) * 100) / 100
    })()

    // RC state
    const [selectedRCTypeId, setSelectedRCTypeId] = useState(rcTypes[0]?.id || '')
    const [rcQuantity, setRCQuantity] = useState(1)
    const [rcPhone, setRCPhone] = useState('')
    const [rcEmail, setRCEmail] = useState('')
    const [rcBreakdown, setRCBreakdown] = useState<{unit_price:number;quantity:number;subtotal:number;paystack_fee:number;total:number} | null>(null)
    const [showRCSuccess, setShowRCSuccess] = useState(false)
    const [rcSuccessData, setRcSuccessData] = useState<{order: any, vouchers: any[]} | null>(null)

    // UI refinement states
    const [showRCConfirmModal, setShowRCConfirmModal] = useState(false)
    const [revealedRCPins, setRevealedRCPins] = useState<Set<string>>(new Set())

    const toggleRCPinReveal = (pin: string) => {
        const next = new Set(revealedRCPins)
        if (next.has(pin)) next.delete(pin)
        else next.add(pin)
        setRevealedRCPins(next)
    }

    useEffect(() => {
        try { sessionStorage.setItem('shop_sticky_slug', shop.shop_slug) } catch (_) { }
    }, [shop.shop_slug])

    // Sticky header scroll listener
    useEffect(() => {
        const handleScroll = () => {
            const heroHeight = heroRef.current?.offsetHeight || 200
            setScrolled(window.scrollY > heroHeight - 60)
        }
        window.addEventListener('scroll', handleScroll, { passive: true })
        return () => window.removeEventListener('scroll', handleScroll)
    }, [])

    // Reveal a paid voucher order on screen by reference (shared by the in-app charge
    // success path AND the legacy ?rc_ref= redirect callback). Looks the order up with the
    // delivery phone saved at purchase time; falls back to the retrieve page if we can't.
    const revealVouchersByRef = useCallback(async (rcRef: string) => {
        const hostname = window.location.hostname
        const isSubdomain = hostname.startsWith('shop.')
            || (hostname !== 'kingflexygh.com' && hostname !== 'www.kingflexygh.com' && !hostname.includes('localhost'))
        const retrieveHref = `${isSubdomain ? '' : '/shop'}/${shop.shop_slug}/results-checker/retrieve`
        setActiveTab('vouchers')
        try {
            const savedPhone = localStorage.getItem('shop_last_phone')
            if (!savedPhone) {
                router.replace(`${retrieveHref}?reference=${encodeURIComponent(rcRef)}`)
                return
            }
            setPageLoading(true)
            const res = await fetch('/api/results-checker/retrieve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reference: rcRef, phone: savedPhone })
            })
            const data = await res.json()
            if (res.ok && data.order) {
                setRcSuccessData(data)
                setShowRCSuccess(true)
            } else {
                router.replace(`${retrieveHref}?reference=${encodeURIComponent(rcRef)}`)
            }
        } catch (err) {
            toast.error('Network error checking order status')
        } finally {
            setPageLoading(false)
        }
    }, [router, shop.shop_slug])

    useEffect(() => {
        const error = searchParams.get('error')
        if (error) {
            const messages: Record<string, string> = {
                payment_failed: 'Payment was not completed. Please try again.',
                order_not_found: 'Order not found. Please try again.',
                server_error: 'Something went wrong. Please try again.',
                invalid_ref: 'Invalid payment reference.',
            }
            setErrorMsg(messages[error] || 'An error occurred. Please try again.')
        }

        const rcRef = searchParams.get('rc_ref')
        if (rcRef && /^RC-[A-Za-z0-9-]{1,90}$/.test(rcRef)) revealVouchersByRef(rcRef)
    }, [searchParams, revealVouchersByRef])

    // Clamp the RC quantity to on-hand stock when the selected exam type changes, mirroring
    // the server's pre-charge stock check (skip when the admin allows backorders) so the
    // displayed total can't be for more vouchers than exist.
    useEffect(() => {
        if (adminSettings['results_checker_allow_backorders'] === 'true') return
        const t = rcTypes.find(x => x.id === selectedRCTypeId)
        if (t && typeof t.available_count === 'number' && t.available_count > 0) {
            setRCQuantity(q => Math.min(q, t.available_count as number))
        }
    }, [selectedRCTypeId, rcTypes, adminSettings])

    // Auto-detect network for airtime
    useEffect(() => {
        const clean = airtimePhone.replace(/\s+/g, '')
        
        // Reset network selection and manual flag if phone is deleted or < 3 chars
        if (clean.length < 3) {
            setDetectedNetwork(null)
            setIsManualSelection(false)
            return
        }

        if (isManualSelection) return
        
        const prefix = clean.substring(0, 3)
        let detected: 'MTN' | 'Telecel' | 'AT' | null = null
        
        const prefixes = {
            MTN: ['024', '054', '055', '059', '025', '053', '098'],
            Telecel: ['020', '050'],
            AT: ['026', '027', '056', '028', '058', '057'] // Includes 057 and 028 from main site
        }

        for (const [net, prfxs] of Object.entries(prefixes)) {
            if (prfxs.includes(prefix)) {
                detected = net as 'MTN' | 'Telecel' | 'AT'
                break
            }
        }
        
        if (detected && airtimeNetworks.some(n => n.id === detected)) {
            setDetectedNetwork(detected)
        } else {
            setDetectedNetwork(null)
        }
    }, [airtimePhone, airtimeNetworks, isManualSelection])

    // Generate Network Soft Warning
    const airtimeNetworkWarning = useMemo(() => {
        const clean = airtimePhone.replace(/\s+/g, '')
        if (clean.length < 3) return null

        const prefix = clean.substring(0, 3)
        const prefixes = {
            MTN: ['024', '054', '055', '059', '025', '053', '098'],
            Telecel: ['020', '050'],
            AT: ['026', '027', '056', '028', '058', '057']
        }
        
        let actualNet = null
        for (const [net, prfxs] of Object.entries(prefixes)) {
            if (prfxs.includes(prefix)) {
                actualNet = net
                break
            }
        }

        if (!actualNet) return 'Unrecognized prefix — please confirm your network.'
        if (detectedNetwork && actualNet !== detectedNetwork) {
            return `This number looks like it belongs to ${actualNet}. Please verify before proceeding.`
        }
        return null
    }, [airtimePhone, detectedNetwork])

    const calculateAirtimeFees = () => {
        if (!detectedNetwork || !airtimeAmount) return { feeAmount: 0, totalPay: 0, airtimeToReceive: 0 }
        const numAmount = parseFloat(airtimeAmount)
        if (isNaN(numAmount) || numAmount <= 0) return { feeAmount: 0, totalPay: 0, airtimeToReceive: 0 }

        const shopFeeConfig = airtimeNetworks.find(n => n.id === detectedNetwork)
        const shopFeeMultiplier = shopFeeConfig ? shopFeeConfig.fee : 0
        const adminFeeMultiplier = parseFloat(adminSettings[`airtime_fee_${detectedNetwork.toLowerCase()}_${shop.ownerRole}`] || '0')
        
        const totalMultiplier = (adminFeeMultiplier + shopFeeMultiplier) / 100
        const round2 = (n: number) => Math.round(n * 100) / 100

        if (useExact) {
            const feeAmount = round2(numAmount * totalMultiplier)
            return { feeAmount, totalPay: round2(numAmount + feeAmount), airtimeToReceive: numAmount }
        } else {
            const feeAmount = round2(numAmount * totalMultiplier)
            return { feeAmount, totalPay: numAmount, airtimeToReceive: round2(numAmount - feeAmount) }
        }
    }

    const calculateMashupFees = () => {
        if (!mashupAmount) return { feeAmount: 0, totalPay: 0 }
        const numAmount = parseFloat(mashupAmount)
        if (isNaN(numAmount) || numAmount <= 0) return { feeAmount: 0, totalPay: 0 }

        const shopFeeMultiplier = shop.mashup_fee_percent || 1
        const adminFeeMultiplier = parseFloat(adminSettings[`airtime_fee_mtn_${shop.ownerRole}`] || '0')
        
        const totalMultiplier = (adminFeeMultiplier + shopFeeMultiplier) / 100
        const round2 = (n: number) => Math.round(n * 100) / 100

        const feeAmount = round2(numAmount * totalMultiplier)
        return { feeAmount, totalPay: round2(numAmount + feeAmount) }
    }

    const handleBuyAirtime = async () => {
        if (!detectedNetwork) { toast.error('Enter a valid registered network number'); return }
        if (!airtimeAmount) { toast.error('Enter airtime amount'); return }
        
        const numAmount = parseFloat(airtimeAmount)
        const minAmount = parseFloat(adminSettings['airtime_min_amount_customer'] || '1')
        const maxAmount = parseFloat(adminSettings['airtime_max_amount_customer'] || '500')

        if (numAmount < minAmount) { toast.error(`Minimum airtime purchase is GHS ${minAmount.toFixed(2)}`); return }
        if (numAmount > maxAmount) { toast.error(`Maximum airtime purchase is GHS ${maxAmount.toFixed(2)}`); return }

        const cleanPhone = airtimePhone.replace(/\s+/g, '')
        if (!/^(0\d{9}|233\d{9})$/.test(cleanPhone)) { toast.error('Enter a valid recipient phone number'); return }
        try { localStorage.setItem('shop_last_phone', cleanPhone) } catch (_) { }

        // Open the in-app MoMo charge sheet (no redirect). The recipient, amount and email
        // are already collected on the airtime tab, so the sheet only collects the MoMo wallet.
        const net = detectedNetwork
        const recipientEmail = airtimeEmail.trim()
        const { totalPay } = calculateAirtimeFees()
        setChargeDescriptor({
            title: `${net} · GHS ${numAmount.toFixed(2)} Airtime`,
            network: net,
            amountLabel: formatCurrency(totalPay),
            chargeUrl: '/api/shop/charge',
            statusUrl: '/api/shop/charge/status',
            beneficiary: null,
            email: null,
            successText: () => `GHS ${numAmount.toFixed(2)} airtime is being sent to ${cleanPhone}.`,
            buildBody: ({ momoPhone, provider }) => ({
                shopSlug: shop.shop_slug, orderType: 'airtime', network: net,
                amount: numAmount, useExactAmount: useExact,
                guestPhone: cleanPhone, guestEmail: recipientEmail || undefined,
                momoPhone, momoProvider: provider,
            }),
        })
        setChargeOpen(true)
    }

    const handleBuyMashup = async () => {
        if (!mashupAmount) { toast.error('Enter mashup amount'); return }
        if (!mashupBundle) { toast.error('Select bundle preference (Balanced or Data)'); return }

        const numAmount = parseFloat(mashupAmount)
        // Mashup has its own admin-configured limits, independent of plain airtime's —
        // never fall back to airtime's min/max for a mashup order.
        const minAmount = parseFloat(adminSettings['mashup_min_amount_customer'] || '5')
        const maxAmount = parseFloat(adminSettings['mashup_max_amount_customer'] || '500')

        if (numAmount < minAmount) { toast.error(`Minimum purchase is GHS ${minAmount.toFixed(2)}`); return }
        if (numAmount > maxAmount) { toast.error(`Maximum purchase is GHS ${maxAmount.toFixed(2)}`); return }

        const cleanPhone = mashupPhone.replace(/\s+/g, '')
        if (!/^(0\d{9}|233\d{9})$/.test(cleanPhone)) { toast.error('Enter a valid recipient phone number'); return }
        try { localStorage.setItem('shop_last_phone', cleanPhone) } catch (_) { }

        // Open the in-app MoMo charge sheet (no redirect). Recipient/amount/bundle/email are
        // already collected on the mashup tab, so the sheet only collects the MoMo wallet.
        const bundle = mashupBundle
        const recipientEmail = mashupEmail.trim()
        const { totalPay } = calculateMashupFees()
        setChargeDescriptor({
            title: `MTN · GHS ${numAmount.toFixed(2)} Mashup`,
            network: 'MTN',
            amountLabel: formatCurrency(totalPay),
            chargeUrl: '/api/shop/charge',
            statusUrl: '/api/shop/charge/status',
            beneficiary: null,
            // Guess the recipient also pays — pre-fills the MoMo field but stays editable there.
            initialMomoPhone: cleanPhone,
            email: null,
            successText: () => `Your MTN Mashup is being processed for ${cleanPhone}.`,
            buildBody: ({ momoPhone, provider }) => ({
                shopSlug: shop.shop_slug, orderType: 'mashup', network: 'MTN',
                amount: numAmount, useExactAmount: true, bundlePreference: bundle,
                guestPhone: cleanPhone, guestEmail: recipientEmail || undefined,
                momoPhone, momoProvider: provider,
            }),
        })
        setChargeOpen(true)
    }

    // AFA KYC form collects details first; this opens the shared in-app MoMo charge
    // sheet for payment (native charge via /api/shop/afa/charge — no redirect). The
    // sheet's own email field stays hidden (email is already collected on the KYC form).
    const handleAfaSubmit = (formData: Record<string, any>, guestEmail: string) => {
        const cleanPhone = String(formData.phone || '').replace(/\s+/g, '')
        setChargeDescriptor({
            title: 'AFA Registration',
            amountLabel: afaDisplayPrice != null ? formatCurrency(afaDisplayPrice) : '',
            chargeUrl: '/api/shop/afa/charge',
            statusUrl: '/api/shop/afa/charge/status',
            beneficiary: null,
            // Guess the registrant also pays — pre-fills the MoMo field but stays editable.
            initialMomoPhone: cleanPhone,
            email: null,
            successText: () => `Your AFA registration has been received and is being processed. We'll notify you once it's completed.`,
            buildBody: ({ momoPhone, provider }) => ({
                shopSlug: shop.shop_slug, guestPhone: cleanPhone, guestEmail: guestEmail || undefined,
                formData, momoPhone, momoProvider: provider,
            }),
        })
        setChargeOpen(true)
    }

    // Contrast utility
    const isLightColor = (hex: string) => {
        const r = parseInt(hex.slice(1, 3), 16)
        const g = parseInt(hex.slice(3, 5), 16)
        const b = parseInt(hex.slice(5, 7), 16)
        const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000
        return yiq >= 128
    }

    const brandColor = shop.brand_color || '#2563eb'
    const isValidHex = (color: string) => /^#([A-Fa-f0-9]{3}){1,4}$/.test(color)
    const safeBrandColor = isValidHex(brandColor) ? brandColor : '#2563eb'
    
    const brandContrastText = isLightColor(safeBrandColor) ? '#111827' : '#ffffff'
    const isBrandColorLight = isLightColor(safeBrandColor)
    const { feeAmount: airFee, totalPay: airTotal, airtimeToReceive } = calculateAirtimeFees()
    const { feeAmount: mashFee, totalPay: mashTotal } = calculateMashupFees()
    // Mashup's own admin-configured limits — shown to the guest and used to bound the input,
    // never airtime's (see handleBuyMashup for the matching validation).
    const mashupMinAmount = parseFloat(adminSettings['mashup_min_amount_customer'] || '5')
    const mashupMaxAmount = parseFloat(adminSettings['mashup_max_amount_customer'] || '500')

    const mashupBreakdown = useMemo(() => {
        if (!mashupAmount || !mashupBundle) return null
        const amt = parseFloat(mashupAmount)
        if (isNaN(amt) || amt <= 0) return null
        return calcMashupBundle(amt, mashupBundle.toLowerCase() as BundlePreference)
    }, [mashupAmount, mashupBundle])

    // ── Select product + scroll to section ───────────────────
    const selectProduct = (tab: 'data' | 'airtime' | 'mashup' | 'vouchers' | 'utilities' | 'afa') => {
        setActiveTab(tab)
        setIsSidebarOpen(false)
        setTimeout(() => {
            productSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 80)
    }

    if (pageLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[var(--brand-color)] theme-shop">
                <style dangerouslySetInnerHTML={{ __html: `.theme-shop { --brand-color: ${safeBrandColor}; }` }} />
                <div className="flex flex-col items-center gap-4">
                    {shop.logo_url ? (
                        <div className="relative w-16 h-16 rounded-2xl overflow-hidden bg-white/20">
                            <Image src={shop.logo_url} alt={shop.shop_name} fill className="object-contain" />
                        </div>
                    ) : (
                        <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center">
                            <ShoppingCart className="w-8 h-8 text-white" />
                        </div>
                    )}
                    <div className="flex gap-1.5">
                        {[0, 1, 2].map(i => (
                            <div key={i} className={cn("w-2 h-2 rounded-full bg-white animate-bounce", ['[animation-delay:0s]', '[animation-delay:0.15s]', '[animation-delay:0.3s]'][i])} />
                        ))}
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-950 theme-shop">
            <PWAInstallPrompt />
            {/* Page-load terms gate — blocks the storefront for a guest until they accept (like the main site).
                Announcements are held until it reports resolved, so terms always render first. */}
            <StorefrontTermsBoundary brandName={shop.shop_name} onGateResolved={() => setTermsGateResolved(true)} />
            {/* Shared in-app MoMo charge sheet for airtime / mashup / results checker */}
            <ServiceChargeSheet open={chargeOpen} onClose={() => setChargeOpen(false)} descriptor={chargeDescriptor} brandName={shop.shop_name} />
            <style dangerouslySetInnerHTML={{ __html: `
                .theme-shop { 
                    --brand-color: ${safeBrandColor}; 
                    --brand-contrast-text: ${brandContrastText};
                }
                @keyframes shake { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(15deg); } 75% { transform: rotate(-15deg); } }
                .animate-shake { animation: shake 0.5s infinite; transform-origin: top center; }
            ` }} />
            {/* ── Permanent Top Bar ── */}
            <div className="fixed top-0 left-0 w-full z-[45] shadow-lg border-b border-black/5 dark:border-white/5 bg-[var(--brand-color)]/95 backdrop-blur-md transition-all duration-300 ease-in-out">
                <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <button onClick={() => setIsSidebarOpen(true)} className="p-1 bg-[#FFCE00] hover:bg-[#E6B800] rounded-lg transition-colors flex-shrink-0 text-black border border-black/10 shadow-sm" aria-label="Open menu">
                            <Menu className="w-6 h-6 text-black" />
                        </button>
                        {shop.logo_url && (
                            <div className="relative w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 border border-black/5 shadow-sm bg-white/20">
                                <Image src={shop.logo_url} alt="Logo" fill sizes="32px" className="object-contain" />
                            </div>
                        )}
                        <h1 className="text-h2 font-black truncate text-[var(--brand-contrast-text)] transition-colors">
                            {shop.shop_name}
                        </h1>
                    </div>
                    <ThemeToggle brandName={shop.shop_name} />
                </div>
            </div>
            {/* Spacer to account for fixed top bar height */}
            <div className="h-[60px] flex-shrink-0" />

            {/* ── Floating Notification Bell ── */}
            {announcement && (
                <button
                    onClick={() => setShowAnnouncementModal(true)}
                    className="fixed top-[76px] right-4 z-[40] p-3 rounded-full bg-white dark:bg-gray-800 shadow-xl border border-gray-100 dark:border-gray-700 hover:scale-110 transition-transform group"
                    aria-label="Announcements"
                >
                    <Bell className={cn("w-6 h-6 text-amber-500", !announcementDismissed && "animate-shake")} />
                    {!announcementDismissed && <span className="absolute top-0 right-0 w-3 h-3 rounded-full bg-red-500 border-2 border-white dark:border-gray-800 animate-pulse" />}
                </button>
            )}

            {/* Header / Hero */}
            <div ref={heroRef} className="relative transition-colors duration-300 pt-6 pb-16 bg-[var(--brand-color)]">
                <div className="max-w-5xl mx-auto px-4 text-center">
                    <div className="flex flex-col items-center gap-3">
                        {/* Glassmorphic Container for Logo and Text */}
                        <div className="flex flex-col items-center gap-3 backdrop-blur-md bg-white/10 dark:bg-black/25 border border-white/20 dark:border-white/5 shadow-xl p-6 rounded-[2rem] w-full max-w-lg mx-auto">
                            {/* 1. Logo */}
                            {shop.logo_url ? (
                                <div className="relative w-24 h-24 rounded-3xl overflow-hidden bg-white/20 flex-shrink-0 shadow-lg border border-white/20">
                                    <Image src={shop.logo_url} alt={shop.shop_name} fill sizes="96px" priority className="object-contain" />
                                </div>
                            ) : (
                                <div className="w-24 h-24 rounded-3xl bg-white/20 flex items-center justify-center flex-shrink-0 border border-white/20">
                                    <ShoppingCart className="w-10 h-10 text-white" />
                                </div>
                            )}
                            {/* 2. Shop Name */}
                            <h1 className="text-h1 text-[var(--brand-contrast-text)] leading-tight title-center transition-colors font-black">
                                {shop.shop_name}
                            </h1>
                            {/* 3. Description */}
                            {shop.description && (
                                <p className="text-[var(--brand-contrast-text)]/90 text-sm leading-relaxed transition-colors font-medium">
                                    {shop.description}
                                </p>
                            )}
                        </div>
                    </div>
                </div>
                {/* 5. Divider SVG — always at absolute bottom */}
                <DividerSVG style={shop.divider_style} fillClass="fill-gray-50 dark:fill-gray-950" />
            </div>

            <div className="max-w-5xl mx-auto px-4 -mt-10 mb-4">
                <PromoCarousel
                    slides={buildStorefrontSlides({
                        packages,
                        oosNetworks,
                        airtimeEnabled: isShopAirtimeEnabled,
                        afaEnabled: isShopAfaEnabled,
                        rcEnabled: isRCEnabled,
                        utilitiesEnabled,
                        ownerRole: shop.ownerRole,
                        shopName: shop.shop_name,
                        whatsappNumber: shop.whatsapp_number,
                        ownerPhone: shop.owner_phone,
                        accentColor: safeBrandColor,
                        selectProduct,
                        announcement,
                        onOpenAnnouncement: () => setShowAnnouncementModal(true),
                    })}
                />
            </div>

            <div className="max-w-5xl mx-auto px-4 pb-40 -mt-2">

                {/* ── Trust Bar (Replacement for Hero Card) ── */}
                {isRCEnabled && activeTab === 'vouchers' && (
                    <div className="mb-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 px-6 py-3 bg-white dark:bg-slate-900 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm transition-colors">
                        <div className="flex items-center gap-2 text-[10px] font-bold text-gray-500 dark:text-slate-400 uppercase tracking-widest">
                            <Lock className="w-3.5 h-3.5 text-[#22C55E]" /> Secure
                        </div>
                        <div className="w-1 h-1 bg-gray-200 dark:bg-slate-800 rounded-full hidden sm:block" />
                        <div className="flex items-center gap-2 text-[10px] font-bold text-gray-500 dark:text-slate-400 uppercase tracking-widest">
                            <Zap className="w-3.5 h-3.5 text-[#F5B800]" /> Instant Delivery
                        </div>
                        <div className="w-1 h-1 bg-gray-200 dark:bg-slate-800 rounded-full hidden sm:block" />
                        <div className="flex items-center gap-2 text-[10px] font-bold text-gray-500 dark:text-slate-400 uppercase tracking-widest">
                            <ShieldCheck className="w-3.5 h-3.5 text-blue-500" /> Verified Access
                        </div>
                    </div>
                )}

                {/* ── Need Help? Contact Card (ABOVE service content) ── */}
                <div className="mb-6 rounded-2xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 shadow-sm px-4 py-4 space-y-3 transition-colors">
                    <p className="text-[11px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1.5 text-center">Need Help?</p>
                    <div className="flex flex-wrap justify-center gap-x-4 gap-y-2">
                        {shop.owner_phone && (
                            <a href={`tel:${shop.owner_phone}`} className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-700 dark:text-gray-200 hover:text-emerald-600 transition-colors">
                                <Phone className="w-4 h-4" /> {shop.owner_phone}
                            </a>
                        )}
                        {shop.owner_email && (
                            <a href={`mailto:${shop.owner_email}`} className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-700 dark:text-gray-200 hover:text-emerald-600 transition-colors">
                                <Mail className="w-4 h-4" /> Email Us
                            </a>
                        )}
                    </div>
                    {shop.community_link && (
                        <a href={shop.community_link} target="_blank" rel="noopener noreferrer" className="mt-2 flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90 active:scale-95 shadow-md bg-[var(--brand-color)]">
                            <Users className="w-4 h-4" /> Join Our Community
                        </a>
                    )}
                </div>

                {/* ── USSD Storefront Guide — only shown when shop has an active USSD code ── */}
                {shop.ussd_active && shop.ussd_code && (
                    <UssdStorefrontGuide
                        code={shop.ussd_code}
                        shortcode={process.env.NEXT_PUBLIC_USSD_SHORTCODE ?? '*713*9939#'}
                        shopName={shop.shop_name}
                    />
                )}

            {/* ── Product Selector (Card Grid) ── */}
                <div ref={productSectionRef}>
                    <h2 className="text-[11px] font-black text-gray-500 dark:text-gray-400 uppercase tracking-[0.3em] mb-3 text-center">Choose a Service</h2>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
                        {/* Data Packages */}
                        <button
                            onClick={() => selectProduct('data')}
                            className={cn(
                                'flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all duration-200 active:scale-95 hover:shadow-md',
                                activeTab === 'data'
                                    ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-500 shadow-md shadow-emerald-100 dark:shadow-emerald-900/30'
                                    : 'bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800'
                            )}
                        >
                            <div className={cn('p-2.5 rounded-xl', activeTab === 'data' ? 'bg-emerald-500' : 'bg-gray-100 dark:bg-gray-700')}>
                                <Zap className={cn('w-5 h-5', activeTab === 'data' ? 'text-white fill-white' : 'text-gray-500 dark:text-gray-400')} />
                            </div>
                            <span className={cn('text-xs font-black uppercase tracking-wider', activeTab === 'data' ? 'text-emerald-700 dark:text-emerald-400' : 'text-gray-500 dark:text-gray-400')}>Data</span>
                        </button>

                        {/* Airtime */}
                        {isShopAirtimeEnabled && (
                            <button
                                onClick={() => selectProduct('airtime')}
                                className={cn(
                                    'flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all duration-200 active:scale-95 hover:shadow-md',
                                    activeTab === 'airtime'
                                        ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-500 shadow-md shadow-blue-100 dark:shadow-blue-900/30'
                                        : 'bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800'
                                )}
                            >
                                <div className={cn('p-2.5 rounded-xl', activeTab === 'airtime' ? 'bg-blue-500' : 'bg-gray-100 dark:bg-gray-700')}>
                                    <Smartphone className={cn('w-5 h-5', activeTab === 'airtime' ? 'text-white' : 'text-gray-500 dark:text-gray-400')} />
                                </div>
                                <span className={cn('text-xs font-black uppercase tracking-wider', activeTab === 'airtime' ? 'text-blue-700 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400')}>Airtime</span>
                            </button>
                        )}

                        {/* MTN Mashup */}
                        {isShopMashupEnabled && (
                            <button
                                onClick={() => selectProduct('mashup')}
                                className={cn(
                                    'flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all duration-200 active:scale-95 hover:shadow-md',
                                    activeTab === 'mashup'
                                        ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-400 shadow-md shadow-amber-100 dark:shadow-amber-900/30'
                                        : 'bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800'
                                )}
                            >
                                <div className={cn('p-2.5 rounded-xl', activeTab === 'mashup' ? 'bg-[#FFCE00]' : 'bg-gray-100 dark:bg-gray-700')}>
                                    <Zap className={cn('w-5 h-5', activeTab === 'mashup' ? 'text-gray-900 fill-gray-900' : 'text-gray-500 dark:text-gray-400')} />
                                </div>
                                <span className={cn('text-xs font-black uppercase tracking-wider', activeTab === 'mashup' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400')}>Mashup</span>
                            </button>
                        )}

                        {/* Credentials / RC */}
                        {isRCEnabled && (
                            <button
                                onClick={() => selectProduct('vouchers')}
                                className={cn(
                                    'flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all duration-200 active:scale-95 hover:shadow-md',
                                    activeTab === 'vouchers'
                                        ? 'bg-[#0B1F3A]/5 dark:bg-[#F5B800]/10 border-[#0B1F3A] dark:border-[#F5B800] shadow-md'
                                        : 'bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800'
                                )}
                            >
                                <div className={cn('p-2.5 rounded-xl', activeTab === 'vouchers' ? 'bg-[#0B1F3A] dark:bg-[#F5B800]' : 'bg-gray-100 dark:bg-gray-700')}>
                                    <GraduationCap className={cn('w-5 h-5', activeTab === 'vouchers' ? 'text-white dark:text-gray-900' : 'text-gray-500 dark:text-gray-400')} />
                                </div>
                                <span className={cn('text-xs font-black uppercase tracking-wider', activeTab === 'vouchers' ? 'text-[#0B1F3A] dark:text-[#F5B800]' : 'text-gray-500 dark:text-gray-400')}>Results Checker</span>
                            </button>
                        )}

                        {/* Utility Bills */}
                        {utilitiesEnabled && (
                            <button
                                onClick={() => selectProduct('utilities')}
                                className={cn(
                                    'flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all duration-200 active:scale-95 hover:shadow-md',
                                    activeTab === 'utilities'
                                        ? 'bg-slate-100 dark:bg-slate-800/60 border-slate-500 shadow-md shadow-slate-200 dark:shadow-slate-900/30'
                                        : 'bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800'
                                )}
                            >
                                <div className={cn('p-2.5 rounded-xl', activeTab === 'utilities' ? 'bg-slate-700' : 'bg-gray-100 dark:bg-gray-700')}>
                                    <Receipt className={cn('w-5 h-5', activeTab === 'utilities' ? 'text-white' : 'text-gray-500 dark:text-gray-400')} />
                                </div>
                                <span className={cn('text-xs font-black uppercase tracking-wider', activeTab === 'utilities' ? 'text-slate-700 dark:text-slate-300' : 'text-gray-500 dark:text-gray-400')}>Utility Bills</span>
                            </button>
                        )}

                        {/* AFA Registration */}
                        {isShopAfaEnabled && (
                            <button
                                onClick={() => selectProduct('afa')}
                                className={cn(
                                    'flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all duration-200 active:scale-95 hover:shadow-md',
                                    activeTab === 'afa'
                                        ? 'bg-amber-100 dark:bg-amber-900/30 border-amber-500 shadow-md shadow-amber-200 dark:shadow-amber-900/30'
                                        : 'bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800'
                                )}
                            >
                                <div className={cn('p-2.5 rounded-xl', activeTab === 'afa' ? 'bg-amber-600' : 'bg-gray-100 dark:bg-gray-700')}>
                                    <IdCard className={cn('w-5 h-5', activeTab === 'afa' ? 'text-white' : 'text-gray-500 dark:text-gray-400')} />
                                </div>
                                <span className={cn('text-xs font-black uppercase tracking-wider text-center leading-tight', activeTab === 'afa' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400')}>AFA Registration</span>
                            </button>
                        )}
                    </div>
                </div>

                {/* Error banner */}
                {errorMsg && (
                    <div className="mb-4 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 space-y-3">
                        <div className="flex items-start gap-2">
                            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                            <div className="flex-1">
                                <p className="text-sm font-bold text-red-800 dark:text-red-300">{errorMsg}</p>
                                {contactInfo ? (
                                    <p className="text-xs text-red-700 dark:text-red-400 mt-1">This shop is temporarily offline. Please contact the owner directly to complete your purchase:</p>
                                ) : (
                                    <p className="text-xs text-red-700 dark:text-red-400 mt-1">Please try again or contact support if the issue persists.</p>
                                )}
                            </div>
                            <button 
                                onClick={() => { setErrorMsg(null); setContactInfo(null); }} 
                                title="Dismiss error"
                                aria-label="Dismiss error"
                                className="p-1 hover:bg-red-100 dark:hover:bg-red-800/40 rounded-full transition-colors"
                            >
                                <X className="w-4 h-4 text-red-400" />
                            </button>
                        </div>

                        {contactInfo && (
                            <div className="flex flex-wrap gap-2 pt-1">
                                {contactInfo.phone && <a href={`tel:${contactInfo.phone}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-red-100 text-xs font-bold shadow-sm"><Phone className="w-3.5 h-3.5" /> Call {contactInfo.phone}</a>}
                                {contactInfo.whatsapp && <a href={`https://wa.me/${contactInfo.whatsapp}`} target="_blank" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#25D366] text-xs font-bold text-white shadow-sm"><MessageCircle className="w-3.5 h-3.5" /> WhatsApp</a>}
                            </div>
                        )}
                    </div>
                )}

                {/* ── Airtime Tab Content ── */}
                {isShopAirtimeEnabled && activeTab === 'airtime' && (
                    <div ref={airtimeRef} className="mb-6 bg-white dark:bg-slate-900 rounded-[2rem] border border-gray-200 dark:border-slate-800 shadow-sm overflow-hidden p-5 animate-in fade-in slide-in-from-bottom-2 duration-300 transition-colors">
                        <div className="flex items-center gap-3 mb-5 border-b border-gray-100 dark:border-gray-800 pb-5">
                            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white bg-indigo-600 shadow-sm">
                                <Smartphone className="w-6 h-6" />
                            </div>
                            <div className="text-left">
                                <h2 className="text-h2 uppercase">Buy Direct Airtime</h2>
                                <p className="text-label text-gray-500 uppercase mt-1">Instant Credit to Any Network</p>
                            </div>
                        </div>

                        <div className="space-y-5">
                                    {/* Network Selection Grid */}
                                    <div>
                                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3 ml-1">Select Network</p>
                                        <div className="grid grid-cols-3 gap-2">
                                            {['MTN', 'Telecel', 'AT'].map(netId => {
                                                const netConfig = airtimeNetworks.find(n => n.id === netId)
                                                const isEnabled = !!netConfig
                                                const isSelected = detectedNetwork === netId
                                                const colors = networkColors[netId]
                                                
                                                return (
                                                    <button
                                                        key={netId}
                                                        disabled={!isEnabled}
                                                        onClick={() => { setDetectedNetwork(netId as any); setIsManualSelection(true) }}
                                                        className={cn(
                                                            "relative flex flex-col items-center gap-2 p-3 rounded-2xl border-2 transition-all duration-300",
                                                            isSelected 
                                                                ? `bg-gradient-to-br ${colors.gradient} border-transparent shadow-lg scale-[1.03]` 
                                                                : "bg-gray-50 dark:bg-gray-800 border-gray-100 dark:border-gray-700 hover:border-gray-200",
                                                            !isEnabled && "opacity-40 grayscale cursor-not-allowed"
                                                        )}
                                                    >
                                                        <NetworkIcon network={netId} size={32} />
                                                        <span className={cn("text-[10px] font-black uppercase tracking-tight", isSelected ? "text-white" : "text-gray-500")}>
                                                            {netId}
                                                        </span>
                                                        {!isEnabled && <span className="absolute top-1 right-1 px-1 py-0.5 bg-gray-200 dark:bg-gray-700 text-[10px] font-black rounded-md">OFF</span>}
                                                    </button>
                                                )
                                            })}
                                        </div>
                                    </div>

                                    <div className="space-y-4">
                                        <div className="relative">
                                            <Phone className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                            <input
                                                type="tel" value={airtimePhone} onChange={(e) => setAirtimePhone(e.target.value)}
                                                placeholder="Receiver Phone (e.g. 024XXXXXXX)"
                                                className="w-full pl-12 pr-12 py-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-base font-bold transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                            />
                                            {detectedNetwork && (
                                                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                                    <div 
                                                        className={cn("px-2 py-1 tracking-widest text-[10px] uppercase font-black rounded-lg shadow-sm", networkColors[detectedNetwork].bgClass, networkColors[detectedNetwork].textClass)}
                                                    >
                                                        {detectedNetwork}
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        {airtimeNetworkWarning && (
                                            <div className="flex gap-2 items-start bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 p-3 rounded-lg border border-amber-200 dark:border-amber-800">
                                                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                                                <p className="text-xs font-medium leading-relaxed">{airtimeNetworkWarning}</p>
                                            </div>
                                        )}

                                    <div className="space-y-3">
                                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Recharge Amount</p>
                                        
                                        {/* Quick Amount Chips */}
                                        <div className="flex gap-2 flex-wrap mb-1">
                                            {QUICK_AMOUNTS.map(q => (
                                                <button
                                                    key={q}
                                                    onClick={() => setAirtimeAmount(String(q))}
                                                    className={cn(
                                                        "px-4 py-2 rounded-xl text-xs font-black border-2 transition-all",
                                                        airtimeAmount === String(q)
                                                            ? "bg-gray-900 dark:bg-white text-white dark:text-gray-900 border-gray-900 dark:border-white shadow-md scale-105"
                                                            : "bg-gray-50 dark:bg-gray-800 text-gray-500 border-gray-100 dark:border-gray-700 hover:border-gray-300"
                                                    )}
                                                >
                                                    {q}
                                                </button>
                                            ))}
                                        </div>

                                        <div className="relative">
                                            <span className="absolute left-5 top-1/2 -translate-y-1/2 font-black text-gray-400 text-sm">GHS</span>
                                            <input
                                                type="number" min="1" step="0.5" value={airtimeAmount} onChange={(e) => setAirtimeAmount(e.target.value)}
                                                placeholder={`Custom Amount`}
                                                className="w-full pl-14 pr-4 py-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-lg font-black transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                            />
                                        </div>
                                    </div>

                                    <div className="relative">
                                        <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                        <input
                                            type="email" value={airtimeEmail} onChange={(e) => setAirtimeEmail(e.target.value)}
                                            placeholder="Email for receipt (Optional)"
                                            className="w-full pl-12 pr-4 py-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm font-bold transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                        />
                                    </div>

                                    {/* Pay Separately Toggle */}
                                    <div 
                                        onClick={() => setUseExact(!useExact)}
                                        className={cn(
                                            "flex items-start gap-3 p-4 rounded-2xl border transition-all cursor-pointer group",
                                            useExact 
                                                ? "bg-emerald-50 dark:bg-emerald-900/10 border-emerald-400 shadow-sm" 
                                                : "bg-gray-50 dark:bg-gray-800/40 border-gray-100 dark:border-gray-700 hover:border-gray-200"
                                        )}
                                    >
                                        <div className={cn(
                                            "mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all",
                                            useExact ? "bg-emerald-500 border-emerald-500 text-white" : "border-gray-300 dark:border-gray-600 group-hover:border-gray-400"
                                        )}>
                                            {useExact && <Check className="w-3.5 h-3.5 stroke-[3px]" />}
                                        </div>
                                        <div className="flex-1">
                                            <p className={cn("text-xs font-black uppercase tracking-tight mb-0.5", useExact ? "text-emerald-700 dark:text-emerald-400" : "text-gray-700 dark:text-gray-300")}>
                                                Pay processing fee separately
                                            </p>
                                            <p className="text-[10px] font-bold text-gray-500 leading-tight">
                                                {useExact ? "You'll pay a bit more, but recipient gets exactly the amount typed." : "Standard: Fee is deducted from the amount you recharge."}
                                            </p>
                                        </div>
                                    </div>

                                    {detectedNetwork && airtimeAmount !== '' && parseFloat(airtimeAmount) > 0 && (
                                        <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-2xl p-5 border border-indigo-100 dark:border-indigo-800 shadow-inner">
                                            <div className="space-y-3">
                                                <div className="flex justify-between items-center text-xs font-bold text-gray-500 uppercase tracking-widest">
                                                    <span>Recharge Value</span>
                                                    <span className="text-gray-900 dark:text-gray-200 font-black">{formatCurrency(parseFloat(airtimeAmount))}</span>
                                                </div>
                                                
                                                <div className="flex justify-between items-center text-xs font-bold">
                                                    <span className="text-gray-500 uppercase tracking-widest flex items-center gap-1">Processing Fee ({(((airFee) / (useExact ? parseFloat(airtimeAmount) : parseFloat(airtimeAmount) - airFee)) * 100).toFixed(0)}%)</span>
                                                    <span className="text-gray-600 dark:text-gray-400">{useExact ? '+' : '–'} {formatCurrency(airFee)}</span>
                                                </div>

                                                <div className="flex justify-between items-center py-2 px-3 rounded-xl bg-indigo-100/50 dark:bg-indigo-950/50 border border-indigo-200/50 dark:border-indigo-900/50">
                                                    <span className="text-[10px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-tighter flex items-center gap-1.5">
                                                        <Info className="w-3.5 h-3.5" /> Recipient Gets
                                                    </span>
                                                    <span className="text-sm font-black text-indigo-700 dark:text-indigo-300">{formatCurrency(airtimeToReceive)}</span>
                                                </div>

                                                <div className="pt-2 border-t border-indigo-200/30">
                                                    <div className="flex justify-between items-center">
                                                        <span className="text-sm font-black text-indigo-900 dark:text-indigo-100 uppercase tracking-tighter">You Pay Total</span>
                                                        <span className="text-2xl font-black text-indigo-600 dark:text-indigo-400">{formatCurrency(airTotal)}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    <button
                                        onClick={handleBuyAirtime} disabled={loading || !detectedNetwork || parseFloat(airtimeAmount || '0') <= 0}
                                        className="w-full py-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-black text-base uppercase tracking-widest shadow-lg flex justify-center items-center gap-3 transition-transform active:scale-95 disabled:opacity-50 disabled:active:scale-100"
                                    >
                                        {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Processing...</> : <><Smartphone className="w-5 h-5"/> Recharge Airtime</>}
                                    </button>
                                </div>
                            </div>
                        </div>
                )}

                {/* ── Mashup Tab Content ── */}
                {isShopMashupEnabled && activeTab === 'mashup' && (
                    <div className="mb-6 bg-white dark:bg-slate-900 rounded-[2rem] border border-gray-200 dark:border-slate-800 shadow-sm overflow-hidden p-5 animate-in fade-in slide-in-from-bottom-2 duration-300 transition-colors">
                        <div className="flex items-center gap-3 mb-5 border-b border-gray-100 dark:border-gray-800 pb-5">
                            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-gray-900 bg-[#FFCE00] shadow-sm">
                                <Zap className="w-6 h-6" />
                            </div>
                            <div className="text-left">
                                <h2 className="text-h2 uppercase">MTN Mashup</h2>
                                <p className="text-label text-gray-500 uppercase mt-1">Instant Mashup to any MTN</p>
                            </div>
                        </div>

                        <div className="space-y-5">
                            <div className="space-y-4">
                                <div className="relative">
                                    <Phone className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                    <input
                                        type="tel" value={mashupPhone} onChange={(e) => setMashupPhone(e.target.value)}
                                        placeholder="MTN Number (e.g. 024XXXXXXX)"
                                        className="w-full pl-12 pr-4 py-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-base font-bold transition-all focus:outline-none focus:ring-2 focus:ring-yellow-500"
                                    />
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <button onClick={() => setMashupBundle('data')} className={cn("py-3 rounded-xl border-2 font-bold transition-all flex items-center justify-center gap-2", mashupBundle === 'data' ? "border-[#FFCE00] bg-yellow-50 dark:bg-yellow-900/20 text-gray-900 dark:text-yellow-600" : "border-gray-100 dark:border-gray-800 text-gray-500")}>
                                        <Zap className="w-4 h-4" /> Data Preferred
                                    </button>
                                    <button onClick={() => setMashupBundle('balanced')} className={cn("py-3 rounded-xl border-2 font-bold transition-all flex items-center justify-center gap-2", mashupBundle === 'balanced' ? "border-[#FFCE00] bg-yellow-50 dark:bg-yellow-900/20 text-gray-900 dark:text-yellow-600" : "border-gray-100 dark:border-gray-800 text-gray-500")}>
                                        <RefreshCw className="w-4 h-4" /> Balanced Preferred
                                    </button>
                                </div>

                                <div>
                                    <div className="relative">
                                        <span className="absolute left-4 top-1/2 -translate-y-1/2 font-black text-gray-400">GHS</span>
                                        <input
                                            type="number" step="0.01" min={mashupMinAmount} max={mashupMaxAmount}
                                            value={mashupAmount} onChange={(e) => setMashupAmount(e.target.value)}
                                            placeholder="Amount"
                                            className="w-full pl-14 pr-4 py-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-base font-bold transition-all focus:outline-none focus:ring-2 focus:ring-yellow-500"
                                        />
                                    </div>
                                    <p className="mt-2 text-xs font-semibold text-gray-500 dark:text-gray-400">
                                        Acceptable amount: GHS {mashupMinAmount.toFixed(2)} – GHS {mashupMaxAmount.toFixed(2)}
                                    </p>
                                    <div className="flex gap-2 mt-3 overflow-x-auto pb-1 scrollbar-hide">
                                        {QUICK_AMOUNTS.filter(a => a <= 50).map(amt => (
                                            <button
                                                key={amt} onClick={() => setMashupAmount(amt.toString())}
                                                className="px-4 py-2 flex-shrink-0 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-bold text-gray-700 dark:text-gray-300 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 hover:border-yellow-200 transition-colors"
                                            >
                                                GHS {amt}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="relative">
                                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                    <input
                                        type="email" value={mashupEmail} onChange={(e) => setMashupEmail(e.target.value)}
                                        placeholder="Email for receipt (Optional)"
                                        className="w-full pl-12 pr-4 py-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm font-bold transition-all focus:outline-none focus:ring-2 focus:ring-yellow-500"
                                    />
                                </div>

                                {mashupAmount !== '' && parseFloat(mashupAmount) > 0 && (
                                    <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-2xl p-5 border border-yellow-100 dark:border-yellow-800/50 shadow-inner">
                                        <div className="space-y-3">
                                            {mashupBreakdown && (
                                                <div className="flex gap-2 p-3 bg-white/60 dark:bg-black/20 rounded-xl border border-yellow-200/50 dark:border-yellow-700/30 mb-2">
                                                    <div className="flex-1 text-center border-r border-yellow-200/50 dark:border-yellow-700/50">
                                                        <p className="text-[10px] font-bold text-yellow-600/70 dark:text-yellow-500/70 uppercase tracking-widest mb-1 flex items-center justify-center gap-1">
                                                            <Zap className="w-3 h-3" /> Data
                                                        </p>
                                                        <p className="text-sm font-black text-blue-700 dark:text-blue-400">{mashupBreakdown.data}</p>
                                                        {!mashupBreakdown.exact && <p className="text-xs text-blue-500 mt-0.5">Estimated Range</p>}
                                                    </div>
                                                    <div className="flex-1 text-center">
                                                        <p className="text-[10px] font-bold text-yellow-600/70 dark:text-yellow-500/70 uppercase tracking-widest mb-1 flex items-center justify-center gap-1">
                                                            <Phone className="w-3 h-3" /> Voice
                                                        </p>
                                                        <p className="text-sm font-black text-purple-700 dark:text-purple-400">{mashupBreakdown.voice}</p>
                                                        {!mashupBreakdown.exact && <p className="text-xs text-purple-500 mt-0.5">Estimated Range</p>}
                                                    </div>
                                                </div>
                                            )}
                                            
                                            <div className="flex justify-between items-center text-xs font-bold text-gray-500 uppercase tracking-widest">
                                                <span>Mashup Value</span>
                                                <span className="text-gray-900 dark:text-gray-200 font-black">{formatCurrency(parseFloat(mashupAmount))}</span>
                                            </div>
                                            
                                            <div className="flex justify-between items-center text-xs font-bold">
                                                <span className="text-gray-500 uppercase tracking-widest flex items-center gap-1">Processing Fee ({(((mashFee) / parseFloat(mashupAmount)) * 100).toFixed(0)}%)</span>
                                                <span className="text-gray-600 dark:text-gray-400">+ {formatCurrency(mashFee)}</span>
                                            </div>

                                            <div className="pt-2 border-t border-yellow-200/50">
                                                <div className="flex justify-between items-center">
                                                    <span className="text-sm font-black text-yellow-900 dark:text-yellow-100 uppercase tracking-tighter">You Pay Total</span>
                                                    <span className="text-2xl font-black text-yellow-600 dark:text-yellow-400">{formatCurrency(mashTotal)}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <button
                                    onClick={handleBuyMashup}
                                    disabled={
                                        loading || !mashupBundle ||
                                        !mashupAmount ||
                                        parseFloat(mashupAmount) < mashupMinAmount ||
                                        parseFloat(mashupAmount) > mashupMaxAmount
                                    }
                                    className="w-full py-4 rounded-xl bg-[#FFCE00] hover:bg-yellow-500 text-gray-900 font-black text-base uppercase tracking-widest shadow-lg flex justify-center items-center gap-3 transition-transform active:scale-95 disabled:opacity-50 disabled:active:scale-100"
                                >
                                    {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Processing...</> : <><Zap className="w-5 h-5"/> Buy Mashup</>}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ── Results Checker / Vouchers Tab Content ── */}
                {isRCEnabled && activeTab === 'vouchers' && (() => {
                    const selectedRCType = rcTypes.find(t => t.id === selectedRCTypeId)
                    let basePrice = selectedRCType ? selectedRCType.customer_price : 0
                    if (selectedRCType && Array.isArray(selectedRCType.bulk_pricing) && selectedRCType.bulk_pricing.length > 0) {
                        const tier = selectedRCType.bulk_pricing.find(t => rcQuantity >= t.min_qty && rcQuantity <= t.max_qty)
                        if (tier) basePrice = tier.unit_price
                    }
                    const unitPrice = selectedRCType ? basePrice + markupFor(selectedRCType.id) : 0
                    const adminMaxQty = parseInt(adminSettings['results_checker_max_quantity'] || '50', 10)
                    const allowBackorders = adminSettings['results_checker_allow_backorders'] === 'true'
                    const stockAvail = selectedRCType?.available_count
                    // Cap selectable quantity at on-hand stock so a guest can't pick more than exists
                    // and get declined AFTER paying — unless the admin allows backorders.
                    const maxQty = (!allowBackorders && typeof stockAvail === 'number' && stockAvail > 0)
                        ? Math.min(adminMaxQty, stockAvail)
                        : adminMaxQty
                    const feePercent = parseFloat(adminSettings['results_checker_paystack_fee_percent'] || '1.95')
                    const subtotal = parseFloat((unitPrice * rcQuantity).toFixed(2))
                    const paystackFee = parseFloat((subtotal * (feePercent / 100)).toFixed(2))
                    const total = parseFloat((subtotal + paystackFee).toFixed(2))

                    const handleBuyVouchers = async () => {
                        if (!selectedRCTypeId) { toast.error('Select a voucher type'); return }
                        const cleanPhone = rcPhone.replace(/\s+/g, '')
                        if (!/^(0\d{9}|233\d{9})$/.test(cleanPhone)) { toast.error('Enter a valid phone number'); return }
                        // Email is OPTIONAL — the voucher shows on screen and is texted. Only reject a
                        // non-empty value that is malformed.
                        const emailTrim = rcEmail.trim()
                        if (emailTrim && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
                            toast.error('Enter a valid email or leave it blank — your voucher is shown on screen and texted.')
                            return
                        }
                        // Stock guard (mirrors the server's pre-charge check): block out-of-stock and
                        // over-ordering before charging, unless the admin allows backorders. Catches a
                        // stale quantity left over from a previously-selected, better-stocked type.
                        if (!allowBackorders && typeof stockAvail === 'number') {
                            if (stockAvail <= 0) { toast.error('This voucher is currently out of stock. Please check back soon.'); return }
                            if (rcQuantity > stockAvail) {
                                setRCQuantity(stockAvail)
                                toast.error(`Only ${stockAvail} in stock — quantity set to ${stockAvail}. Review the total and tap buy again.`)
                                return
                            }
                        }
                        setShowRCConfirmModal(false)
                        try { localStorage.setItem('shop_last_phone', cleanPhone) } catch (_) { }

                        // Open the in-app MoMo charge sheet (no redirect). Exam type, quantity,
                        // delivery phone and email are already collected on the vouchers tab, so the
                        // sheet only collects the MoMo wallet. On success, reveal the PINs on screen.
                        const recipientEmail = rcEmail.trim()
                        const qty = rcQuantity
                        const typeName = selectedRCType?.name || 'Voucher'

                        // Server-authoritative total: the browser can't reproduce the cost-price
                        // floor / per-role markup cap, so ask the server for the exact amount it
                        // will charge and display THAT. Falls back to the local estimate on error.
                        let authoritativeTotal = total
                        try {
                            const bRes = await fetch('/api/shop/results-checker/breakdown', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ shopSlug: shop.shop_slug, typeId: selectedRCTypeId, quantity: qty }),
                            })
                            const bData = await bRes.json().catch(() => null)
                            if (bRes.ok && bData && typeof bData.total === 'number') authoritativeTotal = bData.total
                        } catch { /* keep local estimate */ }

                        setChargeDescriptor({
                            title: `${qty}× ${typeName}`,
                            amountLabel: formatCurrency(authoritativeTotal),
                            chargeUrl: '/api/shop/results-checker/charge',
                            statusUrl: '/api/shop/results-checker/charge/status',
                            beneficiary: null,
                            email: null,
                            successText: () => `Your voucher${qty > 1 ? 's are' : ' is'} ready — opening your PIN${qty > 1 ? 's' : ''}…`,
                            receivedText: () => `Payment received. Your PIN${qty > 1 ? 's are' : ' is'} being prepared and will be texted to ${cleanPhone}. You can also retrieve ${qty > 1 ? 'them' : 'it'} later using your reference.`,
                            buildBody: ({ momoPhone, provider }) => ({
                                shopSlug: shop.shop_slug, typeId: selectedRCTypeId, quantity: qty,
                                guestPhone: cleanPhone, guestEmail: recipientEmail || undefined,
                                momoPhone, momoProvider: provider,
                            }),
                            onPaid: (reference) => { setChargeOpen(false); revealVouchersByRef(reference) },
                        })
                        setChargeOpen(true)
                    }

                    return (
                        <div className="mb-6 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">

                            {/* Section Header */}
                            <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm p-4">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[#0B1F3A] dark:bg-[#F5B800] shadow-sm flex-shrink-0">
                                        <GraduationCap className="w-5 h-5 text-white dark:text-[#0B1F3A]" />
                                    </div>
                                    <div>
                                        <h2 className="text-h2 uppercase">Results Checker</h2>
                                        <p className="text-label text-gray-500 uppercase mt-1">Official WAEC exam credentials · Instant delivery</p>
                                    </div>
                                </div>
                            </div>

                            {/* Already bought banner */}
                            <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3.5 text-sm text-emerald-900 shadow-sm dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-100">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="space-y-0.5">
                                        <p className="text-sm font-semibold">Bought a voucher already?</p>
                                        <p className="text-xs leading-relaxed text-emerald-700 dark:text-emerald-200">
                                            Use the secure retrieval page to review, reveal, and download your completed Results Checker vouchers again.
                                        </p>
                                    </div>
                                    <Link
                                        href={rcRetrieveHref}
                                        className="inline-flex h-9 shrink-0 items-center rounded-xl bg-emerald-900 px-3 text-xs font-semibold text-white transition-colors hover:bg-emerald-800 dark:bg-emerald-200 dark:text-emerald-950 dark:hover:bg-emerald-100"
                                    >
                                        Retrieve
                                    </Link>
                                </div>
                            </div>

                            {/* Exam Type */}
                            <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-100 dark:border-gray-900 shadow-sm p-4 sm:p-5">
                                <span className="block text-sm font-semibold text-gray-900 dark:text-white mb-3">Select Examination Type</span>
                                <div className="flex flex-col gap-2">
                                    {rcTypes.map(t => {
                                        const isSelected = selectedRCTypeId === t.id
                                        const hasBulk = Array.isArray(t.bulk_pricing) && t.bulk_pricing.length > 0
                                        const waecUrl = t.name.includes('BECE') ? 'eresults.waecgh.org' : 'ghana.waecdirect.org'
                                        return (
                                            // Tap a selected type again to deselect it.
                                            <button key={t.id} onClick={() => setSelectedRCTypeId(prev => prev === t.id ? '' : t.id)}
                                                className={cn(
                                                    'relative flex items-center gap-2.5 p-3 rounded-xl border-[1.5px] text-left transition-all duration-200 overflow-hidden',
                                                    'before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[3px] before:content-[""] before:transition-colors',
                                                    isSelected
                                                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/[0.12] before:bg-emerald-500 ring-1 ring-emerald-500/30'
                                                        : 'border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-700 before:bg-transparent'
                                                )}>
                                                <div className="flex-1 min-w-0">
                                                    <p className={cn('text-[13px] sm:text-sm font-semibold leading-snug break-words', isSelected ? 'text-emerald-700 dark:text-emerald-400' : 'text-gray-900 dark:text-white')}>{t.name}</p>
                                                    <p className="text-[10px] sm:text-[11px] text-gray-400 mt-0.5 truncate">
                                                        {waecUrl}{hasBulk ? ' · Bulk discounts' : ''}
                                                    </p>
                                                </div>
                                                <p className="text-[13px] sm:text-sm font-bold text-gray-900 dark:text-white whitespace-nowrap flex-shrink-0">{formatCurrency(t.customer_price + markupFor(t.id))}</p>
                                                <div className={cn(
                                                    'w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all',
                                                    isSelected ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300 dark:border-gray-600'
                                                )}>
                                                    {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                                                </div>
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>

                            {/* Steps 2 & 3 — Quantity, Delivery & Summary */}
                            <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-100 dark:border-gray-900 shadow-sm p-5 space-y-5">

                                {/* Quantity */}
                                <div>
                                    <span className="block text-sm font-semibold text-gray-900 dark:text-white mb-3">Set Quantity</span>
                                    <div className="flex items-center gap-4">
                                        <div className="text-[11px] text-gray-400 flex-1">Max {maxQty} per order</div>
                                        <div className="flex items-center">
                                            <button onClick={() => setRCQuantity(q => Math.max(1, q - 1))}
                                                className="w-8 h-8 rounded-l-lg border-[1.5px] border-r-0 border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-500 hover:bg-[#0B1F3A] hover:text-white hover:border-[#0B1F3A] dark:hover:bg-[#F5B800] dark:hover:text-[#0B1F3A] dark:hover:border-[#F5B800] transition-all bg-white dark:bg-gray-900">
                                                –
                                            </button>
                                            <input type="number" title="Quantity" placeholder="1" min={1} max={maxQty} value={rcQuantity}
                                                onChange={e => setRCQuantity(Math.max(1, Math.min(maxQty, parseInt(e.target.value) || 1)))}
                                                className="w-12 h-8 text-center border-[1.5px] border-gray-200 dark:border-gray-700 border-x-0 text-sm font-bold text-gray-900 dark:text-white bg-white dark:bg-gray-900 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
                                            <button onClick={() => setRCQuantity(q => Math.min(maxQty, q + 1))}
                                                className="w-8 h-8 rounded-r-lg border-[1.5px] border-l-0 border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-500 hover:bg-[#0B1F3A] hover:text-white hover:border-[#0B1F3A] dark:hover:bg-[#F5B800] dark:hover:text-[#0B1F3A] dark:hover:border-[#F5B800] transition-all bg-white dark:bg-gray-900">
                                                +
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* Delivery */}
                                <div>
                                    <span className="block text-sm font-semibold text-gray-900 dark:text-white mb-3">Delivery Details</span>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div className="relative group">
                                            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-emerald-500 transition-colors" />
                                            <input type="tel" value={rcPhone} onChange={e => setRCPhone(e.target.value)} placeholder="Phone Number"
                                                className="w-full pl-10 pr-4 py-3 bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-gray-800 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/10 focus:border-emerald-500 transition-all" />
                                        </div>
                                        <div className="relative group">
                                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-emerald-500 transition-colors" />
                                            <input type="email" value={rcEmail} onChange={e => setRCEmail(e.target.value)} placeholder="Email (optional)"
                                                className="w-full pl-10 pr-4 py-3 bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-gray-800 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/10 focus:border-emerald-500 transition-all" />
                                        </div>
                                    </div>
                                    <p className="mt-2 text-[11px] text-gray-400 leading-tight">
                                        Your PIN appears on screen instantly and is texted to your number. Add an email for a copy (optional).
                                    </p>
                                </div>

                                {/* Order summary — only when type selected */}
                                {selectedRCType && (() => {
                                    const bulkTiers = Array.isArray(selectedRCType.bulk_pricing) ? selectedRCType.bulk_pricing : []
                                    const sortedTiers = [...bulkTiers].sort((a, b) => a.min_qty - b.min_qty)
                                    const activeTier = bulkTiers.find(t => rcQuantity >= t.min_qty && rcQuantity <= t.max_qty)
                                    return (
                                        <div className="space-y-3 pt-2 border-t border-gray-100 dark:border-gray-800">
                                            {sortedTiers.length > 0 && (
                                                <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-800/40 rounded-xl px-3 py-2.5 space-y-1.5">
                                                    <div className="flex items-center gap-1.5">
                                                        <TrendingUp className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                                                        <p className="text-[11px] font-bold text-amber-700 dark:text-amber-300 uppercase tracking-tight">Bulk discounts — the more you buy, the less per voucher</p>
                                                    </div>
                                                    <div className="space-y-1">
                                                        {sortedTiers.map((tier, i) => {
                                                            const isActive = !!activeTier && tier.min_qty === activeTier.min_qty && tier.max_qty === activeTier.max_qty
                                                            return (
                                                                <div key={i} className={cn(
                                                                    'flex items-center justify-between gap-2 text-[11px] leading-tight rounded-md px-2 py-1',
                                                                    isActive ? 'bg-amber-100 dark:bg-amber-800/30 font-bold text-amber-900 dark:text-amber-200' : 'text-amber-700/90 dark:text-amber-300/90'
                                                                )}>
                                                                    <span className="whitespace-nowrap">{tier.min_qty}–{tier.max_qty} vouchers</span>
                                                                    <span className="font-semibold tabular-nums whitespace-nowrap">{formatCurrency(tier.unit_price + markupFor(selectedRCType.id))}/ea</span>
                                                                </div>
                                                            )
                                                        })}
                                                    </div>
                                                </div>
                                            )}
                                            <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
                                                <div className="flex justify-between items-center px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 text-sm">
                                                    <span className="text-gray-500 font-medium">Exam</span>
                                                    <span className="font-semibold text-gray-900 dark:text-white">{selectedRCType.name}</span>
                                                </div>
                                                <div className="flex justify-between items-center px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 text-sm">
                                                    <span className="text-gray-500 font-medium">Quantity</span>
                                                    <span className="font-semibold text-gray-900 dark:text-white">{rcQuantity} {rcQuantity === 1 ? 'voucher' : 'vouchers'}</span>
                                                </div>
                                                <div className="flex justify-between items-center px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 text-sm">
                                                    <span className="text-gray-500 font-medium">Subtotal</span>
                                                    <span className="font-semibold text-gray-900 dark:text-white">{formatCurrency(subtotal)}</span>
                                                </div>
                                                <div className="flex justify-between items-center px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 text-sm">
                                                    <span className="text-gray-500 font-medium">Paystack fee <span className="text-[10px]">({feePercent}%)</span></span>
                                                    <span className="font-semibold text-gray-900 dark:text-white">{formatCurrency(paystackFee)}</span>
                                                </div>
                                                <div className="flex justify-between items-center px-4 py-3">
                                                    <span className="text-sm font-semibold text-gray-900 dark:text-white">Total</span>
                                                    <span className="text-xl font-black text-[#0B1F3A] dark:text-[#F5B800]">{formatCurrency(total)}</span>
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })()}
                            </div>

                            {/* CTA */}
                            <button onClick={() => setShowRCConfirmModal(true)} disabled={loading || !selectedRCTypeId}
                                className="w-full py-4 rounded-xl bg-[#0B1F3A] dark:bg-[#F5B800] text-white dark:text-[#0B1F3A] text-sm font-bold flex items-center justify-center gap-2 transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50">
                                <Lock className="w-4 h-4" /> Proceed to Checkout
                            </button>
                            <p className="text-center text-[11px] text-gray-400 -mt-2">Secured by Paystack · No account needed</p>

                            {/* Confirm Purchase Modal */}
                            <Dialog open={showRCConfirmModal} onOpenChange={setShowRCConfirmModal}>
                                <DialogContent className="rounded-[2rem] max-w-sm p-0 overflow-hidden border-none shadow-2xl">
                                    <DialogHeader className="sr-only">
                                        <DialogTitle>Confirm storefront results checker order</DialogTitle>
                                        <DialogDescription>
                                            Review the exam type, quantity, delivery phone number, email address, and payment total before continuing.
                                        </DialogDescription>
                                    </DialogHeader>
                                    <div className="bg-[#0B1F3A] p-8 text-white space-y-2">
                                        <h3 className="text-xl font-bold tracking-tight">Confirm Order</h3>
                                        <p className="text-xs text-gray-400 font-medium leading-relaxed">
                                            Vouchers will be delivered to <span className="font-bold text-white">{rcPhone}</span> and <span className="font-bold text-white">{rcEmail}</span>.
                                        </p>
                                    </div>
                                    <div className="p-8 space-y-6 bg-white dark:bg-gray-950">
                                        <div className="space-y-4">
                                            <div className="flex justify-between items-center text-xs pb-3 border-b border-gray-200 dark:border-white/5">
                                                <span className="text-gray-700 dark:text-gray-400 font-semibold">Exam Type</span>
                                                <span className="font-bold text-gray-900 dark:text-white">{selectedRCType?.name}</span>
                                            </div>
                                            <div className="flex justify-between items-center text-xs pb-3 border-b border-gray-200 dark:border-white/5">
                                                <span className="text-gray-700 dark:text-gray-400 font-semibold">Quantity</span>
                                                <span className="font-bold text-gray-900 dark:text-white">{rcQuantity} Units</span>
                                            </div>
                                            <div className="flex justify-between items-center text-sm pt-2">
                                                <span className="text-gray-900 dark:text-white font-bold">Total Payable</span>
                                                <span className="font-black text-[#0B1F3A] dark:text-[#F5B800]">{formatCurrency(total)}</span>
                                            </div>
                                        </div>

                                        <div className="flex gap-3">
                                            <button className="flex-1 py-3.5 rounded-xl text-xs font-bold uppercase tracking-widest text-gray-500 hover:bg-gray-100 transition-colors" onClick={() => setShowRCConfirmModal(false)}>
                                                Cancel
                                            </button>
                                            <button 
                                                className="flex-1 py-3.5 rounded-xl text-xs font-bold uppercase tracking-widest bg-[#0B1F3A] dark:bg-[#F5B800] text-white dark:text-[#0B1F3A] hover:opacity-90 shadow-md" 
                                                onClick={handleBuyVouchers} 
                                                disabled={loading}
                                            >
                                                {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Confirm'}
                                            </button>
                                        </div>
                                    </div>
                                </DialogContent>
                            </Dialog>
                        </div>
                    )
                })()}

                {/* ── Data Packages Tab Content ── */}
                {activeTab === 'data' && (
                    <StorefrontDataTab shopSlug={shop.shop_slug} packages={packages} oosNetworks={oosNetworks} brandName={shop.shop_name} />
                )}

                {/* ── Utility Bills Tab Content ── */}
                {utilitiesEnabled && activeTab === 'utilities' && (
                    <StorefrontUtilitiesTab
                        shopSlug={shop.shop_slug}
                        enabledBillers={enabledUtilityBillers}
                        minAmount={utilityMinAmount}
                        maxAmount={utilityMaxAmount}
                        onProceedToPayment={(descriptor) => { setChargeDescriptor(descriptor); setChargeOpen(true) }}
                    />
                )}

                {/* ── AFA Registration Tab Content ── */}
                {isShopAfaEnabled && activeTab === 'afa' && (
                    <div className="mb-6 bg-white dark:bg-slate-900 rounded-[2rem] border border-gray-200 dark:border-slate-800 shadow-sm overflow-hidden p-5 animate-in fade-in slide-in-from-bottom-2 duration-300 transition-colors">
                        <div className="flex items-center gap-3 mb-5 border-b border-gray-100 dark:border-gray-800 pb-5">
                            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white bg-amber-600 shadow-sm">
                                <IdCard className="w-6 h-6" />
                            </div>
                            <div className="text-left">
                                <h2 className="text-h2 uppercase">AFA Registration</h2>
                                <p className="text-label text-gray-500 uppercase mt-1">Register Your SIM with Ghana Card</p>
                            </div>
                        </div>

                        <AfaRegistrationForm shopSlug={shop.shop_slug} displayPrice={afaDisplayPrice} onSubmitDetails={handleAfaSubmit} />
                    </div>
                )}
            </div>

            {/* ── Guest Push Notification FAB ────────────────────────────────── */}
            {pushPermission !== 'unsupported' && (
                isGuestSubscribed ? (
                    <div className="fixed bottom-6 left-4 z-50 flex items-center gap-2 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-full px-4 py-3 shadow-lg animate-in slide-in-from-bottom-6 duration-700">
                        <Bell className="w-4 h-4 text-green-600 dark:text-green-400" />
                        <span className="text-xs font-bold text-green-700 dark:text-green-400">Subscribed</span>
                    </div>
                ) : (
                    <button
                        onClick={() => setShowPushOptIn(true)}
                        className="fixed bottom-6 left-4 z-50 flex items-center gap-2 bg-white dark:bg-gray-800 shadow-xl border border-gray-100 dark:border-gray-700 rounded-full px-4 py-3 hover:scale-105 transition-transform animate-in slide-in-from-bottom-6 duration-700"
                        aria-label="Get shop notifications"
                    >
                        <BellPlus className="w-4 h-4 text-amber-500" />
                        <span className="text-xs font-bold text-gray-700 dark:text-gray-200">Get Notified</span>
                    </button>
                )
            )}

            {/* WhatsApp floating button */}
            {!isPwaPromptVisible && shop.whatsapp_number && (
                <div className="fixed bottom-6 right-4 z-50 flex items-center gap-3 group animate-in slide-in-from-bottom-6 duration-700">
                    <style dangerouslySetInnerHTML={{ __html: `
                        @keyframes promptPeek {
                            0%, 100% { transform: translateX(5px); opacity: 0; }
                            10%, 90% { transform: translateX(0); opacity: 1; }
                        }
                        .animate-prompt-peek { animation: promptPeek 4s ease-in-out infinite; }
                    ` }} />
                    <div className="absolute right-[4.5rem] bg-white dark:bg-gray-800 text-gray-800 dark:text-white px-3 py-1.5 rounded-xl shadow-lg border border-gray-100 dark:border-gray-700 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity animate-prompt-peek whitespace-nowrap">
                        <span className="font-bold text-xs sm:text-sm tracking-tight text-gray-700 dark:text-gray-200">Need Help?</span>
                        <div className="absolute top-1/2 -mt-1 -right-1.5 w-3 h-3 bg-white dark:bg-gray-800 border-r border-t border-gray-100 dark:border-gray-700 rotate-45" />
                    </div>
                    <a
                        href={`https://wa.me/${shop.whatsapp_number}`} target="_blank" rel="noopener noreferrer"
                        className="w-14 h-14 rounded-full bg-[#25D366] shadow-xl flex items-center justify-center hover:scale-110 transition-transform relative"
                        aria-label="Chat on WhatsApp"
                    >
                        <div className="absolute inset-0 rounded-full bg-[#25D366] animate-ping opacity-20" />
                        <svg viewBox="0 0 24 24" className="w-7 h-7 fill-white relative z-10" xmlns="http://www.w3.org/2000/svg">
                            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.008-.57-.008-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.88 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                        </svg>
                    </a>
                </div>
            )}

            {/* ── Sidebar Navigation Overlay ── */}
            <div className={cn("fixed inset-0 z-[100] transition-opacity duration-200", isSidebarOpen ? "opacity-100" : "opacity-0 pointer-events-none")}>
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsSidebarOpen(false)} />
                <div className={cn("absolute top-0 left-0 w-[300px] h-full bg-gray-50 dark:bg-gray-950 shadow-2xl transition-transform duration-200 transform flex flex-col will-change-transform", isSidebarOpen ? "translate-x-0" : "-translate-x-full")}>
                    <div className="p-5 relative flex flex-col items-center justify-center bg-[var(--brand-color)] h-32 overflow-hidden shadow-inner border-b border-black/10">
                        <div className="absolute inset-0 opacity-10 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]" />
                        {shop.logo_url ? (
                            <div className="relative w-14 h-14 rounded-2xl overflow-hidden bg-white/20 shadow-md mb-2">
                                <Image src={shop.logo_url} alt="Logo" fill className="object-contain" />
                            </div>
                        ) : (
                            <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center shadow-md mb-2">
                                <ShoppingCart className="w-6 h-6 text-white" />
                            </div>
                        )}
                        <p className="font-black text-white text-lg truncate w-full text-center relative z-10 drop-shadow-md">{shop.shop_name}</p>
                        <button 
                            onClick={() => setIsSidebarOpen(false)} 
                            className="absolute top-3 right-3 p-1.5 bg-black/20 hover:bg-black/40 rounded-full text-white transition-colors backdrop-blur-sm shadow-sm border border-white/10"
                            aria-label="Close menu"
                            title="Close menu"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto py-5 px-3 space-y-1.5">
                        {/* ── Products ── */}
                        <p className="text-[10px] font-black text-gray-400 dark:text-gray-600 uppercase tracking-[0.25em] px-3 pb-1">Products</p>

                        <button onClick={() => selectProduct('data')} className={cn("w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all shadow-sm border", activeTab === 'data' ? "bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-200 dark:border-gray-700" : "hover:bg-gray-100 dark:hover:bg-gray-900 text-gray-600 dark:text-gray-400 border-transparent")}>
                            <div className={cn("p-1.5 rounded-lg", activeTab === 'data' ? "bg-emerald-500" : "bg-gray-100 dark:bg-gray-800")}>
                                <Zap className={cn("w-4 h-4", activeTab === 'data' ? "text-white fill-white" : "text-gray-400")} />
                            </div>
                            <span className="font-bold flex-1 text-left">Data Packages</span>
                            {activeTab === 'data' && <Check className="w-4 h-4 text-emerald-500" />}
                        </button>

                        {isShopAirtimeEnabled && (
                            <button onClick={() => selectProduct('airtime')} className={cn("w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all shadow-sm border", activeTab === 'airtime' ? "bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-200 dark:border-gray-700" : "hover:bg-gray-100 dark:hover:bg-gray-900 text-gray-600 dark:text-gray-400 border-transparent")}>
                                <div className={cn("p-1.5 rounded-lg", activeTab === 'airtime' ? "bg-blue-500" : "bg-gray-100 dark:bg-gray-800")}>
                                    <Smartphone className={cn("w-4 h-4", activeTab === 'airtime' ? "text-white" : "text-gray-400")} />
                                </div>
                                <span className="font-bold flex-1 text-left">Airtime Recharge</span>
                                {activeTab === 'airtime' && <Check className="w-4 h-4 text-blue-500" />}
                            </button>
                        )}

                        {isShopMashupEnabled && (
                            <button onClick={() => selectProduct('mashup')} className={cn("w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all shadow-sm border", activeTab === 'mashup' ? "bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-200 dark:border-gray-700" : "hover:bg-gray-100 dark:hover:bg-gray-900 text-gray-600 dark:text-gray-400 border-transparent")}>
                                <div className={cn("p-1.5 rounded-lg", activeTab === 'mashup' ? "bg-[#FFCE00]" : "bg-gray-100 dark:bg-gray-800")}>
                                    <Zap className={cn("w-4 h-4", activeTab === 'mashup' ? "text-gray-900 fill-gray-900" : "text-gray-400")} />
                                </div>
                                <span className="font-bold flex-1 text-left">MTN Mashup</span>
                                {activeTab === 'mashup' && <Check className="w-4 h-4 text-amber-500" />}
                            </button>
                        )}

                        {isRCEnabled && (
                            <button onClick={() => selectProduct('vouchers')} className={cn("w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all shadow-sm border", activeTab === 'vouchers' ? "bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-200 dark:border-gray-700" : "hover:bg-gray-100 dark:hover:bg-gray-900 text-gray-600 dark:text-gray-400 border-transparent")}>
                                <div className={cn("p-1.5 rounded-lg", activeTab === 'vouchers' ? "bg-[#0B1F3A] dark:bg-[#F5B800]" : "bg-gray-100 dark:bg-gray-800")}>
                                    <GraduationCap className={cn("w-4 h-4", activeTab === 'vouchers' ? "text-white dark:text-gray-900" : "text-gray-400")} />
                                </div>
                                <span className="font-bold flex-1 text-left">Results Checker</span>
                                {activeTab === 'vouchers' && <Check className="w-4 h-4 text-[#0B1F3A] dark:text-[#F5B800]" />}
                            </button>
                        )}

                        {utilitiesEnabled && (
                            <button onClick={() => selectProduct('utilities')} className={cn("w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all shadow-sm border", activeTab === 'utilities' ? "bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-200 dark:border-gray-700" : "hover:bg-gray-100 dark:hover:bg-gray-900 text-gray-600 dark:text-gray-400 border-transparent")}>
                                <div className={cn("p-1.5 rounded-lg", activeTab === 'utilities' ? "bg-slate-700" : "bg-gray-100 dark:bg-gray-800")}>
                                    <Receipt className={cn("w-4 h-4", activeTab === 'utilities' ? "text-white" : "text-gray-400")} />
                                </div>
                                <span className="font-bold flex-1 text-left">Utility Bills</span>
                                {activeTab === 'utilities' && <Check className="w-4 h-4 text-slate-600 dark:text-slate-300" />}
                            </button>
                        )}

                        {isShopAfaEnabled && (
                            <button onClick={() => selectProduct('afa')} className={cn("w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all shadow-sm border", activeTab === 'afa' ? "bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-200 dark:border-gray-700" : "hover:bg-gray-100 dark:hover:bg-gray-900 text-gray-600 dark:text-gray-400 border-transparent")}>
                                <div className={cn("p-1.5 rounded-lg", activeTab === 'afa' ? "bg-amber-600" : "bg-gray-100 dark:bg-gray-800")}>
                                    <IdCard className={cn("w-4 h-4", activeTab === 'afa' ? "text-white" : "text-gray-400")} />
                                </div>
                                <span className="font-bold flex-1 text-left">AFA Registration</span>
                                {activeTab === 'afa' && <Check className="w-4 h-4 text-amber-600 dark:text-amber-400" />}
                            </button>
                        )}

                        <div className="my-4 border-t border-gray-200 dark:border-gray-800" />

                        {/* ── Account & Links ── */}
                        <p className="text-[10px] font-black text-gray-400 dark:text-gray-600 uppercase tracking-[0.25em] px-3 pb-1">Account</p>

                        <Link href={`${baseLinkPath}/status?shop=${shop.shop_slug}&name=${encodeURIComponent(shop.shop_name)}`} onClick={() => setIsSidebarOpen(false)} className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-900 text-left font-bold text-gray-600 dark:text-gray-400 transition-colors">
                            <div className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-800"><History className="w-4 h-4 text-gray-400" /></div>
                            Track My Orders
                        </Link>
                        {isRCEnabled && (
                            <Link href={rcRetrieveHref} onClick={() => setIsSidebarOpen(false)} className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-900 text-left font-bold text-gray-600 dark:text-gray-400 transition-colors">
                                <div className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-800"><GraduationCap className="w-4 h-4 text-gray-400" /></div>
                                Retrieve Voucher
                            </Link>
                        )}
                        <Link href={`${baseLinkPath}/${shop.shop_slug}/about`} onClick={() => setIsSidebarOpen(false)} className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-900 text-left font-bold text-gray-600 dark:text-gray-400 transition-colors">
                            <div className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-800"><Info className="w-4 h-4 text-gray-400" /></div>
                            About Shop & Terms
                        </Link>
                    </div>
                </div>
            </div>

            {/* ── Announcement Modal ── */}
            {announcement && showAnnouncementModal && (
                <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center">
                    {/* Backdrop — no dismiss on click, user must read */}
                    <div className="absolute inset-0 bg-black/70 backdrop-blur-md animate-in fade-in duration-200" />

                    {/* Card — bottom-sheet on mobile, centred dialog on sm+ */}
                    <div className={cn(
                        "relative w-full sm:max-w-md sm:mx-4",
                        "bg-white dark:bg-gray-950",
                        "rounded-t-[2.5rem] sm:rounded-[2.5rem]",
                        "shadow-[0_-20px_80px_rgba(0,0,0,0.3)] sm:shadow-2xl",
                        "overflow-hidden border border-white/10 dark:border-white/5",
                        "animate-in slide-in-from-bottom sm:zoom-in-95 fade-in duration-300"
                    )}>
                        {/* Drag handle pill (mobile) */}
                        <div className="sm:hidden flex justify-center pt-3 pb-1">
                            <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-700" />
                        </div>

                        {/* Gradient header */}
                        <div className={cn(
                            "relative overflow-hidden px-6 pt-6 pb-7 text-center",
                            announcement.type === 'admin'
                                ? "bg-gradient-to-br from-amber-400 via-amber-500 to-orange-500"
                                : "bg-gradient-to-br from-blue-500 via-blue-600 to-indigo-600"
                        )}>
                            {/* Decorative blobs */}
                            <div className="absolute -right-10 -top-10 w-36 h-36 rounded-full bg-white/10 pointer-events-none" />
                            <div className="absolute -left-6 bottom-0 w-24 h-24 rounded-full bg-black/5 pointer-events-none" />

                            {/* Icon badge */}
                            <div className="relative inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/20 backdrop-blur-sm border border-white/30 mb-4">
                                <Bell className="w-8 h-8 text-white" />
                            </div>

                            {/* Type label */}
                            <div className="inline-block px-3 py-1 rounded-full bg-black/15 text-white text-[10px] font-medium tracking-wide mb-2">
                                {announcement.type === 'admin' ? 'Official Platform Notice' : 'Shop Announcement'}
                            </div>

                            {/* Title */}
                            <h3 className="text-base sm:text-lg font-semibold text-white leading-tight">
                                {announcement.title || 'Important Update'}
                            </h3>
                        </div>

                        {/* Scrollable message body */}
                        <div className="overflow-y-auto max-h-[38vh] sm:max-h-[45vh] px-6 py-5 text-center custom-scrollbar">
                            <p className="text-[15px] text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap font-normal text-left">
                                {announcement.message}
                            </p>
                            <AnnouncementCTAButtons row={announcement} variant="modal" className="mt-5" />
                        </div>

                        {/* Footer with countdown button */}
                        <div className="px-6 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] sm:pb-6 pt-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/40">
                            <button
                                type="button"
                                onClick={handleDismissAnnouncement}
                                disabled={announcementCountdown > 0}
                                className={cn(
                                    "w-full py-4 rounded-2xl font-medium text-sm transition-all duration-200",
                                    "flex items-center justify-center gap-2.5",
                                    "active:scale-[0.98]",
                                    announcementCountdown > 0
                                        ? "bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed"
                                        : "bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 shadow-lg"
                                )}
                            >
                                {announcementCountdown > 0 ? (
                                    <>
                                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full border-2 border-gray-400 dark:border-gray-500 text-xs font-semibold tabular-nums">
                                            {announcementCountdown}
                                        </span>
                                        Please read…
                                    </>
                                ) : (
                                    'Got it, thanks!'
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── RC Guest Success Modal ── */}
            {showRCSuccess && rcSuccessData && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in" onClick={() => setShowRCSuccess(false)} />
                    <div className="relative w-full max-w-sm bg-white dark:bg-gray-900 rounded-[2rem] shadow-2xl overflow-hidden animate-in zoom-in-95 fade-in duration-200 border border-gray-100 dark:border-gray-800">
                        <div className="p-6 flex flex-col items-center text-center bg-[#22C55E]/5">
                            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 shadow-inner border-4 border-white dark:border-gray-800 bg-[#22C55E]">
                                {rcSuccessData.order.status === 'completed' ? (
                                    <CheckCircle2 className="w-8 h-8 text-white" />
                                ) : (
                                    <Clock className="w-8 h-8 text-white" />
                                )}
                            </div>
                            <span className="text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-2 bg-white dark:bg-gray-800 shadow-sm border border-[#22C55E]/20 text-[#22C55E]">
                                {rcSuccessData.order.status === 'completed' ? 'Purchase Successful' : 'Order Processing'}
                            </span>
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white capitalize">
                                {rcSuccessData.order.quantity}x {rcSuccessData.order.type_name}
                            </h3>
                        </div>
                        <div className="p-6 pt-5 bg-white dark:bg-gray-900 space-y-4">
                            <div className="space-y-3">
                                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest text-center">Reference: {rcSuccessData.order.reference_code}</p>
                                {rcSuccessData.order.status === 'completed' ? (
                                    <div className="space-y-3">
                                        <div className="grid grid-cols-1 gap-2">
                                            {rcSuccessData.vouchers.map((v: any, i: number) => {
                                                const isRevealed = revealedRCPins.has(v.pin)
                                                return (
                                                    <div key={i} className="p-3 bg-gray-50 dark:bg-white/[0.02] rounded-xl border border-gray-100 dark:border-white/5 space-y-2">
                                                        <div className="flex justify-between items-center">
                                                            <span className="text-xs font-bold text-gray-400 uppercase">Voucher {i + 1}</span>
                                                            <button
                                                                onClick={() => {
                                                                    navigator.clipboard.writeText(`Serial: ${v.serial_number}\nPIN: ${v.pin}`)
                                                                    toast.success('Copied to clipboard')
                                                                }}
                                                                className="text-xs font-bold text-blue-500 uppercase px-2 py-1"
                                                            >
                                                                Copy
                                                            </button>
                                                        </div>
                                                        <div className="space-y-1">
                                                            <p className="text-xs text-gray-400 font-bold uppercase">Serial: <span className="text-gray-900 dark:text-white font-mono">{v.serial_number}</span></p>
                                                            <div 
                                                                onClick={() => toggleRCPinReveal(v.pin)}
                                                                className="flex items-center justify-between p-1.5 bg-white dark:bg-black/20 rounded border border-gray-100 dark:border-white/5 cursor-pointer"
                                                            >
                                                                <span className={cn("font-mono text-xs font-bold", isRevealed ? "text-[#0B1F3A] dark:text-[#F5B800]" : "text-gray-300 blur-[3px]")}>
                                                                    {isRevealed ? v.pin : "PIN HIDDEN"}
                                                                </span>
                                                                {isRevealed ? <EyeOff className="w-3 h-3 text-gray-400" /> : <Eye className="w-3 h-3 text-gray-400" />}
                                                            </div>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                        <p className="text-[11px] text-gray-500 text-center leading-relaxed">Results Checker delivered. Tap to reveal PINs or download the receipt below.</p>
                                    </div>
                                ) : (
                                    <p className="text-sm text-gray-600 dark:text-gray-300 text-center">Your payment was received. We are processing your vouchers and will send them via SMS shortly.</p>
                                )}
                            </div>
                            {rcSuccessData.order.status === 'completed' && rcSuccessData.vouchers.length > 0 && (
                                <div className="space-y-2">
                                    <button
                                        onClick={() => downloadResultsCheckerVouchers(
                                            rcSuccessData.order,
                                            rcSuccessData.vouchers,
                                            localStorage.getItem('shop_last_phone') || rcSuccessData.order.customer_phone || '',
                                            rcSuccessData.order.customer_email || '',
                                            shop.shop_name
                                        )}
                                        className="w-full py-3.5 rounded-xl bg-[#0B1F3A] dark:bg-[#F5B800] text-white dark:text-[#0B1F3A] font-bold text-xs uppercase tracking-widest shadow-md flex justify-center items-center gap-2 transition-transform active:scale-95"
                                    >
                                        <Download className="w-4 h-4" /> Download Receipt
                                    </button>
                                    <Link
                                        href={`${rcRetrieveHref}?reference=${encodeURIComponent(rcSuccessData.order.reference_code)}`}
                                        className="flex w-full items-center justify-center rounded-xl border border-gray-200 px-4 py-3 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                                    >
                                        Open Retrieve Page
                                    </Link>
                                </div>
                            )}
                            <button 
                                onClick={() => { setShowRCSuccess(false); router.replace(window.location.pathname) }}
                                className="w-full py-3.5 rounded-xl bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-bold text-xs uppercase tracking-widest hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Push Notification Opt-In Sheet ─────────────────────────────── */}
            {showPushOptIn && (
                <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setShowPushOptIn(false)} />
                    <div className={cn(
                        "relative w-full sm:max-w-md sm:mx-4",
                        "bg-white dark:bg-gray-950",
                        "rounded-t-[2.5rem] sm:rounded-[2.5rem]",
                        "shadow-[0_-20px_80px_rgba(0,0,0,0.3)] sm:shadow-2xl",
                        "overflow-hidden border border-white/10 dark:border-white/5",
                        "animate-in slide-in-from-bottom sm:zoom-in-95 fade-in duration-300"
                    )}>
                        <div className="sm:hidden flex justify-center pt-3 pb-1">
                            <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-700" />
                        </div>

                        {/* Gradient header */}
                        <div className="relative overflow-hidden px-6 pt-6 pb-7 text-center bg-gradient-to-br from-violet-500 via-violet-600 to-purple-700">
                            <div className="absolute -right-10 -top-10 w-36 h-36 rounded-full bg-white/10 pointer-events-none" />
                            <div className="absolute -left-6 bottom-0 w-24 h-24 rounded-full bg-black/5 pointer-events-none" />
                            <div className="relative inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/20 backdrop-blur-sm border border-white/30 mb-4">
                                <BellPlus className="w-8 h-8 text-white" />
                            </div>
                            <div className="inline-block px-3 py-1 rounded-full bg-black/15 text-white text-[10px] font-black uppercase tracking-widest mb-2">
                                Shop Notifications
                            </div>
                            <h3 className="text-xl font-black text-white leading-tight">Stay in the loop</h3>
                        </div>

                        {/* Body */}
                        <div className="px-6 py-5 space-y-3">
                            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed text-center">
                                Get instant alerts when <strong className="text-gray-900 dark:text-white">{shop.shop_name}</strong> posts new announcements or special offers.
                            </p>
                            <div className="flex flex-col gap-2">
                                {[
                                    { icon: '📢', text: 'New announcements & offers' },
                                    { icon: '⚡', text: 'Instant delivery to your device' },
                                    { icon: '🔕', text: 'Turn off anytime in browser settings' },
                                ].map(({ icon, text }) => (
                                    <div key={text} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800/60 text-sm text-gray-700 dark:text-gray-300">
                                        <span className="text-base">{icon}</span>
                                        <span className="font-medium">{text}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="px-6 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] sm:pb-6 pt-2 space-y-2 border-t border-gray-100 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/40">
                            <button
                                type="button"
                                onClick={handleGuestSubscribe}
                                disabled={isSubscribing}
                                className={cn(
                                    "w-full py-4 rounded-2xl font-bold text-sm flex items-center justify-center gap-2.5 active:scale-[0.98] transition-all",
                                    "bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 shadow-lg disabled:opacity-60"
                                )}
                            >
                                {isSubscribing
                                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Enabling…</>
                                    : <><BellPlus className="w-4 h-4" /> Enable Notifications</>
                                }
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowPushOptIn(false)}
                                className="w-full py-2.5 rounded-2xl font-semibold text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                            >
                                Not now
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <CopyrightFooter
                variant="shop"
                shopName={shop.shop_name}
                adminSettings={adminSettings}
                className="pb-20 pt-10" // Extra padding to stay clear of floating buttons
            />
        </div>
    )
}
