'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { usePin } from '@/contexts/pin-context'
import { supabase } from '@/lib/supabase'
import { Label } from '@/components/ui/label'
import { ClayButton, NeuInput } from '@/components/ft'
import { signInWithPasskey, browserSupportsWebAuthn } from '@/lib/passkey-client'
import { resolveLoginIdentifier } from '@/lib/login-identifier'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Eye, EyeOff, Loader2, LogIn, Mail, Lock, KeyRound, RefreshCw } from 'lucide-react'
import { AuthAlert, FT_LINK, GoogleButton, OrDivider } from './shared'

// ─── Sign In form ─────────────────────────────────────────────────────────────
export function SignInForm({ onGoogleLoading, googleLoading }: {
    onGoogleLoading: (v: boolean) => void
    googleLoading: boolean
}) {
    const { signIn, syncSession } = useAuth()
    const { showPinSetup } = usePin()
    const router = useRouter()
    const [identifier, setIdentifier] = useState('')
    const [password, setPassword] = useState('')
    const [showPw, setShowPw] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState('')
    const [failedAttempts, setFailedAttempts] = useState(0)
    const [lockoutMinutes, setLockoutMinutes] = useState<number | null>(null)
    const [passkeyLoading, setPasskeyLoading] = useState(false)
    const [passkeySupported, setPasskeySupported] = useState(false)
    const [needsConfirm, setNeedsConfirm] = useState(false)
    const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle')

    const handleResendConfirmation = async () => {
        // Email confirmation is an email-only concept — the identifier field
        // now also accepts phone numbers (see resolveLoginIdentifier), so only
        // fire this when what was typed actually resolves to an email.
        const resolved = resolveLoginIdentifier(identifier)
        if (resolved.type !== 'email' || resendState === 'sending') return
        setResendState('sending')
        try {
            await fetch('/api/auth/resend-confirmation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: resolved.value }),
            })
            setResendState('sent')
            toast.success('If that account needs confirmation, a new link is on its way. Check your inbox and spam.')
        } catch {
            setResendState('idle')
            toast.error('Could not resend right now. Please try again.')
        }
    }

    useEffect(() => {
        setPasskeySupported(browserSupportsWebAuthn())
    }, [])

    const handlePasskey = async () => {
        setPasskeyLoading(true)
        setError('')
        const err = await signInWithPasskey()

        if (err !== null) {
            // signInWithPasskey returns a string on any error
            setPasskeyLoading(false)
            setError(err)
            return
        }

        // null means either success or user dismissed the picker.
        // syncSession reads the current supabase session and, crucially,
        // awaits fetchDbUser so that user + dbUser are both populated in the
        // auth context BEFORE router.push fires. Without this, DashboardLayout-
        // Client renders with user=null, its useEffect redirects to /auth/login,
        // middleware bounces back to /dashboard → infinite BrandLoader loop.
        const signedIn = await syncSession()
        setPasskeyLoading(false)

        if (signedIn) {
            // Strong auth (biometric/passkey) just happened — mark the app-lock PIN
            // session verified so the dashboard doesn't re-prompt for a PIN.
            try {
                localStorage.setItem('kfg_pin_verified', 'true')
                localStorage.setItem('kfg_pin_verified_at', Date.now().toString())
            } catch {}
            toast.success('Welcome back!')
            router.push('/dashboard')
        }
        // If user cancelled the picker, signedIn is false — stay on auth page silently
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setIsLoading(true)
        try {
            const { error: signInError, code } = await signIn(identifier, password)
            if (signInError) {
                if (signInError.message.startsWith('TOO_MANY_ATTEMPTS:')) {
                    const minutes = parseInt(signInError.message.split(':')[1])
                    setLockoutMinutes(minutes)
                    setNeedsConfirm(false)
                    setError(`Too many login attempts. Try again in ${minutes} minute${minutes !== 1 ? 's' : ''}.`)
                } else {
                    setLockoutMinutes(null)
                    setFailedAttempts(prev => prev + 1)
                    // Surface a "Resend confirmation email" affordance for the
                    // unconfirmed-email case (otherwise a dead end).
                    setNeedsConfirm(code === 'email_not_confirmed')
                    setResendState('idle')
                    setError(signInError.message)
                }
                return
            }

            toast.success('Welcome back!')

            // One-time nudge: the user got here via the PIN screen's "sign in
            // with email instead" bypass, which already wiped their stale
            // trusted device. Offer to set up a fresh PIN now instead of
            // silently leaving them without one. The setup-pin page has its
            // own Cancel button, so this never blocks anyone who'd rather
            // skip it.
            let promptedPinSetup = false
            try {
                if (sessionStorage.getItem('kfg_prompt_pin_setup') === '1') {
                    sessionStorage.removeItem('kfg_prompt_pin_setup')
                    promptedPinSetup = true
                }
            } catch {}

            if (promptedPinSetup) {
                showPinSetup(password)
            } else {
                router.push('/dashboard')
            }
        } catch {
            setError('An unexpected error occurred.')
        } finally {
            setIsLoading(false)
        }
    }

    const handleGoogle = async () => {
        onGoogleLoading(true)
        try {
            const next = new URLSearchParams(window.location.search).get('next') || ''
            const callbackUrl = `${window.location.origin}/auth/callback${next ? `?next=${encodeURIComponent(next)}` : ''}`
            const { error } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo: callbackUrl },
            })
            // signInWithOAuth redirects the browser on success — only reaches
            // here if it returned synchronously with an error (e.g. provider
            // not enabled, network failure before the redirect).
            if (error) {
                toast.error('Could not reach Google. Check your connection and try again.')
                onGoogleLoading(false)
            }
            // On success the page navigates away; loading stays true intentionally.
        } catch {
            toast.error('Google sign-in failed. Please try again.')
            onGoogleLoading(false)
        }
    }

    return (
        <div className="space-y-4">
            <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                    <AuthAlert tone={lockoutMinutes !== null ? 'warn' : 'error'}>{error}</AuthAlert>
                )}

                <div className="space-y-2">
                    <Label htmlFor="signin-identifier" className="text-sm font-semibold text-ft-ink">Email or phone number</Label>
                    <NeuInput
                        id="signin-identifier"
                        type="text"
                        autoComplete="username"
                        placeholder="you@email.com or 024 XXX XXXX"
                        value={identifier}
                        onChange={e => setIdentifier(e.target.value)}
                        required
                        leading={<Mail className="h-4 w-4" aria-hidden="true" />}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="signin-password" className="text-sm font-semibold text-ft-ink">Password</Label>
                    <NeuInput
                        id="signin-password"
                        type={showPw ? 'text' : 'password'}
                        autoComplete="current-password"
                        placeholder="Your password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        required
                        leading={<Lock className="h-4 w-4" aria-hidden="true" />}
                        trailing={
                            <button type="button" aria-label={showPw ? 'Hide password' : 'Show password'}
                                onClick={() => setShowPw(p => !p)}
                                className="-mr-3 flex h-12 w-12 items-center justify-center rounded-xl text-[color:var(--ft-muted)] hover:text-ft-ink">
                                {showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                            </button>
                        }
                    />
                </div>

                <ClayButton type="submit" disabled={lockoutMinutes !== null} loading={isLoading} className="w-full">
                    {isLoading ? 'Signing you in…' : <><LogIn className="h-4 w-4" aria-hidden="true" />Sign in</>}
                </ClayButton>
            </form>

            {needsConfirm && (
                <div className="text-center animate-in fade-in slide-in-from-top-1 duration-300">
                    <button type="button" onClick={handleResendConfirmation} disabled={resendState !== 'idle'}
                        className={cn('min-h-12 px-3 text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-60', FT_LINK)}>
                        <RefreshCw className={cn('h-4 w-4', resendState === 'sending' && 'animate-spin')} aria-hidden="true" />
                        {resendState === 'sending' ? 'Sending…' : resendState === 'sent' ? 'Confirmation email sent. Check your inbox' : 'Resend confirmation email'}
                    </button>
                </div>
            )}

            {/* Always visible — recovery must never be one failed attempt away. */}
            <div className="text-center">
                <Link href="/auth/reset-password"
                    className={cn('min-h-12 px-3 text-sm font-semibold inline-flex items-center justify-center gap-1.5', FT_LINK)}>
                    <KeyRound className="h-4 w-4" aria-hidden="true" />Forgot your password?
                </Link>
            </div>

            {passkeySupported && (
                <>
                    <OrDivider />
                    <ClayButton
                        type="button"
                        variant="soft"
                        onClick={handlePasskey}
                        disabled={passkeyLoading || isLoading || googleLoading}
                        className="w-full"
                    >
                        {passkeyLoading
                            ? <Loader2 className="h-5 w-5 animate-spin flex-shrink-0" aria-hidden="true" />
                            : <KeyRound className={cn('h-5 w-5 flex-shrink-0', FT_LINK)} aria-hidden="true" />
                        }
                        <span>{passkeyLoading ? 'Authenticating…' : 'Sign in with a passkey'}</span>
                    </ClayButton>
                </>
            )}

            <OrDivider />
            <GoogleButton label="Continue with Google" isLoading={googleLoading} onClick={handleGoogle} />
        </div>
    )
}
