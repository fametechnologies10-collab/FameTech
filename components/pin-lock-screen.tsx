'use client'

import { useState, useCallback } from 'react'
import { PinPad } from '@/components/ui/pin-pad'
import { Loader2, LogOut, Eye, EyeOff, ArrowLeft, ShieldCheck } from 'lucide-react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { saveTrustedDevice, clearTrustedDevice } from '@/lib/pin-crypto'
import { toast } from '@/lib/toast'

interface PinLockScreenProps {
    userName?: string
    email?: string
    /** Called when the correct existing PIN is entered. */
    onVerified: (pin: string) => void
    /** Called after a password-verified recovery. `pinStillSet` is true if the
     *  user set a new PIN, false if they disabled it. */
    onRecovered: (pinStillSet: boolean) => void
}

type Mode = 'pin' | 'forgot' | 'setpin'

export function PinLockScreen({ userName, email, onVerified, onRecovered }: PinLockScreenProps) {
    const router = useRouter()
    const { signOut } = useAuth()

    const [mode, setMode] = useState<Mode>('pin')
    const [error, setError] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(false)

    // Recovery state
    const [password, setPassword] = useState('')
    const [showPw, setShowPw] = useState(false)
    const [setpinStep, setSetpinStep] = useState<'enter' | 'confirm'>('enter')
    const [firstPin, setFirstPin] = useState('')

    // ── Normal PIN entry ─────────────────────────────────────────────────────
    const handlePinSubmit = useCallback(async (pin: string) => {
        setIsLoading(true)
        setError(null)
        try {
            const res = await fetch('/api/auth/pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin, action: 'verify' }),
            })
            const data = await res.json().catch(() => ({}))

            // Session expired/revoked while the lock screen was open. The verify
            // route returns 401 { error: 'Unauthorized' } (no `verified` field) —
            // do NOT show "Wrong PIN"; send them to sign in again.
            if (res.status === 401 && data?.error === 'Unauthorized') {
                router.push('/auth?reason=session_expired')
                return
            }

            if (res.ok && data.verified) {
                try {
                    localStorage.setItem('kfg_pin_verified', 'true')
                    localStorage.setItem('kfg_pin_verified_at', Date.now().toString())
                } catch {}
                onVerified(pin)
            } else if (data.locked) {
                setError(data.message || 'PIN locked. Tap "Forgot PIN?" to reset it with your password.')
            } else {
                setError(data.message || 'Wrong PIN')
            }
        } catch {
            setError('Connection error. Please try again.')
        } finally {
            setIsLoading(false)
        }
    }, [onVerified, router])

    // ── Forgot PIN: verify account password, which also disables the PIN ───────
    // Removing the PIN on password-verify makes "disable" the safe default: if the
    // user doesn't set a new PIN, it simply stays off (and they're told they can
    // re-enable it from Profile). Setting a new PIN afterwards is a fresh first-time set.
    const handleForgotSubmit = useCallback(async () => {
        if (!password) { setError('Please enter your account password.'); return }
        setIsLoading(true)
        setError(null)
        try {
            const res = await fetch('/api/auth/pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'remove', password }),
            })
            const data = await res.json().catch(() => ({}))

            if (res.status === 401 && data?.error === 'Unauthorized') {
                router.push('/auth?reason=session_expired')
                return
            }
            if (!res.ok) {
                setError(res.status === 401
                    ? 'Incorrect password. Please try again.'
                    : (data.error || 'Could not verify your password. Please try again.'))
                return
            }
            // Password verified, PIN now disabled. Offer to set a new one.
            setError(null)
            setSetpinStep('enter')
            setFirstPin('')
            setMode('setpin')
        } catch {
            setError('Connection error. Please try again.')
        } finally {
            setIsLoading(false)
        }
    }, [password, router])

    // ── Set a NEW PIN (optional after recovery) ────────────────────────────────
    const handleSetPinComplete = useCallback(async (pin: string) => {
        if (setpinStep === 'enter') {
            setFirstPin(pin)
            setError(null)
            setSetpinStep('confirm')
            return
        }
        // confirm step
        if (pin !== firstPin) {
            setError("PINs don't match. Please start over.")
            setSetpinStep('enter')
            setFirstPin('')
            return
        }
        setIsLoading(true)
        setError(null)
        try {
            const res = await fetch('/api/auth/pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'set', pin }),
            })
            if (!res.ok) throw new Error()
            try {
                localStorage.setItem('kfg_pin_verified', 'true')
                localStorage.setItem('kfg_pin_verified_at', Date.now().toString())
            } catch {}
            // Re-establish the trusted device with the NEW PIN so quick PIN login
            // works again next time (the old blob was encrypted with the forgotten PIN).
            if (email) {
                try { await saveTrustedDevice(email, password, pin) } catch {}
            }
            setPassword('')
            toast.success('New PIN set.')
            onRecovered(true)
        } catch {
            setError('Something went wrong. Please try again.')
            setSetpinStep('enter')
            setFirstPin('')
        } finally {
            setIsLoading(false)
        }
    }, [setpinStep, firstPin, email, password, onRecovered])

    // ── Skip: leave the PIN disabled ────────────────────────────────────────────
    const handleSkipNewPin = useCallback(() => {
        // The trusted-device blob was encrypted with the now-forgotten PIN, so a
        // PIN-first screen would be unusable — clear it. Flag a one-time notice so
        // the user is reminded they can re-enable a PIN from Profile.
        try { clearTrustedDevice() } catch {}
        try { localStorage.setItem('kfg_pin_notice', 'setup') } catch {}
        setPassword('')
        toast.info('PIN disabled. You can set up a new one anytime in Profile → Security.', { duration: 6000 })
        onRecovered(false)
    }, [onRecovered])

    const handleLogout = async () => {
        try {
            localStorage.removeItem('kfg_pin_verified')
            localStorage.removeItem('kfg_pin_verified_at')
        } catch {}
        await signOut()
    }

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center p-4 transition-colors">
            <div className="w-full max-w-xs">
                {/* App branding */}
                <div className="text-center mb-6 animate-in fade-in duration-500">
                    <div className="relative w-16 h-16 mx-auto mb-3">
                        <Image
                            src="/icons/icon-512x512.png"
                            alt="KiNGFLEXYGH"
                            width={64}
                            height={64}
                            className="rounded-xl shadow-lg"
                        />
                    </div>
                    {userName && mode === 'pin' && (
                        <p className="text-lg font-black text-slate-900 dark:text-white">
                            Hi, {userName}
                        </p>
                    )}
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        {mode === 'pin' && 'Enter PIN to unlock'}
                        {mode === 'forgot' && 'Verify it’s you'}
                        {mode === 'setpin' && (setpinStep === 'enter' ? 'Set a new PIN' : 'Confirm your new PIN')}
                    </p>
                </div>

                {/* ── PIN entry ── */}
                {mode === 'pin' && (
                    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 delay-150">
                        <PinPad
                            onComplete={handlePinSubmit}
                            isLoading={isLoading}
                            error={error}
                            title=""
                            showForgotPin={true}
                            onForgotPin={() => { setMode('forgot'); setError(null); setPassword(''); setShowPw(false) }}
                        />
                    </div>
                )}

                {/* ── Forgot PIN: password verification ── */}
                {mode === 'forgot' && (
                    <div className="animate-in fade-in duration-300 space-y-4">
                        <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full mx-auto w-full justify-center bg-[#0056B315] border border-[#0056B330]">
                            <ShieldCheck className="w-3.5 h-3.5 text-[#0056B3]" />
                            <span className="text-xs font-bold text-[#0056B3]">Reset your PIN</span>
                        </div>
                        <p className="text-xs text-center text-slate-500 dark:text-slate-400">
                            Enter your account password to reset your PIN. You can set a new one next, or continue without a PIN.
                        </p>
                        <div className="relative">
                            <Input
                                type={showPw ? 'text' : 'password'}
                                inputMode="text"
                                autoComplete="current-password"
                                placeholder="Account password"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleForgotSubmit() }}
                                autoFocus
                                className="h-11 pr-10 rounded-xl text-sm"
                            />
                            <button type="button" aria-label={showPw ? 'Hide password' : 'Show password'}
                                onClick={() => setShowPw(p => !p)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                        </div>
                        {error && <p className="text-xs font-semibold text-red-500 text-center">{error}</p>}
                        <Button
                            type="button"
                            onClick={handleForgotSubmit}
                            disabled={isLoading || !password}
                            className="w-full h-11 text-sm font-bold text-white rounded-xl bg-gradient-to-br from-[#0056B3] to-[#00B4D8] disabled:opacity-50"
                        >
                            {isLoading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</> : 'Continue'}
                        </Button>
                        <button
                            type="button"
                            onClick={() => { setMode('pin'); setError(null); setPassword('') }}
                            className="w-full text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 flex items-center justify-center gap-1.5"
                        >
                            <ArrowLeft className="w-3.5 h-3.5" /> Back to PIN
                        </button>
                    </div>
                )}

                {/* ── Set a new PIN (optional) ── */}
                {mode === 'setpin' && (
                    <div className="animate-in fade-in duration-300">
                        <PinPad
                            onComplete={handleSetPinComplete}
                            isLoading={isLoading}
                            error={error}
                            title=""
                            showForgotPin={false}
                        />
                        <div className="mt-5 text-center">
                            <button
                                type="button"
                                onClick={handleSkipNewPin}
                                disabled={isLoading}
                                className="text-xs font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors disabled:opacity-50"
                            >
                                Skip — continue without a PIN
                            </button>
                        </div>
                    </div>
                )}

                {isLoading && mode === 'pin' && (
                    <div className="flex justify-center mt-4">
                        <Loader2 className="w-5 h-5 animate-spin text-[#0056B3]" />
                    </div>
                )}

                {/* Logout link */}
                <div className="text-center mt-8">
                    <button
                        onClick={handleLogout}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-red-500 dark:text-slate-500 dark:hover:text-red-400 transition-colors"
                    >
                        <LogOut className="w-3.5 h-3.5" />
                        Logout from account
                    </button>
                </div>
            </div>
        </div>
    )
}
