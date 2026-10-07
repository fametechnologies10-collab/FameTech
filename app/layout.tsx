import type { Metadata, Viewport } from 'next'

export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    themeColor: '#0f172a',
    interactiveWidget: 'resizes-content',
}
import { Inter } from 'next/font/google'
import './globals.css'
import { AuthProvider } from '@/contexts/auth-context'
import { Toaster } from '@/components/ui/sonner'
import { ThemeProvider } from '@/components/theme-provider'
import { PinProvider } from '@/contexts/pin-context'
import { OfflineOverlay } from '@/components/offline-overlay'

const inter = Inter({
    subsets: ['latin'],
    variable: '--font-inter',
    display: 'swap',
})

export const metadata: Metadata = {
    metadataBase: new URL('https://kingflexygh.com'),
    title: 'KiNG FLEXY GH - Powering Digital Services in Ghana',
    description: 'Buy affordable MTN, Telecel, and AirtelTigo data bundles, airtime, and mashup online in Ghana. Instantly purchase WAEC & BECE Results Checker vouchers, pay utility bills, send bulk SMS, complete MTN AFA Registrations, sell over USSD, and integrate our Developer API for data, airtime, SMS, results checkers, AFA and bills. Fast, secure, and reliable digital solutions — KiNG FLEXY GH, Powering Digital Services in Ghana.',
    keywords: [
        // Brand
        'KiNG FLEXY GH', 'King Flexy Technologies', 'kingflexygh.com',
        // Data & Airtime
        'buy data bundles Ghana', 'cheap data Ghana', 'affordable data bundles', 'MTN data bundles Ghana',
        'Telecel data bundles', 'AirtelTigo data bundles', 'buy data online Ghana', 'mobile data Ghana',
        'cheap airtime Ghana', 'buy airtime online Ghana', 'MTN airtime Ghana', 'Telecel airtime',
        'data packages Ghana', 'instant data delivery Ghana',
        // Mashup
        'MTN mashup', 'Telecel mashup', 'buy mashup bundles Ghana', 'mashup data Ghana',
        'affordable mashup Ghana', 'MTN mashup bundle',
        // Results Checker
        'buy result checker Ghana', 'WAEC result checker online Ghana', 'BECE result checker Ghana',
        'WASSCE result checker', 'school placement checker Ghana', 'results checker voucher Ghana',
        'cheap result checker Ghana', 'buy WAEC checker online', 'online result checker Ghana',
        // AFA Registration
        'MTN AFA registration Ghana', 'AFA agent registration', 'MTN agent registration Ghana',
        'how to register for AFA Ghana', 'AFA registration fee Ghana',
        // Developer API
        'developer API Ghana', 'VTU API Ghana', 'King Flexy API', 'data reseller API Ghana',
        'airtime API Ghana', 'results checker API', 'digital services API Ghana',
        'reseller platform Ghana', 'bulk data API Ghana',
        'bulk SMS API Ghana', 'utility bill payment API Ghana', 'data bundle API Ghana',
        'AFA registration API Ghana', 'USSD data reseller Ghana', 'sell data on USSD Ghana',
        // General
        'digital services Ghana', 'online digital platform Ghana', 'data reseller Ghana',
        'Ghana fintech', 'instant delivery Ghana'
    ],
    authors: [{ name: 'KiNG FLEXY TECHNOLOGIES LTD' }],
    openGraph: {
        title: 'KiNG FLEXY GH - Powering Digital Services in Ghana',
        description: 'Buy data bundles, airtime, mashup, WAEC Results Checkers, AFA Registrations & access our Developer API. Fast, secure digital services in Ghana.',
        type: 'website',
        url: 'https://kingflexygh.com',
        siteName: 'KiNG FLEXY GH',
        images: [
            {
                url: '/logo.png',
                width: 1200,
                height: 630,
                alt: 'KiNG FLEXY GH Logo',
            },
        ],
    },
    twitter: {
        card: 'summary_large_image',
        title: 'KiNG FLEXY GH - Powering Digital Services in Ghana',
        description: 'Buy data bundles, airtime, mashup, WAEC Results Checkers, AFA Registrations & access our Developer API. Fast, secure digital services in Ghana.',
        images: ['/logo.png'],
    },
    appleWebApp: {
        title: 'KiNGFLEXYGH',
        statusBarStyle: 'black-translucent',
        capable: true,
    },
    icons: {
        icon: [
            { url: '/icons/icon-192x192.png?v=2', sizes: '192x192', type: 'image/png' },
            { url: '/icons/icon-512x512.png?v=2', sizes: '512x512', type: 'image/png' },
        ],
        shortcut: '/icons/icon-192x192.png?v=2',
        apple: '/icons/apple-touch-icon.png?v=2',
    },
    manifest: '/manifest.json',
}

import { UIProvider } from '@/contexts/ui-context'
import { PageReadyLoader } from '@/components/ui/page-ready-loader'

export default function RootLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <link rel="preload" href="/logo.png" as="image" />
            </head>
            <body className={`${inter.variable} ${inter.className}`}>
                <script
                    type="application/ld+json"
                    dangerouslySetInnerHTML={{
                        __html: JSON.stringify({
                            "@context": "https://schema.org",
                            "@type": "Organization",
                            "name": "KiNG FLEXY TECHNOLOGIES LTD",
                            "alternateName": "KiNG FLEXY GH",
                            "url": "https://kingflexygh.com/",
                            "logo": "https://kingflexygh.com/logo.png",
                            "description": "Powering Digital Services in Ghana. Buy data bundles, airtime, mashup, WAEC Results Checker vouchers, utility bills, bulk SMS and MTN AFA Registrations, sell over USSD, and integrate our Developer API.",
                            "areaServed": "GH",
                            "hasOfferCatalog": {
                                "@type": "OfferCatalog",
                                "name": "KiNG FLEXY GH products and APIs",
                                "itemListElement": [
                                    ['Data Bundles API', 'data-bundles'],
                                    ['Airtime API', 'airtime'],
                                    ['Results Checker API', 'results-checker'],
                                    ['AFA Registration API', 'afa-registration'],
                                    ['SMS API', 'sms'],
                                    ['Utility Bills API', 'utility-bills'],
                                    ['USSD for Resellers', 'ussd'],
                                ].map(([name, slug]) => ({
                                    "@type": "Offer",
                                    "itemOffered": {
                                        "@type": "Service",
                                        "name": name,
                                        "url": `https://kingflexygh.com/developers/${slug}`
                                    }
                                }))
                            },
                            "sameAs": [
                                "https://kingflexygh.com",
                                "https://www.kingflexygh.com"
                            ]
                        })
                    }}
                />
                <ThemeProvider
                    attribute="class"
                    defaultTheme="system"
                    enableSystem
                    disableTransitionOnChange
                >
                    <AuthProvider>
                        <PinProvider>
                            <UIProvider>
                                <PageReadyLoader />
                                <OfflineOverlay />
                                {children}
                                <Toaster position="top-right" richColors />
                            </UIProvider>
                        </PinProvider>
                    </AuthProvider>
                </ThemeProvider>
            </body>
        </html>
    )
}
