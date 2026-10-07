'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { formatCurrency, cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
    ArrowLeft, TrendingUp, TrendingDown, Wallet, Loader2, RefreshCcw,
    CheckCircle2, Clock, Banknote, Package, Phone, FileText,
    MessageSquare, Zap, BarChart3, XCircle, ArrowDownLeft, ArrowUpRight, Smartphone, IdCard, Receipt
} from 'lucide-react'
import { toast } from '@/lib/toast'

type EntryType = 'data' | 'airtime' | 'rc' | 'afa' | 'withdrawal' | 'sms_bundle' | 'sms_activation' | 'utility_commission'

interface LedgerEntry {
    id: string
    kind: 'credit' | 'debit'
    entryType: EntryType
    label: string
    detail: string
    amount: number
    status: string
    created_at: string
    balanceAfter: number
    isUssd?: boolean
}

interface ShopWallet {
    balance: number
    total_earned: number
    total_withdrawn: number
}

type DateFilter = 'today' | '7d' | '30d' | 'all'
type KindFilter = 'all' | 'credit' | 'withdrawal' | 'sms'

// Profit is credited at payment time and is never reversed on 'failed' or 'refunded' — the shop
// owner keeps their margin either way (see lib/refund-service.ts) — so those statuses stay visible
// here too, instead of the credit silently vanishing from the owner's own ledger.
const EARNING_STATUSES = ['pending', 'processing', 'completed', 'failed', 'refunded']

const ENTRY_CONFIG: Record<EntryType, { icon: React.ElementType; color: string; bg: string }> = {
    data:           { icon: Package,       color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-100 dark:bg-emerald-900/30' },
    airtime:        { icon: Phone,         color: 'text-green-600 dark:text-green-400',     bg: 'bg-green-100 dark:bg-green-900/30' },
    rc:             { icon: FileText,      color: 'text-violet-600 dark:text-violet-400',   bg: 'bg-violet-100 dark:bg-violet-900/30' },
    afa:            { icon: IdCard,        color: 'text-teal-600 dark:text-teal-400',       bg: 'bg-teal-100 dark:bg-teal-900/30' },
    withdrawal:     { icon: ArrowUpRight,  color: 'text-blue-600 dark:text-blue-400',       bg: 'bg-blue-100 dark:bg-blue-900/30' },
    sms_bundle:     { icon: MessageSquare, color: 'text-purple-600 dark:text-purple-400',   bg: 'bg-purple-100 dark:bg-purple-900/30' },
    sms_activation: { icon: Zap,           color: 'text-amber-600 dark:text-amber-400',     bg: 'bg-amber-100 dark:bg-amber-900/30' },
    utility_commission: { icon: Receipt,   color: 'text-cyan-600 dark:text-cyan-400',       bg: 'bg-cyan-100 dark:bg-cyan-900/30' },
}

import React from 'react'

export default function ShopProfitLogsPage() {
    const [allEntries, setAllEntries] = useState<LedgerEntry[]>([])
    const [wallet, setWallet] = useState<ShopWallet | null>(null)
    const [loading, setLoading] = useState(true)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [filterDate, setFilterDate] = useState<DateFilter>('30d')
    const [kindFilter, setKindFilter] = useState<KindFilter>('all')

    useEffect(() => { fetchData() }, [])

    const fetchData = async () => {
        try {
            const res  = await fetch('/api/shop/profit-logs')
            const json = await res.json()
            if (!json.success) { setAllEntries([]); setLoading(false); return }

            const { wallet: walletRow, orders, rcOrders, afaOrders, withdrawals, smsPurchases, smsActs, utilityCommissions } = json.data

            if (walletRow) setWallet(walletRow)

            const raw: Omit<LedgerEntry, 'balanceAfter'>[] = [
                ...orders
                    .filter((o: any) => EARNING_STATUSES.includes(o.status) && (o.profit || 0) > 0)
                    .map((o: any) => ({
                        id: `ord-${o.id}`,
                        kind: 'credit' as const,
                        entryType: (o.package_id == null ? 'airtime' : 'data') as EntryType,
                        label: o.package_id == null ? `${o.network} Airtime` : `${o.network} ${o.package_size}`,
                        detail: o.guest_phone || '',
                        amount: o.profit || 0,
                        status: o.status,
                        created_at: o.created_at,
                        isUssd: o.source === 'ussd' || o.source === 'ussd_shop',
                    })),
                ...rcOrders
                    .filter((o: any) => EARNING_STATUSES.includes(o.status) && (o.shop_markup || 0) > 0)
                    .map((o: any) => ({
                        id: `rc-${o.id}`,
                        kind: 'credit' as const,
                        entryType: 'rc' as EntryType,
                        label: `${o.quantity}× ${o.type_name}`,
                        detail: o.customer_phone || '',
                        amount: (o.shop_markup || 0) * (o.quantity || 1),
                        status: o.status,
                        created_at: o.created_at,
                        isUssd: o.source === 'ussd' || o.source === 'ussd_shop',
                    })),
                ...(afaOrders || [])
                    .filter((o: any) => EARNING_STATUSES.includes(o.status) && (o.profit || 0) > 0)
                    .map((o: any) => ({
                        id: `afa-${o.id}`,
                        kind: 'credit' as const,
                        entryType: 'afa' as EntryType,
                        label: 'AFA Registration',
                        detail: o.phone || '',
                        amount: o.profit || 0,
                        status: o.status,
                        created_at: o.created_at,
                        isUssd: o.source === 'ussd' || o.source === 'ussd_shop',
                    })),
                ...withdrawals.map((w: any) => ({
                    id: `wd-${w.id}`,
                    kind: 'debit' as const,
                    entryType: 'withdrawal' as EntryType,
                    label: 'Withdrawal',
                    detail: [w.account_name, w.momo_number, w.fee ? `fee ${formatCurrency(w.fee)}` : ''].filter(Boolean).join(' · '),
                    amount: w.amount || 0,
                    status: w.status,
                    created_at: w.created_at,
                })),
                ...smsPurchases.map((s: any) => ({
                    id: `sms-${s.id}`,
                    kind: 'debit' as const,
                    entryType: 'sms_bundle' as EntryType,
                    label: s.shop_sms_bundles?.name || 'SMS Bundle',
                    detail: `${s.credits} credits purchased`,
                    amount: s.price || 0,
                    status: 'completed',
                    created_at: s.created_at,
                })),
                ...smsActs.map((a: any) => ({
                    id: `smsact-${a.id}`,
                    kind: 'debit' as const,
                    entryType: 'sms_activation' as EntryType,
                    label: 'SMS Activation',
                    detail: 'One-time feature unlock fee',
                    amount: a.amount_paid || 0,
                    status: 'completed',
                    created_at: a.created_at,
                })),
                ...(utilityCommissions || []).map((c: any) => ({
                    id: `utilcomm-${c.id}`,
                    kind: 'credit' as const,
                    entryType: 'utility_commission' as EntryType,
                    label: 'Utility Bill Commission',
                    detail: c.description || '',
                    amount: c.amount || 0,
                    status: 'completed',
                    created_at: c.created_at,
                })),
            ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

            // Compute running balance backwards from current wallet balance.
            // Newest entry → balanceAfter = current balance.
            // Each step back: undo the credit (subtract) or debit (add).
            let rb = walletRow?.balance ?? 0
            const withBalance: LedgerEntry[] = raw.map(entry => {
                const balanceAfter = rb
                rb = entry.kind === 'credit' ? rb - entry.amount : rb + entry.amount
                return { ...entry, balanceAfter }
            })

            setAllEntries(withBalance)
        } catch (err) {
            console.error('[ProfitLogs]', err)
            toast.error('Failed to load profit logs')
        } finally {
            setLoading(false)
        }
    }

    const handleRefresh = async () => {
        setIsRefreshing(true)
        await fetchData()
        setIsRefreshing(false)
        toast.success('Refreshed')
    }

    // ── Filtering (all client-side after first fetch) ──────────────────────────
    const floor: number | null = (() => {
        if (filterDate === 'today') return new Date().setHours(0, 0, 0, 0)
        if (filterDate === '7d')   return Date.now() - 7  * 86400000
        if (filterDate === '30d')  return Date.now() - 30 * 86400000
        return null
    })()

    const periodEntries = allEntries.filter(e => !floor || new Date(e.created_at).getTime() >= floor)

    const visible = periodEntries.filter(e => {
        if (kindFilter === 'credit')     return e.kind === 'credit'
        if (kindFilter === 'withdrawal') return e.entryType === 'withdrawal'
        if (kindFilter === 'sms')        return e.entryType === 'sms_bundle' || e.entryType === 'sms_activation'
        return true
    })

    const periodEarned    = periodEntries.filter(e => e.kind === 'credit').reduce((s, e) => s + e.amount, 0)
    const periodWithdrawn = periodEntries.filter(e => e.entryType === 'withdrawal').reduce((s, e) => s + e.amount, 0)
    const periodSmsSpend  = periodEntries.filter(e => e.entryType === 'sms_bundle' || e.entryType === 'sms_activation').reduce((s, e) => s + e.amount, 0)
    const periodNet       = periodEarned - periodWithdrawn - periodSmsSpend
    const hasSms          = allEntries.some(e => e.entryType === 'sms_bundle' || e.entryType === 'sms_activation')

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="space-y-5 pb-20 md:pb-6 max-w-4xl mx-auto">
            {/* ── Header ── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                    <Link href="/dashboard/shop">
                        <Button variant="ghost" size="sm" className="w-fit gap-2 -ml-2 text-muted-foreground hover:text-emerald-600">
                            <ArrowLeft className="w-4 h-4" /> Back to Shop Dashboard
                        </Button>
                    </Link>
                    <h1 className="text-xl font-bold flex items-center gap-2 mt-1">
                        <BarChart3 className="w-5 h-5 text-emerald-600" />
                        Profit Logs
                    </h1>
                    <p className="text-muted-foreground text-sm mt-0.5">
                        Full ledger — every earning, withdrawal and expense with running balance.
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing} className="gap-1.5 w-fit shrink-0">
                    <RefreshCcw className={cn('w-3.5 h-3.5', isRefreshing && 'animate-spin')} />
                    Refresh
                </Button>
            </div>

            {/* ── Primary stat cards ── */}
            <div className="space-y-2.5">
                {/* Wallet balance — full width */}
                <Card className="border shadow-sm rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border-emerald-200 dark:border-emerald-800">
                    <CardContent className="p-4 flex items-center justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-1.5 mb-1">
                                <Wallet className="w-3.5 h-3.5 text-emerald-600" />
                                <p className="text-[11px] text-emerald-700 dark:text-emerald-400 font-semibold uppercase tracking-wide">Profit Balance</p>
                            </div>
                            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">{formatCurrency(wallet?.balance ?? 0)}</p>
                        </div>
                        <div className="text-right shrink-0">
                            <p className="text-[10px] text-emerald-600/70 dark:text-emerald-500">Lifetime earned</p>
                            <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{formatCurrency(wallet?.total_earned ?? 0)}</p>
                            <p className="text-[10px] text-emerald-600/70 dark:text-emerald-500 mt-0.5">Lifetime withdrawn</p>
                            <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{formatCurrency(wallet?.total_withdrawn ?? 0)}</p>
                        </div>
                    </CardContent>
                </Card>

                {/* 3-col mini cards — always side-by-side including mobile */}
                <div className="grid grid-cols-3 gap-2">
                    <Card className="rounded-xl border shadow-sm">
                        <CardContent className="p-2.5 sm:p-3.5">
                            <div className="flex items-center gap-1 mb-1">
                                <TrendingUp className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-green-600 flex-shrink-0" />
                                <p className="text-[10px] sm:text-[11px] text-muted-foreground font-medium truncate">Earned</p>
                            </div>
                            <p className="text-sm sm:text-base font-bold tabular-nums text-green-600 truncate">{formatCurrency(periodEarned)}</p>
                            <p className="text-[10px] text-muted-foreground/60 mt-0.5 hidden sm:block">this period</p>
                        </CardContent>
                    </Card>

                    <Card className="rounded-xl border shadow-sm">
                        <CardContent className="p-2.5 sm:p-3.5">
                            <div className="flex items-center gap-1 mb-1">
                                <TrendingDown className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-blue-600 flex-shrink-0" />
                                <p className="text-[10px] sm:text-[11px] text-muted-foreground font-medium truncate">Withdrawn</p>
                            </div>
                            <p className="text-sm sm:text-base font-bold tabular-nums text-blue-600 truncate">{formatCurrency(periodWithdrawn)}</p>
                            <p className="text-[10px] text-muted-foreground/60 mt-0.5 hidden sm:block">this period</p>
                        </CardContent>
                    </Card>

                    <Card className={cn('rounded-xl border shadow-sm', periodNet < 0 && 'border-red-200 dark:border-red-900')}>
                        <CardContent className="p-2.5 sm:p-3.5">
                            <div className="flex items-center gap-1 mb-1">
                                <BarChart3 className={cn('w-3 h-3 sm:w-3.5 sm:h-3.5 flex-shrink-0', periodNet >= 0 ? 'text-emerald-600' : 'text-red-500')} />
                                <p className="text-[10px] sm:text-[11px] text-muted-foreground font-medium truncate">Net</p>
                            </div>
                            <p className={cn('text-sm sm:text-base font-bold tabular-nums truncate', periodNet >= 0 ? 'text-emerald-600' : 'text-red-500')}>
                                {periodNet >= 0 ? '+' : ''}{formatCurrency(periodNet)}
                            </p>
                            <p className="text-[10px] text-muted-foreground/60 mt-0.5 hidden sm:block">earned – expenses</p>
                        </CardContent>
                    </Card>
                </div>
            </div>

            {/* ── SMS expense mini-row (only if shop has SMS activity) ── */}
            {hasSms && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-purple-50 dark:bg-purple-900/10 border border-purple-100 dark:border-purple-900">
                    <MessageSquare className="w-4 h-4 text-purple-600 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-purple-800 dark:text-purple-300">SMS Expenses this period</p>
                        <p className="text-[11px] text-purple-600/70 dark:text-purple-400/70">Bundle purchases + activation fee</p>
                    </div>
                    <p className="text-sm font-bold text-purple-700 dark:text-purple-300 tabular-nums shrink-0">
                        {formatCurrency(periodSmsSpend)}
                    </p>
                </div>
            )}

            {/* ── Filters ── */}
            <div className="flex flex-wrap items-center gap-2">
                {/* Date filter */}
                <div className="flex bg-muted rounded-lg p-1">
                    {(['today', '7d', '30d', 'all'] as const).map(f => (
                        <button
                            key={f}
                            onClick={() => setFilterDate(f)}
                            className={cn(
                                'px-3 py-1.5 text-xs font-semibold rounded-md transition-all',
                                filterDate === f ? 'bg-white dark:bg-gray-800 shadow-sm text-emerald-600' : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {f === 'today' ? 'Today' : f === '7d' ? '7 Days' : f === '30d' ? '30 Days' : 'All Time'}
                        </button>
                    ))}
                </div>

                {/* Kind filter */}
                <div className="flex bg-muted rounded-lg p-1">
                    {([
                        { id: 'all', label: 'All' },
                        { id: 'credit', label: 'Earnings' },
                        { id: 'withdrawal', label: 'Withdrawals' },
                        ...(hasSms ? [{ id: 'sms', label: 'SMS' }] : []),
                    ] as const).map(f => (
                        <button
                            key={f.id}
                            onClick={() => setKindFilter(f.id as KindFilter)}
                            className={cn(
                                'px-3 py-1.5 text-xs font-semibold rounded-md transition-all',
                                kindFilter === f.id ? 'bg-white dark:bg-gray-800 shadow-sm text-emerald-600' : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>

                {visible.length > 0 && (
                    <span className="text-xs text-muted-foreground ml-auto">
                        {visible.length} entr{visible.length === 1 ? 'y' : 'ies'}
                    </span>
                )}
            </div>

            {/* ── Ledger ── */}
            <Card className="rounded-2xl overflow-hidden border shadow-sm">
                <CardContent className="p-0">
                    {visible.length === 0 ? (
                        <div className="text-center py-14 text-muted-foreground">
                            <BarChart3 className="w-9 h-9 mx-auto mb-2 opacity-20" />
                            <p className="text-sm font-medium">No entries for this filter.</p>
                            <p className="text-xs mt-1">Try changing the period or category.</p>
                        </div>
                    ) : (
                        <div className="divide-y divide-border/60">
                            {visible.map((entry) => {
                                const cfg = ENTRY_CONFIG[entry.entryType]
                                const EntryIcon = cfg.icon
                                const isCredit = entry.kind === 'credit'
                                const isPending = entry.status === 'pending' || entry.status === 'processing' || entry.status === 'moolre_pending'
                                const isFailed  = entry.status === 'failed' || entry.status === 'rejected'

                                return (
                                    <div key={entry.id} className="px-4 py-3.5 flex items-start justify-between gap-3 hover:bg-muted/30 transition-colors">
                                        {/* Left: icon + label */}
                                        <div className="flex items-start gap-3 min-w-0 flex-1">
                                            <div className={cn('w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5', cfg.bg)}>
                                                <EntryIcon className={cn('w-4 h-4', cfg.color)} />
                                            </div>
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-1.5 min-w-0">
                                                    <p className="font-semibold text-sm truncate leading-tight">{entry.label}</p>
                                                    {entry.isUssd && (
                                                        <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400 flex-shrink-0">
                                                            <Smartphone className="w-2.5 h-2.5" /> USSD
                                                        </span>
                                                    )}
                                                </div>
                                                {entry.detail && (
                                                    <p className="text-xs text-muted-foreground truncate mt-0.5">{entry.detail}</p>
                                                )}
                                                <div className="flex items-center gap-2 mt-1 flex-wrap">
                                                    <p className="text-[11px] text-muted-foreground/70">
                                                        {new Date(entry.created_at).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' })}
                                                        {' · '}
                                                        {new Date(entry.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                    </p>
                                                    <span className={cn(
                                                        'inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
                                                        isPending ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400'
                                                            : isFailed ? 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                                                            : 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                                                    )}>
                                                        {isPending ? <Clock className="w-2.5 h-2.5" />
                                                            : isFailed ? <XCircle className="w-2.5 h-2.5" />
                                                            : <CheckCircle2 className="w-2.5 h-2.5" />}
                                                        {entry.status.replace(/_/g, ' ')}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Right: amount + balance after */}
                                        <div className="text-right flex-shrink-0">
                                            <p className={cn(
                                                'font-bold text-sm tabular-nums flex items-center justify-end gap-1',
                                                isCredit ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-600 dark:text-slate-400'
                                            )}>
                                                {isCredit
                                                    ? <ArrowDownLeft className="w-3 h-3" />
                                                    : <ArrowUpRight className="w-3 h-3" />}
                                                {isCredit ? '+' : '−'}{formatCurrency(entry.amount)}
                                            </p>
                                            {/* Running balance after this transaction */}
                                            <p className="text-[11px] text-muted-foreground/70 tabular-nums mt-0.5">
                                                bal {formatCurrency(entry.balanceAfter)}
                                            </p>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* ── Ledger footnote ── */}
            {visible.length > 0 && (
                <p className="text-[11px] text-muted-foreground/60 text-center px-4">
                    "bal" = profit wallet balance immediately after each transaction.
                    Running balance is computed from your current balance of <strong>{formatCurrency(wallet?.balance ?? 0)}</strong>.
                </p>
            )}
        </div>
    )
}
