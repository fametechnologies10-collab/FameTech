'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { BackgroundBubbles } from '@/components/background-bubbles'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, Phone, CheckCircle, RefreshCw, LogOut, ShieldQuestion, MessageCircleQuestion } from 'lucide-react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

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
            <div className="relative min-h-screen flex items-center justify-center">
                <BackgroundBubbles scrollable />
                <div className="flex items-center gap-2 text-slate-500 relative z-10">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span className="text-sm">Checking your account...</span>
                </div>
            </div>
        )
    }

    return (
        <div className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 py-8 overflow-y-auto">
            <BackgroundBubbles scrollable />
            <div className="w-full max-w-[380px] sm:max-w-md relative z-10">
                <div className="text-center mb-6">
                    <Link href="/" className="inline-flex flex-col items-center">
                        <div className="relative w-20 h-20 mb-3 rounded-full overflow-hidden bg-white dark:bg-slate-800 shadow-lg border-[3px] border-[#FFCC00]">
                            <BrandLogo width={80} height={80} className="object-contain w-full h-full" />
                        </div>
                        <BrandTitle className="text-xl font-bold text-slate-900 dark:text-white tracking-tight" />
                    </Link>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 font-medium">Verify your phone number to continue</p>
                </div>

                <Card className="w-full border border-white/60 dark:border-slate-700/50 bg-white/92 dark:bg-slate-900/92 backdrop-blur-xl shadow-[0_20px_60px_rgba(0,0,0,0.12)] dark:shadow-[0_20px_60px_rgba(0,0,0,0.5)] rounded-2xl overflow-hidden">
                    <div className="h-0.5 w-full bg-gradient-to-r from-[#0056B3] via-[#00B4D8] to-[#FFCC00]" />
                    <CardContent className="p-5 sm:p-6">
                        {error && (
                            <Alert variant="destructive" className="mb-4 py-2 bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800/30">
                                <AlertDescription className="text-red-600 dark:text-red-400 text-sm">{error}</AlertDescription>
                            </Alert>
                        )}

                        {mode === 'otp-verify' && (
                            <form onSubmit={handleVerifyCurrent} className="space-y-4">
                                <div>
                                    <h2 className="text-base font-bold text-slate-900 dark:text-white">Verify Your Number</h2>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                        Enter the 6-digit code sent to <strong className="text-slate-700 dark:text-slate-200">{phoneHint}</strong>
                                    </p>
                                </div>
                                <Input
                                    value={otpCode}
                                    onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                    required inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={6}
                                    className="h-14 text-center text-2xl font-bold tracking-[0.5em] rounded-xl bg-white dark:bg-slate-800/70"
                                />
                                <Button type="submit" disabled={submitting || otpCode.length !== 6}
                                    className="w-full h-12 text-sm font-bold text-white rounded-xl shadow-lg bg-gradient-to-br from-[#0056B3] to-[#00B4D8]">
                                    {submitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying...</> : 'Verify & Continue'}
                                </Button>
                                <div className="flex items-center justify-center gap-3 text-xs">
                                    <button type="button" onClick={sendCurrentCode} disabled={sendingCode || resendCooldown > 0}
                                        className="flex items-center gap-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors disabled:opacity-50">
                                        <RefreshCw className={cn('w-3 h-3', sendingCode && 'animate-spin')} />
                                        {sendingCode ? 'Sending...' : resendCooldown > 0 ? `Resend in ${formatCooldown(resendCooldown)}` : 'Resend code'}
                                    </button>
                                    <span className="text-slate-300 dark:text-slate-600">·</span>
                                    <button type="button" onClick={startLostNumberFlow}
                                        className="flex items-center gap-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors">
                                        <ShieldQuestion className="w-3 h-3" /> Can&apos;t access this number?
                                    </button>
                                </div>
                            </form>
                        )}

                        {mode === 'lost-hint' && (
                            <form onSubmit={handleGuessSubmit} className="space-y-4">
                                <div>
                                    <h2 className="text-base font-bold text-slate-900 dark:text-white">Confirm Your Old Number</h2>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                        For your security, type the full number matching this hint: <strong className="text-slate-700 dark:text-slate-200">{phoneHint}</strong>
                                    </p>
                                </div>
                                <div className="space-y-1.5">
                                    <Label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Old Mobile Number</Label>
                                    <div className="relative">
                                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                        <Input value={oldNumberGuess} onChange={e => setOldNumberGuess(e.target.value)}
                                            required type="tel" placeholder="024XXXXXXX" className="h-11 pl-10 rounded-xl text-sm bg-white dark:bg-slate-800/70" />
                                    </div>
                                </div>
                                <Button type="submit" disabled={submitting}
                                    className="w-full h-12 text-sm font-bold text-white rounded-xl shadow-lg bg-gradient-to-br from-[#0056B3] to-[#00B4D8]">
                                    {submitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Checking...</> : 'Confirm'}
                                </Button>
                            </form>
                        )}

                        {mode === 'lost-new-number' && (
                            <form onSubmit={handleNewNumberSubmit} className="space-y-4">
                                <div>
                                    <h2 className="text-base font-bold text-slate-900 dark:text-white">Enter Your New Number</h2>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">We&apos;ll send a 6-digit code to confirm it.</p>
                                </div>
                                <div className="space-y-1.5">
                                    <Label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">New Mobile Number</Label>
                                    <div className="relative">
                                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                        <Input value={newPhone} onChange={e => setNewPhone(e.target.value)}
                                            required type="tel" placeholder="024XXXXXXX" className="h-11 pl-10 rounded-xl text-sm bg-white dark:bg-slate-800/70" />
                                    </div>
                                </div>
                                <Button type="submit" disabled={submitting}
                                    className="w-full h-12 text-sm font-bold text-white rounded-xl shadow-lg bg-gradient-to-br from-[#0056B3] to-[#00B4D8]">
                                    {submitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending...</> : 'Send Verification Code'}
                                </Button>
                            </form>
                        )}

                        {mode === 'lost-otp-verify' && (
                            <form onSubmit={handleNewNumberOtpSubmit} className="space-y-4">
                                <div>
                                    <h2 className="text-base font-bold text-slate-900 dark:text-white">Verify Your New Number</h2>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                        Enter the 6-digit code sent to <strong className="text-slate-700 dark:text-slate-200">{newPhone}</strong>
                                    </p>
                                </div>
                                <Input
                                    value={otpCode}
                                    onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                    required inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={6}
                                    className="h-14 text-center text-2xl font-bold tracking-[0.5em] rounded-xl bg-white dark:bg-slate-800/70"
                                />
                                <Button type="submit" disabled={submitting || otpCode.length !== 6}
                                    className="w-full h-12 text-sm font-bold text-white rounded-xl shadow-lg bg-gradient-to-br from-[#0056B3] to-[#00B4D8]">
                                    {submitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying...</> : 'Verify & Continue'}
                                </Button>
                                <div className="flex items-center justify-center text-xs">
                                    <button type="button" onClick={() => sendCodeToNewNumber(newPhone)} disabled={sendingCode || resendCooldown > 0}
                                        className="flex items-center gap-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors disabled:opacity-50">
                                        <RefreshCw className={cn('w-3 h-3', sendingCode && 'animate-spin')} />
                                        {sendingCode ? 'Sending...' : resendCooldown > 0 ? `Resend in ${formatCooldown(resendCooldown)}` : 'Resend code'}
                                    </button>
                                </div>
                            </form>
                        )}

                        {mode === 'message-admin' && (
                            <form onSubmit={handleSupportSubmit} className="space-y-4">
                                <div>
                                    <h2 className="text-base font-bold text-slate-900 dark:text-white">Message Admin</h2>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                        {lockMessage || "Describe the issue you're having verifying your number and our team will help."}
                                    </p>
                                </div>
                                <div className="space-y-1.5">
                                    <Label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Your Phone / WhatsApp Number</Label>
                                    <div className="relative">
                                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                        <Input value={supportContact} onChange={e => setSupportContact(e.target.value)} required
                                            type="tel" placeholder="024XXXXXXX" className="h-11 pl-10 rounded-xl text-sm bg-white dark:bg-slate-800/70" />
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <Label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Subject</Label>
                                    <Input value={supportSubject} onChange={e => setSupportSubject(e.target.value)} required
                                        placeholder="e.g. Can't verify my number" className="h-11 rounded-xl text-sm bg-white dark:bg-slate-800/70" />
                                </div>
                                <div className="space-y-1.5">
                                    <Label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Message</Label>
                                    <Textarea value={supportMessage} onChange={e => setSupportMessage(e.target.value)} required rows={4}
                                        placeholder="Tell us what's happening..." className="rounded-xl text-sm bg-white dark:bg-slate-800/70" />
                                </div>
                                <Button type="submit" disabled={submitting}
                                    className="w-full h-12 text-sm font-bold text-white rounded-xl shadow-lg bg-gradient-to-br from-[#0056B3] to-[#00B4D8]">
                                    {submitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending...</> : 'Send Message'}
                                </Button>
                            </form>
                        )}

                        {mode === 'success' && (
                            <div className="text-center py-6 space-y-3">
                                <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto">
                                    <CheckCircle className="w-9 h-9 text-emerald-600" />
                                </div>
                                <h2 className="text-base font-bold text-slate-900 dark:text-white">Phone Verified!</h2>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Taking you to your dashboard...</p>
                                <Loader2 className="w-5 h-5 animate-spin text-slate-400 mx-auto" />
                            </div>
                        )}
                    </CardContent>
                </Card>

                {mode !== 'success' && (
                    <div className="flex items-center justify-center gap-3 mt-4 text-xs">
                        {mode !== 'message-admin' && (
                            <>
                                <button type="button" onClick={() => setMode('message-admin')}
                                    className="inline-flex items-center gap-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                                    <MessageCircleQuestion className="w-3.5 h-3.5" /> Message admin
                                </button>
                                <span className="text-slate-300 dark:text-slate-600">·</span>
                            </>
                        )}
                        <button type="button" onClick={handleLogout}
                            className="inline-flex items-center gap-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                            <LogOut className="w-3.5 h-3.5" /> Logout
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}
