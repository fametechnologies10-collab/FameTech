import type { LucideIcon } from 'lucide-react'

export type PromoTheme = 'amber' | 'violet' | 'emerald' | 'blue' | 'rose'

export interface PromoSlideCtaLink {
    label: string
    href: string
}

export interface PromoSlideCtaAction {
    label: string
    onClick: () => void
}

export interface PromoSlide {
    id: string
    theme: PromoTheme
    eyebrowIcon: LucideIcon
    eyebrow: string
    title: string
    body: string
    icon: LucideIcon
    cta: PromoSlideCtaLink | PromoSlideCtaAction
    /** Shop owner's brand_color hex, applied to the CTA button when present. */
    accentColor?: string
}
