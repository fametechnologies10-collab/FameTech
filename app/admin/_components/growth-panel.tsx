'use client'

import { cn } from '@/lib/utils'
import { Users, UserPlus, Crown } from 'lucide-react'
import { cardSurface, mutedSurface, sectionLabel, chartPalette, accent } from './dashboard-tokens'
import type { AdminStats } from './use-admin-dashboard'
import type { AdminCounts } from '@/hooks/use-admin-counts'

const ROLE_ORDER = ['customer', 'agent', 'dealer', 'sub-admin', 'admin']

export function GrowthPanel({ stats, counts }: { stats: AdminStats | null; counts: AdminCounts }) {
    if (!stats) return <div className={cn(cardSurface, 'h-full min-h-[200px] animate-pulse')} />

    const roleMix = stats.roleMix || {}
    const totalRoles = Object.values(roleMix).reduce((a, b) => a + (b || 0), 0) || 1
    const roles = ROLE_ORDER.filter(r => roleMix[r]).map(r => ({ role: r, count: roleMix[r] }))
    // Include any roles not in ROLE_ORDER
    Object.keys(roleMix).filter(r => !ROLE_ORDER.includes(r)).forEach(r => roles.push({ role: r, count: roleMix[r] }))

    return (
        <div className={cn(cardSurface, 'p-5 flex flex-col h-full')}>
            <div className="flex items-center gap-2 mb-4">
                <Users className="w-4 h-4" style={{ color: accent.blue }} />
                <p className={sectionLabel}>Growth &amp; Roles</p>
            </div>

            <div className="grid grid-cols-3 gap-2.5 mb-4">
                <div className={cn(mutedSurface, 'p-3')}>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">New · 7d</p>
                    <p className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-1">
                        <UserPlus className="w-3.5 h-3.5 text-emerald-500" />{stats.newUsers7d}
                    </p>
                </div>
                <div className={cn(mutedSurface, 'p-3')}>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">New · 30d</p>
                    <p className="text-lg font-bold text-zinc-900 dark:text-white">{stats.newUsers30d}</p>
                </div>
                <div className={cn(mutedSurface, 'p-3')}>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Expiring</p>
                    <p className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-1">
                        <Crown className="w-3.5 h-3.5 text-amber-500" />{counts.expiringAgents}
                    </p>
                </div>
            </div>

            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">Role mix</p>
            <div className="flex h-2.5 rounded-full overflow-hidden mb-3">
                {roles.map((r, i) => (
                    <div key={r.role} style={{ width: `${(r.count / totalRoles) * 100}%`, backgroundColor: chartPalette[i % chartPalette.length] }} />
                ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-auto">
                {roles.map((r, i) => (
                    <span key={r.role} className="inline-flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: chartPalette[i % chartPalette.length] }} />
                        <span className="capitalize">{r.role.replace('-', ' ')}</span>
                        <span className="font-bold">{r.count}</span>
                    </span>
                ))}
            </div>
        </div>
    )
}
