// lib/promo-carousel/dashboard-slides.ts
import {
    ShieldCheck, Smartphone, UserPlus, TrendingUp, Store,
    Wifi, PhoneCall, IdCard, GraduationCap, Zap, Megaphone,
} from 'lucide-react'
import type { PromoSlide } from './types'

export interface DashboardSlideContext {
    role: string | null | undefined
    hasShop: boolean
    ussdShortcode: string
    /** Opens the MTN whitelist checker dialog. */
    onOpenWhitelistCheck: () => void
    /** Latest active platform announcement, if any. The slide needs both this and the opener. */
    announcement?: { title: string } | null
    onOpenAnnouncement?: () => void
}

export function buildDashboardSlides(ctx: DashboardSlideContext): PromoSlide[] {
    const slides: PromoSlide[] = []
    const { announcement, onOpenAnnouncement } = ctx

    if (announcement && onOpenAnnouncement) {
        const title = announcement.title.trim() || 'Important update'
        slides.push({
            id: 'announcement',
            theme: 'amber',
            eyebrowIcon: Megaphone,
            eyebrow: 'NOTICE',
            title: title.length > 56 ? `${title.slice(0, 55)}…` : title,
            body: 'There is an official announcement from KiNG FLEXY GH. Tap to read it.',
            icon: Megaphone,
            cta: { label: 'Read Announcement', onClick: onOpenAnnouncement },
        })
    }

    // MTN only delivers to registered (whitelisted) numbers; the checker also submits any
    // unregistered number to MTN, so the copy promises no turnaround and names no supplier.
    slides.push({
        id: 'mtn-whitelist',
        theme: 'rose',
        eyebrowIcon: ShieldCheck,
        eyebrow: 'MTN',
        title: 'Check your MTN number',
        body: 'MTN data only reaches registered numbers. Check yours now — numbers that are not registered are sent to MTN automatically.',
        icon: ShieldCheck,
        cta: { label: 'Check Number', onClick: ctx.onOpenWhitelistCheck },
    })

    slides.push({
        id: 'ussd-quick-buy',
        theme: 'violet',
        eyebrowIcon: Smartphone,
        eyebrow: 'USSD',
        title: 'Buy on USSD — no app, no data',
        body: `Dial ${ctx.ussdShortcode} from your registered number and pay your role price instantly.`,
        icon: Smartphone,
        cta: { label: 'Sell on USSD', href: '/dashboard/shop' },
    })

    if (ctx.role === 'agent' || ctx.role === 'dealer') {
        slides.push({
            id: 'recruit-subagents',
            theme: 'amber',
            eyebrowIcon: UserPlus,
            eyebrow: 'NETWORK',
            title: 'Recruit Sub-Agents',
            body: 'Recruit sellers under you and earn on every sale they make.',
            icon: UserPlus,
            cta: { label: 'Recruit Agents', href: '/dashboard/recruit' },
        })
    }

    if (ctx.role === 'customer' || ctx.role === 'agent') {
        slides.push({
            id: 'upgrade-account',
            theme: 'blue',
            eyebrowIcon: TrendingUp,
            eyebrow: 'UPGRADE',
            title: 'Upgrade your account',
            body: 'Unlock wholesale pricing and higher limits with an Agent or Dealer upgrade.',
            icon: TrendingUp,
            cta: { label: 'View Upgrade', href: '/dashboard/upgrade' },
        })
    }

    if (!ctx.hasShop) {
        slides.push({
            id: 'launch-shop',
            theme: 'violet',
            eyebrowIcon: Store,
            eyebrow: 'STOREFRONT',
            title: 'Own Shop',
            body: 'Launch your white-label storefront and sell under your own brand.',
            icon: Store,
            cta: { label: 'Launch Shop', href: '/dashboard/shop/setup' },
        })
    }

    slides.push(
        {
            id: 'product-data',
            theme: 'emerald',
            eyebrowIcon: Wifi,
            eyebrow: 'DATA BUNDLES',
            title: 'MTN, Telecel & AT data',
            body: 'High-speed data packages at wholesale reseller rates.',
            icon: Wifi,
            cta: { label: 'Buy Data', href: '/dashboard/data-packages' },
        },
        {
            id: 'product-airtime',
            theme: 'blue',
            eyebrowIcon: PhoneCall,
            eyebrow: 'AIRTIME',
            title: 'Instant airtime top-up',
            body: 'VTU airtime recharge for all networks with direct phone delivery.',
            icon: PhoneCall,
            cta: { label: 'Buy Airtime', href: '/dashboard/airtime' },
        },
        {
            id: 'product-afa',
            theme: 'amber',
            eyebrowIcon: IdCard,
            eyebrow: 'AFA',
            title: 'AFA registration',
            body: 'Seamless MTN AFA registrations and renewals for field agents.',
            icon: IdCard,
            cta: { label: 'Register AFA', href: '/dashboard/afa-orders' },
        },
        {
            id: 'product-results-checker',
            theme: 'rose',
            eyebrowIcon: GraduationCap,
            eyebrow: 'RESULTS CHECKER',
            title: 'WAEC, BECE & WASSCE vouchers',
            body: 'Purchase results checker vouchers instantly, delivered as codes.',
            icon: GraduationCap,
            cta: { label: 'Buy Vouchers', href: '/dashboard/results-checker' },
        },
        {
            id: 'product-mashup',
            theme: 'amber',
            eyebrowIcon: Zap,
            eyebrow: 'MASHUP',
            title: 'MTN Mashup bundles',
            body: 'Activate custom voice & data combination bundles on any MTN line.',
            icon: Zap,
            cta: { label: 'Buy Mashup', href: '/dashboard/data-packages' },
        },
    )

    return slides
}
