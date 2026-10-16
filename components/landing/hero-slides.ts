export interface HeroSlide {
    id: string
    badge: string
    headline: string
    body: string
}

export const HERO_SLIDES: HeroSlide[] = [
    {
        id: 'data',
        badge: 'Instant delivery',
        headline: 'Data that lands before you blink.',
        body: 'MTN, Telecel and AirtelTigo bundles, paid from your wallet in seconds.',
    },
    {
        id: 'airtime-bills',
        badge: 'One wallet, every network',
        headline: 'Airtime and bills, settled in one place.',
        body: 'Top up any network and pay ECG, ECG prepaid and other bills without leaving your wallet.',
    },
    {
        id: 'afa',
        badge: 'Results and registrations',
        headline: 'Results checkers and AFA, sorted.',
        body: 'BECE, WASSCE and AFA registration slips, ready minutes after you pay.',
    },
    {
        id: 'resell',
        badge: 'Built for resellers',
        headline: 'Resell at your price, keep the margin.',
        body: 'Agents and dealers get their own storefront, bulk pricing and a public API to automate orders.',
    },
]
