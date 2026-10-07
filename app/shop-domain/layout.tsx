import { Metadata } from 'next'

export const metadata: Metadata = {
    metadataBase: new URL('https://shop.fametechgh.com'),
    title: 'FameTech Stores — Find a Shop | Buy Cheap Data Bundles Ghana',
    description: 'Discover and shop from FameTech reseller stores. Buy affordable MTN, Telecel, and AirtelTigo data bundles, airtime, and mashup online in Ghana. Instantly purchase WAEC & BECE Results Checker vouchers, complete MTN AFA Registrations, and integrate our powerful Developer API. Fast, secure, and reliable digital solutions — FameTech, Powering Digital Services in Ghana.',
    keywords: [
        'data bundle shop Ghana', 'find data shop', 'FameTech Stores',
        'Fame Technologies', 'data reseller shops Ghana', 'buy cheap data Ghana',
        'cheap data bundles Ghana', 'online data store Ghana', 'buy airtime Ghana',
        'MTN data shop', 'Telecel data shop', 'AirtelTigo data shop',
        'buy result checker', 'buy waec results checker', 'bece results checker online',
        'buy mashup bundles', 'developer api ghana', 'mtn afa registration ghana'
    ],
    alternates: {
        canonical: 'https://shop.fametechgh.com',
    },
    openGraph: {
        title: 'FameTech Stores — Find a Shop | Buy Cheap Data Bundles Ghana',
        description: 'Discover and shop from FameTech reseller stores. Buy affordable data, airtime, mashup, and results checker vouchers. Powering Digital Services in Ghana.',
        images: [
            {
                url: '/logo.png',
                width: 1200,
                height: 630,
                alt: 'FameTech Stores',
            }
        ],
        type: 'website',
        url: 'https://shop.fametechgh.com',
        siteName: 'FameTech Stores',
    },
    twitter: {
        card: 'summary_large_image',
        title: 'FameTech Stores — Find a Shop | Buy Cheap Data Bundles Ghana',
        description: 'Discover and shop from FameTech reseller stores. Buy affordable data, airtime, mashup, and results checker vouchers. Powering Digital Services in Ghana.',
        images: ['/logo.png'],
    },
}
