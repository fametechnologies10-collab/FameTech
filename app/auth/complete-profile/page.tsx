'use client'

import { useState, useEffect, useCallback, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { isStrongPassword, PASSWORD_REQUIREMENTS_MESSAGE } from '@/lib/password-validation'
import { BackgroundBubbles } from '@/components/background-bubbles'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, Phone, CheckCircle, Lock, Eye, EyeOff, ShieldCheck, RefreshCw, LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'

type Step = 'loading' | 'phone-entry' | 'otp-verify' | 'set-password' | 'success'

// ─── Step progress bar ────────────────────────────────────────────────────────
function StepProgress({ labels, currentStep }: { labels: string[]; currentStep: number }) {
    if (labels.length <= 1) return null
    return (
        <div className="flex items-start mb-6">
            {labels.map((label, i) => {
                const num = i + 1
                const done = num < currentStep
                const active = num === currentStep
                return (
                    <Fragment key={i}>
                        <div className="flex flex-col items-center gap-1">
                            <div className={cn(
                                'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all duration-300 shrink-0',
                                done   && 'bg-emerald-500 border-emerald-500 text-white',
                                active && 'bg-[#0056B3] border-[#0056B3] text-white shadow-[0_0_0_3px_rgba(0,86,179,0.18)]',
                                !done && !active && 'bg-transparent border-slate-300 dark:border-slate-600 text-slate-400',
                            )}>
                                {done ? <CheckCircle className="w-4 h-4" /> : num}
                            </div>
                            <span className={cn(
                                'text-[10px] font-bold uppercase tracking-wider whitespace-nowrap',
                                done   && 'text-emerald-600 dark:text-emerald-400',
                                active && 'text-[#0056B3]',
                                !done && !active && 'text-slate-400',
                            )}>{label}</span>
                        </div>
                        {i < labels.length - 1 && (
                            <div className={cn(
                                'flex-1 h-0.5 mt-4 mx-2 transition-all duration-500',
                                done ? 'bg-emerald-400' : 'bg-slate-200 dark:bg-slate-700',
                            )} />
                        )}
                    </Fragment>
                )
            })}
        </div>
    )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function CompleteProfilePage() {
    const router = useRouter()

    // User context
    const [userId,      setUserId]      = useState('')
    const [email,       setEmail]       = useState('')
    const [firstName,   setFirstName]   = useState('')
    const [lastName,    setLastName]    = useState('')
    const [isGoogleUser, setIsGoogleUser] = useState(false)
    const [otpEnabled,  setOtpEnabled]  = useState(false)

    // Step machine
    const [step,         setStep]        = useState<Step>('loading')
    const [stepLabels,   setStepLabels]  = useState<string[]>([])
    const [progressStep, setProgressStep] = useState(1)

    // Phone
    const [phoneNumber,     setPhoneNumber]     = useState('')
    const [normalizedPhone, setNormalizedPhone] = useState('')

    // OTP
    const [otpCode,        setOtpCode]        = useState('')
    const [resendCooldown, setResendCooldown] = useState(0)

    // Password
    const [password,        setPassword]        = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [showPassword,    setShowPassword]    = useState(false)
    const [showConfirm,     setShowConfirm]     = useState(false)

    // UI
    const [submitting, setSubmitting] = useState(false)
    const [error,      setError]      = useState('')

    // Resend countdown
    useEffect(() => {
        if (resendCooldown <= 0) return
        const t = setTimeout(() => setResendCooldown(c => c - 1), 1000)
        return () => clearTimeout(t)
    }, [resendCooldown])

    // ── Init: detect current state & jump to correct step ─────────────────────
    useEffect(() => {
        const init = async () => {
            const { data: { user } } = await supabase.auth.getUser()
            if (!user) { router.replace('/auth'); return }

            setUserId(user.id)
            setEmail(user.email || '')

            // Populate name from Google OAuth metadata
            const meta = user.user_metadata || {}
            const fullName = ((meta.full_name || meta.name || '') as string).trim()
            if (fullName) {
                const parts = fullName.split(' ')
                setFirstName(parts[0] || '')
                setLastName(parts.slice(1).join(' ') || '')
            }

            // Detect whether a password has been set. We cannot rely on
            // identities[].provider === 'email' because updateUser({ password })
            // for a Google-only user does NOT insert an email identity record —
            // it only updates encrypted_password. Instead we use a has_password
            // flag we write into user_metadata when the password is first set.
            // The identities fallback handles pure email/password accounts.
            const isGoogle   = user.identities?.some((id: any) => id.provider === 'google') ?? false
            const hasPassword = (user.user_metadata?.has_password === true)
                || (user.identities?.some((id: any) => id.provider === 'email') ?? false)
            setIsGoogleUser(isGoogle)

            // Fetch DB profile + admin OTP setting in parallel.
            // The OTP setting is read via the public API route (uses service-role client)
            // so it isn't blocked by RLS on the admin_settings table.
            const [dbRes, settingRes] = await Promise.all([
                (supabase.from('users') as any)
                    .select('phone_number, phone_verified, first_name, last_name')
                    .eq('id', user.id)
                    .single(),
                fetch('/api/admin-settings?keys=phone_verification_enabled')
                    .then(r => r.ok ? r.json() as Promise<Record<string, unknown>> : {})
                    .catch(() => ({} as Record<string, unknown>)),
            ])

            const db = dbRes.data
            const otpVal = (settingRes as Record<string, unknown>)?.phone_verification_enabled
            const adminOtp = otpVal === true || otpVal === 'true'
            setOtpEnabled(adminOtp)

            if (db?.first_name) setFirstName(db.first_name)
            if (db?.last_name)  setLastName(db.last_name)

            const phoneSaved    = !!db?.phone_number
            const phoneVerified = !!db?.phone_verified

            // ── ROUTING ─────────────────────────────────────────────────────────
            if (isGoogle) {
                // Google users always have two meaningful steps
                const labels = adminOtp
                    ? ['Verify Phone', 'Set Password']
                    : ['Add Phone', 'Set Password']
                setStepLabels(labels)

                // Fully complete
                if (phoneSaved && (phoneVerified || !adminOtp) && hasPassword) {
                    router.replace('/dashboard'); return
                }

                // Phone step done, password still needed
                if (phoneSaved && (phoneVerified || !adminOtp) && !hasPassword) {
                    setNormalizedPhone(db.phone_number)
                    setStep('set-password')
                    setProgressStep(2)
                    return
                }

                // Phone saved, OTP not done (user quit mid-verification)
                if (phoneSaved && !phoneVerified && adminOtp) {
                    setNormalizedPhone(db.phone_number)
                    setPhoneNumber(db.phone_number)
                    setStep('otp-verify')
                    setProgressStep(1)
                    return
                }

                // Fresh start
                setStep('phone-entry')
                setProgressStep(1)
            } else {
                // Email users — single step only (no password needed)
                setStepLabels([]) // no progress bar for a single step

                if (phoneSaved) { router.replace('/dashboard'); return }

                setStep('phone-entry')
                setProgressStep(1)
            }
        }

        init()
    }, [router])

    // ── Save phone to DB ───────────────────────────────────────────────────────
    const savePhoneToDb = useCallback(async (phone: string, verified: boolean) => {
        // The row already exists (handle_new_user creates it at signup), so this
        // must be an UPDATE, never an upsert: Postgres/PostgREST builds the full
        // candidate row for an upsert's insert branch — including NULL for any
        // NOT NULL column omitted from the payload — and validates it *before*
        // falling back to the conflict/update path. Omitting last_name for a
        // Google user with a single-word display name (empty last name) then
        // fails with a not-null violation even though the existing row is fine.
        const row: Record<string, unknown> = {
            email,
            phone_number: phone,
            phone_verified: verified,
        }
        // Only write names if we actually have them — avoids overwriting
        // existing values with empty strings for returning users
        if (firstName.trim()) row.first_name = firstName.trim()
        if (lastName.trim())  row.last_name  = lastName.trim()

        const { error } = await (supabase.from('users') as any)
            .update(row)
            .eq('id', userId)
        return error
    }, [userId, email, firstName, lastName])

    // ── Handler: phone entry ───────────────────────────────────────────────────
    const handlePhoneSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')

        const v = validateGhanaianPhone(phoneNumber)
        if (!v.isValid) { setError(v.error || 'Invalid phone number'); return }

        const norm = v.normalizedNumber!
        setSubmitting(true)
        try {
            if (!otpEnabled) {
                // Admin disabled verification — save phone directly, no OTP
                const dbErr = await savePhoneToDb(norm, false)
                if (dbErr) {
                    setError(
                        dbErr.code === '23505' || dbErr.message?.toLowerCase().includes('unique')
                            ? 'This number is already linked to another account. Please try a different one.'
                            : `Could not save your number: ${dbErr.message}`
                    )
                    return
                }
                setNormalizedPhone(norm)
                if (isGoogleUser) {
                    setStep('set-password')
                    setProgressStep(2)
                } else {
                    setStep('success')
                    setTimeout(() => router.push('/dashboard'), 2000)
                }
            } else {
                // Admin enabled OTP — send code
                const res  = await fetch('/api/auth/verify-phone', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'send', phone: norm }),
                })
                const data = await res.json()
                if (!res.ok) { setError(data.error || 'Failed to send verification code'); return }
                setNormalizedPhone(norm)
                setResendCooldown(60)
                setStep('otp-verify')
            }
        } catch {
            setError('Connection error. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    // ── Handler: OTP verify ────────────────────────────────────────────────────
    const handleOtpSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setSubmitting(true)
        try {
            const res  = await fetch('/api/auth/verify-phone', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'verify', phone: normalizedPhone, code: otpCode }),
            })
            const data = await res.json()
            if (!res.ok || !data.verified) {
                setError(data.error || 'Invalid code. Please try again.')
                return
            }

            const dbErr = await savePhoneToDb(normalizedPhone, true)
            if (dbErr) {
                setError(
                    dbErr.code === '23505' || dbErr.message?.toLowerCase().includes('unique')
                        ? 'This number is already linked to another account. Go back and enter a different one.'
                        : `Could not save your number: ${dbErr.message}`
                )
                return
            }

            if (isGoogleUser) {
                setStep('set-password')
                setProgressStep(2)
            } else {
                setStep('success')
                setTimeout(() => router.push('/dashboard'), 2000)
            }
        } catch {
            setError('Connection error. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    // ── Handler: resend OTP ────────────────────────────────────────────────────
    const handleResend = async () => {
        if (resendCooldown > 0) return
        try {
            await fetch('/api/auth/verify-phone', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'send', phone: normalizedPhone }),
            })
            setResendCooldown(60)
            toast.success('Verification code resent!')
        } catch {
            toast.error('Failed to resend. Please try again.')
        }
    }

    // ── Handler: password ──────────────────────────────────────────────────────
    const handlePasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')

        if (!isStrongPassword(password)) { setError(PASSWORD_REQUIREMENTS_MESSAGE); return }
        if (password !== confirmPassword) { setError('Passwords do not match'); return }

        setSubmitting(true)
        try {
            // Write the password AND mark has_password=true in one atomic call.
            // The metadata flag is what all profile-completeness guards check —
            // updateUser({ password }) does NOT add an email identity for OAuth
            // users so we cannot rely on identities[].provider === 'email'.
            const { error: pwErr } = await supabase.auth.updateUser({
                password,
                data: { has_password: true },
            })
            if (pwErr) {
                const msg = pwErr.message || ''
                if (msg.toLowerCase().includes('same password') || msg.toLowerCase().includes('different')) {
                    // User already has this password set (returning user whose
                    // profile was complete before the has_password flag existed).
                    // Just stamp the flag and let them through.
                    await supabase.auth.updateUser({ data: { has_password: true } })
                } else if (msg.toLowerCase().includes('weak') || msg.toLowerCase().includes('characters')) {
                    setError(`Password is too weak — ${msg}`)
                    return
                } else {
                    setError(`Could not set your password: ${msg || 'Please try again.'}`)
                    return
                }
            }

            // Notify admins (fire-and-forget — server handles push-service)
            fetch('/api/auth/notify-google-signup', { method: 'POST' }).catch(() => {})

            setStep('success')
            // Hard navigate so AuthContext reinitialises from a fresh getSession()
            // call and picks up the updated user_metadata before the dashboard
            // guard runs. router.push() reuses the existing context and may still
            // hold the pre-update snapshot, causing a false profile-incomplete
            // redirect.
            setTimeout(() => { window.location.href = '/dashboard' }, 2000)
        } catch {
            setError('Connection error. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    // ── Loading screen ─────────────────────────────────────────────────────────
    if (step === 'loading') {
        return (
            <div className="relative min-h-screen flex items-center justify-center">
                <BackgroundBubbles scrollable />
                <div className="flex items-center gap-2 text-slate-500 relative z-10">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span className="text-sm">Loading your profile...</span>
                </div>
            </div>
        )
    }

    // ── Main UI ────────────────────────────────────────────────────────────────
    const isResuming = step === 'set-password' && !!normalizedPhone

    return (
        <div className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 py-8 overflow-y-auto">
            <BackgroundBubbles scrollable />

            <div className="w-full max-w-[380px] sm:max-w-md relative z-10">
                {/* Brand header */}
                <div className="text-center mb-6">
                    <Link href="/" className="inline-flex flex-col items-center">
                        <div className="relative w-20 h-20 mb-3 rounded-full overflow-hidden bg-white dark:bg-slate-800 shadow-lg border-[3px] border-[#FFCC00]">
                            <BrandLogo width={80} height={80} className="object-contain w-full h-full" />
                        </div>
                        <BrandTitle className="text-xl font-bold text-slate-900 dark:text-white tracking-tight" />
                    </Link>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 font-medium">
                        {firstName ? `Welcome, ${firstName}! ` : ''}Complete your profile
                    </p>
                </div>

                <Card className="w-full border border-white/60 dark:border-slate-700/50 bg-white/92 dark:bg-slate-900/92 backdrop-blur-xl shadow-[0_20px_60px_rgba(0,0,0,0.12)] dark:shadow-[0_20px_60px_rgba(0,0,0,0.5)] rounded-2xl overflow-hidden">
                    <div className="h-0.5 w-full bg-gradient-to-r from-[#0056B3] via-[#00B4D8] to-[#FFCC00]" />
                    <CardContent className="p-5 sm:p-6">

                        {/* Progress bar (only when 2 steps) */}
                        <StepProgress labels={stepLabels} currentStep={progressStep} />

                        {/* Resume banner — shown when user comes back mid-flow */}
                        {isResuming && (
                            <div className="flex items-start gap-2 mb-4 px-3 py-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/30">
                                <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                                <p className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
                                    Phone saved ({normalizedPhone}) — just set your password to finish.
                                </p>
                            </div>
                        )}

                        {/* Error */}
                        {error && (
                            <Alert variant="destructive" className="mb-4 py-2 bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800/30">
                                <AlertDescription className="text-red-600 dark:text-red-400 text-sm">{error}</AlertDescription>
                            </Alert>
                        )}

                        {/* ── Step: phone entry ─────────────────────────────────── */}
                        {step === 'phone-entry' && (
                            <form onSubmit={handlePhoneSubmit} className="space-y-4">
                                <div>
                                    <h2 className="text-base font-bold text-slate-900 dark:text-white">Add Your Phone Number</h2>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                        {otpEnabled
                                            ? "We'll send a 6-digit code to confirm your number."
                                            : 'Your number will be saved to your account.'}
                                    </p>
                                </div>

                                <div className="space-y-1.5">
                                    <Label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">
                                        Mobile Number
                                    </Label>
                                    <div className="relative">
                                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                        <Input
                                            value={phoneNumber}
                                            onChange={e => setPhoneNumber(e.target.value)}
                                            required
                                            type="tel"
                                            autoComplete="tel"
                                            placeholder="024XXXXXXX"
                                            className="h-11 pl-10 rounded-xl text-sm bg-white dark:bg-slate-800/70"
                                        />
                                    </div>
                                    <p className="text-[11px] text-slate-400">Ghana number: 024XXXXXXX or 0233XXXXXXXXX</p>
                                </div>

                                <Button type="submit" disabled={submitting}
                                    className="w-full h-12 text-sm font-bold text-white rounded-xl shadow-lg bg-gradient-to-br from-[#0056B3] to-[#00B4D8]">
                                    {submitting
                                        ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Please wait...</>
                                        : otpEnabled ? 'Send Verification Code' : 'Continue'
                                    }
                                </Button>
                            </form>
                        )}

                        {/* ── Step: OTP verify ──────────────────────────────────── */}
                        {step === 'otp-verify' && (
                            <form onSubmit={handleOtpSubmit} className="space-y-4">
                                <div>
                                    <h2 className="text-base font-bold text-slate-900 dark:text-white">Verify Your Number</h2>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                        Enter the 6-digit code sent to{' '}
                                        <strong className="text-slate-700 dark:text-slate-200">{normalizedPhone}</strong>
                                    </p>
                                </div>

                                <div className="space-y-1.5">
                                    <Label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">
                                        6-Digit Code
                                    </Label>
                                    <Input
                                        value={otpCode}
                                        onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                        required
                                        inputMode="numeric"
                                        autoComplete="one-time-code"
                                        placeholder="000000"
                                        maxLength={6}
                                        className="h-14 text-center text-2xl font-bold tracking-[0.5em] rounded-xl bg-white dark:bg-slate-800/70"
                                    />
                                </div>

                                <Button type="submit" disabled={submitting || otpCode.length !== 6}
                                    className="w-full h-12 text-sm font-bold text-white rounded-xl shadow-lg bg-gradient-to-br from-[#0056B3] to-[#00B4D8]">
                                    {submitting
                                        ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying...</>
                                        : 'Verify & Continue'
                                    }
                                </Button>

                                <div className="flex items-center justify-center gap-3 text-xs">
                                    <button type="button" onClick={handleResend} disabled={resendCooldown > 0}
                                        className="flex items-center gap-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors disabled:opacity-50">
                                        <RefreshCw className="w-3 h-3" />
                                        {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                                    </button>
                                    <span className="text-slate-300 dark:text-slate-600">·</span>
                                    <button type="button"
                                        onClick={() => { setStep('phone-entry'); setOtpCode(''); setError('') }}
                                        className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors">
                                        Change number
                                    </button>
                                </div>
                            </form>
                        )}

                        {/* ── Step: set password ────────────────────────────────── */}
                        {step === 'set-password' && (
                            <form onSubmit={handlePasswordSubmit} className="space-y-4">
                                <div>
                                    <h2 className="text-base font-bold text-slate-900 dark:text-white">Set Your Password</h2>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                        Create a password so you can sign in even when Google is unavailable.
                                    </p>
                                </div>

                                <div className="space-y-1.5">
                                    <Label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                        <Input
                                            value={password}
                                            onChange={e => setPassword(e.target.value)}
                                            required
                                            type={showPassword ? 'text' : 'password'}
                                            autoComplete="new-password"
                                            placeholder="Min 8 chars, uppercase, lowercase, number"
                                            minLength={8}
                                            className="h-11 pl-10 pr-10 rounded-xl text-sm bg-white dark:bg-slate-800/70"
                                        />
                                        <button type="button" onClick={() => setShowPassword(v => !v)} tabIndex={-1}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </button>
                                    </div>
                                </div>

                                <div className="space-y-1.5">
                                    <Label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Confirm Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                        <Input
                                            value={confirmPassword}
                                            onChange={e => setConfirmPassword(e.target.value)}
                                            required
                                            type={showConfirm ? 'text' : 'password'}
                                            autoComplete="new-password"
                                            placeholder="Repeat your password"
                                            minLength={8}
                                            className="h-11 pl-10 pr-10 rounded-xl text-sm bg-white dark:bg-slate-800/70"
                                        />
                                        <button type="button" onClick={() => setShowConfirm(v => !v)} tabIndex={-1}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                                            {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </button>
                                    </div>
                                </div>

                                <Button type="submit" disabled={submitting}
                                    className="w-full h-12 text-sm font-bold text-white rounded-xl shadow-lg bg-gradient-to-br from-[#0056B3] to-[#00B4D8]">
                                    {submitting
                                        ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Setting password...</>
                                        : 'Complete Setup'
                                    }
                                </Button>
                            </form>
                        )}

                        {/* ── Step: success ─────────────────────────────────────── */}
                        {step === 'success' && (
                            <div className="text-center py-6 space-y-3">
                                <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto">
                                    <CheckCircle className="w-9 h-9 text-emerald-600" />
                                </div>
                                <h2 className="text-base font-bold text-slate-900 dark:text-white">Profile Complete!</h2>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Taking you to your dashboard...</p>
                                <Loader2 className="w-5 h-5 animate-spin text-slate-400 mx-auto" />
                            </div>
                        )}

                    </CardContent>
                </Card>

                {/* Escape hatch — hidden during success redirect */}
                {step !== 'success' && (
                    <div className="text-center mt-4">
                        <button
                            type="button"
                            onClick={() => {
                                try {
                                    localStorage.removeItem('kfg_pin_verified')
                                    localStorage.removeItem('kfg_pin_verified_at')
                                } catch {}
                                window.location.href = '/api/auth/signout'
                            }}
                            className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                        >
                            <LogOut className="w-3.5 h-3.5" />
                            Use a different account
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}
