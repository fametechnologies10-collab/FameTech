'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { registerBiometric, isBiometricRegistered } from '@/lib/biometric-auth'
import { BIO_NEVER_KEY } from '@/components/biometric-setup-prompt'
import { saveUserDisplayHint } from '@/lib/pin-crypto'
import { ClayButton } from '@/components/ft'
import { Fingerprint, ShieldCheck, CheckCircle2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { AuthShell } from '../_components/auth-shell'
import { AuthAlert } from '../_components/shared'

function safeNext(next: string | null): string {
    if (!next) return '/dashboard'
    return next.startsWith('/') && !next.startsWith('//') && !next.includes(':') ? next : '/dashboard'
}

export default function EnableBiometricPage() {
    const { user, dbUser } = useAuth()
    const router = useRouter()
    const searchParams = useSearchParams()
    const nextUrl = safeNext(searchParams.get('next'))

    const [password, setPassword] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [success, setSuccess] = useState(false)

    useEffect(() => {
        if (isBiometricRegistered()) { router.replace(nextUrl); return }
        try {
            const pw = sessionStorage.getItem('kfg_bio_pw')
            sessionStorage.removeItem('kfg_bio_pw')
            setPassword(pw ?? '')
        } catch {
            setPassword('')
        }
    }, [])

    const handleEnable = async () => {
        if (!user?.id || !dbUser?.email || !password) return
        setLoading(true)
        setError('')
        try {
            const result = await registerBiometric(user.id, dbUser.email, password)
            if (result.success) {
                saveUserDisplayHint(dbUser.first_name || '', dbUser.email)
                setSuccess(true)
                toast.success('Biometric login enabled!')
                setTimeout(() => router.push(nextUrl), 1200)
            } else {
                setError(result.error || 'Setup failed. Please try again.')
            }
        } finally {
            setLoading(false)
        }
    }

    const handleNever = () => {
        try { localStorage.setItem(BIO_NEVER_KEY, '1') } catch {}
        router.push(nextUrl)
    }

    const fullName = [dbUser?.first_name, dbUser?.last_name].filter(Boolean).join(' ') || ''
    const hasPassword = password !== null && password !== ''

    return (
        <AuthShell
            showBrandPanel={false}
            title={success ? 'Biometric sign-in is on' : 'Sign in faster next time'}
            subtitle={success ? 'Taking you back now…' : 'Use your face or fingerprint instead of typing your password.'}
        >
            <div className="flex flex-col items-center space-y-4 text-center">
                <div className="flex flex-col items-center gap-2">
                    <span className="ft-inset inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-ft-ink">
                        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                        Trusted device
                    </span>
                    <p className="text-base font-semibold text-ft-ink">
                        {fullName ? `Hi, ${fullName}` : 'Welcome back'}
                    </p>
                </div>

                <div className="ft-clay flex h-16 w-16 items-center justify-center !rounded-full">
                    {success
                        ? <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
                        : <Fingerprint className="h-8 w-8" aria-hidden="true" />
                    }
                </div>

                {error && (
                    <div className="w-full text-left">
                        <AuthAlert tone="error">{error}</AuthAlert>
                    </div>
                )}

                {!hasPassword ? (
                    <div className="w-full space-y-3">
                        <p className="text-sm leading-relaxed text-[color:var(--ft-muted)]">
                            Biometric setup requires your account password. Enable it from{' '}
                            <strong className="text-ft-ink">Profile → Security</strong>.
                        </p>
                        <ClayButton onClick={() => router.push(nextUrl)} className="w-full">
                            Go back
                        </ClayButton>
                    </div>
                ) : (
                    <div className="w-full space-y-3">
                        <ClayButton onClick={handleEnable} loading={loading} className="w-full">
                            {loading
                                ? 'Setting up…'
                                : <><Fingerprint className="h-4 w-4" aria-hidden="true" />Enable Face ID / fingerprint</>}
                        </ClayButton>
                        <ClayButton
                            onClick={() => router.push(nextUrl)}
                            disabled={loading}
                            variant="soft"
                            className="w-full"
                        >
                            Maybe later
                        </ClayButton>
                    </div>
                )}

                <ClayButton variant="ghost" onClick={handleNever} disabled={loading}>
                    Don&apos;t show this again
                </ClayButton>
                <p className="text-xs text-[color:var(--ft-muted)]">
                    You can enable this anytime in Profile → Security
                </p>
            </div>
        </AuthShell>
    )
}
