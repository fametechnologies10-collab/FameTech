'use client'

import { useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { registerBiometric } from '@/lib/biometric-auth'
import { Fingerprint, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
import { BackgroundBubbles } from '@/components/background-bubbles'

export const BIO_NEVER_KEY = 'kfg_bio_prompt_never'

export function isBiometricPromptNever(): boolean {
    try {
        return localStorage.getItem(BIO_NEVER_KEY) === '1'
    } catch {
        return false
    }
}

interface BiometricSetupPromptProps {
    password: string
    onDone: (action: 'enabled' | 'later' | 'never') => void
}

export function BiometricSetupPrompt({ password, onDone }: BiometricSetupPromptProps) {
    const { user, dbUser } = useAuth()
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')

    const handleEnable = async () => {
        if (!user?.id || !dbUser?.email) return
        setLoading(true)
        setError('')
        try {
            const result = await registerBiometric(user.id, dbUser.email, password)
            if (result.success) {
                toast.success('Biometric login enabled!')
                onDone('enabled')
            } else {
                setError(result.error || 'Setup failed. Please try again.')
            }
        } finally {
            setLoading(false)
        }
    }

    const handleNever = () => {
        try { localStorage.setItem(BIO_NEVER_KEY, '1') } catch {}
        onDone('never')
    }

    return (
        <div className="relative min-h-screen w-full flex flex-col items-center justify-center px-4 py-10 overflow-y-auto">
            <BackgroundBubbles scrollable />
            <div className="relative z-10 w-full max-w-sm flex flex-col items-center text-center">
                <div className="mb-8">
                    <div className="relative w-16 h-16 mb-3 rounded-full overflow-hidden flex items-center justify-center bg-white dark:bg-slate-800 shadow-xl border-[3px] border-[#FFCC00] mx-auto">
                        <BrandLogo width={60} height={60} />
                    </div>
                    <BrandTitle className="text-lg font-black tracking-tight" />
                </div>

                <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-[#0056B315] border-2 border-[#0056B330]">
                    <Fingerprint className="w-10 h-10 text-[#0056B3]" />
                </div>

                <h2 className="text-2xl font-black text-slate-900 dark:text-white mb-2">
                    Sign in faster next time
                </h2>
                <p className="text-sm text-slate-500 dark:text-slate-400 mb-8 leading-relaxed px-2">
                    Use your face or fingerprint to sign in instantly — no password needed.
                </p>

                {error && (
                    <p className="text-sm text-red-600 mb-4 font-semibold">{error}</p>
                )}

                <div className="w-full space-y-3">
                    <Button
                        onClick={handleEnable}
                        disabled={loading}
                        className="w-full h-12 text-base font-bold text-white rounded-xl shadow-lg bg-gradient-to-br from-[#0056B3] to-[#00B4D8] disabled:opacity-50"
                    >
                        {loading
                            ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" />Setting up…</>
                            : <><Fingerprint className="w-5 h-5 mr-2" />Enable Face ID / Fingerprint</>
                        }
                    </Button>

                    <Button
                        onClick={() => onDone('later')}
                        disabled={loading}
                        variant="outline"
                        className="w-full h-11 font-semibold rounded-xl"
                    >
                        Maybe later
                    </Button>
                </div>

                <button
                    type="button"
                    onClick={handleNever}
                    disabled={loading}
                    className="mt-4 text-xs text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 transition-colors font-medium"
                >
                    Don&apos;t show this again
                </button>

                <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
                    You can enable this anytime in Profile → Security
                </p>
            </div>
        </div>
    )
}
