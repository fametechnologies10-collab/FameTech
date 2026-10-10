import type { SupabaseClient } from '@supabase/supabase-js'

export const LOW_BALANCE_GHS = 10
export const POLL_INTERVAL_MS = 15000

export interface DashboardSummary {
    counts: {
        total: number
        pending: number
        queued: number
        processing: number
        completed: number
        failed: number
        refunded: number
    }
    wallet_balance: number
    spend: {
        last7: number[]
        total7: number
        total30: number
        top_network: string | null
    }
    active_order: null | {
        id: string
        network: string
        size: string
        phone_masked: string | null
        status: string
        created_at: string
        updated_at: string
    }
}

export type TrackerStatus = 'pending' | 'queued' | 'processing'

export function trackerStep(status: string): 0 | 1 | 2 | 3 {
    switch (status) {
        case 'queued':
            return 1
        case 'processing':
            return 2
        case 'completed':
            return 3
        default:
            return 0
    }
}

export function isLowBalance(balance: number | null | undefined, threshold = LOW_BALANCE_GHS): boolean {
    if (balance === null || balance === undefined) return false
    return balance < threshold
}

export function spendFor(s: DashboardSummary, window: '7d' | '30d'): number {
    return window === '7d' ? s.spend.total7 : s.spend.total30
}

export function sparkHeights(values: number[], maxPx: number): number[] {
    const max = Math.max(0, ...values)
    if (max <= 0) return values.map(() => 0)
    return values.map((v) => (v > 0 ? Math.max(2, Math.round((v / max) * maxPx)) : 0))
}

export function shouldPoll(s: DashboardSummary | null, hidden: boolean): boolean {
    return !!s?.active_order && !hidden
}

function num(v: unknown): number {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function obj(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export function normalizeSummary(raw: unknown): DashboardSummary {
    const r = obj(raw)
    const c = obj(r.counts)
    const sp = obj(r.spend)
    const last7 = Array.isArray(sp.last7) ? sp.last7 : []
    const ao = r.active_order && typeof r.active_order === 'object' ? obj(r.active_order) : null

    return {
        counts: {
            total: num(c.total),
            pending: num(c.pending),
            queued: num(c.queued),
            processing: num(c.processing),
            completed: num(c.completed),
            failed: num(c.failed),
            refunded: num(c.refunded),
        },
        wallet_balance: num(r.wallet_balance),
        spend: {
            last7: Array.from({ length: 7 }, (_, i) => num(last7[i])),
            total7: num(sp.total7),
            total30: num(sp.total30),
            top_network: typeof sp.top_network === 'string' && sp.top_network ? sp.top_network : null,
        },
        active_order: ao
            ? {
                  id: str(ao.id),
                  network: str(ao.network),
                  size: str(ao.size),
                  phone_masked: typeof ao.phone_masked === 'string' ? ao.phone_masked : null,
                  status: str(ao.status),
                  created_at: str(ao.created_at),
                  updated_at: str(ao.updated_at),
              }
            : null,
    }
}

export async function fetchDashboardSummary(client: Pick<SupabaseClient, 'rpc'>): Promise<DashboardSummary> {
    const { data, error } = await client.rpc('get_dashboard_summary')
    if (error) throw new Error(error.message || 'Failed to load dashboard summary')
    return normalizeSummary(data)
}
