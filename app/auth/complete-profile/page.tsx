'use client'

import { useState, useEffect, useCallback, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { isStrongPassword, PASSWORD_REQUIREMENTS_MESSAGE } from '@/lib/password-validation'
import { Label } from '@/components/ui/label'
import { ClayButton, NeuInput, PasswordStrength } from '@/components/ft'
import { Loader2, Phone, CheckCircle, Lock, Eye, EyeOff, ShieldCheck, RefreshCw, LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { AuthShell } from '../_components/auth-shell'
import { AuthAlert, FT_LINK } from '../_components/shared'

type Step = 'loading' | 'phone-entry' | 'otp-verify' | 'set-password' | 'success'

// ─── Step progress bar ────────────────────────────────────────────────────────
// State is carried by a check icon, a number and a text label, not by colour alone.
function StepProgress({ labels, currentStep }: { labels: string[]; currentStep: number }) {
    if (labels.length <= 1) return null
    return (
        <ol className="mb-6 flex items-start" aria-label="Progress">
            {labels.map((label, i) => {
                const num = i + 1
                const done = num < currentStep
                const active = num === currentStep
                return (
                    <Fragment key={i}>
                        <li className="flex flex-col items-center gap-1" aria-current={active ? 'step' : undefined}>
                            <span className={cn(
                                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold',
                                done && 'border-ft-blue bg-ft-blue text-white dark:border-[color:var(--ft-cyan)] dark:bg-[color:var(--ft-cyan)] dark:text-slate-900',
                                active && 'ft-raised border-ft-blue text-ft-ink dark:border-[color:var(--ft-cyan)]',
                                !done && !active && 'border-[color:var(--ft-muted)] text-[color:var(--ft-muted)]',
                            )}>
                                {done ? <CheckCircle className="h-4 w-4" aria-hidden="true" /> : num}
                            </span>
                            <span className={cn(
                                'whitespace-nowrap text-xs font-semibold',
                                active ? 'text-ft-ink' : 'text-[color:var(--ft-muted)]',
                            )}>{label}{done ? ' (done)' : ''}</span>
                        </li>
                        {i < labels.length - 1 && (
                            <div aria-hidden="true" className={cn(
                                'mx-2 mt-[1.0625rem] h-0.5 flex-1',
                                done ? 'bg-ft-blue dark:bg-[color:var(--ft-cyan)]' : 'bg-[color:var(--ft-lo)] opacity-60',
                            )} />
                        )}
                    </Fragment>
                )
            })}
        </ol>
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
                    ? ['Verify phone', 'Set password']
                    : ['Add phone', 'Set password']
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
            <AuthShell showBrandPanel={false}>
                <div className="flex items-center justify-center gap-2 py-6 text-[color:var(--ft-muted)]" role="status">
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                    <span className="text-sm">Loading your profile…</span>
                </div>
            </AuthShell>
        )
    }

    // ── Main UI ────────────────────────────────────────────────────────────────
    const isResuming = step === 'set-password' && !!normalizedPhone

    return (
        <AuthShell
            showBrandPanel={false}
            title="Complete your profile"
            subtitle={firstName ? `Welcome, ${firstName}.` : undefined}
            footer={step !== 'success' ? (
                // Escape hatch — hidden during success redirect
                <div className="mt-4 text-center">
                    <button
                        type="button"
                        onClick={() => {
                            try {
                                localStorage.removeItem('kfg_pin_verified')
                                localStorage.removeItem('kfg_pin_verified_at')
                            } catch {}
                            window.location.href = '/api/auth/signout'
                        }}
                        className={cn('inline-flex min-h-12 items-center gap-1.5 px-3 text-sm font-semibold', FT_LINK)}
                    >
                        <LogOut className="h-4 w-4" aria-hidden="true" />
                        Use a different account
                    </button>
                </div>
            ) : undefined}
        >
            {/* Progress bar (only when 2 steps) */}
            <StepProgress labels={stepLabels} currentStep={progressStep} />

            {/* Resume banner — shown when user comes back mid-flow */}
            {isResuming && (
                <div className="mb-4">
                    <div className="ft-inset flex items-start gap-3 border-l-4 border-ft-blue px-4 py-3 text-sm font-semibold text-ft-ink dark:border-[color:var(--ft-cyan)]" role="status">
                        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 break-words">Phone saved ({normalizedPhone}). Set your password to finish.</span>
                    </div>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="mb-4">
                    <AuthAlert tone="error">{error}</AuthAlert>
                </div>
            )}

            {/* ── Step: phone entry ─────────────────────────────────── */}
            {step === 'phone-entry' && (
                <form onSubmit={handlePhoneSubmit} className="space-y-4">
                    <div>
                        <h2 className="ft-display text-lg font-extrabold text-ft-ink">Add your phone number</h2>
                        <p className="mt-0.5 text-sm text-[color:var(--ft-muted)]">
                            {otpEnabled
                                ? "We'll send a 6-digit code to confirm your number."
                                : 'Your number will be saved to your account.'}
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="cp-phone" className="text-sm font-semibold text-ft-ink">Mobile number</Label>
                        <NeuInput
                            id="cp-phone"
                            value={phoneNumber}
                            onChange={e => setPhoneNumber(e.target.value)}
                            required
                            type="tel"
                            autoComplete="tel"
                            placeholder="024XXXXXXX"
                            leading={<Phone className="h-4 w-4" aria-hidden="true" />}
                        />
                        <p className="text-xs text-[color:var(--ft-muted)]">Ghana number: 024XXXXXXX or 0233XXXXXXXXX</p>
                    </div>

                    <ClayButton type="submit" loading={submitting} className="w-full">
                        {submitting
                            ? 'Please wait…'
                            : otpEnabled ? 'Send verification code' : 'Continue'
                        }
                    </ClayButton>
                </form>
            )}

            {/* ── Step: OTP verify ──────────────────────────────────── */}
            {step === 'otp-verify' && (
                <form onSubmit={handleOtpSubmit} className="space-y-4">
                    <div>
                        <h2 className="ft-display text-lg font-extrabold text-ft-ink">Verify your number</h2>
                        <p className="mt-0.5 text-sm text-[color:var(--ft-muted)]">
                            Enter the 6-digit code sent to{' '}
                            <strong className="text-ft-ink">{normalizedPhone}</strong>
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="cp-otp" className="text-sm font-semibold text-ft-ink">6-digit code</Label>
                        <NeuInput
                            id="cp-otp"
                            value={otpCode}
                            onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                            required
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            placeholder="000000"
                            maxLength={6}
                            wrapperClassName="h-14"
                            className="text-center text-xl font-extrabold tracking-[0.4em]"
                        />
                    </div>

                    <ClayButton type="submit" disabled={otpCode.length !== 6} loading={submitting} className="w-full">
                        {submitting ? 'Verifying…' : 'Verify and continue'}
                    </ClayButton>

                    <div className="flex items-center justify-between gap-2">
                        <button type="button"
                            onClick={() => { setStep('phone-entry'); setOtpCode(''); setError('') }}
                            className="min-h-12 rounded-xl px-3 text-sm font-semibold text-ft-ink">
                            Change number
                        </button>
                        <button type="button" onClick={handleResend} disabled={resendCooldown > 0}
                            className={cn('flex min-h-12 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold disabled:opacity-60', FT_LINK)}>
                            <RefreshCw className="h-4 w-4" aria-hidden="true" />
                            {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                        </button>
                    </div>
                </form>
            )}

            {/* ── Step: set password ────────────────────────────────── */}
            {step === 'set-password' && (
                <form onSubmit={handlePasswordSubmit} className="space-y-4">
                    <div>
                        <h2 className="ft-display text-lg font-extrabold text-ft-ink">Set your password</h2>
                        <p className="mt-0.5 text-sm text-[color:var(--ft-muted)]">
                            Create a password so you can sign in even when Google is unavailable.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="cp-password" className="text-sm font-semibold text-ft-ink">Password</Label>
                        <NeuInput
                            id="cp-password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            required
                            type={showPassword ? 'text' : 'password'}
                            autoComplete="new-password"
                            placeholder="Min 8 chars, uppercase, lowercase, number"
                            minLength={8}
                            leading={<Lock className="h-4 w-4" aria-hidden="true" />}
                            trailing={
                                <button type="button" onClick={() => setShowPassword(v => !v)}
                                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                                    className="-mr-3 flex h-12 w-12 items-center justify-center rounded-xl text-[color:var(--ft-muted)] hover:text-ft-ink">
                                    {showPassword ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
                                </button>
                            }
                        />
                        <PasswordStrength password={password} />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="cp-confirm" className="text-sm font-semibold text-ft-ink">Confirm password</Label>
                        <NeuInput
                            id="cp-confirm"
                            value={confirmPassword}
                            onChange={e => setConfirmPassword(e.target.value)}
                            required
                            type={showConfirm ? 'text' : 'password'}
                            autoComplete="new-password"
                            placeholder="Repeat your password"
                            minLength={8}
                            leading={<Lock className="h-4 w-4" aria-hidden="true" />}
                            trailing={
                                <button type="button" onClick={() => setShowConfirm(v => !v)}
                                    aria-label={showConfirm ? 'Hide password' : 'Show password'}
                                    className="-mr-3 flex h-12 w-12 items-center justify-center rounded-xl text-[color:var(--ft-muted)] hover:text-ft-ink">
                                    {showConfirm ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
                                </button>
                            }
                        />
                    </div>

                    <ClayButton type="submit" loading={submitting} className="w-full">
                        {submitting ? 'Setting password…' : 'Complete setup'}
                    </ClayButton>
                </form>
            )}

            {/* ── Step: success ─────────────────────────────────────── */}
            {step === 'success' && (
                <div className="space-y-3 py-4 text-center" role="status">
                    <div className="ft-clay mx-auto flex h-14 w-14 items-center justify-center !rounded-full">
                        <CheckCircle className="h-7 w-7" aria-hidden="true" />
                    </div>
                    <h2 className="ft-display text-lg font-extrabold text-ft-ink">Profile complete</h2>
                    <p className="text-sm text-[color:var(--ft-muted)]">Taking you to your dashboard…</p>
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-[color:var(--ft-muted)]" aria-hidden="true" />
                </div>
            )}
        </AuthShell>
    )
}
