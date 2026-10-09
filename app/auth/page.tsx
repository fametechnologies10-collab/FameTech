'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import dynamic from 'next/dynamic'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
const BackgroundBubbles = dynamic(() => import('@/components/background-bubbles').then(m => ({ default: m.BackgroundBubbles })), { ssr: false, loading: () => null })
const WhatsAppCommunityButtons = dynamic(() => import('@/components/whatsapp-community-buttons').then(m => ({ default: m.WhatsAppCommunityButtons })), { ssr: false, loading: () => null })
import { getTrustedDeviceInfo, clearTrustedDevice, getUserDisplayHint } from '@/lib/pin-crypto'
import { cn } from '@/lib/utils'
import {
    Loader2, Mail, Phone, Home, Smartphone, Zap, GraduationCap, Store, ShoppingBag, ArrowUpRight,
} from 'lucide-react'
import { BrandAccentLine } from './_components/shared'
import { PinFirstScreen } from './_components/pin-first-screen'
import { SignInForm } from './_components/sign-in-form'
import { SignUpForm } from './_components/sign-up-form'

// ─── Left brand features (desktop only) ──────────────────────────────────────
const BRAND_FEATURES = [
    { icon: Zap, title: 'Instant Data Bundles', desc: 'MTN, Telecel, AirtelTigo' },
    { icon: Phone, title: 'Airtime & Transfers', desc: 'All networks covered' },
    { icon: GraduationCap, title: 'Results Checkers', desc: 'WASSCE & BECE scratch cards' },
    { icon: Store, title: 'Reseller Programme', desc: 'API access & agent tiers' },
]

// ─── Main auth page ───────────────────────────────────────────────────────────
export default function AuthPage() {
    const searchParams = useSearchParams()
    const tabParam = searchParams.get('tab')
    const oauthError = searchParams.get('error')
    const reason = searchParams.get('reason')
    const router = useRouter()

    // A single notice for redirect-driven states so the user always knows WHY
    // they landed here (previously ?reason=session_expired was silently ignored).
    const authNotice: { kind: 'info' | 'error'; text: string } | null =
        reason === 'session_expired'
            ? { kind: 'info', text: 'You were signed out for your security. Please sign in again.' }
        : oauthError === 'access_denied'
            ? { kind: 'error', text: 'Google sign-in was cancelled. Please try again.' }
        : oauthError === 'rate_limited'
            ? { kind: 'error', text: 'Too many attempts from your network. Please wait a moment and try again.' }
        : oauthError === 'email_exists'
            ? { kind: 'error', text: 'This email is already registered. Please sign in with your password below.' }
        : oauthError
            ? { kind: 'error', text: 'Google sign-in failed. Please try again or use email & password.' }
        : null

    const [mode, setMode] = useState<'initializing' | 'pin-first' | 'tabs'>('initializing')
    const [activeTab, setActiveTab] = useState<'signin' | 'signup'>(tabParam === 'signup' ? 'signup' : 'signin')
    const [emailHint, setEmailHint] = useState('')
    const [firstName, setFirstName] = useState('')
    const [googleLoading, setGoogleLoading] = useState(false)

    useEffect(() => {
        const init = async () => {
            const displayHint = getUserDisplayHint()
            const info = getTrustedDeviceInfo()
            if (info) {
                setEmailHint(info.emailHint)
                if (displayHint?.firstName) setFirstName(displayHint.firstName)
                setMode('pin-first')
            } else {
                setMode('tabs')
            }
        }
        init()
    }, [])

    const handleSwitchAccount = useCallback(() => {
        clearTrustedDevice()
        setMode('tabs')
    }, [])

    const handleUsePassword = useCallback(() => {
        setMode('tabs')
        setActiveTab('signin')
    }, [])

    const handleTabChange = (tab: 'signin' | 'signup') => {
        setActiveTab(tab)
        window.history.replaceState(null, '', tab === 'signup' ? '/auth?tab=signup' : '/auth')
    }

    // ── Initialising ──────────────────────────────────────────────────────────
    if (mode === 'initializing') {
        return (
            <div className="relative min-h-screen w-full flex items-center justify-center">
                <BackgroundBubbles scrollable />
                <Loader2 className="w-7 h-7 animate-spin text-[#0056B3]" />
            </div>
        )
    }

    // ── PIN-first screen ──────────────────────────────────────────────────────
    if (mode === 'pin-first') {
        return (
            <div className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 py-10 overflow-y-auto">
                <BackgroundBubbles scrollable />
                <div className="absolute top-4 left-4 sm:top-6 sm:left-6 z-50">
                    <Button asChild variant="ghost" size="sm" className="font-bold gap-2 rounded-full text-slate-700 dark:text-slate-200">
                        <Link href="/">
                            <Home className="w-4 h-4" />
                            <span className="hidden sm:inline text-sm">Home</span>
                        </Link>
                    </Button>
                </div>
                <div className="relative z-10 w-full flex flex-col items-center">
                    <Link href="/" className="inline-flex flex-col items-center mb-8">
                        <div className="relative w-16 h-16 mb-2 rounded-full overflow-hidden flex items-center justify-center bg-white dark:bg-slate-800 shadow-xl border-[3px] border-[#FFCC00]">
                            <BrandLogo width={60} height={60} />
                        </div>
                        <BrandTitle className="text-base font-black tracking-tight" />
                    </Link>
                    <PinFirstScreen
                        emailHint={emailHint}
                        firstName={firstName}
                        onSwitchAccount={handleSwitchAccount}
                        onUsePassword={handleUsePassword}
                    />
                </div>
            </div>
        )
    }

    // ── Tab view — desktop split layout ───────────────────────────────────────
    return (
        <div className="relative min-h-screen w-full overflow-y-auto">
            <BackgroundBubbles scrollable />

            {/* Home button */}
            <div className="absolute top-4 left-4 sm:top-6 sm:left-6 z-50">
                <Button asChild variant="ghost" size="sm" className="font-bold gap-2 rounded-full text-slate-700 dark:text-slate-200 hover:bg-white/70 dark:hover:bg-slate-800/70">
                    <Link href="/">
                        <Home className="w-4 h-4" />
                        <span className="hidden sm:inline text-sm">Home</span>
                    </Link>
                </Button>
            </div>

            <div className="relative z-10 flex flex-col lg:flex-row min-h-screen">

                {/* ── LEFT: Brand panel (lg+) ── */}
                <div className="hidden lg:flex flex-col justify-center px-12 xl:px-16 py-16 w-[420px] xl:w-[460px] shrink-0 border-r border-slate-200/60 dark:border-slate-700/40 bg-white/30 dark:bg-slate-900/20 backdrop-blur-sm">
                    <Link href="/" className="flex flex-col items-start mb-10">
                        <div className="relative w-14 h-14 rounded-full overflow-hidden flex items-center justify-center bg-white dark:bg-slate-800 shadow-xl border-[3px] border-[#FFCC00] mb-3">
                            <BrandLogo width={52} height={52} />
                        </div>
                        <BrandTitle className="text-xl font-black tracking-tight" />
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 font-medium leading-snug max-w-[240px]">
                            Ghana&apos;s All-In-One Mobile Data &amp; Reseller Platform
                        </p>
                    </Link>

                    <div className="space-y-5 mb-10">
                        {BRAND_FEATURES.map(({ icon: Icon, title, desc }) => (
                            <div key={title} className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-xl bg-[#0056B310] dark:bg-[#0056B320] flex items-center justify-center shrink-0">
                                    <Icon className="w-[18px] h-[18px] text-[#0056B3]" />
                                </div>
                                <div>
                                    <p className="text-sm font-bold text-slate-800 dark:text-slate-100 leading-none">{title}</p>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{desc}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    <WhatsAppCommunityButtons compact />
                </div>

                {/* ── RIGHT: Form panel ── */}
                <div className="flex-1 flex flex-col items-center justify-center px-4 sm:px-8 py-10 lg:py-16">
                    <div className="w-full max-w-[420px]">

                        {/* Logo — mobile only */}
                        <Link href="/" className="flex flex-col items-center w-full mb-6 lg:hidden">
                            <div className="relative w-16 h-16 mb-2 rounded-full overflow-hidden flex items-center justify-center bg-white dark:bg-slate-800 shadow-xl border-[3px] border-[#FFCC00]">
                                <BrandLogo width={60} height={60} />
                            </div>
                            <BrandTitle className="text-base font-black tracking-tight" />
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-medium text-center">
                                Ghana&apos;s All-In-One Mobile Data &amp; Reseller Platform
                            </p>
                        </Link>

                        {authNotice && (
                            <Alert variant="destructive" className={cn(
                                'mb-4 py-2 w-full',
                                authNotice.kind === 'info' ? 'bg-amber-500/10 border-amber-500/40' : 'bg-red-500/10 border-red-500/40'
                            )}>
                                <AlertDescription className={cn('text-sm', authNotice.kind === 'info' ? 'text-amber-600' : 'text-red-600')}>
                                    {authNotice.text}
                                </AlertDescription>
                            </Alert>
                        )}

                        {/* Tab switcher */}
                        <div className="w-full flex mb-4 p-1 rounded-2xl bg-white/70 dark:bg-slate-800/70 backdrop-blur border border-white/60 dark:border-slate-700/50 shadow-sm">
                            {(['signin', 'signup'] as const).map(tab => (
                                <button
                                    key={tab}
                                    type="button"
                                    onClick={() => handleTabChange(tab)}
                                    className={cn(
                                        'flex-1 h-9 rounded-xl text-sm font-bold transition-all duration-200',
                                        activeTab === tab
                                            ? 'text-white shadow-md bg-gradient-to-br from-[#0056B3] to-[#00B4D8]'
                                            : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                                    )}
                                >
                                    {tab === 'signin' ? 'Sign In' : 'Create Account'}
                                </button>
                            ))}
                        </div>

                        {/* Form card */}
                        <Card className="w-full border border-white/60 dark:border-slate-700/50 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl shadow-[0_24px_64px_rgba(0,0,0,0.12)] dark:shadow-[0_24px_64px_rgba(0,0,0,0.5)] rounded-2xl overflow-hidden">
                            <BrandAccentLine />
                            <CardContent className="p-5 sm:p-6">
                                {activeTab === 'signin' ? (
                                    <SignInForm
                                        onGoogleLoading={setGoogleLoading}
                                        googleLoading={googleLoading}
                                    />
                                ) : (
                                    <SignUpForm
                                        onGoogleLoading={setGoogleLoading}
                                        googleLoading={googleLoading}
                                    />
                                )}
                            </CardContent>
                        </Card>

                        {/* Secondary CTAs */}
                        <div className="mt-4 w-full grid grid-cols-2 gap-2">
                            <Button asChild variant="outline"
                                className="h-10 text-xs font-bold rounded-xl border-slate-200 dark:border-slate-700 shadow-sm">
                                <Link href="/download">
                                    <Smartphone className="w-3.5 h-3.5 mr-1.5" />Get Our App
                                </Link>
                            </Button>
                            <a
                                href="https://fametechgh.com/shop/felix-s-shop"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="h-10 flex items-center justify-center gap-1.5 text-xs font-bold rounded-xl px-3 bg-gradient-to-br from-amber-500 to-orange-500 text-white shadow-sm hover:shadow-md hover:from-amber-400 hover:to-orange-400 active:scale-[0.98] transition-all duration-200"
                            >
                                <ShoppingBag className="w-3.5 h-3.5" />
                                Shop as Guest
                                <ArrowUpRight className="w-3 h-3 opacity-80" />
                            </a>
                        </div>

                        {/* WhatsApp — mobile only */}
                        <div className="mt-4 lg:hidden w-full border-t border-slate-200/60 dark:border-slate-700/40 pt-4">
                            <WhatsAppCommunityButtons compact />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
