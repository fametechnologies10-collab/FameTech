'use client'

import { formatCurrency, cn } from '@/lib/utils'
import { Signal } from 'lucide-react'
import { cardSurface, sectionLabel, networkColor, accent } from './dashboard-tokens'
import type { BreakdownRow } from './use-admin-dashboard'

export function NetworkBreakdown({ rows }: { rows: BreakdownRow[] | null }) {
    const data = rows ?? []
    const total = data.reduce((a, r) => a + (r.revenue || 0), 0) || 1

    return (
        <div className={cn(cardSurface, 'p-5')}>
            <div className="flex items-center gap-2 mb-4">
                <Signal className="w-4 h-4" style={{ color: accent.blue }} />
                <p className={sectionLabel}>Revenue by Network</p>
            </div>

            {!rows ? (
                <div className="h-40 animate-pulse rounded-xl bg-zinc-100 dark:bg-white/5" />
            ) : data.length === 0 ? (
                <div className="h-40 flex items-center justify-center text-sm text-zinc-400">No data in this period</div>
            ) : (
                <div className="space-y-3">
                    {data.map(r => {
                        const pct = (r.revenue / total) * 100
                        const color = networkColor[(r.network || '').toUpperCase()] || accent.slate
                        return (
                            <div key={r.network || 'unknown'}>
                                <div className="flex items-center justify-between text-xs mb-1">
                                    <span className="font-semibold text-zinc-900 dark:text-white">{r.network || 'Unknown'}</span>
                                    <span className="text-zinc-500 dark:text-zinc-400">{formatCurrency(r.revenue)} · {r.orders}</span>
                                </div>
                                <div className="h-2 rounded-full bg-zinc-100 dark:bg-white/5 overflow-hidden">
                                    <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
