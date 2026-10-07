'use client'

import { formatCurrency, cn } from '@/lib/utils'
import { Package, Crown } from 'lucide-react'
import { cardSurface, sectionLabel, accent } from './dashboard-tokens'
import type { AdminTrends } from './use-admin-dashboard'

export function TopMovers({ trends }: { trends: AdminTrends | null }) {
    const packages = trends?.topPackages ?? []
    const agents = trends?.topAgents ?? []

    return (
        <div className={cn(cardSurface, 'p-5')}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                    <div className="flex items-center gap-2 mb-3">
                        <Package className="w-4 h-4" style={{ color: accent.yellow }} />
                        <p className={sectionLabel}>Top Packages</p>
                    </div>
                    {!trends ? (
                        <div className="h-32 animate-pulse rounded-xl bg-zinc-100 dark:bg-white/5" />
                    ) : packages.length === 0 ? (
                        <p className="text-sm text-zinc-400 py-4">No sales in this period</p>
                    ) : (
                        <ol className="space-y-2">
                            {packages.map((p, i) => (
                                <li key={p.label} className="flex items-center justify-between text-sm">
                                    <span className="flex items-center gap-2 min-w-0">
                                        <span className="w-5 text-xs font-bold text-zinc-400">{i + 1}</span>
                                        <span className="font-medium text-zinc-900 dark:text-white truncate">{p.label}</span>
                                    </span>
                                    <span className="text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{formatCurrency(p.revenue)} · {p.orders}</span>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>
                <div>
                    <div className="flex items-center gap-2 mb-3">
                        <Crown className="w-4 h-4" style={{ color: accent.violet }} />
                        <p className={sectionLabel}>Top Agents</p>
                    </div>
                    {!trends ? (
                        <div className="h-32 animate-pulse rounded-xl bg-zinc-100 dark:bg-white/5" />
                    ) : agents.length === 0 ? (
                        <p className="text-sm text-zinc-400 py-4">No agent sales in this period</p>
                    ) : (
                        <ol className="space-y-2">
                            {agents.map((a, i) => (
                                <li key={a.user_id} className="flex items-center justify-between text-sm">
                                    <span className="flex items-center gap-2 min-w-0">
                                        <span className="w-5 text-xs font-bold text-zinc-400">{i + 1}</span>
                                        <span className="font-medium text-zinc-900 dark:text-white truncate">{a.name}</span>
                                    </span>
                                    <span className="text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{formatCurrency(a.revenue)} · {a.orders}</span>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>
            </div>
        </div>
    )
}
