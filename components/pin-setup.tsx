'use client'

import { useState } from 'react'
import { PinPad } from '@/components/ui/pin-pad'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'

interface PinSetupProps {
    userName?: string
    onComplete: (pin: string) => void
    onCancel?: () => void
}

type SetupStep = 'enter' | 'confirm' | 'success'

export function PinSetup({ userName: _userName, onComplete, onCancel }: PinSetupProps) {
    const [step, setStep] = useState<SetupStep>('enter')
    const [firstPin, setFirstPin] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(false)

    const handleFirstPin = (pin: string) => {
        setFirstPin(pin)
        setError(null)
        setStep('confirm')
    }

    const handleConfirmPin = async (pin: string) => {
        if (pin !== firstPin) {
            setError('PINs do not match. Try again.')
            setStep('enter')
            setFirstPin('')
            return
        }

        setIsLoading(true)
        try {
            const res = await fetch('/api/auth/pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin, action: 'set' }),
            })

            if (!res.ok) throw new Error('Failed to set PIN')

            try {
                localStorage.setItem('kfg_pin_verified', 'true')
                localStorage.setItem('kfg_pin_verified_at', Date.now().toString())
            } catch {}

            setStep('success')
            toast.success('Quick Access PIN activated!')
            setTimeout(() => onComplete(pin), 1500)
        } catch {
            setError('Something went wrong. Please try again.')
            setStep('enter')
            setFirstPin('')
        } finally {
            setIsLoading(false)
        }
    }

    if (step === 'success') {
        return (
            <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4 transition-colors">
                <div className="text-center space-y-4 animate-in fade-in zoom-in duration-300">
                    <div className="w-20 h-20 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto">
                        <CheckCircle2 className="w-10 h-10 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <h2 className="text-xl font-black text-slate-900 dark:text-white">PIN Activated!</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                        You can now use your 6-digit PIN to sign in quickly.
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4 transition-colors">
            <div className="w-full max-w-xs animate-in fade-in slide-in-from-bottom-4 duration-300">
                <PinPad
                    onComplete={step === 'enter' ? handleFirstPin : handleConfirmPin}
                    isLoading={isLoading}
                    error={error}
                    title={step === 'enter' ? 'Create your PIN' : 'Confirm your PIN'}
                    subtitle={step === 'enter' ? "Choose a 6-digit PIN you'll remember" : 'Enter the same PIN again to confirm'}
                    showForgotPin={false}
                />
                {isLoading && (
                    <div className="flex justify-center mt-4">
                        <Loader2 className="w-5 h-5 animate-spin text-[#0056B3]" />
                    </div>
                )}
                {!isLoading && onCancel && (
                    <div className="flex justify-center mt-5">
                        <button
                            type="button"
                            onClick={onCancel}
                            className="text-sm text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 font-semibold transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}
