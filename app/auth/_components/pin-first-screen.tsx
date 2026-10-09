'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { clearTrustedDevice } from '@/lib/pin-crypto'
import { toast } from '@/lib/toast'
import { Loader2, KeyRound, ShieldCheck, ArrowLeft, RefreshCw } from 'lucide-react'
import { BrandAccentLine } from './shared'
import { PinDots, PinPadFast } from './pin-pad'

// ─── PIN-first screen (Moolre-style, login only) ──────────────────────────────
export function PinFirstScreen({
    emailHint,
    firstName,
    onSwitchAccount,
    onUsePassword,
}: {
    emailHint: string
    firstName?: string
    onSwitchAccount: () => void
    onUsePassword: () => void
}) {
    const { signIn } = useAuth()
    const router = useRouter()
    const [pin, setPin] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [shake, setShake] = useState(false)
    const attempts = useRef(0)

    const handlePinChange = useCallback((next: string) => setPin(next), [])

    useEffect(() => {
        if (pin.length === 6 && !isLoading) submitPin(pin)
    }, [pin])

    const submitPin = async (currentPin: string) => {
        setIsLoading(true)
        setError(null)
        try {
            // Verify the PIN client-side via AES-256-GCM decryption.
            // The server PIN verify endpoint (/api/auth/pin action=verify) requires
            // an authenticated session, but PIN login happens BEFORE the user is
            // authenticated — calling it returns 401 which was misread as "Wrong PIN".
            // AES-GCM's authentication tag rejects any wrong-key decryption attempt
            // instantly, so the decryption result IS the PIN check.
            const { decryptTrustedDevice } = await import('@/lib/pin-crypto')
            const creds = await decryptTrustedDevice(currentPin)

            if (!creds) {
                // Decryption failed → wrong PIN
                attempts.current += 1
                const remaining = 5 - attempts.current
                setError(remaining > 0
                    ? `Wrong PIN. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
                    : 'Too many attempts. Use email login instead.'
                )
                setShake(true)
                setPin('')
                setTimeout(() => setShake(false), 500)
                if (remaining <= 0) { clearTrustedDevice(); setTimeout(onUsePassword, 2000) }
                return
            }

            // Correct PIN — sign in with the decrypted credentials
            const { error: signInError, status, code } = await signIn(creds.email, creds.password)
            if (signInError) {
                // ONLY a genuine credential rejection (401 invalid_credentials —
                // the stored password went stale) should wipe the trusted device.
                // A transient 429/500 must NOT destroy it: the PIN was correct and
                // the user can retry. (Previously every error cleared the device.)
                if (status === 401 && code !== 'email_not_confirmed') {
                    toast.error('Your saved password is out of date. Please sign in with email & password.')
                    clearTrustedDevice()
                    onUsePassword()
                    return
                }
                if (signInError.message?.startsWith('TOO_MANY_ATTEMPTS:')) {
                    const mins = parseInt(signInError.message.split(':')[1]) || 10
                    setError(`Too many attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`)
                } else if (code === 'email_not_confirmed') {
                    setError('Please confirm your email address, then try again.')
                } else {
                    setError('Something went wrong. Please try again in a moment.')
                }
                setPin('') // clear so the length-6 effect doesn't auto-resubmit
                return
            }

            // Strong auth just happened — stamp the same verification flag
            // PinLockScreen sets on its own successful verify. Without this,
            // PinContext has no record the PIN was just checked, so it
            // re-prompts with ANOTHER PIN screen the instant the dashboard
            // mounts — forcing every user to enter their PIN twice per login.
            try {
                localStorage.setItem('kfg_pin_verified', 'true')
                localStorage.setItem('kfg_pin_verified_at', Date.now().toString())
            } catch {}

            toast.success('Welcome back!')
            router.push('/dashboard')
        } catch {
            setError('Connection error. Please try again.')
            setPin('')
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="w-full max-w-sm flex flex-col items-center">
            {/* Identity */}
            <div className="text-center mb-6">
                <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full mb-3 bg-[#0056B315] border border-[#0056B330]">
                    <ShieldCheck className="w-3.5 h-3.5 text-[#0056B3]" />
                    <span className="text-xs font-bold text-[#0056B3]">Trusted Device</span>
                </div>
                {firstName ? (
                    <h2 className="text-xl font-black text-slate-900 dark:text-white">Hi, {firstName}! 👋</h2>
                ) : (
                    <h2 className="text-xl font-black text-slate-900 dark:text-white">Welcome back</h2>
                )}
                <p className="text-sm text-slate-500 dark:text-slate-400 font-medium mt-0.5">{emailHint}</p>
            </div>

            <Card className="w-full border border-white/60 dark:border-slate-700/50 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl shadow-[0_24px_64px_rgba(0,0,0,0.12)] dark:shadow-[0_24px_64px_rgba(0,0,0,0.5)] rounded-2xl overflow-hidden">
                <BrandAccentLine />
                <CardContent className="p-6">
                    <p className="text-center text-sm font-semibold text-slate-600 dark:text-slate-300 mb-5">
                        Enter your 6-digit PIN to continue
                    </p>
                    <PinDots filled={pin.length} shake={shake} />
                    {error && (
                        <p className="text-xs font-semibold text-red-500 text-center mt-2 mb-1 animate-in fade-in">
                            {error}
                        </p>
                    )}
                    {isLoading && (
                        <div className="flex items-center justify-center gap-2 mt-3">
                            <Loader2 className="w-4 h-4 animate-spin text-[#0056B3]" />
                            <span className="text-sm font-medium text-slate-500">Verifying…</span>
                        </div>
                    )}
                    <PinPadFast pin={pin} onChange={handlePinChange} isLoading={isLoading} />
                </CardContent>
            </Card>

            <div className="mt-5 flex flex-col items-center gap-3">
                <button
                    type="button"
                    onClick={() => {
                        // Treat an explicit "I don't have my PIN" bypass the same
                        // way the other two onUsePassword call-sites in this
                        // component already do (5 failed attempts, stale trusted
                        // device on sign-in failure) — clear it so the user isn't
                        // asked for the same forgotten PIN again on their next
                        // visit. Flag a one-time nudge so SignInForm offers to
                        // set up a fresh PIN once this password login succeeds.
                        clearTrustedDevice()
                        try { sessionStorage.setItem('kfg_prompt_pin_setup', '1') } catch {}
                        onUsePassword()
                    }}
                    className="text-sm font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center gap-1.5 transition-colors"
                >
                    <KeyRound className="w-3.5 h-3.5" />
                    Sign in with email instead
                </button>
                <Link
                    href="/auth/reset-password"
                    className="text-sm font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center gap-1.5 transition-colors"
                >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Forgot your password?
                </Link>
                <button
                    type="button"
                    onClick={onSwitchAccount}
                    className="text-sm font-semibold flex items-center gap-1.5 transition-colors text-[#0056B3]"
                >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Sign in as someone else
                </button>
            </div>
        </div>
    )
}
