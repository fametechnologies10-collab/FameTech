'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Download, X, Share, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import Image from 'next/image'

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type Platform = 'ios' | 'android' | 'windows' | 'mac' | 'unknown'

function detectPlatform(): Platform {
    if (typeof navigator === 'undefined') return 'unknown'
    const ua = navigator.userAgent.toLowerCase()
    if (/iphone|ipad|ipod/.test(ua)) return 'ios'
    if (/android/.test(ua)) return 'android'
    if (/windows/.test(ua)) return 'windows'
    if (/macintosh|mac os/.test(ua)) return 'mac'
    return 'unknown'
}

function isStandalone(): boolean {
    if (typeof window === 'undefined') return false
    return (
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as any).standalone === true
    )
}

// ─── iOS Manual Instructions Modal ───────────────────────────────────────────
// Only shown on iOS/Safari where the browser doesn't support beforeinstallprompt.
function IOSInstallInstructions({ onClose }: { onClose: () => void }) {
    return (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-t-3xl sm:rounded-3xl p-6 pb-8 shadow-2xl border-t border-slate-200 dark:border-slate-800 animate-in slide-in-from-bottom-8 duration-300">
                <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-black text-slate-900 dark:text-white">Install KiNGFLEXYGH</h3>
                    <button onClick={onClose} title="Close" className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                        <X className="w-5 h-5 text-slate-500" />
                    </button>
                </div>
                <div className="space-y-5">
                    <div className="flex items-start gap-4">
                        <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center flex-shrink-0">
                            <span className="text-sm font-black text-blue-600">1</span>
                        </div>
                        <div>
                            <p className="text-sm font-bold text-slate-900 dark:text-white">
                                Tap the <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-xs font-mono"><Share className="w-3 h-3" /> Share</span> button
                            </p>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                At the bottom of Safari (the square with an arrow pointing up)
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-4">
                        <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center flex-shrink-0">
                            <span className="text-sm font-black text-blue-600">2</span>
                        </div>
                        <div>
                            <p className="text-sm font-bold text-slate-900 dark:text-white">
                                Scroll down and tap <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-xs font-mono"><Plus className="w-3 h-3" /> Add to Home Screen</span>
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-4">
                        <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center flex-shrink-0">
                            <span className="text-sm font-black text-emerald-600">3</span>
                        </div>
                        <div>
                            <p className="text-sm font-bold text-slate-900 dark:text-white">
                                Tap <span className="font-black text-emerald-600">&quot;Add&quot;</span> in the top right corner
                            </p>
                        </div>
                    </div>
                    <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30">
                        <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
                            <strong>Tip:</strong> Make sure you&apos;re using Safari. Other browsers on iPhone don&apos;t support Add to Home Screen.
                        </p>
                    </div>
                </div>
                <Button onClick={onClose} className="w-full mt-6 h-11 bg-[#0056B3] hover:bg-[#004494] text-white font-bold rounded-xl">
                    Got it!
                </Button>
            </div>
        </div>
    )
}

// ─── Main PWA Install Prompt (Floating Banner) ────────────────────────────────
export function PWAInstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
    const [showIOSModal, setShowIOSModal] = useState(false)
    const [showBanner, setShowBanner] = useState(false)
    const [platform, setPlatform] = useState<Platform>('unknown')
    const [isInstalled, setIsInstalled] = useState(false)

    useEffect(() => {
        const p = detectPlatform()
        setPlatform(p)
        if (isStandalone()) {
            setIsInstalled(true)
            return
        }

        try {
            const dismissed = localStorage.getItem('kfg_pwa_banner_dismissed')
            if (dismissed) {
                const dismissedAt = parseInt(dismissed, 10)
                if (Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000) return
            }
        } catch {}

        // For iOS: show banner immediately (we'll show instructions on click)
        // For Android/Windows: banner only shows AFTER the browser fires beforeinstallprompt
        if (p === 'ios') {
            const timer = setTimeout(() => setShowBanner(true), 3000)
            return () => clearTimeout(timer)
        }
        // Android/Windows: banner is shown from the beforeinstallprompt handler below
    }, [])

    // Dispatch visibility event for WhatsApp button coordination
    useEffect(() => {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('pwa-prompt-visibility', { detail: { isVisible: showBanner } }))
        }
    }, [showBanner])

    // Listen for the native install event — Android/Windows/Chrome only
    useEffect(() => {
        const handler = (e: Event) => {
            e.preventDefault()
            const prompt = e as BeforeInstallPromptEvent
            setDeferredPrompt(prompt)
            // Only show banner now that we KNOW the native prompt is available
            try {
                const dismissed = localStorage.getItem('kfg_pwa_banner_dismissed')
                if (dismissed) {
                    const dismissedAt = parseInt(dismissed, 10)
                    if (Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000) return
                }
            } catch {}
            setShowBanner(true)
        }

        window.addEventListener('beforeinstallprompt', handler)
        window.addEventListener('appinstalled', () => {
            setIsInstalled(true)
            setShowBanner(false)
            setDeferredPrompt(null)
        })

        return () => window.removeEventListener('beforeinstallprompt', handler)
    }, [])

    const handleInstallClick = useCallback(async () => {
        // iOS: show manual instructions (no native prompt available)
        if (platform === 'ios') {
            setShowIOSModal(true)
            return
        }

        // Android/Windows: fire the native browser prompt directly
        if (deferredPrompt) {
            try {
                await deferredPrompt.prompt()
                const { outcome } = await deferredPrompt.userChoice
                if (outcome === 'accepted') {
                    setIsInstalled(true)
                    setShowBanner(false)
                }
                setDeferredPrompt(null)
            } catch (e) {
                console.error('PWA Prompt error:', e)
            }
        } else {
            // Fallback if prompt isn't ready
            setShowIOSModal(true)
        }
    }, [platform, deferredPrompt])

    const handleDismiss = useCallback(() => {
        setShowBanner(false)
        try {
            localStorage.setItem('kfg_pwa_banner_dismissed', Date.now().toString())
        } catch {}
    }, [])

    if (isInstalled) return null

    // OS-specific banner text
    let installText = 'Install App'
    let installDesc = 'Install for faster access & offline use'
    if (platform === 'android') {
        installText = 'Install App'
        installDesc = 'Add to your Android home screen'
    } else if (platform === 'windows' || platform === 'mac') {
        installText = 'Install App'
        installDesc = 'Install the desktop app for faster access'
    } else if (platform === 'ios') {
        installText = 'Add to Home Screen'
        installDesc = 'Install via Safari for the best experience'
    }

    return (
        <>
            {/* Floating Install Banner */}
            {showBanner && (
                <div className="fixed bottom-4 left-4 right-4 z-50 animate-in slide-in-from-bottom-6 duration-500 sm:left-auto sm:right-4 sm:max-w-sm">
                    <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 p-4 flex items-center gap-3">
                        <div className="w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 shadow-md">
                            <Image src="/icons/icon-192x192.png" alt="KiNGFLEXYGH" width={48} height={48} className="w-full h-full object-cover" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-black text-slate-900 dark:text-white truncate">KiNGFLEXYGH</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">{installDesc}</p>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                            <Button
                                onClick={handleInstallClick}
                                size="sm"
                                className="bg-[#0056B3] hover:bg-[#004494] text-white font-bold rounded-lg text-xs px-3 h-8"
                            >
                                <Download className="w-3.5 h-3.5 mr-1" />
                                {installText}
                            </Button>
                            <button
                                onClick={handleDismiss}
                                title="Dismiss install banner"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                            >
                                <X className="w-4 h-4 text-slate-400" />
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* iOS-only Instructions Modal */}
            {showIOSModal && <IOSInstallInstructions onClose={() => setShowIOSModal(false)} />}
        </>
    )
}

// ─── Navbar/Sidebar Install Button (compact) ──────────────────────────────────
export function PWAInstallButton({ className }: { className?: string }) {
    const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
    const [showIOSModal, setShowIOSModal] = useState(false)
    const [platform, setPlatform] = useState<Platform>('unknown')
    const [isInstalled, setIsInstalled] = useState(false)

    useEffect(() => {
        setPlatform(detectPlatform())
        setIsInstalled(isStandalone())
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

    const handleClick = async () => {
        if (platform === 'ios') {
            setShowIOSModal(true)
            return
        }
        if (deferredPrompt) {
            try {
                await deferredPrompt.prompt()
                const { outcome } = await deferredPrompt.userChoice
                if (outcome === 'accepted') setIsInstalled(true)
                setDeferredPrompt(null)
            } catch (e) {
                console.error('PWA Prompt error:', e)
            }
        } else {
            // On Windows/Mac with no native prompt, show a browser-specific tip
            setShowIOSModal(true)
        }
    }

    if (isInstalled) return null

    return (
        <>
            <Button
                onClick={handleClick}
                variant="outline"
                size="sm"
                className={cn(
                    'border-[#0056B3]/30 text-[#0056B3] hover:bg-[#0056B3]/10 font-bold gap-1.5 rounded-full text-xs',
                    className
                )}
            >
                <Download className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Install App</span>
                <span className="sm:hidden">App</span>
            </Button>
            {showIOSModal && <IOSInstallInstructions onClose={() => setShowIOSModal(false)} />}
        </>
    )
}
