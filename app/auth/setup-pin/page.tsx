'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { saveTrustedDevice, clearTrustedDevice, saveUserDisplayHint } from '@/lib/pin-crypto'
import { BackgroundBubbles } from '@/components/background-bubbles'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
import { Card, CardContent } from '@/components/ui/card'
import { Loader2, ShieldCheck, KeyRound, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeNext(next: string | null): string {
    if (!next) return '/dashboard'
    return next.startsWith('/') && !next.startsWith('//') && !next.includes(':') ? next : '/dashboard'
}

// ─── PIN dots ────────────────────────────────────────────────────────────────
function PinDots({ filled, shake }: { filled: number; shake: boolean }) {
    return (
        <div className={cn('flex items-center justify-center gap-4 mb-2', shake && 'animate-shake')}>
            {Array.from({ length: 6 }).map((_, i) => (
                <div
                    key={i}
                    className={cn(
                        'w-4 h-4 rounded-full transition-all duration-200',
                        i < filled
                            ? 'scale-110 bg-[#0056B3] shadow-[0_0_8px_#0056B350]'
                            : 'bg-slate-200 dark:bg-slate-700'
                    )}
                />
            ))}
        </div>
    )
}

// ─── PIN pad ─────────────────────────────────────────────────────────────────
function PinPad({ pin, onChange, isLoading }: { pin: string; onChange: (p: string) => void; isLoading: boolean }) {
    const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0']

    const handlePress = useCallback((d: string) => {
        onChange(pin.length < 6 ? pin + d : pin)
    }, [onChange, pin])

    const handleDelete = useCallback(() => {
        onChange(pin.slice(0, -1))
    }, [onChange, pin])

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (isLoading) return
            if (/^\d$/.test(e.key)) handlePress(e.key)
            else if (e.key === 'Backspace') handleDelete()
        }
        window.addEventListener('keydown', handleKey)
        return () => window.removeEventListener('keydown', handleKey)
    }, [handlePress, handleDelete, isLoading])

    return (
        <div className="grid grid-cols-3 gap-3 w-full mt-4">
            {digits.map((d, i) =>
                d === '' ? (
                    <div key={`empty-${i}`} />
                ) : (
                    <button
                        key={d}
                        type="button"
                        disabled={isLoading || pin.length >= 6}
                        onPointerDown={(e) => { e.preventDefault(); if (!isLoading) handlePress(d) }}
                        className={cn(
                            'touch-manipulation h-16 rounded-2xl flex items-center justify-center select-none',
                            'text-2xl font-bold text-slate-800 dark:text-slate-100',
                            'bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700',
                            'hover:bg-slate-50 dark:hover:bg-slate-700 shadow-sm',
                            'active:scale-90 active:shadow-inner transition-all duration-100',
                            (isLoading || pin.length >= 6) && 'opacity-40 cursor-not-allowed'
                        )}
                    >
                        {d}
                    </button>
                )
            )}
            <button
                type="button"
                aria-label="Delete last digit"
                onPointerDown={(e) => { e.preventDefault(); handleDelete() }}
                disabled={isLoading || pin.length === 0}
                className="touch-manipulation h-16 rounded-2xl flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-90 transition-all duration-100 disabled:opacity-30"
            >
                <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
                    <line x1="18" y1="9" x2="12" y2="15" />
                    <line x1="12" y1="9" x2="18" y2="15" />
                </svg>
            </button>
        </div>
    )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function SetupPinPage() {
    const { dbUser } = useAuth()
    const router = useRouter()
    const searchParams = useSearchParams()
    const nextUrl = safeNext(searchParams.get('next'))

    const [step, setStep] = useState<'enter' | 'confirm' | 'success'>('enter')
    const [firstPin, setFirstPin] = useState('')
    const [pin, setPin] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [shake, setShake] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [password, setPassword] = useState<string | null>(null)

    useEffect(() => {
        try {
            const pw = sessionStorage.getItem('kfg_setup_pw')
            sessionStorage.removeItem('kfg_setup_pw')
            setPassword(pw ?? null)
        } catch {
            setPassword(null)
        }
    }, [])

    // Auto-submit when PIN reaches 6 digits
    useEffect(() => {
        if (pin.length !== 6 || isLoading) return
        if (step === 'enter') {
            setFirstPin(pin)
            setPin('')
            setStep('confirm')
            setError(null)
        } else if (step === 'confirm') {
            submitConfirmed(pin)
        }
    }, [pin, step, isLoading])

    const submitConfirmed = async (confirmedPin: string) => {
        if (confirmedPin !== firstPin) {
            setError("PINs don't match. Please start over.")
            setShake(true)
            setTimeout(() => setShake(false), 500)
            setPin('')
            setFirstPin('')
            setStep('enter')
            return
        }

        setIsLoading(true)
        try {
            const res = await fetch('/api/auth/pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // Forward the account password (collected before this page) so the
                // server can authorize OVERWRITING an existing PIN. First-time setup
                // has no existing PIN, so the server ignores it there.
                body: JSON.stringify({ pin: confirmedPin, action: 'set', ...(password ? { password } : {}) }),
            })
            if (!res.ok) throw new Error()

            try {
                localStorage.setItem('kfg_pin_verified', 'true')
                localStorage.setItem('kfg_pin_verified_at', Date.now().toString())
            } catch {}

            if (password && dbUser?.email) {
                try {
                    clearTrustedDevice()
                    await saveTrustedDevice(dbUser.email, password, confirmedPin)
                    saveUserDisplayHint(dbUser.first_name || '', dbUser.email)
                } catch {
                    console.warn('[SetupPin] Could not save trusted device')
                }
            }

            // Signal PinContext to refresh status
            try { sessionStorage.setItem('kfg_pin_just_set', '1') } catch {}

            setStep('success')
            toast.success('PIN set successfully!')
            setTimeout(() => router.push(nextUrl), 1100)
        } catch {
            setError('Something went wrong. Please try again.')
            setPin('')
            setStep('enter')
            setFirstPin('')
        } finally {
            setIsLoading(false)
        }
    }

    const fullName = [dbUser?.first_name, dbUser?.last_name].filter(Boolean).join(' ') || ''

    const stepLabel = step === 'enter'
        ? 'Create your 6-digit PIN'
        : step === 'confirm'
        ? 'Confirm your PIN'
        : 'PIN created!'

    const stepSub = step === 'enter'
        ? "Choose a PIN you'll remember"
        : step === 'confirm'
        ? 'Enter the same PIN again to confirm'
        : 'Redirecting you now…'

    return (
        <div className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 py-10 overflow-y-auto">
            <BackgroundBubbles scrollable />

            <div className="relative z-10 w-full flex flex-col items-center">
                {/* Logo */}
                <Link href="/" className="inline-flex flex-col items-center mb-6">
                    <div className="relative w-14 h-14 rounded-full overflow-hidden flex items-center justify-center bg-white dark:bg-slate-800 shadow-xl border-[3px] border-[#FFCC00] mb-2">
                        <BrandLogo width={52} height={52} />
                    </div>
                    <BrandTitle className="text-base font-black tracking-tight" />
                </Link>

                {/* Identity block */}
                <div className="flex flex-col items-center mb-5 text-center">
                    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full mb-2 bg-[#0056B315] border border-[#0056B330]">
                        <ShieldCheck className="w-3.5 h-3.5 text-[#0056B3]" />
                        <span className="text-xs font-bold text-[#0056B3]">Trusted Device</span>
                    </div>
                    <p className="text-lg font-black text-slate-900 dark:text-white">
                        {fullName ? `Hi, ${fullName}! 👋` : 'Welcome back'}
                    </p>
                </div>

                {step === 'success' ? (
                    <div className="flex flex-col items-center gap-3 text-center">
                        <div className="w-16 h-16 rounded-full flex items-center justify-center bg-gradient-to-br from-emerald-400 to-green-500 shadow-lg">
                            <CheckCircle2 className="w-8 h-8 text-white" />
                        </div>
                        <p className="text-base font-black text-slate-900 dark:text-white">{stepLabel}</p>
                        <p className="text-sm text-slate-500 dark:text-slate-400">{stepSub}</p>
                    </div>
                ) : (
                    <div className="w-full max-w-sm">
                        <Card className="w-full border border-white/60 dark:border-slate-700/50 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl shadow-[0_24px_64px_rgba(0,0,0,0.12)] dark:shadow-[0_24px_64px_rgba(0,0,0,0.5)] rounded-2xl overflow-hidden">
                            <div className="h-1 w-full bg-gradient-to-r from-[#0056B3] via-[#00B4D8] to-[#FFCC00]" />
                            <CardContent className="p-6">
                                <div className="text-center mb-5">
                                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">{stepLabel}</p>
                                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{stepSub}</p>
                                </div>

                                <PinDots filled={pin.length} shake={shake} />

                                {error && (
                                    <p className="text-xs font-semibold text-red-500 text-center mt-2 mb-1 animate-in fade-in">
                                        {error}
                                    </p>
                                )}

                                {isLoading && (
                                    <div className="flex items-center justify-center gap-2 mt-3">
                                        <Loader2 className="w-4 h-4 animate-spin text-[#0056B3]" />
                                        <span className="text-sm font-medium text-slate-500">Saving PIN…</span>
                                    </div>
                                )}

                                <PinPad pin={pin} onChange={setPin} isLoading={isLoading} />
                            </CardContent>
                        </Card>

                        <div className="mt-5 flex flex-col items-center gap-2.5">
                            {step === 'confirm' && (
                                <button
                                    type="button"
                                    onClick={() => { setStep('enter'); setPin(''); setFirstPin(''); setError(null) }}
                                    className="text-xs font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                                >
                                    Start over
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => router.push(nextUrl)}
                                className="text-sm font-semibold text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 flex items-center gap-1.5 transition-colors"
                            >
                                <KeyRound className="w-3.5 h-3.5" />
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
