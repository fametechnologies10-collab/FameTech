'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Label } from '@/components/ui/label'
import { ClayButton, NeuInput } from '@/components/ft'
import { Mail, Send, KeyRound } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { AuthShell } from '../_components/auth-shell'
import { AuthAlert, FT_LINK } from '../_components/shared'

export default function ResetPasswordPage() {
    const router = useRouter()
    const [email, setEmail] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState('')
    const [step, setStep] = useState<1 | 2>(1)
    const [otp, setOtp] = useState('')
    const [lockoutMinutes, setLockoutMinutes] = useState<number | null>(null)
    const [resendCooldown, setResendCooldown] = useState(0)

    // D3: auto-recover from a 429 lockout so the "Send Reset Code" button doesn't
    // stay permanently disabled until a full page reload. Counts the minutes down
    // and clears the lockout (and its stale error) when it elapses.
    useEffect(() => {
        if (lockoutMinutes === null) return
        if (lockoutMinutes <= 0) { setLockoutMinutes(null); setError(''); return }
        const t = setTimeout(() => setLockoutMinutes(m => (m === null ? null : m - 1)), 60_000)
        return () => clearTimeout(t)
    }, [lockoutMinutes])

    // Resend cooldown ticker (step 2).
    useEffect(() => {
        if (resendCooldown <= 0) return
        const t = setTimeout(() => setResendCooldown(c => c - 1), 1000)
        return () => clearTimeout(t)
    }, [resendCooldown])

    const handleResendCode = async () => {
        if (resendCooldown > 0) return
        try {
            const response = await fetch('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            })
            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After')
                const minutes = retryAfter ? Math.ceil(parseInt(retryAfter) / 60) : 10
                toast.error(`Too many attempts. Try again in ${minutes} minute${minutes !== 1 ? 's' : ''}.`)
                return
            }
            if (!response.ok) {
                const data = await response.json().catch(() => ({}))
                toast.error(data.error || 'Could not resend the code. Please try again.')
                return
            }
            toast.success('New code sent!')
            setResendCooldown(60)
        } catch {
            toast.error('Could not resend. Please try again.')
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setIsLoading(true)

        try {
            const response = await fetch('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            })

            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After')
                const minutes = retryAfter ? Math.ceil(parseInt(retryAfter) / 60) : 10
                setLockoutMinutes(minutes)
                setError(`Too many attempts. Please try again in ${minutes} minute${minutes !== 1 ? 's' : ''}.`)
                return
            }

            const data = await response.json()

            if (!response.ok) {
                setLockoutMinutes(null)
                setError(data.error)
                return
            }

            setStep(2)
            setResendCooldown(60)
            toast.success('Verification code sent to your email!')
        } catch (err) {
            setLockoutMinutes(null)
            setError('An unexpected error occurred')
        } finally {
            setIsLoading(false)
        }
    }

    const handleVerifyOtp = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')

        if (otp.length < 6) {
            setError('Please enter the verification code.')
            return
        }

        setIsLoading(true)

        try {
            const { error: otpError } = await supabase.auth.verifyOtp({
                email,
                token: otp,
                type: 'recovery',
            })

            if (otpError) {
                setError(otpError.message)
                return
            }

            // Success! Set recovery flag and redirect
            if (typeof window !== 'undefined') {
                window.sessionStorage.setItem('fametech_password_recovery_active', 'true')
            }
            toast.success('Code verified! Please set a new password.')
            router.push('/auth/update-password')
        } catch (err) {
            setError('An unexpected error occurred')
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <AuthShell
            title="Reset your password"
            subtitle={step === 1 ? 'Enter your email and we will send you a reset code.' : undefined}
            footer={
                <div className="mt-4 text-center">
                    <Link href="/auth" className={cn('inline-flex min-h-12 items-center px-3 text-base font-semibold', FT_LINK)}>
                        ← Back to sign in
                    </Link>
                </div>
            }
        >
            {step === 1 ? (
                <form onSubmit={handleSubmit} className="space-y-4">
                    {error && (
                        <AuthAlert tone={lockoutMinutes !== null ? 'warn' : 'error'}>{error}</AuthAlert>
                    )}

                    <div className="space-y-2">
                        <Label htmlFor="email" className="text-sm font-semibold text-ft-ink">Email address</Label>
                        <NeuInput
                            id="email"
                            type="email"
                            autoComplete="email"
                            placeholder="you@email.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            leading={<Mail className="h-4 w-4" aria-hidden="true" />}
                        />
                    </div>

                    <ClayButton
                        type="submit"
                        disabled={lockoutMinutes !== null}
                        loading={isLoading}
                        className="w-full"
                    >
                        {lockoutMinutes !== null ? (
                            `Locked, try again in ${lockoutMinutes}m`
                        ) : isLoading ? (
                            'Sending…'
                        ) : (
                            <>
                                <Send className="h-4 w-4" aria-hidden="true" />
                                Send reset code
                            </>
                        )}
                    </ClayButton>
                </form>
            ) : (
                <form onSubmit={handleVerifyOtp} className="space-y-4">
                    <div className="space-y-1 text-center">
                        <div className="ft-clay mx-auto mb-3 flex h-12 w-12 items-center justify-center">
                            <KeyRound className="h-6 w-6" aria-hidden="true" />
                        </div>
                        <h2 className="ft-display text-lg font-extrabold text-ft-ink">Check your email</h2>
                        <p className="text-sm text-[color:var(--ft-muted)]">
                            We sent a verification code to <strong className="break-all text-ft-ink">{email}</strong>
                        </p>
                    </div>

                    {error && <AuthAlert tone="error">{error}</AuthAlert>}

                    <div className="space-y-2">
                        <Label htmlFor="otp" className="text-sm font-semibold text-ft-ink">Verification code</Label>
                        <NeuInput
                            id="otp"
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            placeholder="Enter code"
                            value={otp}
                            onChange={(e) => setOtp(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                            required
                            maxLength={8}
                            wrapperClassName="h-14"
                            className="text-center text-xl font-extrabold tracking-[0.2em]"
                        />
                        <div className="text-center">
                            <button
                                type="button"
                                onClick={handleResendCode}
                                disabled={resendCooldown > 0}
                                className={cn('min-h-12 rounded-xl px-3 text-sm font-semibold disabled:opacity-60', FT_LINK)}
                            >
                                {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
                            </button>
                        </div>
                    </div>

                    <ClayButton
                        type="submit"
                        disabled={otp.length < 6}
                        loading={isLoading}
                        className="w-full"
                    >
                        {isLoading ? 'Verifying…' : 'Verify code'}
                    </ClayButton>
                </form>
            )}
        </AuthShell>
    )
}
