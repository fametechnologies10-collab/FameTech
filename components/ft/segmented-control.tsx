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
        <div role="tablist" aria-label={ariaLabel} className={cn('ft-inset flex gap-1 p-1.5', className)}>
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
                            'h-12 flex-1 rounded-2xl px-3 text-sm font-semibold transition-all duration-200',
                            active ? 'ft-raised text-ft-ink' : 'text-[color:var(--ft-muted)] hover:text-ft-ink'
                        )}
                    >
                        {opt.label}
                    </button>
                )
            })}
        </div>
    )
}
