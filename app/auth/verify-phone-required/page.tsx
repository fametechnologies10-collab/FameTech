'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { isPhoneVerificationEnabled } from '@/lib/phone-verification-setting'
import { Label } from '@/components/ui/label'
import { ClayButton, NeuInput } from '@/components/ft'
import { Loader2, Phone, CheckCircle, RefreshCw, LogOut, ShieldQuestion, MessageCircleQuestion } from 'lucide-react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { AuthShell } from '../_components/auth-shell'
import { AuthAlert, FT_LINK } from '../_components/shared'

// "58s" while under a minute; "12m" / "1h 5m" once the 3-per-hour cap kicks
// in and the real wait is the hourly reset, not the usual 60s.
function formatCooldown(totalSeconds: number): string {
    if (totalSeconds < 60) return `${totalSeconds}s`
    const minutes = Math.floor(totalSeconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const remMinutes = minutes % 60
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`
}

type Mode = 'loading' | 'otp-verify' | 'lost-hint' | 'lost-new-number' | 'lost-otp-verify' | 'success' | 'message-admin'

export default function VerifyPhoneRequiredPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const wantsToChangeNumber = searchParams.get('mode') === 'change'

    const [mode, setMode] = useState<Mode>('loading')
    // Masked display only ("05••••••92") — the real phone_number never
    // reaches this page's state or network traffic for the primary flow.
    const [phoneHint, setPhoneHint] = useState('')
    const [otpCode, setOtpCode] = useState('')
    const [resendCooldown, setResendCooldown] = useState(0)
    // Separate from `submitting` (form-submit state) — guards the resend
    // buttons specifically, since they're taps outside any <form> submit.
    const [sendingCode, setSendingCode] = useState(false)
    const [error, setError] = useState('')
    const [submitting, setSubmitting] = useState(false)

    // Lost-number recovery state
    const [oldNumberGuess, setOldNumberGuess] = useState('')
    const [recoveryToken, setRecoveryToken] = useState('')
    const [newPhone, setNewPhone] = useState('')
    const [lockMessage, setLockMessage] = useState('')

    // Message-admin state — the user provides their own contact number here;
    // this page never has the real on-file number to prefill it with.
    const [supportSubject, setSupportSubject] = useState('')
    const [supportMessage, setSupportMessage] = useState('')
    const [supportContact, setSupportContact] = useState('')

    useEffect(() => {
        if (resendCooldown <= 0) return
        const t = setTimeout(() => setResendCooldown(c => c - 1), 1000)
        return () => clearTimeout(t)
    }, [resendCooldown])

    const fetchHint = async (): Promise<{ ok: boolean; hint?: string; phoneVerified?: boolean; error?: string }> => {
        const res = await fetch('/api/auth/phone-verify-gate/hint')
        const data = await res.json()
        if (!res.ok || !data.success) return { ok: false, error: data.error }
        return { ok: true, hint: data.data.hint, phoneVerified: data.data.phoneVerified }
    }

    const sendCurrentCode = async () => {
        if (sendingCode || resendCooldown > 0) return
        setSendingCode(true)
        try {
            const res = await fetch('/api/auth/phone-verify-gate/send-current', { method: 'POST' })
            const data = await res.json().catch(() => ({}))
            setResendCooldown(data?.data?.cooldownSeconds ?? 60)
        } catch {
            setResendCooldown(60)
        } finally {
            setSendingCode(false)
        }
    }

    useEffect(() => {
        const init = async () => {
            const { data: { user } } = await supabase.auth.getUser()
            if (!user) { router.replace('/auth'); return }

            // Verification switched off (e.g. no SMS provider yet): no code can ever
            // be sent, so don't strand the user on a dead-end code screen. The
            // explicit "change my number" flow (?mode=change) is left alone.
            if (!wantsToChangeNumber) {
                const setting = await fetch('/api/admin-settings?keys=phone_verification_enabled')
                    .then(r => (r.ok ? r.json() as Promise<Record<string, unknown>> : {}))
                    .catch(() => ({} as Record<string, unknown>))
                if (!isPhoneVerificationEnabled((setting as Record<string, unknown>)?.phone_verification_enabled)) {
                    router.replace('/dashboard')
                    return
                }
            }

            const hint = await fetchHint()
            if (!hint.ok) {
                // No phone on file at all — send them to complete-profile instead.
                router.replace('/auth/complete-profile')
                return
            }

            if (hint.phoneVerified) {
                // Already verified: only stick around if the user came here on
                // purpose to change their number (from the profile page). A
                // bare visit to this URL while verified just bounces home.
                if (!wantsToChangeNumber) { router.replace('/dashboard'); return }
                setPhoneHint(hint.hint!)
                await startLostNumberFlow()
                return
            }

            setPhoneHint(hint.hint!)
            await sendCurrentCode()
            setMode('otp-verify')
        }
        init()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [router])

    const handleVerifyCurrent = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setSubmitting(true)
        try {
            const res = await fetch('/api/auth/phone-verify-gate/verify-current', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: otpCode }),
            })
            const data = await res.json()
            if (!res.ok || !data.success) {
                setError(data.error || 'Invalid code. Please try again.')
                return
            }

            setMode('success')
            setTimeout(() => { window.location.href = '/dashboard' }, 1500)
        } catch {
            setError('Connection error. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    const startLostNumberFlow = async () => {
        setError('')
        setSubmitting(true)
        try {
            const hint = await fetchHint()
            if (!hint.ok) {
                setError(hint.error || 'Could not load your account hint.')
                return
            }
            setPhoneHint(hint.hint!)
            setMode('lost-hint')
        } catch {
            setError('Connection error. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    const handleGuessSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setLockMessage('')
        setSubmitting(true)
        try {
            const res = await fetch('/api/auth/phone-verify-gate/recover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ guess: oldNumberGuess }),
            })
            const data = await res.json()
            if (!res.ok || !data.success) {
                if (data?.data?.hard_locked || data?.data?.retry_at) {
                    setLockMessage(data.error)
                    setMode('message-admin')
                    return
                }
                setError(data.error || 'That number does not match our records.')
                return
            }
            setRecoveryToken(data.data.token)
            setMode('lost-new-number')
        } catch {
            setError('Connection error. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    // Sends an OTP to a brand-new number the user just typed in — this is a
    // fine use of the shared /api/auth/verify-phone endpoint since the number
    // isn't a stored secret yet, unlike the current on-file number above.
    const sendCodeToNewNumber = async (phone: string, force = false) => {
        // `force` is used only for the very first send when the user just
        // entered this new number — resendCooldown at that point may still
        // reflect an unrelated earlier screen's timer (e.g. the primary
        // on-file number's), a stale value a plain state check can't tell
        // apart from a real cooldown on THIS number.
        if (!force && (sendingCode || resendCooldown > 0)) return
        setSendingCode(true)
        try {
            const res = await fetch('/api/auth/verify-phone', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'send', phone }),
            })
            const data = await res.json().catch(() => ({}))
            setResendCooldown(data?.cooldownSeconds ?? 60)
        } catch {
            setResendCooldown(60)
        } finally {
            setSendingCode(false)
        }
    }

    const handleNewNumberSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        const v = validateGhanaianPhone(newPhone)
        if (!v.isValid) { setError(v.error || 'Invalid phone number'); return }
        setSubmitting(true)
        try {
            // Check before sending an OTP — a number already taken will always
            // fail at the final update anyway (unique constraint), so checking
            // first avoids burning an SMS on a number we already know is a dead end.
            const availRes = await fetch('/api/auth/check-availability', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phoneNumber: v.normalizedNumber }),
            })
            const availData = await availRes.json().catch(() => ({}))
            if (!availRes.ok) { setError('Could not check that number. Please try again.'); return }
            if (!availData.available) { setError('This number is already linked to another account.'); return }

            await sendCodeToNewNumber(v.normalizedNumber!, true)
            setNewPhone(v.normalizedNumber!)
            setOtpCode('')
            setMode('lost-otp-verify')
        } finally {
            setSubmitting(false)
        }
    }

    const handleNewNumberOtpSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setSubmitting(true)
        try {
            const verifyRes = await fetch('/api/auth/verify-phone', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'verify', phone: newPhone, code: otpCode }),
            })
            const verifyData = await verifyRes.json()
            if (!verifyRes.ok || !verifyData.verified) {
                setError(verifyData.error || 'Invalid code. Please try again.')
                return
            }

            const completeRes = await fetch('/api/auth/phone-verify-gate/recover/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: recoveryToken, newPhone }),
            })
            const completeData = await completeRes.json()
            if (!completeRes.ok || !completeData.success) {
                setError(completeData.error || 'Could not update your number. Please try again.')
                return
            }

            setMode('success')
            setTimeout(() => { window.location.href = '/dashboard' }, 1500)
        } catch {
            setError('Connection error. Please try again.')
        } finally {
            setSubmitting(false)
        }
    }

    const handleSupportSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (supportSubject.trim().length < 3) { toast.error('Please enter a short subject'); return }
        if (supportMessage.trim().length < 5) { toast.error('Please describe your issue'); return }
        const contactValidation = validateGhanaianPhone(supportContact)
        if (!contactValidation.isValid) { toast.error('Enter a valid phone/WhatsApp number so we can reach you'); return }
        setSubmitting(true)
        try {
            const res = await fetch('/api/support/threads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    subject: supportSubject.trim(),
                    category: 'account',
                    message: supportMessage.trim(),
                    phone_number: contactValidation.normalizedNumber,
                    whatsapp_number: contactValidation.normalizedNumber,
                }),
            })
            const data = await res.json()
            if (!res.ok || !data.success) throw new Error(data.error || 'Failed to send message')
            toast.success('Message sent — our team will reach out soon.')
            setSupportSubject('')
            setSupportMessage('')
            setSupportContact('')
        } catch (err: any) {
            toast.error(err?.message || 'Failed to send message')
        } finally {
            setSubmitting(false)
        }
    }

    const handleLogout = () => {
        window.location.href = '/api/auth/signout'
    }

    if (mode === 'loading') {
        return (
            <AuthShell showBrandPanel={false}>
                <div className="flex items-center justify-center gap-2 py-6 text-[color:var(--ft-muted)]" role="status">
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                    <span className="text-sm">Checking your account…</span>
                </div>
            </AuthShell>
        )
    }

    const linkBtn = cn('inline-flex min-h-12 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold disabled:opacity-60', FT_LINK)
    const headingCls = 'ft-display text-lg font-extrabold text-ft-ink'
    const subCls = 'mt-0.5 text-sm text-[color:var(--ft-muted)]'
    const labelCls = 'text-sm font-semibold text-ft-ink'

    return (
        <AuthShell
            showBrandPanel={false}
            title="Verify your phone"
            subtitle="Confirm your number to continue."
            footer={mode !== 'success' ? (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-x-2">
                    {mode !== 'message-admin' && (
                        <button type="button" onClick={() => setMode('message-admin')} className={linkBtn}>
                            <MessageCircleQuestion className="h-4 w-4" aria-hidden="true" /> Message admin
                        </button>
                    )}
                    <button type="button" onClick={handleLogout} className={linkBtn}>
                        <LogOut className="h-4 w-4" aria-hidden="true" /> Log out
                    </button>
                </div>
            ) : undefined}
        >
            {error && (
                <div className="mb-4">
                    <AuthAlert tone="error">{error}</AuthAlert>
                </div>
            )}

            {mode === 'otp-verify' && (
                <form onSubmit={handleVerifyCurrent} className="space-y-4">
                    <div>
                        <h2 className={headingCls}>Verify your number</h2>
                        <p className={subCls}>
                            Enter the 6-digit code sent to <strong className="text-ft-ink">{phoneHint}</strong>
                        </p>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="vp-otp" className={labelCls}>6-digit code</Label>
                        <NeuInput
                            id="vp-otp"
                            value={otpCode}
                            onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                            required inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={6}
                            wrapperClassName="h-14"
                            className="text-center text-xl font-extrabold tracking-[0.4em]"
                        />
                    </div>
                    <ClayButton type="submit" disabled={otpCode.length !== 6} loading={submitting} className="w-full">
                        {submitting ? 'Verifying…' : 'Verify and continue'}
                    </ClayButton>
                    <div className="flex flex-wrap items-center justify-between gap-x-2">
                        <button type="button" onClick={sendCurrentCode} disabled={sendingCode || resendCooldown > 0} className={linkBtn}>
                            <RefreshCw className={cn('h-4 w-4', sendingCode && 'animate-spin')} aria-hidden="true" />
                            {sendingCode ? 'Sending…' : resendCooldown > 0 ? `Resend in ${formatCooldown(resendCooldown)}` : 'Resend code'}
                        </button>
                        <button type="button" onClick={startLostNumberFlow} className={linkBtn}>
                            <ShieldQuestion className="h-4 w-4" aria-hidden="true" /> Can&apos;t access this number?
                        </button>
                    </div>
                </form>
            )}

            {mode === 'lost-hint' && (
                <form onSubmit={handleGuessSubmit} className="space-y-4">
                    <div>
                        <h2 className={headingCls}>Confirm your old number</h2>
                        <p className={subCls}>
                            For your security, type the full number matching this hint: <strong className="text-ft-ink">{phoneHint}</strong>
                        </p>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="vp-old" className={labelCls}>Old mobile number</Label>
                        <NeuInput id="vp-old" value={oldNumberGuess} onChange={e => setOldNumberGuess(e.target.value)}
                            required type="tel" placeholder="024XXXXXXX"
                            leading={<Phone className="h-4 w-4" aria-hidden="true" />} />
                    </div>
                    <ClayButton type="submit" loading={submitting} className="w-full">
                        {submitting ? 'Checking…' : 'Confirm'}
                    </ClayButton>
                </form>
            )}

            {mode === 'lost-new-number' && (
                <form onSubmit={handleNewNumberSubmit} className="space-y-4">
                    <div>
                        <h2 className={headingCls}>Enter your new number</h2>
                        <p className={subCls}>We&apos;ll send a 6-digit code to confirm it.</p>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="vp-new" className={labelCls}>New mobile number</Label>
                        <NeuInput id="vp-new" value={newPhone} onChange={e => setNewPhone(e.target.value)}
                            required type="tel" placeholder="024XXXXXXX"
                            leading={<Phone className="h-4 w-4" aria-hidden="true" />} />
                    </div>
                    <ClayButton type="submit" loading={submitting} className="w-full">
                        {submitting ? 'Sending…' : 'Send verification code'}
                    </ClayButton>
                </form>
            )}

            {mode === 'lost-otp-verify' && (
                <form onSubmit={handleNewNumberOtpSubmit} className="space-y-4">
                    <div>
                        <h2 className={headingCls}>Verify your new number</h2>
                        <p className={subCls}>
                            Enter the 6-digit code sent to <strong className="text-ft-ink">{newPhone}</strong>
                        </p>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="vp-new-otp" className={labelCls}>6-digit code</Label>
                        <NeuInput
                            id="vp-new-otp"
                            value={otpCode}
                            onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                            required inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={6}
                            wrapperClassName="h-14"
                            className="text-center text-xl font-extrabold tracking-[0.4em]"
                        />
                    </div>
                    <ClayButton type="submit" disabled={otpCode.length !== 6} loading={submitting} className="w-full">
                        {submitting ? 'Verifying…' : 'Verify and continue'}
                    </ClayButton>
                    <div className="flex items-center justify-center">
                        <button type="button" onClick={() => sendCodeToNewNumber(newPhone)} disabled={sendingCode || resendCooldown > 0} className={linkBtn}>
                            <RefreshCw className={cn('h-4 w-4', sendingCode && 'animate-spin')} aria-hidden="true" />
                            {sendingCode ? 'Sending…' : resendCooldown > 0 ? `Resend in ${formatCooldown(resendCooldown)}` : 'Resend code'}
                        </button>
                    </div>
                </form>
            )}

            {mode === 'message-admin' && (
                <form onSubmit={handleSupportSubmit} className="space-y-4">
                    <div>
                        <h2 className={headingCls}>Message admin</h2>
                        <p className={subCls}>
                            {lockMessage || "Describe the issue you're having verifying your number and our team will help."}
                        </p>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="vp-contact" className={labelCls}>Your phone or WhatsApp number</Label>
                        <NeuInput id="vp-contact" value={supportContact} onChange={e => setSupportContact(e.target.value)} required
                            type="tel" placeholder="024XXXXXXX"
                            leading={<Phone className="h-4 w-4" aria-hidden="true" />} />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="vp-subject" className={labelCls}>Subject</Label>
                        <NeuInput id="vp-subject" value={supportSubject} onChange={e => setSupportSubject(e.target.value)} required
                            placeholder="e.g. Can't verify my number" />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="vp-message" className={labelCls}>Message</Label>
                        <div className="ft-inset px-4 py-3 focus-within:outline focus-within:outline-[3px] focus-within:outline-offset-2 focus-within:outline-[color:var(--ft-blue)] dark:focus-within:outline-[color:var(--ft-cyan)]">
                            <textarea id="vp-message" value={supportMessage} onChange={e => setSupportMessage(e.target.value)} required rows={4}
                                placeholder="Tell us what's happening..."
                                className="w-full resize-y bg-transparent text-base text-ft-ink placeholder:text-[color:var(--ft-muted)] focus:outline-none" />
                        </div>
                    </div>
                    <ClayButton type="submit" loading={submitting} className="w-full">
                        {submitting ? 'Sending…' : 'Send message'}
                    </ClayButton>
                </form>
            )}

            {mode === 'success' && (
                <div className="space-y-3 py-4 text-center" role="status">
                    <div className="ft-clay mx-auto flex h-14 w-14 items-center justify-center !rounded-full">
                        <CheckCircle className="h-7 w-7" aria-hidden="true" />
                    </div>
                    <h2 className={headingCls}>Phone verified</h2>
                    <p className="text-sm text-[color:var(--ft-muted)]">Taking you to your dashboard…</p>
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-[color:var(--ft-muted)]" aria-hidden="true" />
                </div>
            )}
        </AuthShell>
    )
}
