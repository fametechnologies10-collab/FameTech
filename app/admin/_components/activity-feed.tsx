'use client'

import { formatCurrency, cn } from '@/lib/utils'
import { ShoppingCart, Banknote, UserPlus } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { cardSurface, mutedSurface, sectionLabel, accent } from './dashboard-tokens'
import type { ActivityItem } from './use-admin-dashboard'

const KIND_META = {
    order: { icon: ShoppingCart, color: accent.blue },
    withdrawal: { icon: Banknote, color: accent.emerald },
    signup: { icon: UserPlus, color: accent.violet },
} as const

function timeAgo(at: string): string {
    try {
        return formatDistanceToNow(new Date(at), { addSuffix: true })
    } catch {
        return ''
    }
}

export function ActivityFeed({ items, isLoading }: { items: ActivityItem[]; isLoading: boolean }) {
    return (
        <div className={cn(cardSurface, 'p-5 flex flex-col h-full')}>
            <div className="flex items-center gap-2 mb-4">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <p className={sectionLabel}>Recent Activity</p>
            </div>

            {isLoading ? (
                <div className="space-y-2">
                    {[...Array(5)].map((_, i) => <div key={i} className={cn(mutedSurface, 'h-12 animate-pulse')} />)}
                </div>
            ) : items.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-sm text-zinc-400">No recent activity</div>
            ) : (
                <ul className="space-y-1.5 overflow-y-auto max-h-[340px] pr-1">
                    {items.map(item => {
                        const meta = KIND_META[item.kind] ?? KIND_META.order
                        const Icon = meta.icon
                        return (
                            <li key={`${item.kind}-${item.id}`} className={cn(mutedSurface, 'p-2.5 flex items-center gap-3')}>
                                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}>
                                    <Icon className="w-4 h-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-zinc-900 dark:text-white truncate">{item.label}</p>
                                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                                        <span className="capitalize">{item.kind}</span>
                                        {item.status ? ` · ${item.status}` : ''} · {timeAgo(item.at)}
                                    </p>
                                </div>
                                {item.amount != null && (
                                    <span className="text-sm font-bold text-zinc-900 dark:text-white whitespace-nowrap">{formatCurrency(item.amount)}</span>
                                )}
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}
