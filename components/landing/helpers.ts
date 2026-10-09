export interface LandingDataPackage {
    network: string
    volume: string
    price: string
}

export interface LandingAgentPlan {
    key: string
    title: string
    duration: string
    price: string
    oldPrice?: string
    badge?: string
}

export interface LandingReview {
    name: string
    role: string
    rating: number
    quote: string
}
export type PackagesByNetwork = Record<string, LandingDataPackage[]>

export const DEFAULT_GUEST_URL = 'https://fametechgh.com/shop/felix-s-shop'
export const DEFAULT_CUSTOMER_COUNT_LABEL = '5,000+'
export const DEFAULT_CUSTOMER_COUNT_TARGET = 5000

export const DEFAULT_AGENT_PLANS: LandingAgentPlan[] = [
    { key: '3d', title: 'Starter', duration: '3 Days Access', price: '9.99', badge: 'Quick Start' },
    { key: '14d', title: 'Most Popular', duration: '14 Days Access', price: '49.99', badge: 'Best Value' },
    { key: '30d', title: 'Premium', duration: '30 Days Access', price: '99.99', badge: 'Business Ready' },
    { key: 'permanent', title: 'Lifetime', duration: 'Permanent Access', price: '149.99', badge: 'One Time' },
]

export const DEFAULT_TESTIMONIALS: LandingReview[] = [
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

export const DATA_NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime']
export const AIRTIME_NETWORKS = ['MTN', 'Telecel', 'AT']
export const POPULAR_NETWORK_ORDER = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'AT']

export function parseCustomerCountTarget(rawCount: string): number {
    const digitsOnly = rawCount.replace(/[^\d]/g, '')
    if (!digitsOnly) return DEFAULT_CUSTOMER_COUNT_TARGET
    const parsed = parseInt(digitsOnly, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CUSTOMER_COUNT_TARGET
    // M-4: Hard cap at 10 million to prevent render loops even if DB is poisoned
    return Math.min(parsed, 10_000_000)
}

export function isSafeHref(url: string): boolean {
    if (!url || !url.trim()) return false
    try {
        const { protocol } = new URL(url.trim())
        return protocol === 'https:' || protocol === 'http:'
    } catch {
        return false
    }
}

export function isValidPlan(plan: unknown): plan is LandingAgentPlan {
    if (typeof plan !== 'object' || plan === null) return false
    const candidate = plan as Record<string, unknown>
    return (
        typeof candidate.key === 'string' &&
        typeof candidate.title === 'string' &&
        typeof candidate.duration === 'string' &&
        typeof candidate.price === 'string'
    )
}

export function isValidReview(review: unknown): review is LandingReview {
    if (typeof review !== 'object' || review === null) return false
    const candidate = review as Record<string, unknown>
    return (
        typeof candidate.name === 'string' &&
        typeof candidate.role === 'string' &&
        typeof candidate.quote === 'string' &&
        typeof candidate.rating === 'number'
    )
}
