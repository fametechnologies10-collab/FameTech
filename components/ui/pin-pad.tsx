'use client'

import { useState, useCallback, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Delete, Fingerprint } from 'lucide-react'

interface PinPadProps {
    /** Number of digits the PIN should be */
    length?: number
    /** Called when all digits are entered */
    onComplete: (pin: string) => void
    /** Whether the pad is in a loading state */
    isLoading?: boolean
    /** Error message to display (e.g., wrong PIN) */
    error?: string | null
    /** Title text above the dots */
    title?: string
    /** Subtitle text */
    subtitle?: string
    /** Whether to show the "Forgot PIN?" link */
    showForgotPin?: boolean
    /** Callback for "Forgot PIN?" / "Use Password" */
    onForgotPin?: () => void
}

export function PinPad({
    length = 6,
    onComplete,
    isLoading = false,
    error = null,
    title = 'Enter your PIN',
    subtitle,
    showForgotPin = true,
    onForgotPin,
}: PinPadProps) {
    const [pin, setPin] = useState('')
    const [shake, setShake] = useState(false)

    // Trigger shake animation on error
    useEffect(() => {
        if (error) {
            setShake(true)
            setPin('')
            const timer = setTimeout(() => setShake(false), 500)
            return () => clearTimeout(timer)
        }
    }, [error])

    // Auto-submit when all digits entered
    useEffect(() => {
        if (pin.length === length) {
            onComplete(pin)
        }
    }, [pin, length, onComplete])

    const handlePress = useCallback((digit: string) => {
        if (isLoading) return
        setPin(prev => {
            if (prev.length >= length) return prev
            return prev + digit
        })
    }, [isLoading, length])

    const handleDelete = useCallback(() => {
        if (isLoading) return
        setPin(prev => prev.slice(0, -1))
    }, [isLoading])

    // Keyboard support
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isLoading) return
            if (/^\d$/.test(e.key)) {
                handlePress(e.key)
            } else if (e.key === 'Backspace') {
                handleDelete()
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [handlePress, handleDelete, isLoading])

    const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del']

    return (
        <div className="flex flex-col items-center justify-center w-full max-w-xs mx-auto select-none">
            {/* Title */}
            <div className="text-center mb-8">
                <div className="w-16 h-16 rounded-2xl ft-clay-btn flex items-center justify-center mx-auto mb-4">
                    <Fingerprint className="w-8 h-8 text-white" />
                </div>
                <h2 className="text-xl font-black text-foreground">{title}</h2>
                {subtitle && (
                    <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
                )}
            </div>

            {/* PIN Dots */}
            <div className={cn(
                'flex items-center gap-3 mb-2 transition-transform',
                shake && 'animate-shake'
            )}>
                {Array.from({ length }).map((_, i) => (
                    <div
                        key={i}
                        className={cn(
                            'w-4 h-4 rounded-full transition-all duration-200',
                            i < pin.length
                                ? 'bg-[color:var(--ft-blue)] dark:bg-[color:var(--ft-cyan)] scale-110 border-2 border-[color:var(--ft-blue)] dark:border-[color:var(--ft-cyan)]'
                                : 'bg-[color:var(--ft-surface)] border-2 border-[color:var(--ft-muted)] [box-shadow:inset_1px_1px_3px_var(--ft-lo),inset_-1px_-1px_3px_var(--ft-hi)]'
                        )}
                    />
                ))}
            </div>

            {/* Error Message */}
            {error && (
                <p className="text-xs font-semibold text-destructive dark:text-red-400 mt-1 mb-4 text-center animate-in fade-in">
                    {error}
                </p>
            )}

            {/* Number Pad */}
            <div className="grid grid-cols-3 gap-3 mt-6 w-full">
                {digits.map((digit, i) => {
                    if (digit === '') {
                        return <div key={`empty-${i}`} />
                    }
                    if (digit === 'del') {
                        return (
                            <button
                                key="delete"
                                type="button"
                                onPointerDown={(e) => { e.preventDefault(); handleDelete() }}
                                title="Delete last digit"
                                disabled={isLoading || pin.length === 0}
                                className={cn(
                                    'h-16 rounded-2xl flex items-center justify-center transition-all duration-150 touch-manipulation',
                                    'text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                    'active:scale-90 disabled:opacity-30'
                                )}
                            >
                                <Delete className="w-6 h-6" />
                            </button>
                        )
                    }
                    return (
                        <button
                            key={digit}
                            type="button"
                            onPointerDown={(e) => { e.preventDefault(); handlePress(digit) }}
                            disabled={isLoading}
                            className={cn(
                                'h-16 min-w-14 rounded-2xl flex items-center justify-center transition-all duration-150 touch-manipulation',
                                'text-2xl font-bold text-foreground ft-soft',
                                'hover:brightness-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                'active:scale-95 active:[box-shadow:var(--ft-shadow-inset),var(--tw-ring-offset-shadow,0_0_#0000),var(--tw-ring-shadow,0_0_#0000)]',
                                isLoading && 'opacity-50 cursor-not-allowed'
                            )}
                        >
                            {digit}
                        </button>
                    )
                })}
            </div>

            {/* Forgot PIN / Use Password */}
            {showForgotPin && onForgotPin && (
                <button
                    type="button"
                    onClick={onForgotPin}
                    className="mt-6 text-sm font-semibold text-primary underline-offset-4 hover:underline transition-colors"
                >
                    Use email & password instead
                </button>
            )}
        </div>
    )
}
