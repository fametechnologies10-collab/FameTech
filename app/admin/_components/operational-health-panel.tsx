'use client'

import Link from 'next/link'
import { formatCurrency, cn } from '@/lib/utils'
import { Activity, Zap, ZapOff, AlertTriangle, Package, Banknote, BadgeCheck, RotateCcw } from 'lucide-react'
import { cardSurface, mutedSurface, sectionLabel, accent } from './dashboard-tokens'
import type { AdminStats, EngineStatus } from './use-admin-dashboard'
import type { AdminCounts } from '@/hooks/use-admin-counts'

function Stat({ icon: Icon, label, value, color, href }: { icon: typeof Package; label: string; value: string | number; color: string; href?: string }) {
    const body = (
        <div className={cn(mutedSurface, 'p-3 flex items-center gap-3', href && 'hover:border-zinc-300 dark:hover:border-white/20 transition-colors')}>
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${color}1a`, color }}>
                <Icon className="w-4 h-4" />
            </div>
            <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 truncate">{label}</p>
                <p className="text-base font-bold text-zinc-900 dark:text-white">{value}</p>
            </div>
        </div>
    )
    return href ? <Link href={href}>{body}</Link> : body
}

export function OperationalHealthPanel({ stats, engine, counts }: { stats: AdminStats | null; engine: EngineStatus | null; counts: AdminCounts }) {
    const autoOn = engine?.autoFulfillmentEnabled ?? false
    const failedRate = engine?.failedRateToday ?? 0
    const engineHealthy = autoOn && failedRate < 10

    return (
        <div className={cn(cardSurface, 'p-5')}>
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4" style={{ color: accent.blue }} />
                    <p className={sectionLabel}>Operational Health</p>
                </div>
                <span
                    className={cn(
                        'inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-bold',
                        engineHealthy ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10' : 'text-rose-600 bg-rose-50 dark:bg-rose-500/10'
                    )}
                >
                    {autoOn ? <Zap className="w-3.5 h-3.5" /> : <ZapOff className="w-3.5 h-3.5" />}
                    {autoOn ? `Engine on · ${failedRate}% fail` : 'Engine off'}
                </span>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5">
                <Stat icon={Package} label="Pending Orders" value={counts.pendingOrders} color={accent.yellow} href="/admin/orders" />
                <Stat icon={Activity} label="Processing Today" value={counts.pendingFulfillment} color={accent.blue} href="/admin/fulfillment" />
                <Stat icon={AlertTriangle} label="Failed (action)" value={stats?.failedNeedsAction ?? 0} color={accent.red} href="/admin/orders" />
                <Stat icon={RotateCcw} label="Refunds (total)" value={formatCurrency(stats?.refundsAmount ?? 0)} color={accent.violet} href="/admin/orders" />
                <Stat icon={Banknote} label="Withdrawals" value={counts.pendingWithdrawals} color={accent.emerald} href="/admin/shops/withdrawals" />
                <Stat icon={BadgeCheck} label="AFA Pending" value={counts.pendingAfa} color={accent.violet} href="/admin/afa-management" />
                <Stat
                    icon={Banknote}
                    label="Supplier Float"
                    value={engine?.supplierBalance != null ? formatCurrency(engine.supplierBalance) : '—'}
                    color={accent.slate}
                />
            </div>
        </div>
    )
}
