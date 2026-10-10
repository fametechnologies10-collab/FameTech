'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { clearTrustedDevice } from '@/lib/pin-crypto'
import { toast } from '@/lib/toast'
import { Loader2, KeyRound, ShieldCheck, ArrowLeft, RefreshCw } from 'lucide-react'
import { FT_ERROR_TEXT, FT_LINK } from './shared'
import { PinDots, PinPadFast } from './pin-pad'

// ─── PIN-first screen (Moolre-style, login only) ──────────────────────────────
export function PinFirstScreen({
    emailHint,
    onSwitchAccount,
    onUsePassword,
}: {
    emailHint: string
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
        <div className="w-full flex flex-col items-center">
            {/* Identity */}
            <div className="text-center mb-5">
                <div className="ft-raised inline-flex items-center gap-1.5 px-3 py-1.5 !rounded-full mb-3">
                    <ShieldCheck className={`w-4 h-4 ${FT_LINK}`} aria-hidden="true" />
                    <span className="text-sm font-semibold text-ft-ink">Trusted device</span>
                </div>
                <p className="text-sm text-[color:var(--ft-muted)] break-all">{emailHint}</p>
            </div>

            <p className="text-center text-base font-semibold text-ft-ink mb-4">
                Enter your 6-digit PIN
            </p>
            <PinDots filled={pin.length} shake={shake} />
            <div aria-live="polite" className="w-full">
                {error && (
                    <p className={`text-sm font-semibold ${FT_ERROR_TEXT} text-center mt-2 mb-1`}>
                        {error}
                    </p>
                )}
            </div>
            {isLoading && (
                <div className="flex items-center justify-center gap-2 mt-3">
                    <Loader2 className={`w-4 h-4 animate-spin ${FT_LINK}`} aria-hidden="true" />
                    <span className="text-sm font-medium text-[color:var(--ft-muted)]">Checking your PIN…</span>
                </div>
            )}
            <PinPadFast pin={pin} onChange={handlePinChange} isLoading={isLoading} />

            <div className="mt-4 flex flex-col items-center">
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
                    className="min-h-12 px-3 text-sm font-semibold text-ft-ink flex items-center gap-2 rounded-xl"
                >
                    <KeyRound className="w-4 h-4" aria-hidden="true" />
                    Use email and password instead
                </button>
                <Link
                    href="/auth/reset-password"
                    className="min-h-12 px-3 text-sm font-semibold text-ft-ink flex items-center gap-2 rounded-xl"
                >
                    <RefreshCw className="w-4 h-4" aria-hidden="true" />
                    Forgot your password?
                </Link>
                <button
                    type="button"
                    onClick={onSwitchAccount}
                    className={`min-h-12 px-3 text-sm font-semibold flex items-center gap-2 rounded-xl ${FT_LINK}`}
                >
                    <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                    Not you? Use another account
                </button>
            </div>
        </div>
    )
}
