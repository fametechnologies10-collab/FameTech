import type { Metadata } from 'next'
import { SITE, API_BASE } from '@/lib/developer-products'

const TITLE = 'Developer API Ghana — Data, Airtime, SMS, Results Checker, AFA, Utility Bills & USSD | KiNG FLEXY GH'
const DESCRIPTION =
    'Public REST API for Ghana digital services: MTN, Telecel and AirtelTigo data bundles, airtime, bulk SMS, WAEC/BECE results checkers, MTN AFA registration and utility bill payments (ECG, Ghana Water, DStv, GOtv, StarTimes). Resellers can also sell over USSD. OpenAPI spec included.'

export const metadata: Metadata = {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: `${SITE}/developers` },
    openGraph: {
        title: TITLE,
        description: DESCRIPTION,
        url: `${SITE}/developers`,
        type: 'website',
        siteName: 'KiNG FLEXY GH',
    },
    twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
}

const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebAPI',
    name: 'KiNG FLEXY GH Developer API',
    description: DESCRIPTION,
    url: `${SITE}/developers`,
    documentation: `${SITE}/developers`,
    termsOfService: `${SITE}/terms`,
    provider: { '@type': 'Organization', name: 'KiNG FLEXY TECHNOLOGIES LTD', url: SITE },
    areaServed: 'GH',
    potentialAction: { '@type': 'ConsumeAction', target: API_BASE },
}

export default function DevelopersLayout({ children }: { children: React.ReactNode }) {
    return (
        <>
            <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
            {children}
        </>
    )
}
