'use client'

import Link from 'next/link'
import { cn } from '@/lib/utils'
import { ShoppingCart, Users, Package, Wallet, CreditCard, Settings, type LucideIcon } from 'lucide-react'
import { cardSurface, mutedSurface, sectionLabel, accent } from './dashboard-tokens'

interface QuickAction {
    href: string
    label: string
    icon: LucideIcon
    color: string
    adminOnly?: boolean
}

const ACTIONS: QuickAction[] = [
    { href: '/admin/orders', label: 'Orders', icon: ShoppingCart, color: accent.blue },
    { href: '/admin/top-up', label: 'Top-Up', icon: Wallet, color: accent.yellow, adminOnly: true },
    { href: '/admin/users', label: 'Users', icon: Users, color: accent.violet, adminOnly: true },
    { href: '/admin/packages', label: 'Packages', icon: Package, color: accent.emerald, adminOnly: true },
    { href: '/admin/payments', label: 'Payments', icon: CreditCard, color: accent.red, adminOnly: true },
    { href: '/admin/settings', label: 'Settings', icon: Settings, color: accent.slate, adminOnly: true },
]

export function QuickActions({ isSubAdmin }: { isSubAdmin: boolean }) {
    const actions = ACTIONS.filter(a => !(isSubAdmin && a.adminOnly))

    return (
        <div className={cn(cardSurface, 'p-5')}>
            <p className={cn(sectionLabel, 'mb-3')}>Quick Actions</p>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2.5">
                {actions.map(a => {
                    const Icon = a.icon
                    return (
                        <Link
                            key={a.href}
                            href={a.href}
                            className={cn(mutedSurface, 'p-3 flex flex-col items-center gap-1.5 text-center hover:border-zinc-300 dark:hover:border-white/20 transition-colors')}
                        >
                            <Icon className="w-5 h-5" style={{ color: a.color }} />
                            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{a.label}</span>
                        </Link>
                    )
                })}
            </div>
        </div>
    )
}
