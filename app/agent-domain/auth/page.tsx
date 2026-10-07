'use client'

import { useState } from 'react'
import { KeyRound, Mail, Loader2, ShieldCheck, ArrowRight, Eye, EyeOff } from 'lucide-react'
import { resolveLoginIdentifier } from '@/lib/login-identifier'
import { toast } from '@/lib/toast'

// ─── Sub-agent access page ──────────────────────────────────────────────────
// Rewritten to from agent.kingflexygh.com/auth by middleware.ts (Task 3). A
// sub-agent isn't handed a memorized password — a recruiter mints them an
// "access key" (Task 5's Regenerate flow reissues it; there is no self-service
// recovery). This page frames the field accordingly, but the wire protocol is
// unchanged: POST { email, password } OR { phone, password } to
// /api/auth/login, same as the password branch of app/auth/page.tsx (via
// signIn() in contexts/auth-context.tsx) and app/marketplace-domain/auth/
// AuthClient.tsx's SignInForm.submit(), whose status handling this mirrors
// exactly (429 w/ Retry-After, 401, 403, generic). The identifier field
// reuses resolveLoginIdentifier (lib/login-identifier.ts) — the same
// email-vs-Ghanaian-phone detection app/auth/page.tsx's unified "Email or
// Phone Number" field uses — so phone-format validation and error copy stay
// identical between the two login surfaces.

export default function AgentAuthPage() {
    const [identifier, setIdentifier] = useState('')
    const [accessKey, setAccessKey] = useState('')
    const [showKey, setShowKey] = useState(false)
    const [error, setError] = useState('')
    const [submitting, setSubmitting] = useState(false)

    // ─── Self-service reset (Task 9) ────────────────────────────────────
    // A sub-agent isn't handed a memorized password, but they can still
    // request reset instructions themselves rather than waiting on their
    // recruiter. Backs onto POST /api/auth/subagent-reset (Task 8), which
    // is enumeration-safe: it ALWAYS returns the same generic success
    // response regardless of whether the identifier matches a real
    // account, so the UI must show the same confirmation every time too —
    // never branch on the response body to infer account existence. A
    // network error or a 429 (rate limit) are legitimate to handle
    // distinctly since those aren't about account existence.
    const [showResetForm, setShowResetForm] = useState(false)
    const [resetChannel, setResetChannel] = useState<'email' | 'sms'>('email')
    const [resetIdentifier, setResetIdentifier] = useState('')
    const [resetSubmitting, setResetSubmitting] = useState(false)

    const submitReset = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!resetIdentifier.trim()) return
        setResetSubmitting(true)
        try {
            const res = await fetch('/api/auth/subagent-reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel: resetChannel, identifier: resetIdentifier }),
            })
            if (res.status === 429) {
                toast.error('Too many attempts — please wait before trying again.')
                return
            }
            // Always show the same message regardless of the (intentionally
            // generic, enumeration-safe) response body — see Task 8's route.
            toast.success('If that account exists, reset instructions have been sent.')
            setShowResetForm(false)
            setResetIdentifier('')
        } catch {
            toast.error('Something went wrong. Please check your connection and try again.')
        } finally {
            setResetSubmitting(false)
        }
    }

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (submitting) return
        setError('')

        const resolved = resolveLoginIdentifier(identifier)
        if (resolved.type === 'invalid') {
            setError('Invalid email, phone number, or password.')
            return
        }

        setSubmitting(true)
        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                    resolved.type === 'email'
                        ? { email: resolved.value, password: accessKey }
                        : { phone: resolved.value, password: accessKey }
                ),
            })

            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After')
                const minutes = retryAfter ? Math.ceil(parseInt(retryAfter) / 60) : 10
                setError(`Too many attempts. Try again in ${minutes} minute${minutes !== 1 ? 's' : ''}.`)
                return
            }

            const data = await response.json().catch(() => ({}))

            if (!response.ok) {
                if (response.status === 401) {
                    setError('That email or access key is not correct.')
                } else if (response.status === 403) {
                    setError(data.error || 'Sign-in is not allowed right now.')
                } else {
                    setError(data.error || 'Could not sign in. Please try again.')
                }
                return
            }

            // Full navigation (not router.push) so the freshly-set shared cookie
            // is picked up everywhere — same fix app/marketplace-domain/auth/
            // AuthClient.tsx uses for this exact raw-fetch-no-context shape. A
            // soft client nav can race the cookie against /dashboard's SSR auth
            // check; the cookie is already scoped to .kingflexygh.com (Task 3),
            // so no cross-subdomain handoff is needed either way.
            window.location.assign('/dashboard')
        } catch {
            setError('Connection error. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className="relative min-h-dvh w-full overflow-hidden bg-[#0B2036] text-[#EDF1F7] flex items-center justify-center px-4 py-12">
            {/* Ambient field markers — quiet, not decorative noise */}
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0 opacity-[0.07]"
                style={{
                    backgroundImage:
                        'radial-gradient(circle at 1px 1px, #FFCC00 1px, transparent 0)',
                    backgroundSize: '28px 28px',
                }}
            />
            <div
                aria-hidden
                className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 h-[420px] w-[420px] rounded-full bg-[#FFCC00] opacity-[0.08] blur-[120px]"
            />

            <div className="relative z-10 w-full max-w-[380px]">
                {/* Badge header — identifies this as the agent access surface,
                    not the consumer sign-in page it shares infrastructure with. */}
                <div className="flex flex-col items-center text-center mb-7">
                    <div className="w-12 h-12 rounded-full flex items-center justify-center mb-4 bg-[#12314F] border border-[#1E4468] shadow-[0_0_0_5px_rgba(255,204,0,0.06)]">
                        <ShieldCheck className="w-5 h-5 text-[#FFCC00]" />
                    </div>
                    <h1 className="text-xl font-black tracking-tight text-white">
                        Welcome back
                    </h1>
                    <p className="text-sm text-[#8DA0BC] mt-1.5 max-w-[280px] leading-relaxed">
                        Sign in to your sub-agent dashboard with your email or phone number and the access key your recruiter gave you.
                    </p>
                </div>

                <form
                    onSubmit={submit}
                    className="rounded-2xl border border-[#1E3A57] bg-[#0F2740]/90 backdrop-blur-xl shadow-[0_24px_60px_rgba(0,0,0,0.45)] p-6"
                >
                    {error && (
                        <div
                            role="alert"
                            className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300"
                        >
                            {error}
                        </div>
                    )}

                    <div className="space-y-1.5">
                        <label htmlFor="agent-identifier" className="block text-xs font-semibold text-[#9FB2CB]">
                            Email or Phone Number
                        </label>
                        <div className="relative">
                            <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#5E7594]" />
                            <input
                                id="agent-identifier"
                                type="text"
                                autoComplete="username"
                                required
                                value={identifier}
                                onChange={(e) => setIdentifier(e.target.value)}
                                placeholder="your@email.com or 024XXXXXXX"
                                className="w-full h-11 rounded-xl border border-[#1E3A57] bg-[#0B2036] pl-10 pr-3.5 text-sm text-white placeholder:text-[#4A6180] outline-none transition focus:border-[#FFCC00]/60 focus:ring-2 focus:ring-[#FFCC00]/20"
                            />
                        </div>
                    </div>

                    <div className="space-y-1.5 mt-4">
                        <label htmlFor="agent-access-key" className="block text-xs font-semibold text-[#9FB2CB]">
                            Access Key
                        </label>
                        <div className="relative">
                            <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#5E7594]" />
                            <input
                                id="agent-access-key"
                                type={showKey ? 'text' : 'password'}
                                autoComplete="current-password"
                                required
                                value={accessKey}
                                onChange={(e) => setAccessKey(e.target.value)}
                                placeholder="Your access key"
                                className="w-full h-11 rounded-xl border border-[#1E3A57] bg-[#0B2036] pl-10 pr-10 text-sm text-white placeholder:text-[#4A6180] outline-none transition focus:border-[#FFCC00]/60 focus:ring-2 focus:ring-[#FFCC00]/20"
                            />
                            <button
                                type="button"
                                aria-label={showKey ? 'Hide access key' : 'Show access key'}
                                onClick={() => setShowKey((v) => !v)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#5E7594] hover:text-[#9FB2CB] transition-colors"
                            >
                                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                        </div>
                        <p className="text-xs text-[#5E7594] pt-0.5">
                            Not a password you set — it was issued to you. Lost it? Ask your recruiter to reissue one.
                        </p>
                    </div>

                    <button
                        type="submit"
                        disabled={submitting}
                        className="mt-6 w-full h-11 rounded-xl bg-[#FFCC00] text-[#12294A] text-sm font-bold flex items-center justify-center gap-2 transition hover:bg-[#FFD633] disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                        {submitting ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <>
                                Sign in
                                <ArrowRight className="w-4 h-4" />
                            </>
                        )}
                    </button>
                </form>

                {/* Self-service reset (Task 9) — styled to match the dark
                    agent-access theme above rather than the shadcn Input/
                    Button defaults, which assume the light-theme tokens
                    this page doesn't use. */}
                <div className="mt-6 space-y-2 text-center text-sm">
                    <p className="font-medium text-[#EDF1F7]">Can&apos;t sign in?</p>
                    <button
                        type="button"
                        className="text-[#FFCC00] underline underline-offset-2 hover:text-[#FFD633] transition-colors"
                        onClick={() => setShowResetForm(true)}
                    >
                        Reset it yourself
                    </button>
                    <p className="text-[#5E7594]">or ask your recruiter to reset it for you.</p>
                </div>

                {showResetForm && (
                    <form
                        onSubmit={submitReset}
                        className="mt-4 space-y-3 rounded-2xl border border-[#1E3A57] bg-[#0F2740]/90 backdrop-blur-xl shadow-[0_24px_60px_rgba(0,0,0,0.45)] p-5"
                    >
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setResetChannel('email')}
                                className={`flex-1 h-9 rounded-lg text-sm font-semibold transition ${
                                    resetChannel === 'email'
                                        ? 'bg-[#FFCC00] text-[#12294A]'
                                        : 'border border-[#1E3A57] text-[#9FB2CB] hover:border-[#FFCC00]/40'
                                }`}
                            >
                                Email
                            </button>
                            <button
                                type="button"
                                onClick={() => setResetChannel('sms')}
                                className={`flex-1 h-9 rounded-lg text-sm font-semibold transition ${
                                    resetChannel === 'sms'
                                        ? 'bg-[#FFCC00] text-[#12294A]'
                                        : 'border border-[#1E3A57] text-[#9FB2CB] hover:border-[#FFCC00]/40'
                                }`}
                            >
                                SMS
                            </button>
                        </div>
                        <input
                            type="text"
                            value={resetIdentifier}
                            onChange={(e) => setResetIdentifier(e.target.value)}
                            placeholder={resetChannel === 'email' ? 'Your email' : 'Your phone number'}
                            className="w-full h-11 rounded-xl border border-[#1E3A57] bg-[#0B2036] px-3.5 text-sm text-white placeholder:text-[#4A6180] outline-none transition focus:border-[#FFCC00]/60 focus:ring-2 focus:ring-[#FFCC00]/20"
                        />
                        <button
                            type="submit"
                            disabled={resetSubmitting}
                            className="w-full h-11 rounded-xl bg-[#FFCC00] text-[#12294A] text-sm font-bold flex items-center justify-center gap-2 transition hover:bg-[#FFD633] disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {resetSubmitting ? 'Sending…' : 'Send reset instructions'}
                        </button>
                    </form>
                )}
            </div>
        </div>
    )
}
