'use client'

import { formatCurrency, cn } from '@/lib/utils'
import { TrendingUp, TrendingDown, DollarSign, Banknote, ShoppingCart, CheckCircle2, Wallet, Clock } from 'lucide-react'
import { cardSurface, sectionLabel, kpiValue, accent, deltaPct } from './dashboard-tokens'
import type { AdminStats, AdminTrends, DashRange } from './use-admin-dashboard'

function Sparkline({ values, color }: { values: number[]; color: string }) {
    if (!values.length) return null
    const max = Math.max(...values, 1)
    const min = Math.min(...values, 0)
    const range = max - min || 1
    const w = 64
    const h = 22
    const step = values.length > 1 ? w / (values.length - 1) : w
    const points = values
        .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
        .join(' ')
    return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
            <polyline points={points} fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function DeltaChip({ current, previous }: { current: number; previous: number }) {
    const d = deltaPct(current, previous)
    if (d.neutral) return null
    const Icon = d.up ? TrendingUp : TrendingDown
    return (
        <span
            className={cn(
                'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[11px] font-bold',
                d.up ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10' : 'text-rose-600 bg-rose-50 dark:bg-rose-500/10'
            )}
        >
            <Icon className="w-3 h-3" />
            {d.pct.toFixed(1)}%
        </span>
    )
}

interface Kpi {
    label: string
    value: string
    icon: typeof DollarSign
    iconColor: string
    spark?: number[]
    sparkColor?: string
    delta?: { current: number; previous: number }
}

export function KpiStrip({ stats, trends, range }: { stats: AdminStats | null; trends: AdminTrends | null; range: DashRange }) {
    if (!stats) {
        return (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                {[...Array(6)].map((_, i) => <div key={i} className={cn(cardSurface, 'h-28 animate-pulse')} />)}
            </div>
        )
    }

    const revenue = range === 'today' ? stats.revenueToday : range === '7d' ? stats.revenue7d : stats.revenue30d
    const revenuePrev = range === 'today' ? 0 : range === '7d' ? stats.revenuePrev7d : stats.revenuePrev30d
    const profit = range === 'today' ? stats.profitToday : range === '7d' ? stats.profit7d : stats.profit30d
    const series = trends?.series ?? []
    const ordersInRange = series.reduce((a, p) => a + (p.orders || 0), 0)

    const kpis: Kpi[] = [
        {
            label: 'Revenue', value: formatCurrency(revenue), icon: DollarSign, iconColor: accent.emerald,
            spark: series.map(p => p.revenue), sparkColor: accent.emerald,
            ...(range !== 'today' ? { delta: { current: revenue, previous: revenuePrev } } : {}),
        },
        {
            label: 'Profit', value: formatCurrency(profit), icon: Banknote, iconColor: accent.yellow,
            spark: series.map(p => p.profit), sparkColor: accent.yellow,
        },
        {
            label: 'Orders', value: String(ordersInRange || stats.todayOrders), icon: ShoppingCart, iconColor: accent.blue,
            spark: series.map(p => p.orders), sparkColor: accent.blue,
        },
        { label: 'Success Rate', value: `${stats.successRate}%`, icon: CheckCircle2, iconColor: accent.violet },
        { label: 'Float Balance', value: formatCurrency(stats.totalWalletBalance), icon: Wallet, iconColor: accent.slate },
        { label: "Today's Orders", value: String(stats.todayOrders), icon: Clock, iconColor: accent.red },
    ]

    return (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {kpis.map(k => {
                const Icon = k.icon
                return (
                    <div key={k.label} className={cn(cardSurface, 'p-4 flex flex-col gap-2')}>
                        <div className="flex items-center justify-between">
                            <Icon className="w-4 h-4" style={{ color: k.iconColor }} />
                            {k.delta && <DeltaChip current={k.delta.current} previous={k.delta.previous} />}
                        </div>
                        <div>
                            <p className={sectionLabel}>{k.label}</p>
                            <p className={cn(kpiValue, 'mt-0.5')}>{k.value}</p>
                        </div>
                        {k.spark && k.spark.length > 1 && (
                            <div className="mt-auto pt-1">
                                <Sparkline values={k.spark} color={k.sparkColor || accent.slate} />
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}
