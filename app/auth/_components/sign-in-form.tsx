'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { usePin } from '@/contexts/pin-context'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { signInWithPasskey, browserSupportsWebAuthn } from '@/lib/passkey-client'
import { resolveLoginIdentifier } from '@/lib/login-identifier'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Eye, EyeOff, Loader2, LogIn, Mail, Lock, KeyRound, RefreshCw } from 'lucide-react'
import { GoogleButton, OrDivider } from './shared'

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
            <form onSubmit={handleSubmit} className="space-y-3">
                {error && (
                    <Alert variant="destructive" className={cn(
                        'py-2',
                        lockoutMinutes !== null ? 'bg-orange-500/10 border-orange-500/40' : 'bg-red-500/10 border-red-500/40'
                    )}>
                        <AlertDescription className={cn('text-sm', lockoutMinutes !== null ? 'text-orange-600' : 'text-red-600')}>
                            {error}
                        </AlertDescription>
                    </Alert>
                )}

                <div className="space-y-1.5">
                    <Label className="text-slate-700 dark:text-slate-200 font-semibold text-xs">Email or Phone Number</Label>
                    <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <Input type="text" autoComplete="username" placeholder="your@email.com or 024XXXXXXX" value={identifier}
                            onChange={e => setIdentifier(e.target.value)} required
                            className="h-11 pl-10 rounded-xl text-sm focus:ring-2 focus:ring-[#0056B340]" />
                    </div>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-slate-700 dark:text-slate-200 font-semibold text-xs">Password</Label>
                    <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <Input type={showPw ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" value={password}
                            onChange={e => setPassword(e.target.value)} required
                            className="h-11 pl-10 pr-10 rounded-xl text-sm" />
                        <button type="button" aria-label={showPw ? 'Hide password' : 'Show password'}
                            onClick={() => setShowPw(p => !p)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors">
                            {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                    </div>
                </div>

                <Button type="submit" disabled={isLoading || lockoutMinutes !== null}
                    className="w-full h-11 text-sm font-bold text-white rounded-xl shadow-lg transition-all disabled:opacity-50 bg-gradient-to-br from-[#0056B3] to-[#00B4D8]">
                    {isLoading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Signing in…</> : <><LogIn className="w-4 h-4 mr-2" />Sign In</>}
                </Button>
            </form>

            {needsConfirm && (
                <div className="text-center animate-in fade-in slide-in-from-top-1 duration-300">
                    <button type="button" onClick={handleResendConfirmation} disabled={resendState !== 'idle'}
                        className="text-xs font-semibold transition-colors text-[#0056B3] inline-flex items-center justify-center gap-1 disabled:opacity-60">
                        <RefreshCw className={cn('w-3 h-3', resendState === 'sending' && 'animate-spin')} />
                        {resendState === 'sending' ? 'Sending…' : resendState === 'sent' ? 'Confirmation email sent — check your inbox' : 'Resend confirmation email'}
                    </button>
                </div>
            )}

            {/* Always visible — recovery must never be one failed attempt away. */}
            <div className="text-center">
                <Link href="/auth/reset-password"
                    className="text-xs font-semibold transition-colors text-[#0056B3] inline-flex items-center justify-center gap-1">
                    <KeyRound className="w-3 h-3" />Forgot your password?
                </Link>
            </div>

            {passkeySupported && (
                <>
                    <OrDivider />
                    <button
                        type="button"
                        onClick={handlePasskey}
                        disabled={passkeyLoading || isLoading || googleLoading}
                        className="w-full flex items-center justify-center gap-3 h-11 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/80 text-slate-700 dark:text-slate-200 font-semibold text-sm shadow-sm transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                        {passkeyLoading
                            ? <Loader2 className="w-5 h-5 animate-spin flex-shrink-0" />
                            : <KeyRound className="w-5 h-5 text-[#0056B3] flex-shrink-0" />
                        }
                        <span>{passkeyLoading ? 'Authenticating…' : 'Sign in with Passkey'}</span>
                    </button>
                </>
            )}

            <OrDivider />
            <GoogleButton label="Continue with Google" isLoading={googleLoading} onClick={handleGoogle} />
        </div>
    )
}
