'use client'

import { useCallback, useEffect, useState } from 'react'

export type DashRange = 'today' | '7d' | '30d'

export interface AdminStats {
    totalUsers: number
    totalOrders: number
    completedOrders: number
    pendingOrders: number
    totalRevenue: number
    totalWalletBalance: number
    successRate: number
    todayOrders: number
    revenueToday: number
    revenue7d: number
    revenue30d: number
    revenuePrev7d: number
    revenuePrev30d: number
    profitToday: number
    profit7d: number
    profit30d: number
    outstandingDebt: number
    debtorCount: number
    failedNeedsAction: number
    refundedOrders: number
    refundsAmount: number
    refundsToday: number
    refunds7d: number
    refunds30d: number
    newUsers7d: number
    newUsers30d: number
    roleMix: Record<string, number>
    degraded: boolean
}

export interface TrendPoint {
    bucket: string
    revenue: number
    orders: number
    profit: number
}

export interface BreakdownRow {
    revenue: number
    orders: number
    network?: string
    category?: string
    source?: string
}

export interface TopPackage {
    label: string
    network: string
    size: string
    orders: number
    revenue: number
}

export interface TopAgent {
    user_id: string
    name: string
    revenue: number
    orders: number
}

export interface AdminTrends {
    range: string
    series: TrendPoint[]
    byNetwork: BreakdownRow[]
    byCategory: BreakdownRow[]
    bySource: BreakdownRow[]
    topPackages: TopPackage[]
    topAgents: TopAgent[]
}

export interface ActivityItem {
    kind: 'order' | 'withdrawal' | 'signup'
    id: string
    label: string
    amount: number | null
    status: string
    at: string
}

export interface EngineStatus {
    autoFulfillmentEnabled: boolean
    ussdEnabled: boolean
    todayOrders: number
    failedToday: number
    failedRateToday: number
    supplierBalance: number | null
    supplierCurrency: string | null
}

export interface AdminDashboardData {
    stats: AdminStats | null
    trends: AdminTrends | null
    activity: ActivityItem[]
    engine: EngineStatus | null
    degraded: boolean
    isLoading: boolean
    error: string | null
    refresh: () => void
}

/**
 * Single data source for the admin console. Fetches stats, trends (range-bound),
 * recent activity, and engine status in parallel. Surfaces a `degraded` flag so
 * the UI can warn when money figures are unavailable rather than showing ₵0 as
 * truth.
 */
export function useAdminDashboard(range: DashRange): AdminDashboardData {
    const [stats, setStats] = useState<AdminStats | null>(null)
    const [trends, setTrends] = useState<AdminTrends | null>(null)
    const [activity, setActivity] = useState<ActivityItem[]>([])
    const [engine, setEngine] = useState<EngineStatus | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const fetchAll = useCallback(async () => {
        try {
            setError(null)
            const [s, t, a, e] = await Promise.all([
                fetch('/api/admin/stats'),
                fetch(`/api/admin/stats/trends?range=${range}`),
                fetch('/api/admin/activity?limit=12'),
                fetch('/api/admin/engine-status'),
            ])

            if (!s.ok) {
                const body = await s.json().catch(() => ({}))
                throw new Error(body.error || 'Failed to load stats')
            }
            setStats(await s.json())
            setTrends(t.ok ? await t.json() : null)
            setActivity(a.ok ? await a.json() : [])
            setEngine(e.ok ? await e.json() : null)
        } catch (err: any) {
            console.error('Error loading admin dashboard:', err)
            setError(err.message || 'Failed to load dashboard')
        } finally {
            setIsLoading(false)
        }
    }, [range])

    useEffect(() => {
        setIsLoading(true)
        fetchAll()
    }, [fetchAll])

    return {
        stats,
        trends,
        activity,
        engine,
        degraded: stats?.degraded ?? false,
        isLoading,
        error,
        refresh: fetchAll,
    }
}
