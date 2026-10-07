'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, Lock, CheckCircle, Eye, EyeOff, AlertTriangle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { toast } from '@/lib/toast'
import { BackgroundBubbles } from '@/components/background-bubbles'
import { FloatingWhatsApp } from '@/components/floating-whatsapp'
import { isStrongPassword, PASSWORD_REQUIREMENTS_MESSAGE } from '@/lib/password-validation'

const RECOVERY_SESSION_KEY = 'kingflexy_password_recovery_active'

function getRecoveryContext() {
    if (typeof window === 'undefined') {
        return {
            accessToken: null,
            refreshToken: null,
            code: null,
            tokenHash: null,
            hasRecoveryAttempt: false,
            shouldCleanUrl: false,
        }
    }

    const currentUrl = new URL(window.location.href)
    const hashParams = new URLSearchParams(currentUrl.hash.startsWith('#') ? currentUrl.hash.slice(1) : currentUrl.hash)
    const searchParams = currentUrl.searchParams

    const accessToken = hashParams.get('access_token')
    const refreshToken = hashParams.get('refresh_token')
    const code = searchParams.get('code')
    const tokenHash = searchParams.get('token_hash')
    const isRecoveryFlow = searchParams.get('flow') === 'recovery'
    const hasHashSessionTokens = !!accessToken && !!refreshToken
    const hasExchangeableRecovery = isRecoveryFlow && (!!code || !!tokenHash)

    return {
        accessToken,
        refreshToken,
        code,
        tokenHash,
        hasRecoveryAttempt: hasHashSessionTokens || hasExchangeableRecovery,
        shouldCleanUrl: hasHashSessionTokens || hasExchangeableRecovery,
    }
}

function markRecoverySessionActive() {
    if (typeof window !== 'undefined') {
        window.sessionStorage.setItem(RECOVERY_SESSION_KEY, 'true')
    }
}

function clearRecoverySession() {
    if (typeof window !== 'undefined') {
        window.sessionStorage.removeItem(RECOVERY_SESSION_KEY)
    }
}

function isRecoverySessionActive() {
    if (typeof window === 'undefined') {
        return false
    }

    return window.sessionStorage.getItem(RECOVERY_SESSION_KEY) === 'true'
}

function cleanRecoveryUrl() {
    if (typeof window === 'undefined') {
        return
    }

    const cleanUrl = new URL(window.location.href)
    cleanUrl.searchParams.delete('flow')
    cleanUrl.searchParams.delete('code')
    cleanUrl.searchParams.delete('type')
    cleanUrl.searchParams.delete('token_hash')
    cleanUrl.hash = ''
    window.history.replaceState({}, document.title, `${cleanUrl.pathname}${cleanUrl.search}`)
}

export default function UpdatePasswordPage() {
    const router = useRouter()
    const [password, setPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [showConfirm, setShowConfirm] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState('')
    const [success, setSuccess] = useState(false)
    const [isValidSession, setIsValidSession] = useState<boolean | null>(null)

    useEffect(() => {
        let isMounted = true
        const { code, tokenHash, hasRecoveryAttempt, shouldCleanUrl } = getRecoveryContext()

        const checkRecoverySession = async () => {
            let recoveryConfirmed = false

            if (code && hasRecoveryAttempt) {
                const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
                recoveryConfirmed = !exchangeError
            } else if (tokenHash && hasRecoveryAttempt) {
                const { error: otpError } = await supabase.auth.verifyOtp({
                    token_hash: tokenHash,
                    type: 'recovery',
                })
                recoveryConfirmed = !otpError
            }

            if (recoveryConfirmed) {
                markRecoverySessionActive()
            }

            const attempts = hasRecoveryAttempt ? 6 : 1

            for (let index = 0; index < attempts; index++) {
                const { data: { session } } = await supabase.auth.getSession()

                if (!isMounted) {
                    return
                }

                if (session?.user && isRecoverySessionActive()) {
                    if (shouldCleanUrl) {
                        cleanRecoveryUrl()
                    }
                    setIsValidSession(true)
                    return
                }

                if (index < attempts - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 250))
                }
            }

            if (isMounted) {
                setIsValidSession(false)
            }
        }

        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            if (!isMounted) {
                return
            }

            if (event === 'PASSWORD_RECOVERY' && session?.user) {
                markRecoverySessionActive()
                cleanRecoveryUrl()
                setIsValidSession(true)
            }

            if (event === 'SIGNED_OUT') {
                clearRecoverySession()
            }
        })

        checkRecoverySession()

        return () => {
            isMounted = false
            subscription.unsubscribe()
        }
    }, [])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')

        if (!isStrongPassword(password)) {
            setError(PASSWORD_REQUIREMENTS_MESSAGE)
            return
        }

        if (password !== confirmPassword) {
            setError('Passwords do not match.')
            return
        }

        setIsLoading(true)
        try {
            const { error } = await supabase.auth.updateUser({ password })

            if (error) {
                setError(error.message)
                return
            }

            clearRecoverySession()
            setSuccess(true)
            toast.success('Password updated successfully!')

            try {
                await supabase.auth.signOut({ scope: 'global' })
            } catch (signOutError) {
                console.error('Recovery password sign-out error:', signOutError)
            }

            setTimeout(() => {
                router.push('/auth/login')
            }, 2000)
        } catch {
            setError('An unexpected error occurred. Please try again.')
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 py-8 sm:py-10 overflow-y-auto">
            <BackgroundBubbles scrollable />
            <FloatingWhatsApp variant="auth" />
            <div className="w-full max-w-[380px] sm:max-w-md relative z-10 flex flex-col items-center">
                <div className="text-center mb-6">
                    <Link href="/" className="inline-flex flex-col items-center">
                        <div className="relative w-20 h-20 sm:w-24 sm:h-24 mb-3 rounded-full overflow-hidden flex items-center justify-center bg-white/10 backdrop-blur-sm border border-white/20">
                            <BrandLogo width={80} height={80} className="object-contain w-full h-full" />
                        </div>
                        <BrandTitle className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight drop-shadow-lg" />
                        <p className="text-base text-slate-600 dark:text-white/80 mt-1 drop-shadow">
                            Set a new password
                        </p>
                    </Link>
                </div>

                <Card className="w-full border-0 bg-[#E5E7EB]/70 backdrop-blur-md shadow-2xl rounded-2xl overflow-hidden">
                    <CardContent className="p-5 sm:p-6">
                        {isValidSession === false && (
                            <div className="text-center py-4 space-y-4">
                                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-orange-400 to-red-500 flex items-center justify-center mx-auto">
                                    <AlertTriangle className="w-8 h-8 text-white" />
                                </div>
                                <h2 className="text-xl font-bold text-slate-900">Link Expired or Invalid</h2>
                                <p className="text-slate-600 text-sm">
                                    This password reset page only works from a valid recovery link. Please request a fresh reset email.
                                </p>
                                <Link href="/auth/reset-password">
                                    <Button className="w-full h-12 text-base font-bold bg-[#0056B3] hover:bg-[#004494] text-white shadow-lg rounded-xl">
                                        Request a New Link
                                    </Button>
                                </Link>
                            </div>
                        )}

                        {isValidSession === null && (
                            <div className="flex justify-center items-center py-10">
                                <Loader2 className="w-8 h-8 animate-spin text-[#0056B3]" />
                            </div>
                        )}

                        {success && (
                            <div className="text-center py-4 space-y-4">
                                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center mx-auto">
                                    <CheckCircle className="w-8 h-8 text-white" />
                                </div>
                                <h2 className="text-xl font-bold text-slate-900">Password Updated!</h2>
                                <p className="text-slate-600 text-sm">
                                    Your password has been changed. Redirecting you to login...
                                </p>
                                <Loader2 className="w-5 h-5 animate-spin text-[#0056B3] mx-auto" />
                            </div>
                        )}

                        {isValidSession === true && !success && (
                            <form onSubmit={handleSubmit} className="space-y-4">
                                <p className="text-slate-600 text-sm text-center">
                                    Enter and confirm your new password below.
                                </p>

                                {error && (
                                    <Alert variant="destructive" className="bg-red-500/10 border-red-500/50 py-2">
                                        <AlertDescription className="text-red-600 text-sm">{error}</AlertDescription>
                                    </Alert>
                                )}

                                <div className="space-y-1.5">
                                    <Label htmlFor="password" className="text-slate-700 font-semibold text-sm">New Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                                        <Input
                                            id="password"
                                            type={showPassword ? 'text' : 'password'}
                                            autoComplete="new-password"
                                            placeholder="Min. 8 characters"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            required
                                            className="h-12 pl-11 pr-11 bg-white/95 border-slate-200 text-slate-900 placeholder:text-slate-400 focus:border-[#0056B3] focus:ring-[#0056B3]/20 rounded-xl text-base"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword(!showPassword)}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                                        >
                                            {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                        </button>
                                    </div>
                                </div>

                                <div className="space-y-1.5">
                                    <Label htmlFor="confirmPassword" className="text-slate-700 font-semibold text-sm">Confirm Password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                                        <Input
                                            id="confirmPassword"
                                            type={showConfirm ? 'text' : 'password'}
                                            autoComplete="new-password"
                                            placeholder="Re-enter your new password"
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            required
                                            className="h-12 pl-11 pr-11 bg-white/95 border-slate-200 text-slate-900 placeholder:text-slate-400 focus:border-[#0056B3] focus:ring-[#0056B3]/20 rounded-xl text-base"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowConfirm(!showConfirm)}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                                        >
                                            {showConfirm ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                        </button>
                                    </div>
                                </div>

                                <Button
                                    type="submit"
                                    disabled={isLoading}
                                    className="w-full h-12 text-base font-bold bg-[#0056B3] hover:bg-[#004494] text-white shadow-lg rounded-xl"
                                >
                                    {isLoading ? (
                                        <>
                                            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                            Updating...
                                        </>
                                    ) : (
                                        <>
                                            <Lock className="w-5 h-5 mr-2" />
                                            Update Password
                                        </>
                                    )}
                                </Button>
                            </form>
                        )}

                        <div className="mt-5 text-center">
                            <Link href="/auth" className="text-base text-[#0056B3] font-semibold hover:underline">
                                ← Back to Login
                            </Link>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
