'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, Mail, Send, Home, KeyRound } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { toast } from '@/lib/toast'
import { BackgroundBubbles } from '@/components/background-bubbles'
import { FloatingWhatsApp } from '@/components/floating-whatsapp'
import { WhatsAppCommunityButtons } from '@/components/whatsapp-community-buttons'

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
                window.sessionStorage.setItem('kingflexy_password_recovery_active', 'true')
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
        <div className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 py-8 sm:py-10 overflow-y-auto">
            <BackgroundBubbles scrollable />
            <FloatingWhatsApp variant="auth" />
            
            {/* Back to Home Link */}
            <div className="absolute top-4 left-4 sm:top-8 sm:left-8 z-50">
                <Link href="/">
                    <Button variant="ghost" className="text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 font-bold gap-2 rounded-full">
                        <Home className="w-4 h-4" />
                        <span className="hidden sm:inline">Back to Home</span>
                        <span className="sm:hidden">Home</span>
                    </Button>
                </Link>
            </div>
            <div className="w-full max-w-[380px] sm:max-w-md relative z-10 flex flex-col items-center">
                {/* Logo - professional and visible */}
                <div className="text-center mb-6">
                    <Link href="/" className="inline-flex flex-col items-center">
                        <div className="relative w-20 h-20 sm:w-24 sm:h-24 mb-3 rounded-full overflow-hidden flex items-center justify-center bg-white/10 backdrop-blur-sm border border-white/20">
                            <BrandLogo width={80} height={80} className="object-contain w-full h-full" />
                        </div>
                        <BrandTitle className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight drop-shadow-lg" />
                        <p className="text-base text-slate-600 dark:text-white/80 mt-1 drop-shadow">
                            Reset your password
                        </p>
                    </Link>
                </div>

                <Card className="w-full border-0 bg-[#E5E7EB]/70 backdrop-blur-md shadow-2xl rounded-2xl overflow-hidden">
                    <CardContent className="p-5 sm:p-6">
                        {step === 1 ? (
                            <form onSubmit={handleSubmit} className="space-y-4">
                                <p className="text-slate-600 text-sm text-center">
                                    Enter your email to receive a password reset code.
                                </p>

                                {error && (
                                    <Alert variant="destructive" className={lockoutMinutes !== null ? "bg-orange-500/10 border-orange-500/50 py-2" : "bg-red-500/10 border-red-500/50 py-2"}>
                                        <AlertDescription className={lockoutMinutes !== null ? "text-orange-600 text-sm" : "text-red-600 text-sm"}>{error}</AlertDescription>
                                    </Alert>
                                )}

                                <div className="space-y-1.5">
                                    <Label htmlFor="email" className="text-slate-700 font-semibold text-sm">Email Address</Label>
                                    <div className="relative">
                                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                                        <Input
                                            id="email"
                                            type="email"
                                            autoComplete="email"
                                            placeholder="your@email.com"
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            required
                                            className="h-12 pl-11 bg-white/95 border-slate-200 text-slate-900 placeholder:text-slate-400 focus:border-[#0056B3] focus:ring-[#0056B3]/20 rounded-xl text-base"
                                        />
                                    </div>
                                </div>

                                <Button
                                    type="submit"
                                    disabled={isLoading || lockoutMinutes !== null}
                                    className="w-full h-12 text-base font-bold bg-[#0056B3] hover:bg-[#004494] text-white shadow-lg rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {lockoutMinutes !== null ? (
                                        `Locked — try again in ${lockoutMinutes}m`
                                    ) : isLoading ? (
                                        <>
                                            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                            Sending...
                                        </>
                                    ) : (
                                        <>
                                            <Send className="w-5 h-5 mr-2" />
                                            Send Reset Code
                                        </>
                                    )}
                                </Button>
                            </form>
                        ) : (
                            <form onSubmit={handleVerifyOtp} className="space-y-4">
                                <div className="text-center mb-6">
                                    <div className="w-16 h-16 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center mx-auto mb-4">
                                        <KeyRound className="w-8 h-8 text-white" />
                                    </div>
                                    <h2 className="text-xl font-bold text-slate-900 mb-2">Check Your Email</h2>
                                    <p className="text-slate-600 text-sm">
                                        We sent a verification code to <strong className="text-slate-900">{email}</strong>
                                    </p>
                                </div>

                                {error && (
                                    <Alert variant="destructive" className="bg-red-500/10 border-red-500/50 py-2">
                                        <AlertDescription className="text-red-600 text-sm">{error}</AlertDescription>
                                    </Alert>
                                )}

                                <div className="space-y-1.5">
                                    <Label htmlFor="otp" className="text-slate-700 font-semibold text-sm">Verification Code</Label>
                                    <Input
                                        id="otp"
                                        type="text"
                                        inputMode="numeric"
                                        autoComplete="one-time-code"
                                        placeholder="Enter code"
                                        value={otp}
                                        onChange={(e) => setOtp(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                                        required
                                        maxLength={8}
                                        className="h-14 text-center text-2xl tracking-[0.2em] font-bold bg-white/95 border-slate-200 text-slate-900 placeholder:text-slate-300 focus:border-[#0056B3] focus:ring-[#0056B3]/20 rounded-xl"
                                    />
                                    <div className="text-center pt-1">
                                        <button
                                            type="button"
                                            onClick={handleResendCode}
                                            disabled={resendCooldown > 0}
                                            className="text-xs font-semibold text-[#0056B3] hover:underline disabled:opacity-50 disabled:no-underline"
                                        >
                                            {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
                                        </button>
                                    </div>
                                </div>

                                <Button
                                    type="submit"
                                    disabled={isLoading || otp.length < 6}
                                    className="w-full h-12 text-base font-bold bg-[#0056B3] hover:bg-[#004494] text-white shadow-lg rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isLoading ? (
                                        <>
                                            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                            Verifying...
                                        </>
                                    ) : (
                                        'Verify Code'
                                    )}
                                </Button>
                            </form>
                        )}

                        <div className="mt-5 text-center">
                            <Link href="/auth" className="text-base text-[#0056B3] font-semibold hover:underline">
                                ← Back to Login
                            </Link>
                        </div>

                        <div className="mt-5 border-t border-slate-300/50 pt-4">
                            <WhatsAppCommunityButtons compact />
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
