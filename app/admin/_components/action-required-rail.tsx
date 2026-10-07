'use client'

import Link from 'next/link'
import { cn } from '@/lib/utils'
import { ShoppingCart, Store, Banknote, MessageSquare, BadgeCheck, Crown, ArrowRight, type LucideIcon } from 'lucide-react'
import { cardSurface } from './dashboard-tokens'
import type { AdminCounts } from '@/hooks/use-admin-counts'

interface ActionDef {
    key: keyof AdminCounts
    href: string
    label: string
    suffix: string
    icon: LucideIcon
    color: string
    bg: string
}

// The carded actions. The "N Actions Required" total is derived from THIS list
// only — so the headline count can never disagree with the cards shown.
// (Previously the total summed every count incl. pendingFulfillment/pendingDebts,
// which have no card and overlap pendingOrders, inflating the badge.)
const ACTIONS: ActionDef[] = [
    { key: 'pendingOrders', href: '/admin/orders', label: 'Orders', suffix: 'Pending', icon: ShoppingCart, color: 'text-orange-600', bg: 'bg-orange-100 dark:bg-orange-900/30' },
    { key: 'pendingShops', href: '/admin/shops', label: 'Shops', suffix: 'Review', icon: Store, color: 'text-blue-600', bg: 'bg-blue-100 dark:bg-blue-900/30' },
    { key: 'pendingWithdrawals', href: '/admin/shops/withdrawals', label: 'Withdrawals', suffix: 'Pending', icon: Banknote, color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-900/30' },
    { key: 'pendingComplaints', href: '/admin/complaints', label: 'Complaints', suffix: 'Issues', icon: MessageSquare, color: 'text-red-600', bg: 'bg-red-100 dark:bg-red-900/30' },
    { key: 'pendingAfa', href: '/admin/afa-management', label: 'AFA Apps', suffix: 'Pending', icon: BadgeCheck, color: 'text-amber-600', bg: 'bg-amber-100 dark:bg-amber-900/30' },
    { key: 'expiringAgents', href: '/admin/memberships', label: 'Agents', suffix: 'Expiring', icon: Crown, color: 'text-purple-600', bg: 'bg-purple-100 dark:bg-purple-900/30' },
]

/** Total actions = sum of carded counts only (single source of truth). */
export function totalActions(counts: AdminCounts): number {
    return ACTIONS.reduce((sum, a) => sum + (counts[a.key] || 0), 0)
}

export function ActionRequiredRail({ counts }: { counts: AdminCounts }) {
    const active = ACTIONS.filter(a => (counts[a.key] || 0) > 0)
    if (active.length === 0) return null

    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 animate-in fade-in slide-in-from-top-2 duration-500">
            {active.map(a => {
                const Icon = a.icon
                return (
                    <Link key={a.key} href={a.href}>
                        <div className={cn(cardSurface, 'p-3 flex items-center justify-between group cursor-pointer h-full')}>
                            <div className="flex items-center gap-3 min-w-0">
                                <div className={cn('p-2 rounded-lg flex-shrink-0', a.bg, a.color)}>
                                    <Icon className="w-4 h-4" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[10px] font-bold uppercase text-zinc-500 dark:text-zinc-400 tracking-wider truncate">{a.label}</p>
                                    <p className="text-sm font-bold text-zinc-900 dark:text-white">{counts[a.key]} {a.suffix}</p>
                                </div>
                            </div>
                            <ArrowRight className="w-4 h-4 text-zinc-300 group-hover:text-zinc-500 group-hover:translate-x-0.5 transition-all flex-shrink-0" />
                        </div>
                    </Link>
                )
            })}
        </div>
    )
}
