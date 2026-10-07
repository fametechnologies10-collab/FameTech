'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { usePin } from '@/contexts/pin-context'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import dynamic from 'next/dynamic'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
const Dialog = dynamic(() => import('@/components/ui/dialog').then(m => ({ default: m.Dialog })))
const DialogContent = dynamic(() => import('@/components/ui/dialog').then(m => ({ default: m.DialogContent })))
const DialogHeader = dynamic(() => import('@/components/ui/dialog').then(m => ({ default: m.DialogHeader })))
const DialogTitle = dynamic(() => import('@/components/ui/dialog').then(m => ({ default: m.DialogTitle })))
const DialogFooter = dynamic(() => import('@/components/ui/dialog').then(m => ({ default: m.DialogFooter })))
const BackgroundBubbles = dynamic(() => import('@/components/background-bubbles').then(m => ({ default: m.BackgroundBubbles })), { ssr: false, loading: () => null })
const WhatsAppCommunityButtons = dynamic(() => import('@/components/whatsapp-community-buttons').then(m => ({ default: m.WhatsAppCommunityButtons })), { ssr: false, loading: () => null })
import {
    getTrustedDeviceInfo,
    clearTrustedDevice,
    getUserDisplayHint,
} from '@/lib/pin-crypto'
import {
    signInWithPasskey,
    browserSupportsWebAuthn,
} from '@/lib/passkey-client'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { resolveLoginIdentifier } from '@/lib/login-identifier'
import { isStrongPassword, PASSWORD_REQUIREMENTS_MESSAGE } from '@/lib/password-validation'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { FALLBACK_TERMS_VERSION, FALLBACK_EFFECTIVE_DATE } from '@/lib/terms'
import {
    Eye, EyeOff, Loader2, LogIn, Mail, Lock, User, Phone,
    KeyRound, ShieldCheck, ArrowLeft, Home, UserPlus,
    MessageSquare, RefreshCw, CheckCircle2, Smartphone,
    Zap, GraduationCap, Store, ShoppingBag, ArrowUpRight,
    BookOpen, Shield, AlertTriangle, Clock, Users, CreditCard, UserCheck,
} from 'lucide-react'

// ─── Terms content ────────────────────────────────────────────────────────────
const TERMS_SECTIONS = [
    {
        icon: Shield,
        color: 'text-sky-500',
        title: '1. Account Security',
        body: 'You are responsible for maintaining the confidentiality of your login credentials. Any transaction performed through your account is considered authorized by you.',
    },
    {
        icon: CreditCard,
        color: 'text-emerald-500',
        title: '2. Non-Refundable Policy',
        body: 'Due to the instant nature of digital assets (Data, Airtime, Vouchers), all successful transactions are final and non-refundable.',
    },
    {
        icon: AlertTriangle,
        color: 'text-amber-500',
        title: '3. Buyer Accuracy Guarantee',
        body: "You are solely responsible for ensuring that the recipient's phone number and selected telecommunications network are 100% accurate before confirming an order. We are not liable for items sent to an incorrect number due to user input errors.",
    },
    {
        icon: Clock,
        color: 'text-blue-500',
        title: '4. Processing Times & 24hr Reporting',
        body: 'While 99% of transactions hit the entered number within seconds, telecommunications networks may experience downtime. Customers must report non-received orders within 24 hours of purchase. Failure to report within this window may result in the loss of eligibility for fulfillment.',
    },
    {
        icon: AlertTriangle,
        color: 'text-purple-500',
        title: '5. Payment Verification & Stay-on-Page',
        body: 'To ensure orders are processed instantly, you MUST NOT close the payment tab until you see the final confirmation screen. Failure to wait may result in delayed fulfillment.',
    },
    {
        icon: UserCheck,
        color: 'text-indigo-500',
        title: '6. Agent & Shop Roles',
        body: 'Users who purchase Agent upgrades or open Shops are bound by the pricing and operational guidelines set by KiNG FLEXY GH. We reserve the right to suspend accounts that abuse the platform or violate network provider rules.',
    },
]

// ─── Google icon ──────────────────────────────────────────────────────────────
function GoogleIcon() {
    return (
        <svg viewBox="0 0 24 24" className="w-5 h-5 flex-shrink-0" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
        </svg>
    )
}

function GoogleButton({ label, isLoading, onClick }: { label: string; isLoading: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 h-11 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/80 text-slate-700 dark:text-slate-200 font-semibold text-sm shadow-sm transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
        >
            {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <GoogleIcon />}
            <span>{label}</span>
        </button>
    )
}

function OrDivider() {
    return (
        <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700/60" />
            <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-widest">or</span>
            <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700/60" />
        </div>
    )
}

function BrandAccentLine() {
    return <div className="h-1 w-full bg-gradient-to-r from-[#0056B3] via-[#00B4D8] to-[#FFCC00]" />
}

// ─── PIN dots ────────────────────────────────────────────────────────────────
function PinDots({ filled, length = 6, shake }: { filled: number; length?: number; shake: boolean }) {
    return (
        <div className={cn('flex items-center justify-center gap-4 mb-2', shake && 'animate-shake')}>
            {Array.from({ length }).map((_, i) => (
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

const DigitButton = ({ digit, onPress, disabled }: { digit: string; onPress: (d: string) => void; disabled: boolean }) => (
    <button
        type="button"
        disabled={disabled}
        onPointerDown={(e) => { e.preventDefault(); if (!disabled) onPress(digit) }}
        className={cn(
            'touch-manipulation h-16 rounded-2xl flex items-center justify-center select-none',
            'text-2xl font-bold text-slate-800 dark:text-slate-100',
            'bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700',
            'hover:bg-slate-50 dark:hover:bg-slate-700 shadow-sm',
            'active:scale-90 active:shadow-inner transition-all duration-100',
            disabled && 'opacity-40 cursor-not-allowed'
        )}
    >
        {digit}
    </button>
)

function PinPadFast({ pin, onChange, isLoading }: { pin: string; onChange: (p: string) => void; isLoading: boolean }) {
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
                    <DigitButton key={d} digit={d} onPress={handlePress} disabled={isLoading || pin.length >= 6} />
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

// ─── PIN-first screen (Moolre-style, login only) ──────────────────────────────
function PinFirstScreen({
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

// ─── Sign In form ─────────────────────────────────────────────────────────────
function SignInForm({ onGoogleLoading, googleLoading }: {
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

// ─── Create Account form ──────────────────────────────────────────────────────
function SignUpForm({ onGoogleLoading, googleLoading }: {
    onGoogleLoading: (v: boolean) => void
    googleLoading: boolean
}) {
    const { signUp } = useAuth()
    const router = useRouter()
    const [formData, setFormData] = useState({
        firstName: '', lastName: '', email: '', phoneNumber: '', password: '', confirmPassword: '',
    })
    const [showPw, setShowPw] = useState(false)
    const [agreedToTerms, setAgreedToTerms] = useState(false)
    const [showTermsDialog, setShowTermsDialog] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState('')
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
    const [lockoutMinutes, setLockoutMinutes] = useState<number | null>(null)
    const [termsMeta, setTermsMeta] = useState({ version: FALLBACK_TERMS_VERSION, effectiveDate: FALLBACK_EFFECTIVE_DATE })
    useEffect(() => {
        let alive = true
        fetch('/api/terms/current').then(r => r.json()).then(j => { if (alive && j?.success) setTermsMeta({ version: j.data.version, effectiveDate: j.data.effectiveDate }) }).catch(() => {})
        return () => { alive = false }
    }, [])
    const [step, setStep] = useState<'form' | 'otp' | 'success'>('form')
    const [otpCode, setOtpCode] = useState('')
    const [otpLoading, setOtpLoading] = useState(false)
    const [otpError, setOtpError] = useState('')
    const [resendCooldown, setResendCooldown] = useState(0)
    const pendingPhone = useRef('')

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target
        setFormData(prev => ({ ...prev, [name]: value }))
        if (fieldErrors[name]) setFieldErrors(prev => { const { [name]: _, ...rest } = prev; return rest })
    }

    const startResendTimer = () => {
        setResendCooldown(60)
        const t = setInterval(() => setResendCooldown(c => { if (c <= 1) { clearInterval(t); return 0 } return c - 1 }), 1000)
    }

    const handleCreateAccount = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setFieldErrors({})
        const phoneValidation = validateGhanaianPhone(formData.phoneNumber)
        if (!phoneValidation.isValid) { setError(phoneValidation.error || 'Invalid phone number'); return }
        if (!isStrongPassword(formData.password)) { setError(PASSWORD_REQUIREMENTS_MESSAGE); return }
        if (formData.password !== formData.confirmPassword) { setError('Passwords do not match'); return }
        setIsLoading(true)
        try {
            // Pre-check email + phone before burning an SMS OTP.
            const availRes = await fetch('/api/auth/check-availability', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: formData.email, phoneNumber: phoneValidation.normalizedNumber }),
            })
            const availData = await availRes.json().catch(() => ({}))
            if (!availRes.ok) {
                // 400/403/415/429 etc. — not an availability verdict.
                setError(availData.error || 'Could not verify your details. Please try again.')
                return
            }
            // SEC-025: the endpoint returns a single generic { available } verdict
            // (no per-field disclosure) — surface a generic "already exists" message.
            if (availData.available === false) {
                setError('An account with that email or phone number already exists. Please sign in instead.')
                return
            }

            const res = await fetch('/api/auth/verify-phone', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'send', phone: phoneValidation.normalizedNumber }),
            })
            const data = await res.json()
            if (!res.ok) { setError(data.error || 'Failed to send verification code.'); return }
            if (data.requires_otp) {
                pendingPhone.current = phoneValidation.normalizedNumber!
                setStep('otp')
                startResendTimer()
            } else {
                await doSignUp(phoneValidation.normalizedNumber!)
            }
        } catch {
            setError('An unexpected error occurred.')
        } finally {
            setIsLoading(false)
        }
    }

    const handleVerifyOTP = async () => {
        if (otpCode.length !== 6) { setOtpError('Please enter the full 6-digit code.'); return }
        setOtpLoading(true)
        setOtpError('')
        try {
            const res = await fetch('/api/auth/verify-phone', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'verify', phone: pendingPhone.current, code: otpCode }),
            })
            const data = await res.json()
            if (!res.ok) { setOtpError(data.error || 'Verification failed.'); return }
            await doSignUp(pendingPhone.current)
        } catch {
            setOtpError('An unexpected error occurred.')
        } finally {
            setOtpLoading(false)
        }
    }

    // Resend the email-confirmation link from the signup success screen (distinct
    // from the phone-OTP resend above). Reuses the 60s cooldown timer.
    const handleResendSignupConfirmation = async () => {
        if (resendCooldown > 0) return
        try {
            await fetch('/api/auth/resend-confirmation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: formData.email }),
            })
            toast.success('Confirmation email resent. Check your inbox and spam folder.')
            startResendTimer()
        } catch {
            toast.error('Could not resend right now. Please try again.')
        }
    }

    const handleResendOTP = async () => {
        if (resendCooldown > 0) return
        try {
            const res = await fetch('/api/auth/verify-phone', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'send', phone: pendingPhone.current }),
            })
            const data = await res.json().catch(() => ({}))
            // Honor the real HTTP status — a 429 (rate-limited) or 500 (SMS provider
            // failure) means NO code was sent. Previously this always showed success,
            // silently stranding the user waiting for a code that never arrives.
            if (!res.ok) {
                setOtpError(data.error || 'Could not resend the code. Please try again shortly.')
                return
            }
            setOtpError('')
            toast.success('New code sent!')
            startResendTimer()
        } catch {
            toast.error('Failed to resend. Please try again.')
        }
    }

    const doSignUp = async (normalizedPhone: string) => {
        setIsLoading(true)
        try {
            const { error: signUpError, data } = await signUp({
                email: formData.email,
                password: formData.password,
                firstName: formData.firstName,
                lastName: formData.lastName,
                phoneNumber: normalizedPhone,
            })
            if (signUpError) {
                if (signUpError.details) {
                    const errs: Record<string, string> = {}
                    signUpError.details.forEach((e: string) => {
                        const [f, ...m] = e.split(': ')
                        if (f) errs[f] = m.join(': ')
                    })
                    setFieldErrors(errs)
                    setError('Please fix the errors below.')
                } else if (signUpError.message?.startsWith('TOO_MANY_ATTEMPTS:')) {
                    const mins = parseInt(signUpError.message.split(':')[1])
                    setLockoutMinutes(mins)
                    setError(`Too many attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`)
                } else {
                    setError(signUpError.message)
                }
                setStep('form')
                return
            }
            fetch('/api/emails/welcome', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: formData.email, firstName: formData.firstName, lastName: formData.lastName, phoneNumber: normalizedPhone, userId: data?.user?.id }),
            }).catch(() => {})
            if (data?.session) {
                toast.success('Account created! Logging in…')
                router.push('/dashboard')
                return
            }
            setStep('success')
            toast.success('Account created successfully!')
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
            if (error) {
                toast.error('Could not reach Google. Check your connection and try again.')
                onGoogleLoading(false)
            }
        } catch {
            toast.error('Google sign-up failed. Please try again.')
            onGoogleLoading(false)
        }
    }

    // ── OTP step ──────────────────────────────────────────────────────────────
    if (step === 'otp') {
        return (
            <div className="space-y-4">
                <div className="text-center space-y-1">
                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3 bg-gradient-to-br from-[#0056B3] to-[#00B4D8]">
                        <MessageSquare className="w-6 h-6 text-white" />
                    </div>
                    <h3 className="font-black text-base text-slate-900 dark:text-white">Verify your phone</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                        Code sent to <span className="font-bold text-slate-700 dark:text-slate-200">{pendingPhone.current}</span>
                    </p>
                </div>
                {otpError && (
                    <Alert variant="destructive" className="py-2 bg-red-500/10 border-red-500/40">
                        <AlertDescription className="text-red-600 text-sm">{otpError}</AlertDescription>
                    </Alert>
                )}
                <div className="space-y-1.5">
                    <Label className="text-slate-700 dark:text-slate-200 font-semibold text-xs">Verification Code</Label>
                    <Input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="\d*" maxLength={6} placeholder="000000"
                        value={otpCode} onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
                        autoFocus className="h-12 text-center text-xl font-black tracking-[0.4em] rounded-xl" />
                </div>
                <Button type="button" onClick={handleVerifyOTP} disabled={otpLoading || otpCode.length !== 6}
                    className="w-full h-11 text-sm font-bold text-white rounded-xl shadow-lg transition-all disabled:opacity-50 bg-gradient-to-br from-[#0056B3] to-[#00B4D8]">
                    {otpLoading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</> : <><CheckCircle2 className="w-4 h-4 mr-2" />Verify & Create Account</>}
                </Button>
                <div className="flex items-center justify-between text-sm">
                    <button type="button" onClick={() => { setStep('form'); setOtpCode(''); setOtpError('') }}
                        className="font-semibold text-slate-500 hover:text-slate-700 transition-colors flex items-center gap-1 text-xs">
                        <ArrowLeft className="w-3 h-3" /> Go back
                    </button>
                    <button type="button" onClick={handleResendOTP} disabled={resendCooldown > 0}
                        className="font-semibold flex items-center gap-1 transition-colors disabled:opacity-50 text-[#0056B3] text-xs">
                        <RefreshCw className="w-3 h-3" />
                        {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                    </button>
                </div>
            </div>
        )
    }

    // ── Success step ──────────────────────────────────────────────────────────
    if (step === 'success') {
        return (
            <div className="text-center space-y-4 py-4">
                <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto shadow-lg bg-gradient-to-br from-[#10b981] to-[#059669]">
                    <CheckCircle2 className="w-7 h-7 text-white" />
                </div>
                <div>
                    <h3 className="text-base font-black text-slate-900 dark:text-white mb-1">Check Your Email</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                        Verification link sent to <strong className="text-slate-700 dark:text-slate-200">{formData.email}</strong>.
                        Click it to activate your account, then sign in. Didn&apos;t get it? Check your spam folder.
                    </p>
                </div>
                {/* An unconfirmed account has NO session — never route here to /dashboard
                    (middleware just bounces it back to /auth). Offer a resend + a way
                    back to sign in instead. */}
                <Button
                    type="button"
                    onClick={handleResendSignupConfirmation}
                    disabled={resendCooldown > 0}
                    className="w-full h-11 text-sm font-bold text-white rounded-xl shadow-lg bg-gradient-to-br from-[#0056B3] to-[#00B4D8] disabled:opacity-60"
                >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend confirmation email'}
                </Button>
                <a href="/auth" className="block text-xs font-semibold text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
                    ← Back to sign in
                </a>
            </div>
        )
    }

    // ── Main form step ────────────────────────────────────────────────────────
    return (
        <div className="space-y-3">
            {/* Google first */}
            <GoogleButton label="Sign up with Google" isLoading={googleLoading} onClick={handleGoogle} />
            <OrDivider />

            {/* Terms of Service dialog */}
            <Dialog open={showTermsDialog} onOpenChange={setShowTermsDialog}>
                <DialogContent className="max-w-md flex flex-col p-0 gap-0 max-h-[85vh]">
                    <DialogHeader className="px-5 pt-5 pb-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
                        <DialogTitle className="flex items-center gap-2 text-sm font-black">
                            <BookOpen className="w-4 h-4 text-[#0056B3]" />
                            Terms of Service
                        </DialogTitle>
                    </DialogHeader>
                    <div className="flex-1 overflow-y-auto px-5 py-4">
                        <div className="space-y-5">
                            {TERMS_SECTIONS.map(section => (
                                <div key={section.title} className="flex gap-3">
                                    <section.icon className={cn('w-5 h-5 mt-0.5 shrink-0', section.color)} />
                                    <div>
                                        <p className="text-xs font-black text-slate-900 dark:text-white mb-1">{section.title}</p>
                                        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{section.body}</p>
                                    </div>
                                </div>
                            ))}
                            <p className="text-xs text-slate-400 text-center pt-2">Version {termsMeta.version} · effective {termsMeta.effectiveDate}</p>
                        </div>
                    </div>
                    <DialogFooter className="px-5 py-4 border-t border-slate-100 dark:border-slate-800 shrink-0 flex-row gap-2">
                        <Button variant="outline" onClick={() => setShowTermsDialog(false)}
                            className="flex-1 h-10 text-sm font-semibold rounded-xl">
                            Cancel
                        </Button>
                        <Button
                            onClick={() => { setAgreedToTerms(true); setShowTermsDialog(false) }}
                            className="flex-1 h-10 text-sm font-bold text-white rounded-xl bg-gradient-to-br from-[#0056B3] to-[#00B4D8]"
                        >
                            <CheckCircle2 className="w-4 h-4 mr-1.5" />
                            I Accept
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <form onSubmit={handleCreateAccount} className="space-y-3">
                {error && (
                    <Alert variant="destructive" className={cn('py-2',
                        lockoutMinutes !== null ? 'bg-orange-500/10 border-orange-500/40' : 'bg-red-500/10 border-red-500/40')}>
                        <AlertDescription className={cn('text-sm', lockoutMinutes !== null ? 'text-orange-600' : 'text-red-600')}>
                            {error}
                        </AlertDescription>
                    </Alert>
                )}

                <div className="grid grid-cols-2 gap-2">
                    {[{ id: 'firstName', label: 'First Name', placeholder: 'First' }, { id: 'lastName', label: 'Last Name', placeholder: 'Last' }].map(f => (
                        <div key={f.id} className="space-y-1">
                            <Label className="text-slate-700 dark:text-slate-200 font-semibold text-xs">{f.label}</Label>
                            <div className="relative">
                                <User className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                                <Input name={f.id} autoComplete={f.id === 'firstName' ? 'given-name' : 'family-name'} placeholder={f.placeholder} value={(formData as any)[f.id]}
                                    onChange={handleChange} required
                                    className={cn('h-10 pl-9 rounded-xl text-sm', fieldErrors[f.id] && 'border-red-500')} />
                            </div>
                            {fieldErrors[f.id] && <p className="text-red-500 text-xs">{fieldErrors[f.id]}</p>}
                        </div>
                    ))}
                </div>

                <div className="space-y-1">
                    <Label className="text-slate-700 dark:text-slate-200 font-semibold text-xs">Email Address</Label>
                    <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <Input name="email" type="email" autoComplete="email" placeholder="your@email.com" value={formData.email}
                            onChange={handleChange} required
                            className={cn('h-10 pl-10 rounded-xl text-sm', fieldErrors.email && 'border-red-500')} />
                    </div>
                    {fieldErrors.email && <p className="text-red-500 text-xs">{fieldErrors.email}</p>}
                </div>

                <div className="space-y-1">
                    <Label className="text-slate-700 dark:text-slate-200 font-semibold text-xs">Mobile Number</Label>
                    <div className="relative">
                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <Input name="phoneNumber" type="tel" autoComplete="tel" placeholder="024 XXX XXXX" value={formData.phoneNumber}
                            onChange={handleChange} required
                            className={cn('h-10 pl-10 rounded-xl text-sm', fieldErrors.phoneNumber && 'border-red-500')} />
                    </div>
                    {fieldErrors.phoneNumber && <p className="text-red-500 text-xs">{fieldErrors.phoneNumber}</p>}
                </div>

                <div className="space-y-1">
                    <Label className="text-slate-700 dark:text-slate-200 font-semibold text-xs">Password</Label>
                    <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <Input name="password" type={showPw ? 'text' : 'password'} autoComplete="new-password" placeholder="Create a strong password"
                            value={formData.password} onChange={handleChange} required
                            className={cn('h-10 pl-10 pr-10 rounded-xl text-sm', fieldErrors.password && 'border-red-500')} />
                        <button type="button" aria-label={showPw ? 'Hide' : 'Show'}
                            onClick={() => setShowPw(p => !p)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors">
                            {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                    </div>
                    {fieldErrors.password && <p className="text-red-500 text-xs">{fieldErrors.password}</p>}
                </div>

                <div className="space-y-1">
                    <Label className="text-slate-700 dark:text-slate-200 font-semibold text-xs">Confirm Password</Label>
                    <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <Input name="confirmPassword" type={showPw ? 'text' : 'password'} autoComplete="new-password" placeholder="Confirm your password"
                            value={formData.confirmPassword} onChange={handleChange} required
                            className="h-10 pl-10 pr-10 rounded-xl text-sm" />
                    </div>
                </div>

                {/* Terms checkbox — opens dialog on click */}
                <div className="flex items-start gap-2.5 py-1">
                    <input
                        id="terms"
                        type="checkbox"
                        checked={agreedToTerms}
                        onChange={() => {
                            if (agreedToTerms) {
                                setAgreedToTerms(false)
                            } else {
                                setShowTermsDialog(true)
                            }
                        }}
                        className="w-4 h-4 mt-0.5 border-slate-300 rounded cursor-pointer accent-[#0056B3]"
                    />
                    <label htmlFor="terms" className="text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer leading-relaxed">
                        I have read and agree to the latest{' '}
                        <button type="button" onClick={() => setShowTermsDialog(true)}
                            className="font-bold text-[#0056B3] hover:underline">
                            Terms of Service
                        </button>
                        {' '}(v{termsMeta.version}, effective {termsMeta.effectiveDate}){' '}and{' '}
                        <Link href="/privacy" target="_blank" className="font-bold hover:underline text-[#0056B3]">
                            Privacy Policy
                        </Link>
                    </label>
                </div>

                <Button type="submit" disabled={isLoading || !agreedToTerms || lockoutMinutes !== null}
                    className="w-full h-11 text-sm font-bold text-white rounded-xl shadow-lg transition-all disabled:opacity-50 bg-gradient-to-br from-[#0056B3] to-[#00B4D8]">
                    {isLoading
                        ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing…</>
                        : <><UserPlus className="w-4 h-4 mr-2" />Create Account</>}
                </Button>
            </form>
        </div>
    )
}

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
                                href="https://kingflexygh.com/shop/felix-s-shop"
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
