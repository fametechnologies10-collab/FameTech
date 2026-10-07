import type { Metadata } from 'next'

// De-branded metadata for the sub-agent onboarding surface (audit finding #4).
// The /join pages are the one place explicitly meant to hide the KiNG FLEXY
// identity, but as client components they inherit the root layout's KFG title,
// favicon and OpenGraph card — leaking the brand in browser tabs and WhatsApp/
// Facebook link unfurls. This server layout overrides that metadata for /join
// and /join/[code] with a neutral partner identity and an inline SVG favicon
// (no KFG asset referenced). Invitation-only, so also noindex.
//
// Residual: the root layout injects an Organization JSON-LD block into <body>
// that a nested layout cannot remove; crawlers reading raw HTML can still see it.
// The visible tab title, favicon and social-share card are fully de-branded here.

const NEUTRAL_FAVICON =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%232563eb' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z'/%3E%3Cpath d='M3 6h18'/%3E%3Cpath d='M16 10a4 4 0 0 1-8 0'/%3E%3C/svg%3E"

export const metadata: Metadata = {
    title: { absolute: 'Partner Portal' },
    description: 'Join a storefront, get wholesale pricing and start selling.',
    icons: { icon: NEUTRAL_FAVICON, shortcut: NEUTRAL_FAVICON, apple: NEUTRAL_FAVICON },
    robots: { index: false, follow: false },
    openGraph: {
        title: 'Partner Portal',
        description: 'Join a storefront, get wholesale pricing and start selling.',
        siteName: 'Partner Portal',
        images: [],
        type: 'website',
    },
    twitter: {
        card: 'summary',
        title: 'Partner Portal',
        description: 'Join a storefront, get wholesale pricing and start selling.',
        images: [],
    },
}

export default function JoinLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>
}
