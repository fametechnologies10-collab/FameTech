// lib/promo-carousel/storefront-slides.ts
import {
    Wifi, PhoneCall, IdCard, GraduationCap, Receipt, MessageCircle, ShieldCheck, Sparkles, LifeBuoy, Megaphone,
} from 'lucide-react'
import type { PromoSlide } from './types'

// Mirrors NETWORK_ORDER in app/shop/[shopSlug]/components/StorefrontDataTab.tsx —
// duplicated intentionally rather than exported/refactored (small constant, no
// shared ownership change intended by this feature).
const NETWORK_ORDER = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'AT']

const NETWORK_COPY: Record<string, string> = {
    'MTN': 'MTN data bundles at wholesale rates — instant delivery.',
    'Telecel': 'Telecel data bundles at wholesale rates — instant delivery.',
    'AT-iShare': 'AirtelTigo iShare bundles at wholesale rates — instant delivery.',
    'AT-BigTime': 'AirtelTigo BigTime bundles at wholesale rates — instant delivery.',
    'AT': 'AirtelTigo data bundles at wholesale rates — instant delivery.',
}

export type StorefrontTab = 'data' | 'airtime' | 'mashup' | 'vouchers' | 'utilities' | 'afa'

export interface StorefrontSlideContext {
    packages: { network: string }[]
    oosNetworks: string[]
    airtimeEnabled: boolean
    afaEnabled: boolean
    rcEnabled: boolean
    utilitiesEnabled: boolean
    ownerRole: string | null | undefined
    shopName: string
    whatsappNumber: string | null
    ownerPhone: string
    accentColor?: string
    selectProduct: (tab: StorefrontTab) => void
    /** The announcement the page already resolved (platform notice wins over the shop's own). */
    announcement?: { type: 'admin' | 'shop'; title?: string } | null
    onOpenAnnouncement?: () => void
}

// WhatsApp with a pre-filled message when the shop has a usable number, else a plain call.
function contactHref(ctx: StorefrontSlideContext, message: string): string {
    const digits = (ctx.whatsappNumber ?? '').replace(/\D/g, '')
    return digits
        ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
        : `tel:${ctx.ownerPhone}`
}

export function buildStorefrontSlides(ctx: StorefrontSlideContext): PromoSlide[] {
    const slides: PromoSlide[] = []
    const accentColor = ctx.accentColor
    const { announcement, onOpenAnnouncement } = ctx

    if (announcement && onOpenAnnouncement) {
        const isAdmin = announcement.type === 'admin'
        const title = announcement.title?.trim() || 'Important update'
        slides.push({
            id: 'announcement',
            theme: 'amber',
            eyebrowIcon: Megaphone,
            eyebrow: isAdmin ? 'OFFICIAL NOTICE' : 'SHOP NOTICE',
            title: title.length > 56 ? `${title.slice(0, 55)}…` : title,
            body: isAdmin
                ? 'There is an official platform announcement. Tap to read it.'
                : `${ctx.shopName} posted an announcement. Tap to read it.`,
            icon: Megaphone,
            cta: { label: 'Read Announcement', onClick: onOpenAnnouncement },
            accentColor,
        })
    }

    const activeNetworks = NETWORK_ORDER.filter(
        n => ctx.packages.some(p => p.network === n) && !ctx.oosNetworks.includes(n),
    )

    for (const network of activeNetworks) {
        slides.push({
            id: `network-${network}`,
            theme: 'emerald',
            eyebrowIcon: Wifi,
            eyebrow: 'NETWORK',
            title: `${network} Data Bundles`,
            body: NETWORK_COPY[network] ?? `${network} data bundles at wholesale rates — instant delivery.`,
            icon: Wifi,
            cta: { label: 'Buy Now', onClick: () => ctx.selectProduct('data') },
            accentColor,
        })
    }

    if (ctx.airtimeEnabled) {
        slides.push({
            id: 'airtime',
            theme: 'blue',
            eyebrowIcon: PhoneCall,
            eyebrow: 'AIRTIME',
            title: 'Instant airtime top-up',
            body: 'VTU airtime recharge with direct phone delivery.',
            icon: PhoneCall,
            cta: { label: 'Buy Airtime', onClick: () => ctx.selectProduct('airtime') },
            accentColor,
        })
    }

    if (ctx.afaEnabled) {
        slides.push({
            id: 'afa',
            theme: 'amber',
            eyebrowIcon: IdCard,
            eyebrow: 'AFA',
            title: 'AFA registration',
            body: 'Register or renew your MTN AFA line right here.',
            icon: IdCard,
            cta: { label: 'Register Now', onClick: () => ctx.selectProduct('afa') },
            accentColor,
        })
    }

    if (ctx.rcEnabled) {
        slides.push({
            id: 'results-checker',
            theme: 'rose',
            eyebrowIcon: GraduationCap,
            eyebrow: 'RESULTS CHECKER',
            title: 'WAEC, BECE & WASSCE vouchers',
            body: 'Get your results checker voucher instantly.',
            icon: GraduationCap,
            cta: { label: 'Buy Voucher', onClick: () => ctx.selectProduct('vouchers') },
            accentColor,
        })
    }

    if (ctx.utilitiesEnabled) {
        slides.push({
            id: 'bill-pay',
            theme: 'violet',
            eyebrowIcon: Receipt,
            eyebrow: 'BILL PAY',
            title: 'Pay your bills here',
            body: 'ECG, Ghana Water and more — pay instantly.',
            icon: Receipt,
            cta: { label: 'Pay a Bill', onClick: () => ctx.selectProduct('utilities') },
            accentColor,
        })
    }

    // Migrated verbatim from the old static card (ShopStorefront.tsx:1006-1041) —
    // same gating, same WhatsApp-first/tel-fallback request link.
    if (ctx.ownerRole === 'agent' || ctx.ownerRole === 'dealer') {
        const requestMessage = `Hi! I saw your shop "${ctx.shopName}" on KiNG FLEXY GH and I'd like to become a Sub-Agent under you. I understand this means I get my own shop, set my own prices, and resell data bundles, AFA registrations, results checker vouchers and more. Can you help me get set up?`
        const requestHref = contactHref(ctx, requestMessage)
        slides.push({
            id: 'become-subagent',
            theme: 'emerald',
            eyebrowIcon: MessageCircle,
            eyebrow: 'OPPORTUNITY',
            title: 'Want Your Own Shop?',
            body: `Become a Sub-Agent under ${ctx.shopName} and unlock your own storefront and pricing.`,
            icon: MessageCircle,
            cta: { label: 'Request to Become a Sub-Agent', href: requestHref },
            accentColor,
        })
    }

    // Awareness slide — storefront visitors may be anonymous, so nothing here is account-gated.
    // When the shop sells MTN, point at the registration check (MTN is the first network in the
    // data tab, so selecting it lands the visitor right beside the inline checker). The copy names
    // no supplier and promises no turnaround. Otherwise fall back to the generic number tip.
    if (activeNetworks.includes('MTN')) {
        slides.push({
            id: 'mtn-whitelist',
            theme: 'blue',
            eyebrowIcon: ShieldCheck,
            eyebrow: 'MTN',
            title: 'Check your MTN number',
            body: 'MTN data only reaches registered numbers. Check yours before you pay.',
            icon: ShieldCheck,
            cta: { label: 'Check My Number', onClick: () => ctx.selectProduct('data') },
            accentColor,
        })
    } else {
        slides.push({
            id: 'instant-delivery-awareness',
            theme: 'blue',
            eyebrowIcon: ShieldCheck,
            eyebrow: 'TIP',
            title: 'Double-check your number',
            body: 'Enter the correct phone number at checkout for instant delivery.',
            icon: ShieldCheck,
            cta: { label: 'Start Shopping', onClick: () => ctx.selectProduct('data') },
            accentColor,
        })
    }

    slides.push({
        id: 'need-help',
        theme: 'rose',
        eyebrowIcon: LifeBuoy,
        eyebrow: 'SUPPORT',
        title: 'Need help?',
        body: `Questions about an order or a product? Message ${ctx.shopName} directly.`,
        icon: LifeBuoy,
        cta: {
            label: 'Chat for Help',
            href: contactHref(
                ctx,
                `Hi! I need help with an order/purchase on your shop "${ctx.shopName}" on KiNG FLEXY GH.`,
            ),
        },
        accentColor,
    })

    // Pad with a generic trust slide if the shop has very few active products,
    // so the carousel never looks like a broken single card.
    const fillers: PromoSlide[] = [
        {
            id: 'trust-instant-delivery',
            theme: 'violet',
            eyebrowIcon: Sparkles,
            eyebrow: 'DELIVERY',
            title: 'Instant Delivery',
            body: 'Fast, secure checkout — your order is delivered to the number you enter.',
            icon: Sparkles,
            cta: { label: 'Start Shopping', onClick: () => ctx.selectProduct('data') },
            accentColor,
        },
        {
            id: 'trust-pay-safe',
            theme: 'amber',
            eyebrowIcon: ShieldCheck,
            eyebrow: 'SAFE PAYMENT',
            title: 'Pay with confidence',
            body: 'Secure checkout and delivery straight to the number you enter.',
            icon: ShieldCheck,
            cta: { label: 'Start Shopping', onClick: () => ctx.selectProduct('data') },
            accentColor,
        },
    ]
    for (const filler of fillers) {
        if (slides.length >= 3) break
        slides.push(filler)
    }

    return slides
}
