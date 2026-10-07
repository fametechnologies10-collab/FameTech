'use client'

import { useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useAdminCounts } from '@/hooks/use-admin-counts'
import { useAdminDashboard, type DashRange } from './_components/use-admin-dashboard'
import { TimeRange } from './_components/time-range'
import { KpiStrip } from './_components/kpi-strip'
import { RevenueTrendChart } from './_components/revenue-trend-chart'
import { FloatHealthCard } from './_components/float-health-card'
import { OperationalHealthPanel } from './_components/operational-health-panel'
import { SystemControlCenter } from './_components/system-control-center'
import { NetworkBreakdown } from './_components/network-breakdown'
import { ProductSourceBreakdown } from './_components/product-source-breakdown'
import { GrowthPanel } from './_components/growth-panel'
import { TopMovers } from './_components/top-movers'
import { ActivityFeed } from './_components/activity-feed'
import { ActionRequiredRail, totalActions } from './_components/action-required-rail'
import { QuickActions } from './_components/quick-actions'

export default function AdminDashboardPage() {
    const [range, setRange] = useState<DashRange>('7d')
    const { isSubAdmin } = useAuth()
    const { counts } = useAdminCounts()
    const { stats, trends, activity, engine, degraded, isLoading, error, refresh } = useAdminDashboard(range)

    const actions = totalActions(counts)

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
                <AlertTriangle className="w-10 h-10 text-rose-500" />
                <p className="text-lg font-semibold text-rose-600 dark:text-rose-400">Failed to load dashboard</p>
                <p className="text-sm text-muted-foreground">{error}</p>
                <button
                    onClick={refresh}
                    className="mt-2 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm hover:bg-zinc-800 transition-colors"
                >
                    <RefreshCw className="w-4 h-4" /> Retry
                </button>
            </div>
        )
    }

    return (
        <div className="space-y-5">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-black tracking-tight text-zinc-900 dark:text-white">Admin Dashboard</h1>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">Platform performance &amp; operations at a glance.</p>
                </div>
                <div className="flex items-center gap-3">
                    {actions > 0 && (
                        <div className="inline-flex items-center gap-1.5 bg-rose-50 dark:bg-rose-500/10 px-3 py-1.5 rounded-full border border-rose-100 dark:border-rose-500/20">
                            <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
                            <span className="text-xs font-bold text-rose-700 dark:text-rose-400">
                                {actions} Action{actions > 1 ? 's' : ''}
                            </span>
                        </div>
                    )}
                    <TimeRange value={range} onChange={setRange} />
                </div>
            </div>

            {degraded && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-sm text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    Revenue &amp; balance figures are temporarily unavailable (stats service degraded). Counts shown may be incomplete.
                </div>
            )}

            <ActionRequiredRail counts={counts} />

            <KpiStrip stats={stats} trends={trends} range={range} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2"><RevenueTrendChart trends={trends} /></div>
                <FloatHealthCard stats={stats} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2"><OperationalHealthPanel stats={stats} engine={engine} counts={counts} /></div>
                <SystemControlCenter />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <NetworkBreakdown rows={trends?.byNetwork ?? null} />
                <GrowthPanel stats={stats} counts={counts} />
            </div>

            <ProductSourceBreakdown byCategory={trends?.byCategory ?? null} bySource={trends?.bySource ?? null} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2 space-y-4">
                    <TopMovers trends={trends} />
                    <QuickActions isSubAdmin={isSubAdmin} />
                </div>
                <ActivityFeed items={activity} isLoading={isLoading} />
            </div>
        </div>
    )
}
