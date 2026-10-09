'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Label } from '@/components/ui/label'
import { ClayButton, NeuInput, PasswordStrength } from '@/components/ft'
import { Loader2, Lock, CheckCircle, Eye, EyeOff, AlertTriangle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { isStrongPassword, PASSWORD_REQUIREMENTS_MESSAGE } from '@/lib/password-validation'
import { AuthShell } from '../_components/auth-shell'
import { AuthAlert, FT_LINK } from '../_components/shared'

const RECOVERY_SESSION_KEY = 'fametech_password_recovery_active'

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
        <AuthShell
            title="Set a new password"
            subtitle={isValidSession === true && !success ? 'Enter and confirm your new password below.' : undefined}
            footer={
                <div className="mt-4 text-center">
                    <Link href="/auth" className={cn('inline-flex min-h-12 items-center px-3 text-base font-semibold', FT_LINK)}>
                        ← Back to sign in
                    </Link>
                </div>
            }
        >
            {isValidSession === false && (
                <div className="space-y-4 py-2 text-center">
                    <div className="ft-clay mx-auto flex h-14 w-14 items-center justify-center !rounded-full">
                        <AlertTriangle className="h-7 w-7" aria-hidden="true" />
                    </div>
                    <h2 className="ft-display text-lg font-extrabold text-ft-ink">Link expired or invalid</h2>
                    <p className="text-sm text-[color:var(--ft-muted)]">
                        This page only works from a valid recovery link. Request a fresh reset email to continue.
                    </p>
                    <ClayButton asChild className="w-full">
                        <Link href="/auth/reset-password">Request a new link</Link>
                    </ClayButton>
                </div>
            )}

            {isValidSession === null && (
                <div className="flex items-center justify-center py-10" role="status" aria-label="Checking your reset link">
                    <Loader2 className="h-8 w-8 animate-spin text-ft-blue dark:text-[color:var(--ft-cyan)]" aria-hidden="true" />
                </div>
            )}

            {success && (
                <div className="space-y-4 py-2 text-center">
                    <div className="ft-clay mx-auto flex h-14 w-14 items-center justify-center !rounded-full">
                        <CheckCircle className="h-7 w-7" aria-hidden="true" />
                    </div>
                    <h2 className="ft-display text-lg font-extrabold text-ft-ink">Password updated</h2>
                    <p className="text-sm text-[color:var(--ft-muted)]">
                        Your password has been changed. Taking you to sign in…
                    </p>
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-ft-blue dark:text-[color:var(--ft-cyan)]" aria-hidden="true" />
                </div>
            )}

            {isValidSession === true && !success && (
                <form onSubmit={handleSubmit} className="space-y-4">
                    {error && <AuthAlert tone="error">{error}</AuthAlert>}

                    <div className="space-y-2">
                        <Label htmlFor="password" className="text-sm font-semibold text-ft-ink">New password</Label>
                        <NeuInput
                            id="password"
                            type={showPassword ? 'text' : 'password'}
                            autoComplete="new-password"
                            placeholder="Min. 8 characters"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            leading={<Lock className="h-4 w-4" aria-hidden="true" />}
                            trailing={
                                <button
                                    type="button"
                                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="-mr-3 flex h-12 w-12 items-center justify-center rounded-xl text-[color:var(--ft-muted)] hover:text-ft-ink"
                                >
                                    {showPassword ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
                                </button>
                            }
                        />
                        <PasswordStrength password={password} />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="confirmPassword" className="text-sm font-semibold text-ft-ink">Confirm password</Label>
                        <NeuInput
                            id="confirmPassword"
                            type={showConfirm ? 'text' : 'password'}
                            autoComplete="new-password"
                            placeholder="Re-enter your new password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            required
                            leading={<Lock className="h-4 w-4" aria-hidden="true" />}
                            trailing={
                                <button
                                    type="button"
                                    aria-label={showConfirm ? 'Hide password' : 'Show password'}
                                    onClick={() => setShowConfirm(!showConfirm)}
                                    className="-mr-3 flex h-12 w-12 items-center justify-center rounded-xl text-[color:var(--ft-muted)] hover:text-ft-ink"
                                >
                                    {showConfirm ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
                                </button>
                            }
                        />
                    </div>

                    <ClayButton type="submit" loading={isLoading} className="w-full">
                        {isLoading ? 'Updating…' : <><Lock className="h-4 w-4" aria-hidden="true" />Update password</>}
                    </ClayButton>
                </form>
            )}
        </AuthShell>
    )
}
