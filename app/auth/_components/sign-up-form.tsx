'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ClayButton, NeuInput, PasswordStrength } from '@/components/ft'
import dynamic from 'next/dynamic'
const Dialog = dynamic(() => import('@/components/ui/dialog').then(m => ({ default: m.Dialog })))
const DialogContent = dynamic(() => import('@/components/ui/dialog').then(m => ({ default: m.DialogContent })))
const DialogHeader = dynamic(() => import('@/components/ui/dialog').then(m => ({ default: m.DialogHeader })))
const DialogTitle = dynamic(() => import('@/components/ui/dialog').then(m => ({ default: m.DialogTitle })))
const DialogFooter = dynamic(() => import('@/components/ui/dialog').then(m => ({ default: m.DialogFooter })))
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { isStrongPassword, PASSWORD_REQUIREMENTS_MESSAGE } from '@/lib/password-validation'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { FALLBACK_TERMS_VERSION, FALLBACK_EFFECTIVE_DATE } from '@/lib/terms'
import {
    Eye, EyeOff, Mail, Lock, User, Phone, ArrowLeft, UserPlus,
    MessageSquare, RefreshCw, CheckCircle2, BookOpen,
} from 'lucide-react'
import { AuthAlert, FT_ERROR_TEXT, FT_LINK, GoogleButton, OrDivider, TERMS_SECTIONS } from './shared'

// ─── Create Account form ──────────────────────────────────────────────────────
export function SignUpForm({ onGoogleLoading, googleLoading }: {
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
                    <div className="ft-clay w-12 h-12 flex items-center justify-center mx-auto mb-3">
                        <MessageSquare className="w-6 h-6" aria-hidden="true" />
                    </div>
                    <h3 className="ft-display font-extrabold text-lg text-ft-ink">Check your phone</h3>
                    <p className="text-sm text-[color:var(--ft-muted)]">
                        We texted a 6-digit code to <span className="font-semibold text-ft-ink">{pendingPhone.current}</span>
                    </p>
                </div>
                {otpError && <AuthAlert tone="error">{otpError}</AuthAlert>}
                <div className="space-y-2">
                    <Label htmlFor="signup-otp" className="text-sm font-semibold text-ft-ink">Verification code</Label>
                    <NeuInput id="signup-otp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="\d*" maxLength={6} placeholder="000000"
                        value={otpCode} onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
                        autoFocus wrapperClassName="h-14" className="text-center text-xl font-extrabold tracking-[0.4em]" />
                </div>
                <ClayButton type="button" onClick={handleVerifyOTP} disabled={otpCode.length !== 6} loading={otpLoading} className="w-full">
                    {otpLoading ? 'Checking the code…' : <><CheckCircle2 className="w-4 h-4" aria-hidden="true" />Verify and create account</>}
                </ClayButton>
                <div className="flex items-center justify-between gap-2">
                    <button type="button" onClick={() => { setStep('form'); setOtpCode(''); setOtpError('') }}
                        className="min-h-12 px-3 font-semibold text-ft-ink transition-colors flex items-center gap-1.5 text-sm rounded-xl">
                        <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Go back
                    </button>
                    <button type="button" onClick={handleResendOTP} disabled={resendCooldown > 0}
                        className={cn('min-h-12 px-3 font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-60 text-sm rounded-xl', FT_LINK)}>
                        <RefreshCw className="w-4 h-4" aria-hidden="true" />
                        {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                    </button>
                </div>
            </div>
        )
    }

    // ── Success step ──────────────────────────────────────────────────────────
    if (step === 'success') {
        return (
            <div className="text-center space-y-4 py-2">
                <div className="ft-clay w-14 h-14 !rounded-full flex items-center justify-center mx-auto">
                    <CheckCircle2 className="w-7 h-7" aria-hidden="true" />
                </div>
                <div>
                    <h3 className="ft-display text-lg font-extrabold text-ft-ink mb-1">Check your email</h3>
                    <p className="text-sm text-[color:var(--ft-muted)]">
                        We sent a confirmation link to <strong className="text-ft-ink break-all">{formData.email}</strong>.
                        Open it to activate your account, then sign in. Can&apos;t find it? Look in your spam folder.
                    </p>
                </div>
                {/* An unconfirmed account has NO session — never route here to /dashboard
                    (middleware just bounces it back to /auth). Offer a resend + a way
                    back to sign in instead. */}
                <ClayButton
                    type="button"
                    onClick={handleResendSignupConfirmation}
                    disabled={resendCooldown > 0}
                    className="w-full"
                >
                    <RefreshCw className="w-4 h-4" aria-hidden="true" />
                    {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend confirmation email'}
                </ClayButton>
                <a href="/auth" className={cn('inline-flex min-h-12 items-center px-3 text-sm font-semibold', FT_LINK)}>
                    ← Back to sign in
                </a>
            </div>
        )
    }

    // ── Main form step ────────────────────────────────────────────────────────
    return (
        <div className="space-y-4">
            {/* Google first */}
            <GoogleButton label="Sign up with Google" isLoading={googleLoading} onClick={handleGoogle} />
            <OrDivider />

            {/* Terms of Service dialog */}
            <Dialog open={showTermsDialog} onOpenChange={setShowTermsDialog}>
                <DialogContent className="max-w-md flex flex-col p-0 gap-0 max-h-[85vh]">
                    <DialogHeader className="px-5 pt-5 pb-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
                        <DialogTitle className="flex items-center gap-2 text-sm font-black">
                            <BookOpen className="w-4 h-4 text-primary" />
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
                            className="flex-1 h-12 text-sm font-semibold rounded-xl">
                            Cancel
                        </Button>
                        <Button
                            onClick={() => { setAgreedToTerms(true); setShowTermsDialog(false) }}
                            className="flex-1 h-12 text-sm font-bold rounded-xl"
                        >
                            <CheckCircle2 className="w-4 h-4 mr-1.5" />
                            I Accept
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <form onSubmit={handleCreateAccount} className="space-y-4">
                {error && (
                    <AuthAlert tone={lockoutMinutes !== null ? 'warn' : 'error'}>{error}</AuthAlert>
                )}

                <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-3">
                    {[{ id: 'firstName', label: 'First name', placeholder: 'First' }, { id: 'lastName', label: 'Last name', placeholder: 'Last' }].map(f => (
                        <div key={f.id} className="space-y-2">
                            <Label htmlFor={`signup-${f.id}`} className="text-sm font-semibold text-ft-ink">{f.label}</Label>
                            <NeuInput id={`signup-${f.id}`} name={f.id} autoComplete={f.id === 'firstName' ? 'given-name' : 'family-name'} placeholder={f.placeholder} value={(formData as any)[f.id]}
                                onChange={handleChange} required
                                aria-invalid={fieldErrors[f.id] ? true : undefined}
                                wrapperClassName={cn(fieldErrors[f.id] && 'outline outline-2 outline-red-600 dark:outline-red-400')}
                                leading={<User className="h-4 w-4" aria-hidden="true" />} />
                            {fieldErrors[f.id] && <p className={cn('text-sm font-semibold', FT_ERROR_TEXT)}>{fieldErrors[f.id]}</p>}
                        </div>
                    ))}
                </div>

                <div className="space-y-2">
                    <Label htmlFor="signup-email" className="text-sm font-semibold text-ft-ink">Email address</Label>
                    <NeuInput id="signup-email" name="email" type="email" autoComplete="email" placeholder="you@email.com" value={formData.email}
                        onChange={handleChange} required
                        aria-invalid={fieldErrors.email ? true : undefined}
                        wrapperClassName={cn(fieldErrors.email && 'outline outline-2 outline-red-600 dark:outline-red-400')}
                        leading={<Mail className="h-4 w-4" aria-hidden="true" />} />
                    {fieldErrors.email && <p className={cn('text-sm font-semibold', FT_ERROR_TEXT)}>{fieldErrors.email}</p>}
                </div>

                <div className="space-y-2">
                    <Label htmlFor="signup-phone" className="text-sm font-semibold text-ft-ink">Mobile number</Label>
                    <NeuInput id="signup-phone" name="phoneNumber" type="tel" autoComplete="tel" placeholder="024 XXX XXXX" value={formData.phoneNumber}
                        onChange={handleChange} required
                        aria-invalid={fieldErrors.phoneNumber ? true : undefined}
                        wrapperClassName={cn(fieldErrors.phoneNumber && 'outline outline-2 outline-red-600 dark:outline-red-400')}
                        leading={<Phone className="h-4 w-4" aria-hidden="true" />} />
                    {fieldErrors.phoneNumber && <p className={cn('text-sm font-semibold', FT_ERROR_TEXT)}>{fieldErrors.phoneNumber}</p>}
                </div>

                <div className="space-y-2">
                    <Label htmlFor="signup-password" className="text-sm font-semibold text-ft-ink">Password</Label>
                    <NeuInput id="signup-password" name="password" type={showPw ? 'text' : 'password'} autoComplete="new-password" placeholder="Pick a strong password"
                        value={formData.password} onChange={handleChange} required
                        aria-invalid={fieldErrors.password ? true : undefined}
                        wrapperClassName={cn(fieldErrors.password && 'outline outline-2 outline-red-600 dark:outline-red-400')}
                        leading={<Lock className="h-4 w-4" aria-hidden="true" />}
                        trailing={
                            <button type="button" aria-label={showPw ? 'Hide password' : 'Show password'}
                                onClick={() => setShowPw(p => !p)}
                                className="-mr-3 flex h-12 w-12 items-center justify-center rounded-xl text-[color:var(--ft-muted)] hover:text-ft-ink">
                                {showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                            </button>
                        } />
                    {fieldErrors.password && <p className={cn('text-sm font-semibold', FT_ERROR_TEXT)}>{fieldErrors.password}</p>}
                    <PasswordStrength password={formData.password} />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="signup-confirm" className="text-sm font-semibold text-ft-ink">Confirm password</Label>
                    <NeuInput id="signup-confirm" name="confirmPassword" type={showPw ? 'text' : 'password'} autoComplete="new-password" placeholder="Type it once more"
                        value={formData.confirmPassword} onChange={handleChange} required
                        leading={<Lock className="h-4 w-4" aria-hidden="true" />} />
                </div>

                {/* Terms checkbox — opens dialog on click */}
                <div className="flex items-start gap-3 py-1">
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
                        className="w-6 h-6 mt-0.5 shrink-0 rounded cursor-pointer accent-[#0057FF]"
                    />
                    <label htmlFor="terms" className="text-sm font-medium text-ft-ink cursor-pointer leading-relaxed">
                        I have read and agree to the latest{' '}
                        <button type="button" onClick={() => setShowTermsDialog(true)}
                            className={cn('font-bold underline', FT_LINK)}>
                            Terms of Service
                        </button>
                        {' '}(v{termsMeta.version}, effective {termsMeta.effectiveDate}){' '}and{' '}
                        <Link href="/privacy" target="_blank" className={cn('font-bold underline', FT_LINK)}>
                            Privacy Policy
                        </Link>
                    </label>
                </div>

                <ClayButton type="submit" disabled={!agreedToTerms || lockoutMinutes !== null} loading={isLoading} className="w-full">
                    {isLoading
                        ? 'Setting things up…'
                        : <><UserPlus className="w-4 h-4" aria-hidden="true" />Create account</>}
                </ClayButton>
            </form>
        </div>
    )
}
