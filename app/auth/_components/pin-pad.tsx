'use client'

import { useCallback, useEffect } from 'react'
import { cn } from '@/lib/utils'

// ─── PIN dots ────────────────────────────────────────────────────────────────
export function PinDots({ filled, length = 6, shake }: { filled: number; length?: number; shake: boolean }) {
    return (
        <div className={cn('flex items-center justify-center gap-4 mb-2', shake && 'animate-shake')}>
            {Array.from({ length }).map((_, i) => (
                <div
                    key={i}
                    className={cn(
                        'w-4 h-4 rounded-full transition-all duration-200',
                        i < filled
                            ? 'scale-110 bg-[#0056B3] shadow-[0_0_8px_#0056B350]'
                            : 'bg-slate-200 dark:bg-slate-700'
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
            'touch-manipulation h-16 rounded-2xl flex items-center justify-center select-none',
            'text-2xl font-bold text-slate-800 dark:text-slate-100',
            'bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700',
            'hover:bg-slate-50 dark:hover:bg-slate-700 shadow-sm',
            'active:scale-90 active:shadow-inner transition-all duration-100',
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
                className="touch-manipulation h-16 rounded-2xl flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-90 transition-all duration-100 disabled:opacity-30"
            >
                <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
                    <line x1="18" y1="9" x2="12" y2="15" />
                    <line x1="12" y1="9" x2="18" y2="15" />
                </svg>
            </button>
        </div>
    )
}
