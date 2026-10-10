'use client'

import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string> {
    value: T
    label: string
}

export interface SegmentedControlProps<T extends string> {
    value: T
    onChange: (v: T) => void
    options: SegmentedOption<T>[]
    ariaLabel: string
    className?: string
}

export function SegmentedControl<T extends string>({ value, onChange, options, ariaLabel, className }: SegmentedControlProps<T>) {
    return (
        <div role="tablist" aria-label={ariaLabel} className={cn('flex gap-1 rounded-xl border border-[color:var(--ft-edge)] bg-[color:var(--ft-surface)] p-1', className)}>
            {options.map((opt) => {
                const active = opt.value === value
                return (
                    <button
                        key={opt.value}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => onChange(opt.value)}
                        className={cn(
                            'h-10 flex-1 rounded-lg border border-transparent px-3 text-sm font-semibold transition-colors duration-150',
                            active ? 'border-[color:var(--ft-edge)] bg-[color:var(--ft-raised-bg)] text-ft-ink shadow-[var(--ft-shadow-raised)]' : 'text-[color:var(--ft-muted)] hover:text-ft-ink'
                        )}
                    >
                        {opt.label}
                    </button>
                )
            })}
        </div>
    )
}
