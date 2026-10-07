'use client'

import Link from 'next/link'
import { formatCurrency, cn } from '@/lib/utils'
import { Scale, ArrowRight } from 'lucide-react'
import { cardSurface, sectionLabel, accent } from './dashboard-tokens'
import type { AdminStats } from './use-admin-dashboard'

export function FloatHealthCard({ stats }: { stats: AdminStats | null }) {
    if (!stats) return <div className={cn(cardSurface, 'h-full min-h-[180px] animate-pulse')} />

    const liability = stats.totalWalletBalance || 0
    const debt = stats.outstandingDebt || 0
    // Health: debt as a share of total float. Higher debt ratio = worse.
    const ratio = liability > 0 ? debt / liability : debt > 0 ? 1 : 0
    const health = ratio >= 0.25 ? 'critical' : ratio >= 0.1 ? 'warning' : 'healthy'
    const dot = health === 'critical' ? accent.red : health === 'warning' ? accent.yellow : accent.emerald
    const healthLabel = health === 'critical' ? 'Elevated debt' : health === 'warning' ? 'Watch' : 'Healthy'

    return (
        <div className={cn(cardSurface, 'p-5 flex flex-col h-full')}>
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <Scale className="w-4 h-4" style={{ color: accent.slate }} />
                    <p className={sectionLabel}>Float &amp; Liability</p>
                </div>
                <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: dot }} />
                    {healthLabel}
                </span>
            </div>

            <div className="space-y-3 flex-1">
                <div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">Wallet liability (held for users)</p>
                    <p className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">{formatCurrency(liability)}</p>
                </div>
                <div className="h-px bg-zinc-200/70 dark:bg-white/10" />
                <div className="flex items-end justify-between">
                    <div>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">Outstanding debt owed to you</p>
                        <p className={cn('text-xl font-bold tracking-tight', debt > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-900 dark:text-white')}>
                            {formatCurrency(debt)}
                        </p>
                    </div>
                    <span className="text-xs font-semibold text-zinc-400">{stats.debtorCount} debtor{stats.debtorCount !== 1 ? 's' : ''}</span>
                </div>
            </div>

            {debt > 0 && (
                <Link href="/admin/top-up?tab=settlements" className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-rose-600 dark:text-rose-400 hover:gap-1.5 transition-all">
                    Review settlements <ArrowRight className="w-3.5 h-3.5" />
                </Link>
            )}
        </div>
    )
}
