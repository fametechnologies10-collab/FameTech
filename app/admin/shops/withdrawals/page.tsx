'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { formatCurrency, cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Banknote,
    ArrowLeft,
    AlertCircle,
    Clock,
    TrendingUp,
    Search,
    RefreshCw,
    ListChecks,
    History,
    BarChart3,
    Landmark,
    Smartphone,
    AlertTriangle,
    CheckSquare,
    Square,
} from 'lucide-react'
import { useAdminWithdrawals } from './_components/useAdminWithdrawals'
import { PayoutDialog } from './_components/PayoutDialog'
import { BulkActionBar } from './_components/BulkActionBar'
import { WithdrawalDetailSheet } from './_components/WithdrawalDetailSheet'
import { CreditAccountabilityLedger } from './_components/CreditAccountabilityLedger'
import type { WithdrawalRow } from './_components/types'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const QUEUE_STATUSES = new Set(['pending', 'moolre_pending', 'paystack_pending', 'failed'])
const AGE_24H_MS = 24 * 60 * 60 * 1000

type ActiveTab = 'queue' | 'history' | 'accountability'

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function statusLabel(status: WithdrawalRow['status']): string {
    const map: Record<WithdrawalRow['status'], string> = {
        pending: 'Pending',
        moolre_pending: 'Moolre Pending',
        paystack_pending: 'Paystack Pending',
        completed: 'Completed',
        failed: 'Failed',
        reversed: 'Reversed',
    }
    return map[status] ?? status
}

function statusBadgeCls(status: WithdrawalRow['status']): string {
    switch (status) {
        case 'completed':
            return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/40'
        case 'failed':
        case 'reversed':
            return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border border-red-200 dark:border-red-800/40'
        case 'moolre_pending':
        case 'paystack_pending':
            return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border border-blue-200 dark:border-blue-800/40'
        default:
            return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border border-amber-200 dark:border-amber-800/40'
    }
}

function borderAccentCls(status: WithdrawalRow['status']): string {
    switch (status) {
        case 'completed': return 'border-l-emerald-500'
        case 'failed': case 'reversed': return 'border-l-red-500'
        case 'moolre_pending': case 'paystack_pending': return 'border-l-blue-500'
        default: return 'border-l-amber-500'
    }
}

function isOlderThan24h(createdAt: string): boolean {
    return Date.now() - new Date(createdAt).getTime() > AGE_24H_MS
}

// ─────────────────────────────────────────────────────────────────────────────
// Row components (inline — no duplicated logic)
// ─────────────────────────────────────────────────────────────────────────────

interface QueueRowProps {
    row: WithdrawalRow
    selected: boolean
    onToggle: () => void
    onRowClick: () => void
    onPay: () => void
    inFlight: boolean
}

function QueueRow({ row, selected, onToggle, onRowClick, onPay, inFlight }: QueueRowProps) {
    const old = isOlderThan24h(row.created_at)
    return (
        <tr
            className={cn(
                'border-l-4 border-b transition-colors cursor-pointer',
                'hover:bg-muted/40',
                borderAccentCls(row.status),
                old && 'animate-pulse',
            )}
        >
            {/* Checkbox */}
            <td
                className="px-3 py-4"
                onClick={e => { e.stopPropagation(); onToggle() }}
            >
                {selected
                    ? <CheckSquare className="w-4 h-4 text-emerald-600" />
                    : <Square className="w-4 h-4 text-muted-foreground" />}
            </td>

            {/* Date */}
            <td className="px-4 py-4 text-xs text-muted-foreground" onClick={onRowClick}>
                {new Date(row.created_at).toLocaleDateString()}<br />
                {new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </td>

            {/* Shop */}
            <td className="px-4 py-4" onClick={onRowClick}>
                <p className="font-semibold text-sm">{row.shop.shop_name}</p>
                <p className="text-[10px] text-muted-foreground font-medium">{row.shop.owner_name}</p>
                <p className="text-[10px] text-muted-foreground">{row.shop.owner_phone}</p>
            </td>

            {/* Account */}
            <td className="px-4 py-4" onClick={onRowClick}>
                <p className="font-medium text-sm">
                    {row.account_name ?? '—'}
                    {row.name_unverified && (
                        <span className="ml-1.5 inline-flex items-center gap-0.5 text-[9px] font-bold uppercase bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded">
                            <AlertTriangle className="w-2.5 h-2.5" /> Unverified
                        </span>
                    )}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                    {row.payment_type === 'bank' ? row.account_number : row.momo_number}
                </p>
                <span className={cn(
                    'inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full mt-0.5',
                    row.payment_type === 'bank'
                        ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                        : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
                )}>
                    {row.payment_type === 'bank'
                        ? <><Landmark className="w-2.5 h-2.5" /> Bank</>
                        : <><Smartphone className="w-2.5 h-2.5" /> MoMo</>}
                </span>
            </td>

            {/* Net */}
            <td className="px-4 py-4 text-right font-black text-emerald-600 dark:text-emerald-400 text-lg" onClick={onRowClick}>
                {formatCurrency(row.net_amount ?? 0)}
                <p className="text-[10px] text-muted-foreground font-normal">
                    -{formatCurrency(row.fee ?? 0)} fee
                </p>
            </td>

            {/* Status */}
            <td className="px-4 py-4 text-center" onClick={onRowClick}>
                <span className={cn('text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider', statusBadgeCls(row.status))}>
                    {statusLabel(row.status)}
                </span>
            </td>

            {/* Pay button */}
            <td className="px-4 py-4 text-right">
                {QUEUE_STATUSES.has(row.status) && (
                    <Button
                        size="sm"
                        className="h-8 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs gap-1"
                        onClick={e => { e.stopPropagation(); onPay() }}
                        disabled={inFlight}
                    >
                        <Banknote className="w-3 h-3" /> Pay
                    </Button>
                )}
            </td>
        </tr>
    )
}

function QueueMobileCard({ row, selected, onToggle, onRowClick, onPay, inFlight }: QueueRowProps) {
    const old = isOlderThan24h(row.created_at)
    return (
        <div
            onClick={onRowClick}
            className={cn(
                'rounded-xl border-l-4 border bg-card shadow-sm overflow-hidden cursor-pointer',
                borderAccentCls(row.status),
                old && 'animate-pulse',
            )}
        >
            <div className="p-4 space-y-3">
                <div className="flex justify-between items-start">
                    <div className="flex items-center gap-2">
                        <span
                            onClick={e => { e.stopPropagation(); onToggle() }}
                            className="flex-shrink-0"
                        >
                            {selected
                                ? <CheckSquare className="w-4 h-4 text-emerald-600" />
                                : <Square className="w-4 h-4 text-muted-foreground" />}
                        </span>
                        <div>
                            <p className="font-bold text-sm">{row.shop.shop_name}</p>
                            <p className="text-xs text-muted-foreground">{row.shop.owner_name}</p>
                        </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                        <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider', statusBadgeCls(row.status))}>
                            {statusLabel(row.status)}
                        </span>
                    </div>
                </div>

                <div>
                    <p className="text-2xl font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
                        {formatCurrency(row.net_amount ?? 0)}
                    </p>
                    <p className="text-[10px] text-muted-foreground uppercase font-medium mt-0.5">
                        Gross {formatCurrency(row.amount)} · Fee {formatCurrency(row.fee ?? 0)}
                    </p>
                </div>

                <div className="bg-muted/50 rounded-lg p-2.5 space-y-1.5 text-xs">
                    <div className="flex justify-between">
                        <span className="text-[10px] font-bold uppercase text-muted-foreground">Account</span>
                        <span className="font-medium flex items-center gap-1">
                            {row.account_name ?? '—'}
                            {row.name_unverified && <AlertTriangle className="w-3 h-3 text-amber-500" />}
                        </span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-[10px] font-bold uppercase text-muted-foreground">
                            {row.payment_type === 'bank' ? 'Account No.' : 'MoMo'}
                        </span>
                        <span className="font-mono text-emerald-600 dark:text-emerald-400">
                            {row.payment_type === 'bank' ? row.account_number : row.momo_number}
                        </span>
                    </div>
                </div>

                {QUEUE_STATUSES.has(row.status) && (
                    <Button
                        size="sm"
                        className="w-full h-9 bg-emerald-600 hover:bg-emerald-700 text-white font-bold gap-2"
                        onClick={e => { e.stopPropagation(); onPay() }}
                        disabled={inFlight}
                    >
                        <Banknote className="w-4 h-4" /> Pay Now
                    </Button>
                )}
            </div>
        </div>
    )
}

// History row (no checkboxes, no pay button)
function HistoryRow({ row, onRowClick }: { row: WithdrawalRow; onRowClick: () => void }) {
    return (
        <tr
            className={cn('border-l-4 border-b transition-colors cursor-pointer hover:bg-muted/40', borderAccentCls(row.status))}
            onClick={onRowClick}
        >
            <td className="px-4 py-4 text-xs text-muted-foreground">
                {new Date(row.created_at).toLocaleDateString()}<br />
                {new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </td>
            <td className="px-4 py-4">
                <p className="font-semibold text-sm">{row.shop.shop_name}</p>
                <p className="text-[10px] text-muted-foreground">{row.shop.owner_name}</p>
            </td>
            <td className="px-4 py-4">
                <p className="font-medium text-sm">{row.account_name ?? '—'}</p>
                <p className="font-mono text-xs text-muted-foreground">
                    {row.payment_type === 'bank' ? row.account_number : row.momo_number}
                </p>
            </td>
            <td className="px-4 py-4 text-center">
                {row.payout_provider ? (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground uppercase">
                        {row.payout_provider}
                    </span>
                ) : <span className="text-muted-foreground text-xs">—</span>}
            </td>
            <td className="px-4 py-4 text-right font-bold text-sm tabular-nums">
                {formatCurrency(row.net_amount ?? 0)}
            </td>
            <td className="px-4 py-4 text-center">
                <span className={cn('text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider', statusBadgeCls(row.status))}>
                    {statusLabel(row.status)}
                </span>
            </td>
        </tr>
    )
}

function HistoryMobileCard({ row, onRowClick }: { row: WithdrawalRow; onRowClick: () => void }) {
    return (
        <div
            onClick={onRowClick}
            className={cn('rounded-xl border-l-4 border bg-card shadow-sm p-4 cursor-pointer space-y-2', borderAccentCls(row.status))}
        >
            <div className="flex justify-between items-start">
                <div>
                    <p className="font-bold text-sm">{row.shop.shop_name}</p>
                    <p className="text-xs text-muted-foreground">{row.shop.owner_name}</p>
                </div>
                <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider', statusBadgeCls(row.status))}>
                    {statusLabel(row.status)}
                </span>
            </div>
            <div className="flex justify-between items-center">
                <span className="text-lg font-black text-foreground tabular-nums">
                    {formatCurrency(row.net_amount ?? 0)}
                </span>
                {row.payout_provider && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground uppercase">
                        {row.payout_provider}
                    </span>
                )}
            </div>
            <p className="text-[10px] text-muted-foreground">
                {new Date(row.created_at).toLocaleString()}
            </p>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat cards
// ─────────────────────────────────────────────────────────────────────────────

function StatCards({ rows, total }: { rows: WithdrawalRow[]; total: number }) {
    const pendingRows = rows.filter(r => r.status === 'pending')
    const pendingCount = pendingRows.length
    const pendingAmount = pendingRows.reduce((s, r) => s + (r.net_amount ?? 0), 0)
    const totalOnPage = rows.reduce((s, r) => s + (r.net_amount ?? 0), 0)
    const failedCount = rows.filter(r => r.status === 'failed').length

    return (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-xl shadow-lg bg-gradient-to-br from-emerald-600 to-emerald-800 p-4 relative overflow-hidden text-white border border-white/10">
                <TrendingUp className="w-5 h-5 absolute top-4 right-4 opacity-50" />
                <p className="text-[10px] uppercase tracking-wider text-white/70 font-bold">Total Records</p>
                <p className="text-2xl font-black mt-1">{total}</p>
                <p className="text-xs text-white/60 mt-1">Across all pages</p>
            </div>
            <div className="rounded-xl shadow-lg bg-gradient-to-br from-amber-500 to-amber-700 p-4 relative overflow-hidden text-white border border-white/10">
                <Clock className="w-5 h-5 absolute top-4 right-4 opacity-50" />
                <p className="text-[10px] uppercase tracking-wider text-white/70 font-bold">Pending (this page)</p>
                <p className="text-2xl font-black mt-1">{pendingCount}</p>
                <p className="text-xs text-white/60 mt-1">Awaiting payment</p>
            </div>
            <div className="rounded-xl shadow-lg bg-gradient-to-br from-orange-500 to-red-600 p-4 relative overflow-hidden text-white border border-white/10">
                <AlertCircle className="w-5 h-5 absolute top-4 right-4 opacity-50" />
                <p className="text-[10px] uppercase tracking-wider text-white/70 font-bold">Pending Payout</p>
                <p className="text-2xl font-black mt-1">{formatCurrency(pendingAmount)}</p>
                <p className="text-xs text-white/60 mt-1">Net, this page</p>
            </div>
            <div className="rounded-xl shadow-lg bg-gradient-to-br from-blue-600 to-blue-800 p-4 relative overflow-hidden text-white border border-white/10">
                <Banknote className="w-5 h-5 absolute top-4 right-4 opacity-50" />
                <p className="text-[10px] uppercase tracking-wider text-white/70 font-bold">Page Net Total</p>
                <p className="text-2xl font-black mt-1">{formatCurrency(totalOnPage)}</p>
                <p className="text-xs text-white/60 mt-1">{failedCount} failed</p>
            </div>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminWithdrawalsPage() {
    const { dbUser, isAdmin } = useAuth()
    const router = useRouter()

    // ── Tab state ────────────────────────────────────────────────────────────
    const [activeTab, setActiveTab] = useState<ActiveTab>('queue')

    // ── Hook (single instance — tab drives filters.view) ────────────────────
    const {
        rows, total, loading, error,
        filters, setFilters,
        refresh, processOne, processBulk, inFlight,
    } = useAdminWithdrawals()

    // ── Dialog / Sheet state ─────────────────────────────────────────────────
    const [dialogRow, setDialogRow] = useState<WithdrawalRow | null>(null)
    const [dialogOpen, setDialogOpen] = useState(false)
    const [sheetRow, setSheetRow] = useState<WithdrawalRow | null>(null)
    const [sheetOpen, setSheetOpen] = useState(false)

    // ── Selection state (queue tab only) ────────────────────────────────────
    const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set())

    // ── Tab switch helper ────────────────────────────────────────────────────
    function switchTab(tab: ActiveTab) {
        setActiveTab(tab)
        setSelectedSet(new Set())
        if (tab === 'queue') {
            setFilters(f => ({ ...f, view: 'queue', status: 'all', page: 1 }))
        } else if (tab === 'history') {
            setFilters(f => ({ ...f, view: 'history', status: 'all', page: 1 }))
        }
        // accountability tab doesn't touch the hook filters
    }

    // ── Derived: eligible rows for selection (only queue-able statuses) ──────
    const eligibleRows = useMemo(
        () => rows.filter(r => QUEUE_STATUSES.has(r.status)),
        [rows],
    )
    const allEligibleSelected =
        eligibleRows.length > 0 && eligibleRows.every(r => selectedSet.has(r.id))

    function toggleRow(id: string) {
        setSelectedSet(prev => {
            const next = new Set(prev)
            next.has(id) ? next.delete(id) : next.add(id)
            return next
        })
    }

    function toggleAll() {
        if (allEligibleSelected) {
            setSelectedSet(new Set())
        } else {
            setSelectedSet(new Set(eligibleRows.map(r => r.id)))
        }
    }

    // ── Shop list derived from returned rows (for shop filter) ───────────────
    const shopOptions = useMemo(() => {
        const seen = new Map<string, string>()
        rows.forEach(r => {
            if (r.shop.owner_id) seen.set(r.shop.owner_id, r.shop.shop_name)
        })
        return Array.from(seen.entries()).map(([id, name]) => ({ id, name }))
    }, [rows])

    // ── Admin guard (after all hooks) ───────────────────────────────────────
    if (dbUser && !isAdmin) {
        router.replace('/dashboard')
        return null
    }

    return (
        <div className="space-y-6 pb-32">
            {/* ── Header ── */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <Link href="/admin/shops">
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                            <ArrowLeft className="w-4 h-4" />
                        </Button>
                    </Link>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Banknote className="w-6 h-6 text-emerald-600" />
                        Shop Finance
                    </h1>
                </div>

                {/* 3-way segmented control */}
                <div className="flex p-1 bg-muted rounded-xl gap-1 overflow-x-auto">
                    <Button
                        variant={activeTab === 'queue' ? 'default' : 'ghost'}
                        onClick={() => switchTab('queue')}
                        className={cn(
                            'h-9 rounded-lg px-4 text-xs font-bold transition-all whitespace-nowrap',
                            activeTab !== 'queue' && 'text-muted-foreground hover:text-foreground',
                        )}
                    >
                        <ListChecks className="w-3.5 h-3.5 mr-2" /> Payout Queue
                    </Button>
                    <Button
                        variant={activeTab === 'history' ? 'default' : 'ghost'}
                        onClick={() => switchTab('history')}
                        className={cn(
                            'h-9 rounded-lg px-4 text-xs font-bold transition-all whitespace-nowrap',
                            activeTab !== 'history' && 'text-muted-foreground hover:text-foreground',
                        )}
                    >
                        <History className="w-3.5 h-3.5 mr-2" /> History
                    </Button>
                    <Button
                        variant={activeTab === 'accountability' ? 'default' : 'ghost'}
                        onClick={() => switchTab('accountability')}
                        className={cn(
                            'h-9 rounded-lg px-4 text-xs font-bold transition-all whitespace-nowrap',
                            activeTab !== 'accountability' && 'text-muted-foreground hover:text-foreground',
                        )}
                    >
                        <BarChart3 className="w-3.5 h-3.5 mr-2" /> Profit Accountability
                    </Button>
                </div>
            </div>

            {/* ── Accountability tab — self-contained ── */}
            {activeTab === 'accountability' && (
                <CreditAccountabilityLedger />
            )}

            {/* ── Queue + History tabs share the hook ── */}
            {(activeTab === 'queue' || activeTab === 'history') && (
                <>
                    {/* Stat cards — pending stats are only meaningful on the queue tab */}
                    {activeTab === 'queue' && <StatCards rows={rows} total={total} />}

                    {/* Filters bar */}
                    <Card className="bg-muted/30 border-none shadow-none">
                        <CardContent className="p-4 flex flex-col md:flex-row gap-4 items-end">
                            {/* Search */}
                            <div className="flex-1 space-y-1.5">
                                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground ml-1">
                                    Search
                                </p>
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <Input
                                        placeholder="Account, MoMo number, shop…"
                                        value={filters.search}
                                        onChange={e => setFilters(f => ({ ...f, search: e.target.value, page: 1 }))}
                                        className="pl-9 h-10"
                                    />
                                </div>
                            </div>

                            {/* Provider (both tabs) */}
                            <div className="w-full md:w-44 space-y-1.5">
                                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground ml-1">
                                    Provider
                                </p>
                                <Select
                                    value={filters.provider}
                                    onValueChange={v => setFilters(f => ({ ...f, provider: v, page: 1 }))}
                                >
                                    <SelectTrigger className="h-10">
                                        <SelectValue placeholder="All Providers" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All Providers</SelectItem>
                                        <SelectItem value="moolre">Moolre</SelectItem>
                                        <SelectItem value="paystack">Paystack</SelectItem>
                                        <SelectItem value="manual">Manual</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            {/* Shop filter (derived from rows) */}
                            {shopOptions.length > 0 && (
                                <div className="w-full md:w-56 space-y-1.5">
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground ml-1">
                                        Shop
                                    </p>
                                    <Select
                                        value={filters.shopOwnerId}
                                        onValueChange={v => setFilters(f => ({ ...f, shopOwnerId: v, page: 1 }))}
                                    >
                                        <SelectTrigger className="h-10">
                                            <SelectValue placeholder="All Shops" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="all">All Shops</SelectItem>
                                            {shopOptions.map(s => (
                                                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            )}

                            {/* Refresh */}
                            <Button
                                variant="outline"
                                size="icon"
                                className="h-10 w-10 flex-shrink-0"
                                onClick={() => refresh()}
                                disabled={loading}
                                title="Refresh"
                            >
                                <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
                            </Button>
                        </CardContent>
                    </Card>

                    {/* Content area */}
                    <Card>
                        <CardContent className="p-0">
                            {/* Loading skeleton */}
                            {loading && (
                                <div className="p-8 space-y-4">
                                    <Skeleton className="h-12 w-full" />
                                    <Skeleton className="h-12 w-full" />
                                    <Skeleton className="h-12 w-full" />
                                    <Skeleton className="h-12 w-3/4" />
                                </div>
                            )}

                            {/* Error state */}
                            {!loading && error && (
                                <div className="flex flex-col items-center justify-center py-14 gap-3 text-destructive">
                                    <AlertCircle className="w-10 h-10 opacity-40" />
                                    <p className="font-semibold">{error}</p>
                                    <Button variant="outline" size="sm" onClick={() => refresh()}>
                                        <RefreshCw className="w-3.5 h-3.5 mr-2" /> Retry
                                    </Button>
                                </div>
                            )}

                            {/* Empty state */}
                            {!loading && !error && rows.length === 0 && (
                                <div className="flex flex-col items-center justify-center py-14 text-muted-foreground gap-3">
                                    <Banknote className="w-12 h-12 opacity-20" />
                                    <p className="text-sm">
                                        {activeTab === 'queue'
                                            ? 'No pending withdrawals.'
                                            : 'No completed withdrawals found.'}
                                    </p>
                                </div>
                            )}

                            {/* ── Payout Queue ── */}
                            {!loading && !error && rows.length > 0 && activeTab === 'queue' && (
                                <>
                                    {/* Desktop table */}
                                    <div className="hidden lg:block overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead className="bg-card border-b text-muted-foreground">
                                                <tr className="text-xs uppercase tracking-wider">
                                                    <th className="px-3 py-3">
                                                        <button onClick={toggleAll} className="flex items-center">
                                                            {allEligibleSelected
                                                                ? <CheckSquare className="w-4 h-4 text-emerald-600" />
                                                                : <Square className="w-4 h-4" />}
                                                        </button>
                                                    </th>
                                                    <th className="text-left px-4 py-3 font-medium">Date</th>
                                                    <th className="text-left px-4 py-3 font-medium">Shop</th>
                                                    <th className="text-left px-4 py-3 font-medium">Account</th>
                                                    <th className="text-right px-4 py-3 font-medium">Net Payout</th>
                                                    <th className="text-center px-4 py-3 font-medium">Status</th>
                                                    <th className="text-right px-4 py-3 font-medium">Action</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y">
                                                {rows.map(row => (
                                                    <QueueRow
                                                        key={row.id}
                                                        row={row}
                                                        selected={selectedSet.has(row.id)}
                                                        onToggle={() => toggleRow(row.id)}
                                                        onRowClick={() => { setSheetRow(row); setSheetOpen(true) }}
                                                        onPay={() => { setDialogRow(row); setDialogOpen(true) }}
                                                        inFlight={inFlight.includes(row.id)}
                                                    />
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>

                                    {/* Mobile cards */}
                                    <div className="lg:hidden space-y-3 p-4">
                                        {rows.map(row => (
                                            <QueueMobileCard
                                                key={row.id}
                                                row={row}
                                                selected={selectedSet.has(row.id)}
                                                onToggle={() => toggleRow(row.id)}
                                                onRowClick={() => { setSheetRow(row); setSheetOpen(true) }}
                                                onPay={() => { setDialogRow(row); setDialogOpen(true) }}
                                                inFlight={inFlight.includes(row.id)}
                                            />
                                        ))}
                                    </div>
                                </>
                            )}

                            {/* ── History ── */}
                            {!loading && !error && rows.length > 0 && activeTab === 'history' && (
                                <>
                                    {/* Desktop table */}
                                    <div className="hidden lg:block overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead className="bg-card border-b text-muted-foreground">
                                                <tr className="text-xs uppercase tracking-wider">
                                                    <th className="text-left px-4 py-3 font-medium">Date</th>
                                                    <th className="text-left px-4 py-3 font-medium">Shop</th>
                                                    <th className="text-left px-4 py-3 font-medium">Account</th>
                                                    <th className="text-center px-4 py-3 font-medium">Provider</th>
                                                    <th className="text-right px-4 py-3 font-medium">Net Payout</th>
                                                    <th className="text-center px-4 py-3 font-medium">Status</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y">
                                                {rows.map(row => (
                                                    <HistoryRow
                                                        key={row.id}
                                                        row={row}
                                                        onRowClick={() => { setSheetRow(row); setSheetOpen(true) }}
                                                    />
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>

                                    {/* Mobile cards */}
                                    <div className="lg:hidden space-y-3 p-4">
                                        {rows.map(row => (
                                            <HistoryMobileCard
                                                key={row.id}
                                                row={row}
                                                onRowClick={() => { setSheetRow(row); setSheetOpen(true) }}
                                            />
                                        ))}
                                    </div>
                                </>
                            )}

                            {/* Pagination footer */}
                            {!loading && !error && total > filters.pageSize && (
                                <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
                                    <span className="text-xs text-muted-foreground">
                                        {(filters.page - 1) * filters.pageSize + 1}–
                                        {Math.min(filters.page * filters.pageSize, total)} of {total}
                                    </span>
                                    <div className="flex gap-1">
                                        <Button
                                            variant="ghost" size="sm"
                                            disabled={filters.page <= 1}
                                            onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}
                                        >
                                            Prev
                                        </Button>
                                        <Button
                                            variant="ghost" size="sm"
                                            disabled={filters.page * filters.pageSize >= total}
                                            onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}
                                        >
                                            Next
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </>
            )}

            {/* ── PayoutDialog ── */}
            <PayoutDialog
                row={dialogRow}
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                onPaid={refresh}
                processOne={processOne}
            />

            {/* ── WithdrawalDetailSheet ── */}
            <WithdrawalDetailSheet
                row={sheetRow}
                open={sheetOpen}
                onOpenChange={setSheetOpen}
                processOne={processOne}
            />

            {/* ── BulkActionBar (queue tab only) ── */}
            {activeTab === 'queue' && (
                <BulkActionBar
                    selectedIds={[...selectedSet]}
                    rows={rows}
                    onClear={() => setSelectedSet(new Set())}
                    processBulk={processBulk}
                    busy={inFlight.length > 0}
                />
            )}
        </div>
    )
}
