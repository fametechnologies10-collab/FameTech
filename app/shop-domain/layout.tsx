import { Metadata } from 'next'

export const metadata: Metadata = {
    metadataBase: new URL('https://shop.kingflexygh.com'),
    title: 'KiNG FLEXY GH Stores — Find a Shop | Buy Cheap Data Bundles Ghana',
    description: 'Discover and shop from KiNG FLEXY GH reseller stores. Buy affordable MTN, Telecel, and AirtelTigo data bundles, airtime, and mashup online in Ghana. Instantly purchase WAEC & BECE Results Checker vouchers, complete MTN AFA Registrations, and integrate our powerful Developer API. Fast, secure, and reliable digital solutions — KiNG FLEXY GH, Powering Digital Services in Ghana.',
    keywords: [
        'data bundle shop Ghana', 'find data shop', 'KiNG FLEXY GH Stores',
        'King Flexy Technologies', 'data reseller shops Ghana', 'buy cheap data Ghana',
        'cheap data bundles Ghana', 'online data store Ghana', 'buy airtime Ghana',
        'MTN data shop', 'Telecel data shop', 'AirtelTigo data shop',
        'buy result checker', 'buy waec results checker', 'bece results checker online',
        'buy mashup bundles', 'developer api ghana', 'mtn afa registration ghana'
    ],
    alternates: {
        canonical: 'https://shop.kingflexygh.com',
    },
    openGraph: {
        title: 'KiNG FLEXY GH Stores — Find a Shop | Buy Cheap Data Bundles Ghana',
        description: 'Discover and shop from KiNG FLEXY GH reseller stores. Buy affordable data, airtime, mashup, and results checker vouchers. Powering Digital Services in Ghana.',
        images: [
            {
                url: '/logo.png',
                width: 1200,
                height: 630,
                alt: 'KiNG FLEXY GH Stores',
            }
        ],
        type: 'website',
        url: 'https://shop.kingflexygh.com',
        siteName: 'KiNG FLEXY GH Stores',
    },
    twitter: {
        card: 'summary_large_image',
        title: 'KiNG FLEXY GH Stores — Find a Shop | Buy Cheap Data Bundles Ghana',
        description: 'Discover and shop from KiNG FLEXY GH reseller stores. Buy affordable data, airtime, mashup, and results checker vouchers. Powering Digital Services in Ghana.',
        images: ['/logo.png'],
    },
}

export default function ShopDomainLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return <>{children}</>
}
