'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import {
    Download, Smartphone, Monitor, Shield, Zap, Clock,
    ArrowLeft, Share, Plus, MoreVertical, Apple, Chrome,
    CheckCircle2, Fingerprint, Globe,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { BrandTitle, BrandLogo } from '@/components/ui/brand'

type Platform = 'ios' | 'android' | 'windows' | 'unknown'

function detectPlatform(): Platform {
    if (typeof navigator === 'undefined') return 'unknown'
    const ua = navigator.userAgent.toLowerCase()
    if (/iphone|ipad|ipod/.test(ua)) return 'ios'
    if (/android/.test(ua)) return 'android'
    if (/windows/.test(ua)) return 'windows'
    return 'unknown'
}

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export default function DownloadPage() {
    const [platform, setPlatform] = useState<Platform>('unknown')
    const [activeTab, setActiveTab] = useState<'ios' | 'android' | 'windows'>('android')
    const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
    const [isInstalled, setIsInstalled] = useState(false)

    useEffect(() => {
        const detected = detectPlatform()
        setPlatform(detected)
        if (detected === 'ios') setActiveTab('ios')
        else if (detected === 'windows') setActiveTab('windows')
        else setActiveTab('android')

        // Check if already installed
        if (window.matchMedia('(display-mode: standalone)').matches ||
            (window.navigator as any).standalone === true) {
            setIsInstalled(true)
        }
    }, [])

    useEffect(() => {
        const handler = (e: Event) => {
            e.preventDefault()
            setDeferredPrompt(e as BeforeInstallPromptEvent)
        }
        window.addEventListener('beforeinstallprompt', handler)
        window.addEventListener('appinstalled', () => {
            setIsInstalled(true)
            setDeferredPrompt(null)
        })
        return () => window.removeEventListener('beforeinstallprompt', handler)
    }, [])

    const handleInstall = async () => {
        if (deferredPrompt) {
            await deferredPrompt.prompt()
            const { outcome } = await deferredPrompt.userChoice
            if (outcome === 'accepted') setIsInstalled(true)
            setDeferredPrompt(null)
        } else {
            // Fallback: Scroll to instructions if native prompt isn't ready
            const instructions = document.getElementById('instructions-section')
            if (instructions) instructions.scrollIntoView({ behavior: 'smooth' })
            else alert('To install, please look for the install icon in your browser address bar or use the browser menu.')
        }
    }

    const features = [
        {
            icon: Fingerprint,
            title: '6-Digit PIN Login',
            description: 'Skip your email and password. Tap 6 digits to unlock.',
            gradient: 'from-blue-500 to-indigo-600',
        },
        {
            icon: Zap,
            title: 'Lightning Fast',
            description: 'Loads instantly from your device. Works even on slow networks.',
            gradient: 'from-amber-500 to-orange-500',
        },
        {
            icon: Shield,
            title: 'Secure & Private',
            description: 'Your data stays on your device. No app store tracking.',
            gradient: 'from-emerald-500 to-teal-500',
        },
        {
            icon: Clock,
            title: 'Always Updated',
            description: 'No manual updates needed. Always the latest version.',
            gradient: 'from-purple-500 to-pink-500',
        },
    ]

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 transition-colors">
            {/* Header */}
            <div className="fixed top-0 left-0 w-full z-50 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800">
                <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
                    <Link href="/" className="flex items-center gap-2.5">
                        <ArrowLeft className="w-5 h-5 text-slate-600 dark:text-slate-400" />
                        <BrandLogo width={32} height={32} />
                        <BrandTitle className="text-sm font-black" />
                    </Link>
                    <ThemeToggle />
                </div>
            </div>

            <div className="pt-20 pb-16 px-4 max-w-4xl mx-auto">
                {/* Hero */}
                <section className="text-center mb-16 animate-in fade-in slide-in-from-bottom-4 duration-700">
                    <div className="relative w-24 h-24 mx-auto mb-6 rounded-full overflow-hidden shadow-2xl shadow-blue-500/20">
                        <BrandLogo fill className="w-full h-full" />
                    </div>

                    <h1 className="text-3xl sm:text-4xl font-black text-slate-900 dark:text-white mb-3">
                        Get the <BrandTitle /> App
                    </h1>
                    <p className="text-slate-600 dark:text-slate-400 max-w-md mx-auto text-sm sm:text-base">
                        Install directly to your phone or computer. No app store needed. Always free, always updated.
                    </p>

                    {/* Install CTA */}
                    <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                        {isInstalled ? (
                            <div className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 font-bold border border-emerald-200 dark:border-emerald-800/30">
                                <CheckCircle2 className="w-5 h-5" />
                                App Already Installed
                            </div>
                        ) : (
                            <Button
                                onClick={handleInstall}
                                size="lg"
                                className="bg-[#0056B3] hover:bg-[#004494] text-white font-bold px-8 rounded-xl shadow-lg shadow-blue-500/25 h-12 text-base"
                            >
                                <Download className="w-5 h-5 mr-2" />
                                Install <BrandTitle className="text-inherit" />
                            </Button>
                        )}
                    </div>
                </section>

                {/* Features Grid */}
                <section className="mb-16">
                    <h2 className="text-xl font-black text-slate-900 dark:text-white text-center mb-8">
                        Why Install the App?
                    </h2>
                    <div className="grid grid-cols-2 gap-3 sm:gap-4">
                        {features.map((f) => (
                            <div key={f.title} className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 sm:p-5 shadow-sm">
                                <div className={cn('w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center mb-3', f.gradient)}>
                                    <f.icon className="w-5 h-5 text-white" />
                                </div>
                                <h3 className="text-sm font-bold text-slate-900 dark:text-white mb-1">{f.title}</h3>
                                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{f.description}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Installation Tutorials */}
                <section className="mb-16">
                    <h2 className="text-xl font-black text-slate-900 dark:text-white text-center mb-2">
                        How to Install
                    </h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 text-center mb-8">
                        Choose your device to see the steps
                    </p>

                    {/* Tab Selector */}
                    <div className="flex items-center justify-center gap-2 mb-8">
                        {[
                            { key: 'ios' as const, label: 'iPhone', icon: Apple },
                            { key: 'android' as const, label: 'Android', icon: Smartphone },
                            { key: 'windows' as const, label: 'Windows', icon: Monitor },
                        ].map((tab) => (
                            <button
                                key={tab.key}
                                onClick={() => setActiveTab(tab.key)}
                                className={cn(
                                    'flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all duration-200',
                                    activeTab === tab.key
                                        ? 'bg-[#0056B3] text-white shadow-md shadow-blue-500/20'
                                        : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:border-[#0056B3]/30'
                                )}
                            >
                                <tab.icon className="w-4 h-4" />
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    {/* Tutorial Content */}
                    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 sm:p-8 shadow-sm">
                        {activeTab === 'ios' && (
                            <div className="space-y-6 animate-in fade-in duration-300">
                                <div className="flex items-center gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
                                    <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                                        <Apple className="w-5 h-5 text-slate-700 dark:text-slate-300" />
                                    </div>
                                    <div>
                                        <h3 className="font-black text-slate-900 dark:text-white">iPhone / iPad</h3>
                                        <p className="text-xs text-slate-500 dark:text-slate-400">Safari browser required</p>
                                    </div>
                                </div>

                                <div className="space-y-5">
                                    <StepItem step={1} title="Open in Safari">
                                        Make sure you are viewing this page in <strong>Safari</strong>. Other browsers like Chrome on iPhone do not support installation.
                                    </StepItem>
                                    <StepItem step={2} title="Tap the Share button">
                                        Look at the <strong>bottom of the screen</strong> for the Share button (the square with an arrow pointing up). Tap it.
                                    </StepItem>
                                    <StepItem step={3} title="Add to Home Screen">
                                        Scroll down the Share menu and tap <strong>&quot;Add to Home Screen&quot;</strong>.
                                    </StepItem>
                                    <StepItem step={4} title='Tap "Add"'>
                                        Tap <strong>&quot;Add&quot;</strong> in the top-right corner. The app icon will now appear on your home screen!
                                    </StepItem>
                                </div>

                                <div className="p-3 rounded-xl bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/30">
                                    <p className="text-xs text-blue-700 dark:text-blue-400 font-medium">
                                        <strong>Tip:</strong> When the app opens from your home screen, it will run in full-screen mode without Safari&apos;s address bar — just like a real app!
                                    </p>
                                </div>
                            </div>
                        )}

                        {activeTab === 'android' && (
                            <div className="space-y-6 animate-in fade-in duration-300">
                                <div className="flex items-center gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
                                    <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center">
                                        <Smartphone className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                                    </div>
                                    <div>
                                        <h3 className="font-black text-slate-900 dark:text-white">Android</h3>
                                        <p className="text-xs text-slate-500 dark:text-slate-400">Chrome or Samsung Internet</p>
                                    </div>
                                </div>

                                <div className="space-y-5">
                                    <StepItem step={1} title="Look for the Install Banner">
                                        When you visit the site, look for the <strong>&quot;Install App&quot;</strong> button at the top of the page or a banner at the bottom.
                                    </StepItem>
                                    <StepItem step={2} title='Tap "Install"'>
                                        A system prompt will appear asking if you want to install the app. Tap <strong>&quot;Install&quot;</strong>.
                                    </StepItem>
                                    <StepItem step={3} title="Alternative Method">
                                        Tap the <strong>three-dot menu (⋮)</strong> at the top-right corner of Chrome and select <strong>&quot;Install app&quot;</strong> or <strong>&quot;Add to Home screen&quot;</strong>.
                                    </StepItem>
                                </div>

                                {deferredPrompt && (
                                    <div className="pt-4 border-t border-slate-100 dark:border-slate-800 text-center space-y-3">
                                        <p className="text-sm text-emerald-600 dark:text-emerald-400 font-bold">
                                            Your browser is ready for one-tap install!
                                        </p>
                                        <Button
                                            onClick={handleInstall}
                                            className="w-full sm:w-auto bg-[#0056B3] hover:bg-[#004494] text-white font-bold px-8 rounded-xl shadow-lg h-12 text-base"
                                        >
                                            <Download className="w-5 h-5 mr-2" />
                                            Install App Now
                                        </Button>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'windows' && (
                            <div className="space-y-6 animate-in fade-in duration-300">
                                <div className="flex items-center gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
                                    <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center">
                                        <Monitor className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                                    </div>
                                    <div>
                                        <h3 className="font-black text-slate-900 dark:text-white">Windows / Mac</h3>
                                        <p className="text-xs text-slate-500 dark:text-slate-400">Chrome or Microsoft Edge</p>
                                    </div>
                                </div>

                                <div className="space-y-5">
                                    <StepItem step={1} title="Look for the Install Icon">
                                        In Chrome or Edge, look at the <strong>right side of the address bar</strong>. You will see an install icon (a small screen with a downward arrow).
                                    </StepItem>
                                    <StepItem step={2} title='Click "Install"'>
                                        Click the icon and select <strong>&quot;Install&quot;</strong>. The app will be added to your desktop and Start menu.
                                    </StepItem>
                                    <StepItem step={3} title="Launch Like Any App">
                                        Find <strong>KiNG FLEXY GH</strong> in your Start menu or desktop and launch it. It will open in its own window — no browser UI!
                                    </StepItem>
                                </div>

                                 <div className="pt-4 border-t border-slate-100 dark:border-slate-800 text-center space-y-3">
                                        <p className="text-sm text-blue-600 dark:text-blue-400 font-bold">
                                            {deferredPrompt ? 'Your browser is ready for one-tap install!' : 'Click to install or follow instructions above'}
                                        </p>
                                        <Button
                                            onClick={handleInstall}
                                            className="w-full sm:w-auto bg-[#0056B3] hover:bg-[#004494] text-white font-bold px-8 rounded-xl shadow-lg h-12 text-base"
                                        >
                                            <Download className="w-5 h-5 mr-2" />
                                            Install App Now
                                        </Button>
                                    </div>
                            </div>
                        )}
                    </div>
                </section>

                {/* Share Section */}
                <section className="text-center mb-12">
                    <div className="bg-gradient-to-br from-[#0056B3] to-[#00B4D8] rounded-2xl p-6 sm:p-8 text-white relative overflow-hidden">
                        <div className="absolute inset-0 opacity-10 bg-[url('/carbon-fibre.png')]" />
                        <div className="relative z-10">
                            <Globe className="w-10 h-10 mx-auto mb-4 opacity-80" />
                            <h2 className="text-xl sm:text-2xl font-black mb-2">Share with Friends</h2>
                            <p className="text-white/80 text-sm max-w-sm mx-auto mb-6">
                                No APK downloads needed. Just share this link and they can install instantly from their browser!
                            </p>
                            <div className="bg-white/10 backdrop-blur-sm rounded-xl px-4 py-3 inline-flex items-center gap-2 text-sm font-mono">
                                <span>kingflexygh.com/download</span>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Back to Home */}
                <div className="text-center">
                    <Link href="/">
                        <Button variant="ghost" className="font-semibold text-slate-500 dark:text-slate-400">
                            <ArrowLeft className="w-4 h-4 mr-2" />
                            Back to <BrandTitle className="text-inherit" />
                        </Button>
                    </Link>
                </div>
            </div>
        </div>
    )
}

// ─── Step Item Component ───
function StepItem({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
    return (
        <div className="flex items-start gap-4">
            <div className="w-8 h-8 rounded-lg bg-[#0056B3]/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-xs font-black text-[#0056B3]">{step}</span>
            </div>
            <div>
                <p className="text-sm font-bold text-slate-900 dark:text-white mb-1">{title}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{children}</p>
            </div>
        </div>
    )
}
