import type { NextConfig } from 'next'
import withPWAInit from '@ducanh2912/next-pwa'

// Only loaded locally when ANALYZE=true — never required in production builds
const analyzeBundles: (config: NextConfig) => NextConfig =
    process.env.ANALYZE === 'true'
        ? require('@next/bundle-analyzer')({ enabled: true })
        : (config: NextConfig) => config

const withPWA = withPWAInit({
    dest: 'public',
    register: true,
    disable: process.env.NODE_ENV === 'development',
    cacheOnFrontEndNav: false,
    aggressiveFrontEndNavCaching: false,
    reloadOnOnline: true,
    // Fix: Disabling start-URL caching prevents the SWC minifier from
    // generating the broken `_ref.apply(this, arguments)` code block in sw.js
    cacheStartUrl: false,
    dynamicStartUrl: false,
    // Allow a custom worker directory for Web Push Notification handlers
    customWorkerSrc: 'worker',
    // Precached document served when a navigation's network fetch genuinely
    // fails (e.g. NetworkOnly navigations below with no connection). Without
    // this, the SW's fetch handler has nothing to hand back and the browser
    // shows its own raw error page instead of anything on-brand — see
    // app/~offline/page.tsx for the full explanation.
    fallbacks: {
        document: '/~offline',
    },
    workboxOptions: {
        disableDevLogs: true,
        runtimeCaching: [
            // Storefront pages live at the apex of the shop.* subdomain (/<slug>) and are
            // internally rewritten to /shop-domain/<slug>, so they do NOT match the
            // /shop/... rule below. Force ALL top-level document navigations (any path
            // without a file extension) to the network so server-rendered live prices are
            // never served stale from the SW cache. RSC/client navigations (mode !== 'navigate')
            // and hashed assets (with extensions) are unaffected.
            {
                urlPattern: ({ request, url }: { request: Request; url: URL }) =>
                    request.mode === 'navigate' && !/\.[a-z0-9]+$/i.test(url.pathname),
                handler: 'NetworkOnly' as const,
            },
            // NetworkOnly for all auth, dashboard, admin, and shop routes.
            // This prevents session-dependent redirect responses from being
            // cached by the Service Worker, which caused the auth redirect loop.
            {
                urlPattern: /\/(api|auth|dashboard|admin|shop)\/.*/i,
                handler: 'NetworkOnly' as const,
            },
            {
                urlPattern: /\/(api|auth|dashboard|admin|shop)$/i,
                handler: 'NetworkOnly' as const,
            },
        ],
    },
})

const nextConfig: NextConfig = {
    reactStrictMode: true,
    poweredByHeader: false,
    images: {
        domains: ['localhost'],
        remotePatterns: [
            {
                protocol: 'https',
                hostname: '**.supabase.co',
            },
        ],
        minimumCacheTTL: 31536000,
        deviceSizes: [640, 750, 1080, 1920],
        imageSizes: [16, 32, 64, 128, 256],
    },
    experimental: {
        serverActions: {
            bodySizeLimit: '2mb',
        },
    },
    async headers() {
        return [
            // Static assets - cache aggressively
            {
                source: '/_next/static/:path*',
                headers: [
                    {
                        key: 'Cache-Control',
                        value: 'public, max-age=31536000, immutable',
                    },
                ],
            },
            // Images - cache with revalidation
            {
                source: '/:path*\\.(jpg|jpeg|png|gif|svg|webp|ico)',
                headers: [
                    {
                        key: 'Cache-Control',
                        value: 'public, max-age=86400, stale-while-revalidate',
                    },
                ],
            },
            // PWA Files - Must be cacheable for installation to succeed
            {
                source: '/(manifest\\.json|sw\\.js|workbox-.*\\.js)',
                headers: [
                    {
                        key: 'Cache-Control',
                        value: 'public, max-age=0, must-revalidate',
                    },
                ],
            },
            // Dynamic pages and API routes - no cache for user-specific content.
            // Negative lookahead excludes hashed/static assets and PWA files so the
            // immutable/long-cache rules above are NOT clobbered (they share the
            // Cache-Control key, and a later matching rule would otherwise win).
            {
                source: '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:js|css|map|png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|json|txt|xml|webmanifest)$).*)',
                headers: [
                    // Cache Control
                    {
                        key: 'Cache-Control',
                        value: 'no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate',
                    },
                    {
                        key: 'Pragma',
                        value: 'no-cache',
                    },
                    {
                        key: 'Expires',
                        value: '0',
                    },
                    // Security Headers
                    {
                        key: 'X-Frame-Options',
                        value: 'DENY',
                    },
                    {
                        key: 'X-Content-Type-Options',
                        value: 'nosniff',
                    },
                    {
                        key: 'Referrer-Policy',
                        value: 'strict-origin-when-cross-origin',
                    },
                    {
                        key: 'X-XSS-Protection',
                        value: '1; mode=block',
                    },
                    {
                        key: 'Permissions-Policy',
                        value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
                    },
                    {
                        key: 'Strict-Transport-Security',
                        value: 'max-age=31536000; includeSubDomains',
                    },
                    {
                        key: 'Content-Security-Policy',
                        value: [
                            "default-src 'self'",
                            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.paystack.co",
                            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
                            "font-src 'self' https://fonts.gstatic.com",
                            "img-src 'self' data: https://*.supabase.co https://cdn.jsdelivr.net https://www.transparenttextures.com blob:",
                            "connect-src 'self' https://*.supabase.co https://api.paystack.co wss://*.supabase.co",
                            "frame-src https://js.paystack.co",
                            "frame-ancestors 'none'",
                        ].join('; '),
                    },
                ],
            },
        ]
    },
}

export default analyzeBundles(withPWA(nextConfig))
