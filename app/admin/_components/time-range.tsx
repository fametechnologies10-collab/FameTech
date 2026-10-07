'use client'

import { cn } from '@/lib/utils'
import type { DashRange } from './use-admin-dashboard'

const OPTIONS: { value: DashRange; label: string }[] = [
    { value: 'today', label: 'Today' },
    { value: '7d', label: '7D' },
    { value: '30d', label: '30D' },
]

export function TimeRange({ value, onChange }: { value: DashRange; onChange: (r: DashRange) => void }) {
    return (
        <div className="inline-flex items-center gap-1 rounded-full border border-zinc-200/70 dark:border-white/10 bg-zinc-100 dark:bg-white/5 p-1">
            {OPTIONS.map(o => (
                <button
                    key={o.value}
                    onClick={() => onChange(o.value)}
                    className={cn(
                        'px-3 py-1 text-xs font-bold rounded-full transition-colors',
                        value === o.value
                            ? 'bg-white dark:bg-white/10 text-zinc-900 dark:text-white shadow-sm'
                            : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    )
}
