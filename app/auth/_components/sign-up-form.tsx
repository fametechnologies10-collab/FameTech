'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
    Eye, EyeOff, Loader2, Mail, Lock, User, Phone, ArrowLeft, UserPlus,
    MessageSquare, RefreshCw, CheckCircle2, BookOpen,
} from 'lucide-react'
import { GoogleButton, OrDivider, TERMS_SECTIONS } from './shared'

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
