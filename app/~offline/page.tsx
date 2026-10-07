import Link from 'next/link'

// Precached document fallback for the service worker.
//
// Wired via `fallbacks.document` in next.config.ts's withPWAInit() options.
// @ducanh2912/next-pwa automatically attaches a `handlerDidError` plugin to
// EVERY runtimeCaching route entry (including our NetworkOnly navigation
// rule) that serves this precached page whenever a navigation's network
// fetch genuinely fails — this is what was missing before: a NetworkOnly
// navigation with no network gave the browser nothing to render, which is
// why Safari showed its own raw "FetchEvent.respondWith received an error"
// system page instead of anything on-brand.
//
// This is a normal nested page (NOT a root layout — only app/layout.tsx may
// declare <html>/<body>), so it renders inside the existing app shell
// (ThemeProvider/AuthProvider/OfflineOverlay/etc.) exactly like any other
// route. That's intentional, not a gap: AuthProvider's init already
// timeout-guards and catches failures (see contexts/auth-context.tsx), so it
// degrades safely with zero network, and components/offline-overlay.tsx will
// take over this exact same message as soon as React hydrates and detects
// `navigator.onLine === false` — this page's own static markup only needs to
// cover the brief pre-hydration paint from the precached HTML, not stay
// visible forever. It intentionally mirrors OfflineOverlay's copy/branding 1:1
// so the handoff between the two is seamless.
export default function OfflinePage() {
    return (
        <div className="fixed inset-0 z-[99999] bg-[#090D14] flex items-center justify-center p-4 select-none">
            <div className="w-full max-w-[420px] rounded-3xl border border-slate-900 bg-[#0F131C] p-8 sm:p-10 shadow-2xl flex flex-col items-center text-center space-y-6">
                <div className="w-20 h-20 rounded-full bg-slate-900/50 flex items-center justify-center border border-slate-800">
                    <svg className="w-10 h-10 text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
                        <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
                        <circle cx="12" cy="12" r="2" />
                        <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
                        <path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1" />
                    </svg>
                </div>

                <div className="space-y-2">
                    <span className="text-xs font-black uppercase tracking-[0.25em] text-violet-500 block">
                        KiNG FLEXY GH
                    </span>
                    <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
                        You&apos;re Offline
                    </h1>
                </div>

                <p className="text-sm text-slate-450 leading-relaxed font-medium">
                    No internet connection detected. Check your data or Wi-Fi and try again — your session is still safe.
                </p>

                <Link
                    href="/"
                    className="w-full h-12 rounded-full bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm tracking-wide shadow-lg shadow-violet-500/20 active:scale-95 transition-all flex items-center justify-center"
                >
                    Try Again
                </Link>

                <p className="text-[11px] text-slate-600 font-semibold leading-normal pt-2">
                    Your wallet balance and order history will load once you&apos;re back online.
                </p>
            </div>
        </div>
    )
}
