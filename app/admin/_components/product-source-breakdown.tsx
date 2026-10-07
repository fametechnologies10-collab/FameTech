'use client'

import { formatCurrency, cn } from '@/lib/utils'
import { Layers, Radio } from 'lucide-react'
import { cardSurface, sectionLabel, chartPalette, accent } from './dashboard-tokens'
import type { BreakdownRow } from './use-admin-dashboard'

function BreakdownList({ rows, keyName }: { rows: BreakdownRow[]; keyName: 'category' | 'source' }) {
    const total = rows.reduce((a, r) => a + (r.revenue || 0), 0) || 1
    if (rows.length === 0) {
        return <div className="h-24 flex items-center justify-center text-sm text-zinc-400">No data</div>
    }
    return (
        <div className="space-y-2.5">
            {rows.map((r, i) => {
                const name = (keyName === 'category' ? r.category : r.source) || 'Unknown'
                const pct = (r.revenue / total) * 100
                const color = chartPalette[i % chartPalette.length]
                return (
                    <div key={name}>
                        <div className="flex items-center justify-between text-xs mb-1">
                            <span className="font-semibold capitalize text-zinc-900 dark:text-white">{String(name).replace(/_/g, ' ')}</span>
                            <span className="text-zinc-500 dark:text-zinc-400">{formatCurrency(r.revenue)}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-white/5 overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

export function ProductSourceBreakdown({ byCategory, bySource }: { byCategory: BreakdownRow[] | null; bySource: BreakdownRow[] | null }) {
    return (
        <div className={cn(cardSurface, 'p-5')}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                    <div className="flex items-center gap-2 mb-4">
                        <Layers className="w-4 h-4" style={{ color: accent.violet }} />
                        <p className={sectionLabel}>By Product</p>
                    </div>
                    {!byCategory ? <div className="h-24 animate-pulse rounded-xl bg-zinc-100 dark:bg-white/5" /> : <BreakdownList rows={byCategory} keyName="category" />}
                </div>
                <div>
                    <div className="flex items-center gap-2 mb-4">
                        <Radio className="w-4 h-4" style={{ color: accent.emerald }} />
                        <p className={sectionLabel}>By Source</p>
                    </div>
                    {!bySource ? <div className="h-24 animate-pulse rounded-xl bg-zinc-100 dark:bg-white/5" /> : <BreakdownList rows={bySource} keyName="source" />}
                </div>
            </div>
        </div>
    )
}
