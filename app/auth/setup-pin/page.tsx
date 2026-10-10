'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { saveTrustedDevice, clearTrustedDevice, saveUserDisplayHint } from '@/lib/pin-crypto'
import { ClayButton } from '@/components/ft'
import { Loader2, ShieldCheck, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { AuthShell } from '../_components/auth-shell'
import { AuthAlert } from '../_components/shared'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeNext(next: string | null): string {
    if (!next) return '/dashboard'
    return next.startsWith('/') && !next.startsWith('//') && !next.includes(':') ? next : '/dashboard'
}

// ─── PIN dots ────────────────────────────────────────────────────────────────
// Filled vs empty is shown by solid fill vs a visible outline, not by shadow alone.
function PinDots({ filled, shake }: { filled: number; shake: boolean }) {
    return (
        <div
            role="img"
            aria-label={`${filled} of 6 digits entered`}
            className={cn('flex items-center justify-center gap-4 mb-2', shake && 'animate-shake')}
        >
            {Array.from({ length: 6 }).map((_, i) => (
                <div
                    key={i}
                    className={cn(
                        'w-4 h-4 rounded-full border-2 transition-colors duration-200',
                        i < filled
                            ? 'border-ft-blue bg-ft-blue dark:border-[color:var(--ft-cyan)] dark:bg-[color:var(--ft-cyan)]'
                            : 'border-[color:var(--ft-muted)] bg-transparent'
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
                            'ft-raised touch-manipulation h-16 !rounded-2xl flex items-center justify-center select-none',
                            'text-2xl font-bold text-ft-ink',
                            'active:scale-95 transition-transform duration-100',
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
                className="touch-manipulation h-16 rounded-2xl flex items-center justify-center text-ft-ink active:scale-95 transition-transform duration-100 disabled:opacity-40"
            >
                <svg viewBox="0 0 24 24" className="w-6 h-6" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2}>
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
        <AuthShell showBrandPanel={false} title={stepLabel} subtitle={stepSub}>
            <div className="space-y-4">
                <div className="flex flex-col items-center gap-2 text-center">
                    <span className="ft-raised inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-ft-ink">
                        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                        Trusted device
                    </span>
                    <p className="text-base font-semibold text-ft-ink">
                        {fullName ? `Hi, ${fullName}` : 'Welcome back'}
                    </p>
                </div>

                {step === 'success' ? (
                    <div className="flex flex-col items-center gap-3 py-2 text-center" role="status">
                        <div className="ft-clay flex h-14 w-14 items-center justify-center !rounded-full">
                            <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
                        </div>
                    </div>
                ) : (
                    <>
                        <PinDots filled={pin.length} shake={shake} />

                        {error && <AuthAlert tone="error">{error}</AuthAlert>}

                        {isLoading && (
                            <div className="flex items-center justify-center gap-2" role="status">
                                <Loader2 className="h-4 w-4 animate-spin text-ft-blue dark:text-[color:var(--ft-cyan)]" aria-hidden="true" />
                                <span className="text-sm font-medium text-[color:var(--ft-muted)]">Saving PIN…</span>
                            </div>
                        )}

                        <PinPad pin={pin} onChange={setPin} isLoading={isLoading} />

                        <div className="flex flex-col items-center gap-1">
                            {step === 'confirm' && (
                                <ClayButton
                                    variant="ghost"
                                    onClick={() => { setStep('enter'); setPin(''); setFirstPin(''); setError(null) }}
                                >
                                    Start over
                                </ClayButton>
                            )}
                            <ClayButton variant="ghost" onClick={() => router.push(nextUrl)}>
                                Cancel
                            </ClayButton>
                        </div>
                    </>
                )}
            </div>
        </AuthShell>
    )
}
