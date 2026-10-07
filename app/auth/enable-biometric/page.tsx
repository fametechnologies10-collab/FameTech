'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { registerBiometric, isBiometricRegistered } from '@/lib/biometric-auth'
import { BIO_NEVER_KEY } from '@/components/biometric-setup-prompt'
import { saveUserDisplayHint } from '@/lib/pin-crypto'
import { BackgroundBubbles } from '@/components/background-bubbles'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
import { Button } from '@/components/ui/button'
import { Fingerprint, Loader2, ShieldCheck, Home, CheckCircle2 } from 'lucide-react'
import { toast } from '@/lib/toast'

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
        <div className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 py-10 overflow-y-auto">
            <BackgroundBubbles scrollable />

            <div className="absolute top-4 left-4 sm:top-6 sm:left-6 z-50">
                <Link href="/">
                    <Button variant="ghost" size="sm" className="font-bold gap-2 rounded-full text-slate-700 dark:text-slate-200">
                        <Home className="w-4 h-4" />
                        <span className="hidden sm:inline text-sm">Home</span>
                    </Button>
                </Link>
            </div>

            <div className="relative z-10 w-full max-w-sm flex flex-col items-center text-center">
                <Link href="/" className="inline-flex flex-col items-center mb-7">
                    <div className="relative w-14 h-14 rounded-full overflow-hidden flex items-center justify-center bg-white dark:bg-slate-800 shadow-xl border-[3px] border-[#FFCC00] mb-2">
                        <BrandLogo width={52} height={52} />
                    </div>
                    <BrandTitle className="text-base font-black tracking-tight" />
                </Link>

                {/* Identity block */}
                <div className="flex flex-col items-center mb-6">
                    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full mb-3 bg-[#0056B315] border border-[#0056B330]">
                        <ShieldCheck className="w-3.5 h-3.5 text-[#0056B3]" />
                        <span className="text-xs font-bold text-[#0056B3]">Trusted Device</span>
                    </div>
                    <h2 className="text-xl font-black text-slate-900 dark:text-white">
                        {fullName ? `Hi, ${fullName}! 👋` : 'Welcome back'}
                    </h2>
                </div>

                {/* Icon */}
                <div className={`w-20 h-20 rounded-full flex items-center justify-center mb-5 border-2 transition-all duration-300 ${success ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-700' : 'bg-[#0056B315] border-[#0056B330]'}`}>
                    {success
                        ? <CheckCircle2 className="w-10 h-10 text-emerald-500" />
                        : <Fingerprint className="w-10 h-10 text-[#0056B3]" />
                    }
                </div>

                <h3 className="text-base font-black text-slate-900 dark:text-white mb-1.5">
                    {success ? 'Biometric enabled!' : 'Sign in faster next time'}
                </h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mb-6 leading-relaxed px-4">
                    {success ? 'Redirecting you now…' : 'Use your face or fingerprint to sign in instantly — no password needed.'}
                </p>

                {error && (
                    <p className="text-sm text-red-600 dark:text-red-400 mb-4 font-semibold">{error}</p>
                )}

                {!hasPassword ? (
                    <div className="w-full space-y-3">
                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-2 leading-relaxed">
                            Biometric setup requires your account password. Enable it from{' '}
                            <strong className="text-slate-700 dark:text-slate-200">Profile → Security</strong>.
                        </p>
                        <Button onClick={() => router.push(nextUrl)} className="w-full h-11 text-sm font-bold rounded-xl">
                            Go back
                        </Button>
                    </div>
                ) : (
                    <div className="w-full space-y-3">
                        <Button
                            onClick={handleEnable}
                            disabled={loading}
                            className="w-full h-11 text-sm font-bold text-white rounded-xl shadow-lg bg-gradient-to-br from-[#0056B3] to-[#00B4D8] disabled:opacity-50"
                        >
                            {loading
                                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Setting up…</>
                                : <><Fingerprint className="w-4 h-4 mr-2" />Enable Face ID / Fingerprint</>}
                        </Button>
                        <Button
                            onClick={() => router.push(nextUrl)}
                            disabled={loading}
                            variant="outline"
                            className="w-full h-10 text-sm font-semibold rounded-xl"
                        >
                            Maybe later
                        </Button>
                    </div>
                )}

                <button
                    type="button"
                    onClick={handleNever}
                    disabled={loading}
                    className="mt-4 text-xs text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 transition-colors font-medium"
                >
                    Don&apos;t show this again
                </button>
                <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
                    You can enable this anytime in Profile → Security
                </p>
            </div>
        </div>
    )
}
