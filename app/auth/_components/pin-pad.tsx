'use client'

import { useCallback, useEffect } from 'react'
import { cn } from '@/lib/utils'

// ─── PIN dots ────────────────────────────────────────────────────────────────
export function PinDots({ filled, length = 6, shake }: { filled: number; length?: number; shake: boolean }) {
    return (
        <div
            role="img"
            aria-label={`${filled} of ${length} digits entered`}
            className={cn('flex items-center justify-center gap-4 mb-2', shake && 'animate-shake')}
        >
            {Array.from({ length }).map((_, i) => (
                <div
                    key={i}
                    className={cn(
                        'w-5 h-5 rounded-full transition-all duration-200',
                        i < filled
                            ? 'scale-110 bg-ft-blue dark:bg-[color:var(--ft-cyan)]'
                            : 'ft-inset !rounded-full'
                    )}
                />
            ))}
        </div>
    )
}

export const DigitButton = ({ digit, onPress, disabled }: { digit: string; onPress: (d: string) => void; disabled: boolean }) => (
    <button
        type="button"
        disabled={disabled}
        onPointerDown={(e) => { e.preventDefault(); if (!disabled) onPress(digit) }}
        className={cn(
            'ft-raised touch-manipulation h-16 min-h-14 flex items-center justify-center select-none',
            'text-2xl font-bold text-ft-ink',
            'active:scale-95 transition-transform duration-100',
            disabled && 'opacity-40 cursor-not-allowed'
        )}
    >
        {digit}
    </button>
)

export function PinPadFast({ pin, onChange, isLoading }: { pin: string; onChange: (p: string) => void; isLoading: boolean }) {
    const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0']

    const handlePress = useCallback((d: string) => {
        onChange(pin.length < 6 ? pin + d : pin)
    }, [onChange, pin])

    const handleDelete = useCallback(() => {
        onChange(pin.slice(0, -1))
    }, [onChange, pin])

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (isLoading) return
            if (/^\d$/.test(e.key)) handlePress(e.key)
            else if (e.key === 'Backspace') handleDelete()
        }
        window.addEventListener('keydown', handleKey)
        return () => window.removeEventListener('keydown', handleKey)
    }, [handlePress, handleDelete, isLoading])

    return (
        <div className="grid grid-cols-3 gap-3 w-full mt-4">
            {digits.map((d, i) =>
                d === '' ? (
                    <div key={`empty-${i}`} />
                ) : (
                    <DigitButton key={d} digit={d} onPress={handlePress} disabled={isLoading || pin.length >= 6} />
                )
            )}
            <button
                type="button"
                aria-label="Delete last digit"
                onPointerDown={(e) => { e.preventDefault(); handleDelete() }}
                disabled={isLoading || pin.length === 0}
                className="touch-manipulation h-16 min-h-14 rounded-2xl flex items-center justify-center text-ft-ink hover:bg-[color:var(--ft-edge)] active:scale-95 transition-all duration-100 disabled:opacity-40"
            >
                <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
                    <line x1="18" y1="9" x2="12" y2="15" />
                    <line x1="12" y1="9" x2="18" y2="15" />
                </svg>
            </button>
        </div>
    )
}
