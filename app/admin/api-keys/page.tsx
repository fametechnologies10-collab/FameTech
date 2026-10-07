'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
    Key, CheckCircle2, XCircle, Clock, User, Activity,
    Shield, Search, ChevronLeft, ChevronRight, RefreshCw,
    Sliders, Code2, BarChart2, AlertCircle, Check, X,
    TrendingUp, Zap, Settings, ToggleLeft, ToggleRight,
    Wallet, AlertOctagon, Gauge, Crown, Percent, ChevronDown,
    ChevronUp, ShoppingCart, Webhook,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RateLimits {
    purchase: number
    bulk: number
    balance: number
    status: number
}

interface ApiKeyItem {
    id: string
    prefix: string
    name: string
    status: 'pending' | 'active' | 'revoked'
    key_type: 'standard' | 'commission'
    rate_limits: RateLimits | null
    last_used_at: string | null
    created_at: string
    requests_24h: number
    has_webhook: boolean
    user: {
        id: string
        name: string
        email: string
        phone: string
        role: string
    } | null
}

interface ApiLogItem {
    id: string
    endpoint: string
    method: string
    status_code: number
    response_time_ms: number
    ip_address: string | null
    error_message: string | null
    created_at: string
    api_key_id: string | null
    key_prefix?: string
    key_name?: string
    user?: { name: string; email: string } | null
}

// Version-agnostic suffixes (no leading /api/v1 or /api/v2) — v1 is retired
// for NEW traffic but historical api_logs rows still carry /api/v1/* from
// before the port, and this log viewer reads both eras. Matching on the
// version-stripped suffix, the same trick middleware.ts uses for its
// fail-closed set, means a v2 request gets its friendly label too instead of
// silently falling back to generic "API Request".
const ENDPOINT_LABELS: Record<string, string> = {
    '/data/purchase':  'Data Purchase',
    '/data/bulk':      'Bulk Purchase',
    '/wallet/balance': 'Balance Fetch',
    '/wallet/topup':   'Wallet Top-Up',
    '/orders':         'Order Status',
}

function getFriendlyLabel(endpoint: string): string {
    const suffix = endpoint.replace(/^\/api\/v\d+/, '')
    for (const [key, label] of Object.entries(ENDPOINT_LABELS)) {
        if (suffix.startsWith(key)) return label
    }
    return 'API Request'
}

interface Pagination {
    page: number
    limit: number
    total: number
    total_pages: number
}

interface AggregateStats {
    requests_24h: number
    requests_ok_24h: number
    requests_err_24h: number
    success_rate_24h: number
    avg_response_ms: number
    revenue_24h: number
    revenue_all_time: number
    orders_24h: number
    top_user: { name: string; email: string; requests: number } | null
}

interface UserActivity {
    user_id: string
    total_spent: number
    total_orders: number
    success_orders: number
    failed_orders: number
    pending_orders: number
    success_rate: number
    requests_24h: number
    requests_ok_24h: number
    requests_err_24h: number
    avg_response_ms: number
}

type SortBy = 'recent' | 'requests' | 'last_used' | 'oldest'

// ─── Status Config ────────────────────────────────────────────────────────────

const STATUS = {
    pending: {
        icon: Clock,
        color: 'text-amber-600 dark:text-amber-400',
        bg: 'bg-amber-50 dark:bg-amber-500/10',
        border: 'border-amber-200 dark:border-amber-500/30',
        dot: 'bg-amber-400',
        label: 'Pending',
    },
    active: {
        icon: CheckCircle2,
        color: 'text-emerald-600 dark:text-emerald-400',
        bg: 'bg-emerald-50 dark:bg-emerald-500/10',
        border: 'border-emerald-200 dark:border-emerald-500/30',
        dot: 'bg-emerald-400',
        label: 'Active',
    },
    revoked: {
        icon: XCircle,
        color: 'text-red-600 dark:text-red-400',
        bg: 'bg-red-50 dark:bg-red-500/10',
        border: 'border-red-200 dark:border-red-500/30',
        dot: 'bg-red-400',
        label: 'Revoked',
    },
}

const DEFAULT_RATE_LIMITS: RateLimits = { purchase: 10, bulk: 3, balance: 5, status: 5 }

// ─── Stat Card ────────────────────────────────────────────────────────────────

type Accent = 'violet' | 'emerald' | 'red' | 'amber' | 'sky' | 'slate' | 'indigo'

function StatCard({
    icon: Icon, label, value, sub, accent = 'slate', pulse,
}: {
    icon?: any
    label: string
    value: number | string
    sub?: string
    accent?: Accent
    pulse?: boolean
}) {
    const accents: Record<Accent, { iconBg: string; iconText: string; text: string }> = {
        violet:  { iconBg: 'bg-violet-500/10',  iconText: 'text-violet-600 dark:text-violet-400',   text: 'text-violet-600 dark:text-violet-400' },
        emerald: { iconBg: 'bg-emerald-500/10', iconText: 'text-emerald-600 dark:text-emerald-400', text: 'text-emerald-600 dark:text-emerald-400' },
        red:     { iconBg: 'bg-red-500/10',     iconText: 'text-red-600 dark:text-red-400',         text: 'text-red-600 dark:text-red-400' },
        amber:   { iconBg: 'bg-amber-500/10',   iconText: 'text-amber-600 dark:text-amber-400',     text: 'text-amber-500' },
        sky:     { iconBg: 'bg-sky-500/10',     iconText: 'text-sky-600 dark:text-sky-400',         text: 'text-sky-600 dark:text-sky-400' },
        indigo:  { iconBg: 'bg-indigo-500/10',  iconText: 'text-indigo-600 dark:text-indigo-400',   text: 'text-indigo-600 dark:text-indigo-400' },
        slate:   { iconBg: 'bg-slate-200 dark:bg-slate-700/60', iconText: 'text-slate-600 dark:text-slate-300', text: 'text-slate-900 dark:text-white' },
    }
    const a = accents[accent]
    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 sm:p-4 min-w-0">
            <div className="flex items-start gap-2 sm:gap-2.5">
                {Icon && (
                    <div className={cn('w-7 h-7 sm:w-8 sm:h-8 rounded-xl flex items-center justify-center flex-shrink-0', a.iconBg)}>
                        <Icon className={cn('w-3.5 h-3.5 sm:w-4 sm:h-4', a.iconText)} />
                    </div>
                )}
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        {pulse && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />}
                        <p className="text-[10px] sm:text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider truncate">{label}</p>
                    </div>
                    <p className={cn('text-sm sm:text-base lg:text-lg font-semibold mt-0.5 tabular-nums whitespace-nowrap', a.text)}>{value}</p>
                    {sub && <p className="text-[10px] sm:text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 truncate">{sub}</p>}
                </div>
            </div>
        </div>
    )
}

// ─── Rate Limit Editor ────────────────────────────────────────────────────────

function RateLimitEditor({
    keyId, current, onSaved,
}: {
    keyId: string; current: RateLimits | null; onSaved: () => void
}) {
    const [values, setValues] = useState<RateLimits>(current ?? DEFAULT_RATE_LIMITS)
    const [saving, setSaving] = useState(false)

    const field = (key: keyof RateLimits, label: string, hint: string) => (
        <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">{label}</label>
            <div className="flex items-center gap-2">
                <input
                    type="number"
                    min={1}
                    max={1000}
                    title={label}
                    placeholder={label}
                    value={values[key]}
                    onChange={e => setValues(v => ({ ...v, [key]: Math.max(1, parseInt(e.target.value) || 1) }))}
                    className="w-20 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-mono text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-violet-500/40"
                />
                <span className="text-xs text-slate-400">{hint}</span>
            </div>
        </div>
    )

    const save = async () => {
        setSaving(true)
        try {
            const res = await fetch('/api/admin/api-keys', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key_id: keyId, rate_limits: values }),
            })
            if (res.ok) { toast.success('Rate limits updated'); onSaved() }
            else { const j = await res.json(); toast.error(j.error || 'Failed to update') }
        } catch { toast.error('Network error') }
        finally { setSaving(false) }
    }

    return (
        <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800 space-y-4">
            <div className="flex items-center gap-2 mb-3">
                <Sliders className="w-4 h-4 text-violet-500" />
                <h4 className="text-sm font-semibold text-slate-900 dark:text-white">Per-Key Rate Limits <span className="text-xs text-slate-400 font-normal">(req / min)</span></h4>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {field('purchase', 'Purchase', 'req/min')}
                {field('bulk', 'Bulk', 'req/min')}
                {field('balance', 'Balance', 'req/min')}
                {field('status', 'Status', 'req/min')}
            </div>
            <div className="flex items-center gap-2 pt-1">
                <Button
                    size="sm"
                    onClick={save}
                    disabled={saving}
                    className="h-8 text-xs font-semibold bg-violet-600 hover:bg-violet-700 text-white gap-1.5"
                >
                    {saving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    {saving ? 'Saving…' : 'Save Limits'}
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setValues(DEFAULT_RATE_LIMITS)}
                    className="h-8 text-xs"
                >
                    Reset to Default
                </Button>
            </div>
        </div>
    )
}

// ─── User Activity Panel ─────────────────────────────────────────────────────

function UserActivityPanel({ keyId, userId }: { keyId: string; userId: string }) {
    const [data, setData] = useState<UserActivity | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        const fetchActivity = async () => {
            try {
                const params = new URLSearchParams({ tab: 'user_activity', user_id: userId, api_key_id: keyId })
                const res = await fetch(`/api/admin/api-keys?${params}`)
                if (res.ok) setData(await res.json())
            } catch { /* noop */ }
            finally { setLoading(false) }
        }
        fetchActivity()
    }, [keyId, userId])

    if (loading) {
        return (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-16 sm:h-20 rounded-xl" />)}
            </div>
        )
    }

    if (!data) {
        return <p className="text-xs text-slate-400">Failed to load activity.</p>
    }

    const tile = (label: string, value: string | number, color = 'text-slate-900 dark:text-white') => (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-2.5 sm:p-3 min-w-0">
            <p className="text-[9px] sm:text-[10px] font-semibold text-slate-400 uppercase tracking-wider truncate">{label}</p>
            <p className={cn('text-sm sm:text-base font-semibold mt-0.5 tabular-nums whitespace-nowrap', color)}>{value}</p>
        </div>
    )

    return (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {tile('Spent', `GH₵ ${data.total_spent.toFixed(2)}`, 'text-violet-600 dark:text-violet-400')}
            {tile('Orders', data.total_orders.toLocaleString())}
            {tile('Success', data.success_orders.toLocaleString(), 'text-emerald-600 dark:text-emerald-400')}
            {tile('Failed', data.failed_orders.toLocaleString(), 'text-red-600 dark:text-red-400')}
            {tile('Pending', data.pending_orders.toLocaleString(), 'text-amber-500')}
            {tile('Success Rate', `${data.success_rate}%`,
                data.success_rate >= 90 ? 'text-emerald-600 dark:text-emerald-400'
                : data.success_rate >= 70 ? 'text-amber-500' : 'text-red-600 dark:text-red-400')}
            {tile('Reqs (24h)', data.requests_24h.toLocaleString(), 'text-sky-600 dark:text-sky-400')}
            {tile('Avg Latency', `${data.avg_response_ms}ms`)}
        </div>
    )
}

// ─── Key Row ──────────────────────────────────────────────────────────────────

function KeyRow({ item, onAction }: {
    item: ApiKeyItem
    onAction: (id: string, action: 'approve' | 'revoke') => Promise<void>
}) {
    const [expanded, setExpanded] = useState<'limits' | 'activity' | null>(null)
    const [acting, setActing] = useState(false)
    const cfg = STATUS[item.status]
    const StatusIcon = cfg.icon

    const act = async (action: 'approve' | 'revoke') => {
        setActing(true)
        await onAction(item.id, action)
        setActing(false)
    }

    const toggle = (panel: 'limits' | 'activity') =>
        setExpanded(p => (p === panel ? null : panel))

    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden transition-shadow hover:shadow-sm">
            {/* Main row */}
            <div className="flex flex-col gap-3 p-3 sm:p-4 lg:p-5 lg:flex-row lg:items-center">

                {/* User avatar + info */}
                <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-10 h-10 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0">
                        <User className="w-5 h-5 text-slate-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="font-semibold text-slate-900 dark:text-white truncate text-sm">{item.user?.name || 'Unknown User'}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{item.user?.email || '—'}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <code className="text-[10px] font-mono bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded-md">
                                {item.prefix}••••••••
                            </code>
                            <span className={cn(
                                'inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md border',
                                item.key_type === 'commission'
                                    ? 'bg-violet-50 dark:bg-violet-500/10 border-violet-200 dark:border-violet-500/30 text-violet-600 dark:text-violet-400'
                                    : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
                            )}>
                                {item.key_type === 'commission' ? <Percent className="w-2.5 h-2.5" /> : <Key className="w-2.5 h-2.5" />}
                                {item.key_type === 'commission' ? 'Commission · Utilities' : 'Standard'}
                            </span>
                            {item.has_webhook && (
                                <span
                                    title="This key has a webhook URL configured"
                                    className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md border bg-sky-50 dark:bg-sky-500/10 border-sky-200 dark:border-sky-500/30 text-sky-600 dark:text-sky-400"
                                >
                                    <Webhook className="w-2.5 h-2.5" />
                                    Webhook
                                </span>
                            )}
                            <span className="text-[10px] text-slate-400 capitalize">{item.user?.role || '—'}</span>
                        </div>
                    </div>

                    {/* Status pill (mobile: stays with user info) */}
                    <div className={cn(
                        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border flex-shrink-0 lg:hidden',
                        cfg.bg, cfg.color, cfg.border
                    )}>
                        <span className={cn('w-1.5 h-1.5 rounded-full', cfg.dot,
                            item.status === 'active' && 'animate-pulse')} />
                        {cfg.label}
                    </div>
                </div>

                {/* Stats + status pill (desktop) */}
                <div className="hidden lg:flex items-center gap-4 flex-shrink-0 text-right">
                    <div>
                        <div className="flex items-center justify-end gap-1 text-sm font-semibold text-slate-700 dark:text-slate-300">
                            <Activity className="w-3.5 h-3.5 text-slate-400" />
                            {item.requests_24h}
                            <span className="text-xs font-normal text-slate-400">req/24h</span>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                            {item.last_used_at
                                ? `Last: ${new Date(item.last_used_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                                : 'Never used'}
                        </p>
                    </div>
                    <div className={cn(
                        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border',
                        cfg.bg, cfg.color, cfg.border
                    )}>
                        <span className={cn('w-1.5 h-1.5 rounded-full', cfg.dot,
                            item.status === 'active' && 'animate-pulse')} />
                        <StatusIcon className="w-3.5 h-3.5" />
                        {cfg.label}
                    </div>
                </div>

                {/* Mobile stats row */}
                <div className="flex lg:hidden items-center justify-between text-xs px-0.5">
                    <span className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
                        <Activity className="w-3 h-3" />
                        <span className="font-semibold text-slate-700 dark:text-slate-300">{item.requests_24h}</span> req/24h
                    </span>
                    <span className="text-slate-400">
                        {item.last_used_at
                            ? `Last: ${new Date(item.last_used_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                            : 'Never used'}
                    </span>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0 flex-wrap">
                    {item.status === 'pending' && (
                        <Button
                            size="sm"
                            type="button"
                            onClick={() => act('approve')}
                            disabled={acting}
                            className="h-8 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                        >
                            {acting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                            Approve
                        </Button>
                    )}
                    {item.status !== 'revoked' && (
                        <Button
                            size="sm"
                            type="button"
                            variant="outline"
                            onClick={() => act('revoke')}
                            disabled={acting}
                            className="h-8 text-xs text-red-500 border-red-200 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/20"
                        >
                            {acting ? '…' : <><X className="w-3 h-3 mr-1" />Revoke</>}
                        </Button>
                    )}
                    <Button
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={() => toggle('activity')}
                        className={cn('h-8 text-xs gap-1.5', expanded === 'activity' && 'bg-violet-50 dark:bg-violet-500/10 border-violet-200 dark:border-violet-700 text-violet-600 dark:text-violet-400')}
                    >
                        <BarChart2 className="w-3 h-3" />
                        <span className="hidden sm:inline">Activity</span>
                        {expanded === 'activity' ? <ChevronUp className="w-3 h-3 sm:hidden" /> : <ChevronDown className="w-3 h-3 sm:hidden" />}
                    </Button>
                    <Button
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={() => toggle('limits')}
                        className={cn('h-8 text-xs gap-1.5', expanded === 'limits' && 'bg-violet-50 dark:bg-violet-500/10 border-violet-200 dark:border-violet-700 text-violet-600 dark:text-violet-400')}
                    >
                        <Sliders className="w-3 h-3" />
                        <span className="hidden sm:inline">Limits</span>
                    </Button>
                </div>
            </div>

            {/* Expanded: rate limit editor */}
            {expanded === 'limits' && (
                <div className="px-4 sm:px-5 pb-5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20">
                    <RateLimitEditor keyId={item.id} current={item.rate_limits} onSaved={() => setExpanded(null)} />
                </div>
            )}

            {/* Expanded: user activity */}
            {expanded === 'activity' && item.user && (
                <div className="px-4 sm:px-5 py-4 sm:py-5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20">
                    <div className="flex items-center gap-2 mb-3">
                        <BarChart2 className="w-4 h-4 text-violet-500" />
                        <h4 className="text-sm font-semibold text-slate-900 dark:text-white">User Activity</h4>
                        <span className="text-xs text-slate-400 font-normal hidden sm:inline">API order + request totals</span>
                    </div>
                    <UserActivityPanel keyId={item.id} userId={item.user.id} />
                </div>
            )}
        </div>
    )
}

// ─── Logs Tab ─────────────────────────────────────────────────────────────────

function LogsTab() {
    const [logs, setLogs] = useState<ApiLogItem[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [page, setPage] = useState(1)
    const [total, setTotal] = useState(0)
    const PER_PAGE = 50

    const fetchLogs = useCallback(async (p = 1) => {
        setIsLoading(true)
        try {
            const res = await fetch(`/api/admin/api-keys?tab=logs&page=${p}&limit=${PER_PAGE}`)
            if (res.ok) {
                const json = await res.json()
                setLogs(json.logs || [])
                setTotal(json.pagination?.total || 0)
                setPage(p)
            }
        } catch { console.error('Failed to fetch logs') }
        finally { setIsLoading(false) }
    }, [])

    useEffect(() => { fetchLogs(1) }, [fetchLogs])

    const statusColor = (code: number) => {
        if (code < 300) return 'text-emerald-600 dark:text-emerald-400'
        if (code < 400) return 'text-blue-600 dark:text-blue-400'
        if (code < 500) return 'text-amber-600 dark:text-amber-400'
        return 'text-red-600 dark:text-red-400'
    }

    const methodColor = (method: string) => {
        if (method === 'GET') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
        if (method === 'POST') return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20'
        return 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
    }

    const totalPages = Math.ceil(total / PER_PAGE)

    if (isLoading) return (
        <div className="space-y-2">
            {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}
        </div>
    )

    if (logs.length === 0) return (
        <div className="text-center py-16">
            <BarChart2 className="w-12 h-12 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
            <p className="text-sm text-slate-500 dark:text-slate-400">No API request logs yet.</p>
        </div>
    )

    return (
        <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                <div className="overflow-x-auto">
                    <div className="min-w-[620px]">
                        {/* Table header */}
                        <div className="grid grid-cols-[64px_1fr_1fr_72px_72px_110px] gap-2 px-4 py-2.5 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                            {['Method', 'Action', 'User / Key', 'Status', 'Time', 'When'].map(h => (
                                <span key={h} className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{h}</span>
                            ))}
                        </div>
                        {/* Rows */}
                        <div className="divide-y divide-slate-100 dark:divide-slate-800">
                            {logs.map(log => (
                                <div key={log.id} className="grid grid-cols-[64px_1fr_1fr_72px_72px_110px] gap-2 items-center px-4 py-3 hover:bg-slate-50/80 dark:hover:bg-slate-800/30 transition-colors">
                                    <span className={cn('inline-flex w-fit px-2 py-0.5 rounded-md text-[10px] font-semibold border font-mono', methodColor(log.method))}>
                                        {log.method}
                                    </span>
                                    <div className="min-w-0">
                                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 block truncate">
                                            {getFriendlyLabel(log.endpoint)}
                                        </span>
                                        <code className="text-[10px] text-slate-400 dark:text-slate-500 font-mono truncate block">{log.endpoint}</code>
                                    </div>
                                    <div className="min-w-0">
                                        {log.user ? (
                                            <>
                                                <span className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate block">{log.user.name}</span>
                                                <span className="text-[10px] text-slate-400 truncate block">{log.user.email}</span>
                                            </>
                                        ) : log.key_prefix ? (
                                            <span className="text-[10px] text-slate-400 font-mono">{log.key_prefix}••••</span>
                                        ) : (
                                            <span className="text-[10px] text-slate-300 dark:text-slate-600">—</span>
                                        )}
                                    </div>
                                    <span className={cn('text-sm font-semibold font-mono', statusColor(log.status_code))}>
                                        {log.status_code}
                                    </span>
                                    <span className="text-xs text-slate-500 font-mono">
                                        {log.response_time_ms}ms
                                    </span>
                                    <span className="text-[11px] text-slate-400">
                                        {new Date(log.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-500">{total.toLocaleString()} total logs · Page {page} of {totalPages}</p>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => fetchLogs(page - 1)} className="h-8">
                            <ChevronLeft className="w-4 h-4" />
                        </Button>
                        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => fetchLogs(page + 1)} className="h-8">
                            <ChevronRight className="w-4 h-4" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = 'keys' | 'logs'

export default function AdminApiKeysPage() {
    const [tab, setTab] = useState<Tab>('keys')
    const [keys, setKeys] = useState<ApiKeyItem[]>([])
    const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, total_pages: 0 })
    const [stats, setStats] = useState<AggregateStats | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [statusFilter, setStatusFilter] = useState('')
    const [roleFilter, setRoleFilter] = useState('')
    const [sortBy, setSortBy] = useState<SortBy>('recent')
    const [searchQuery, setSearchQuery] = useState('')
    const [debouncedSearch, setDebouncedSearch] = useState('')

    // Feature control settings
    const [featureEnabled, setFeatureEnabled] = useState(true)
    const [allowedRoles, setAllowedRoles] = useState<string[]>(['agent'])
    const [settingsSaving, setSettingsSaving] = useState(false)

    const fetchKeys = useCallback(async (page = 1) => {
        setIsLoading(true)
        try {
            const params = new URLSearchParams({ page: String(page), limit: '50' })
            if (statusFilter) params.set('status', statusFilter)
            if (roleFilter) params.set('role', roleFilter)
            if (sortBy) params.set('sort', sortBy)
            if (debouncedSearch) params.set('search', debouncedSearch)
            const res = await fetch(`/api/admin/api-keys?${params}`)
            if (res.ok) {
                const json = await res.json()
                setKeys(json.keys || [])
                setPagination(json.pagination || { page: 1, limit: 50, total: 0, total_pages: 0 })
                if (json.stats) setStats(json.stats)
                if (json.settings) {
                    setFeatureEnabled(json.settings.feature_enabled !== false)
                    setAllowedRoles(Array.isArray(json.settings.allowed_roles) ? json.settings.allowed_roles : ['agent'])
                }
            }
        } catch { console.error('Failed to fetch keys') }
        finally { setIsLoading(false) }
    }, [statusFilter, roleFilter, sortBy, debouncedSearch])

    // Debounce search → server query (350ms)
    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 350)
        return () => clearTimeout(t)
    }, [searchQuery])

    const saveSettings = async () => {
        setSettingsSaving(true)
        try {
            const res = await fetch('/api/admin/api-keys', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'save_settings', feature_enabled: featureEnabled, allowed_roles: allowedRoles }),
            })
            const json = await res.json()
            if (res.ok) toast.success(json.message || 'Settings saved')
            else toast.error(json.error || 'Failed to save settings')
        } catch { toast.error('Network error') }
        finally { setSettingsSaving(false) }
    }

    const toggleRole = (role: string) => {
        setAllowedRoles(prev =>
            prev.includes(role)
                ? prev.length === 1 ? prev : prev.filter(r => r !== role) // keep at least one
                : [...prev, role]
        )
    }

    useEffect(() => { fetchKeys(1) }, [fetchKeys])

    const handleAction = async (keyId: string, action: 'approve' | 'revoke') => {
        try {
            const res = await fetch('/api/admin/api-keys', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key_id: keyId, action }),
            })
            const json = await res.json()
            if (res.ok) {
                toast.success(json.message || `Key ${action}d`)
                fetchKeys(pagination.page)
            } else {
                toast.error(json.error || 'Action failed')
            }
        } catch { toast.error('Network error') }
    }

    // Server already filtered + searched + sorted.
    const filteredKeys = keys

    const pendingCount = keys.filter(k => k.status === 'pending').length
    const activeCount = keys.filter(k => k.status === 'active').length

    return (
        <div className="space-y-6">

            {/* ── Header ─────────────────────────────────────────────────── */}
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-500/20 flex-shrink-0">
                        <Key className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">API Key Management</h1>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">Approve, revoke, and set per-key rate limits</p>
                    </div>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchKeys(pagination.page)}
                    className="gap-2 h-9 text-xs font-semibold flex-shrink-0"
                >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Refresh
                </Button>
            </div>

            {/* ── Stats ──────────────────────────────────────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-3">
                <StatCard icon={Key} label="Total Keys" value={pagination.total.toLocaleString()} accent="slate" />
                <StatCard icon={Clock} label="Pending" value={pendingCount.toLocaleString()} accent="amber" pulse={pendingCount > 0} />
                <StatCard icon={CheckCircle2} label="Active Keys" value={activeCount.toLocaleString()} accent="emerald" />
                <StatCard icon={Activity} label="Requests (24h)" value={(stats?.requests_24h ?? 0).toLocaleString()} accent="violet" />
                <StatCard
                    icon={Wallet}
                    label="Revenue (24h)"
                    value={`GH₵ ${(stats?.revenue_24h ?? 0).toFixed(2)}`}
                    sub={`GH₵ ${(stats?.revenue_all_time ?? 0).toFixed(2)} lifetime`}
                    accent="indigo"
                />
                <StatCard
                    icon={Percent}
                    label="Success Rate (24h)"
                    value={`${(stats?.success_rate_24h ?? 0).toFixed(1)}%`}
                    sub={`${(stats?.requests_ok_24h ?? 0).toLocaleString()} ok`}
                    accent={(stats?.success_rate_24h ?? 100) >= 90 ? 'emerald' : (stats?.success_rate_24h ?? 0) >= 70 ? 'amber' : 'red'}
                />
                <StatCard
                    icon={AlertOctagon}
                    label="Failed (24h)"
                    value={(stats?.requests_err_24h ?? 0).toLocaleString()}
                    accent="red"
                    pulse={(stats?.requests_err_24h ?? 0) > 0}
                />
                <StatCard
                    icon={Gauge}
                    label="Avg Latency"
                    value={`${stats?.avg_response_ms ?? 0}ms`}
                    sub={stats?.top_user ? `Top: ${stats.top_user.name}` : undefined}
                    accent="sky"
                />
            </div>

            {stats?.top_user && (
                <div className="rounded-2xl border border-amber-200/60 dark:border-amber-700/40 bg-gradient-to-r from-amber-50/50 to-orange-50/50 dark:from-amber-950/20 dark:to-orange-950/20 p-3 sm:p-4">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-xl bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                            <Crown className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-[10px] sm:text-[11px] font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider">Top API User (24h)</p>
                            <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">{stats.top_user.name}</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{stats.top_user.email}</p>
                        </div>
                        <div className="text-right flex-shrink-0">
                            <p className="text-lg sm:text-xl font-semibold text-amber-600 dark:text-amber-400 tabular-nums">{stats.top_user.requests.toLocaleString()}</p>
                            <p className="text-[10px] text-slate-400">requests</p>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Feature Controls ────────────────────────────────────────── */}
            <div className="rounded-2xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-900 p-5">
                <div className="flex items-center gap-2 mb-4">
                    <Settings className="w-4 h-4 text-violet-500" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Feature Controls</h3>
                    <span className="text-xs text-slate-400 font-normal">Global API access settings</span>
                </div>
                <div className="flex flex-col sm:flex-row gap-6">
                    {/* Master toggle */}
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => setFeatureEnabled(e => !e)}
                            className={cn(
                                'flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-semibold transition-all',
                                featureEnabled
                                    ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
                                    : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400'
                            )}
                        >
                            {featureEnabled
                                ? <ToggleRight className="w-5 h-5" />
                                : <ToggleLeft className="w-5 h-5" />
                            }
                            API Access {featureEnabled ? 'Enabled' : 'Disabled'}
                        </button>
                    </div>

                    {/* Role allowlist */}
                    <div className="flex flex-col gap-2">
                        <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Allowed Roles</p>
                        <div className="flex flex-wrap gap-2">
                            {(['agent', 'dealer', 'subagent', 'customer', 'sub-admin', 'admin'] as const).map(role => (
                                <label key={role} className={cn(
                                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer select-none transition-all',
                                    allowedRoles.includes(role)
                                        ? 'bg-violet-50 dark:bg-violet-500/10 border-violet-200 dark:border-violet-500/30 text-violet-700 dark:text-violet-400'
                                        : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-400'
                                )}>
                                    <input
                                        type="checkbox"
                                        className="sr-only"
                                        checked={allowedRoles.includes(role)}
                                        onChange={() => toggleRole(role)}
                                    />
                                    {allowedRoles.includes(role)
                                        ? <Check className="w-3 h-3" />
                                        : <X className="w-3 h-3" />
                                    }
                                    {role}
                                </label>
                            ))}
                        </div>
                        <p className="text-[11px] text-slate-400">Only selected roles can generate and use API keys.</p>
                    </div>
                </div>

                <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2">
                    <Button
                        size="sm"
                        onClick={saveSettings}
                        disabled={settingsSaving}
                        className="h-8 text-xs font-semibold bg-violet-600 hover:bg-violet-700 text-white gap-1.5"
                    >
                        {settingsSaving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                        {settingsSaving ? 'Saving…' : 'Save Settings'}
                    </Button>
                    <p className="text-[11px] text-slate-400">Changes take effect immediately for new API requests.</p>
                </div>
            </div>

            {/* ── Tabs ───────────────────────────────────────────────────── */}
            <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-2xl w-fit">
                {([
                    { id: 'keys', label: 'API Keys', icon: Key },
                    { id: 'logs', label: 'Request Logs', icon: BarChart2 },
                ] as { id: Tab; label: string; icon: any }[]).map(t => {
                    const Icon = t.icon
                    return (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id)}
                            className={cn(
                                'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all',
                                tab === t.id
                                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                            )}
                        >
                            <Icon className="w-4 h-4" />
                            {t.label}
                            {t.id === 'keys' && pendingCount > 0 && (
                                <span className="bg-amber-500 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                                    {pendingCount}
                                </span>
                            )}
                        </button>
                    )
                })}
            </div>

            {/* ── Keys Tab ───────────────────────────────────────────────── */}
            {tab === 'keys' && (
                <div className="space-y-4">
                    {/* Filters */}
                    <div className="space-y-2.5">
                        {/* Search */}
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                            <input
                                type="text"
                                placeholder="Search by name, email, phone or key prefix…"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                className="w-full pl-10 pr-9 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/40 text-slate-900 dark:text-white placeholder:text-slate-400"
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    onClick={() => setSearchQuery('')}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                                    aria-label="Clear search"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            )}
                        </div>

                        {/* Status pills + Role + Sort */}
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 sm:gap-3">
                            {/* Status pills */}
                            <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl overflow-x-auto no-scrollbar">
                                {(['', 'pending', 'active', 'revoked'] as const).map(f => (
                                    <button
                                        key={f || 'all'}
                                        type="button"
                                        onClick={() => setStatusFilter(f)}
                                        className={cn(
                                            'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all capitalize whitespace-nowrap',
                                            statusFilter === f
                                                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                                : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                                        )}
                                    >
                                        {f || 'All'}
                                    </button>
                                ))}
                            </div>

                            <div className="flex gap-2 sm:ml-auto">
                                {/* Role filter */}
                                <div className="relative flex-1 sm:flex-initial">
                                    <select
                                        value={roleFilter}
                                        onChange={e => setRoleFilter(e.target.value)}
                                        aria-label="Filter by role"
                                        className="appearance-none pl-3 pr-8 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-500/40 cursor-pointer w-full"
                                    >
                                        <option value="">All Roles</option>
                                        <option value="agent">Agent</option>
                                        <option value="dealer">Dealer</option>
                                        <option value="customer">Customer</option>
                                        <option value="sub-admin">Sub-Admin</option>
                                        <option value="admin">Admin</option>
                                    </select>
                                    <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                                </div>

                                {/* Sort */}
                                <div className="relative flex-1 sm:flex-initial">
                                    <select
                                        value={sortBy}
                                        onChange={e => setSortBy(e.target.value as SortBy)}
                                        aria-label="Sort by"
                                        className="appearance-none pl-3 pr-8 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-500/40 cursor-pointer w-full"
                                    >
                                        <option value="recent">Newest</option>
                                        <option value="oldest">Oldest</option>
                                        <option value="requests">Most Requests</option>
                                        <option value="last_used">Last Used</option>
                                    </select>
                                    <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Key list */}
                    {isLoading ? (
                        <div className="space-y-3">
                            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-2xl" />)}
                        </div>
                    ) : filteredKeys.length === 0 ? (
                        <div className="text-center py-16 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                            <Shield className="w-12 h-12 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
                            <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">No API Keys Found</p>
                            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                                {statusFilter ? `No ${statusFilter} keys.` : 'No developers have generated API keys yet.'}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {filteredKeys.map(key => (
                                <KeyRow key={key.id} item={key} onAction={handleAction} />
                            ))}
                        </div>
                    )}

                    {/* Pagination */}
                    {pagination.total_pages > 1 && (
                        <div className="flex items-center justify-between pt-2">
                            <p className="text-xs text-slate-500">
                                Page {pagination.page} of {pagination.total_pages} · {pagination.total} keys
                            </p>
                            <div className="flex gap-2">
                                <Button variant="outline" size="sm" disabled={pagination.page <= 1}
                                    onClick={() => fetchKeys(pagination.page - 1)} className="h-8">
                                    <ChevronLeft className="w-4 h-4" />
                                </Button>
                                <Button variant="outline" size="sm" disabled={pagination.page >= pagination.total_pages}
                                    onClick={() => fetchKeys(pagination.page + 1)} className="h-8">
                                    <ChevronRight className="w-4 h-4" />
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Logs Tab ───────────────────────────────────────────────── */}
            {tab === 'logs' && <LogsTab />}
        </div>
    )
}
