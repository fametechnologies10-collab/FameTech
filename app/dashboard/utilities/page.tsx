'use client'

/**
 * /dashboard/utilities — Utility Bills (ECG / Ghana Water / DSTV / GOtv / StarTimes).
 *
 * Layout: wallet hero → "Pay a bill" biller grid → Recent Payments with live
 * delivery timelines. Saved accounts are NOT shown here — entering the page
 * shows no accounts at all; tapping a specific biller opens its flow sheet,
 * which shows that biller's OWN saved accounts (SavedAccountsGrid) scoped to
 * just it, so each biller's sheet can present exactly the fields that matter
 * for it instead of one mixed, cramped cross-biller row.
 *
 * The feature ships dark (utility_bills_enabled='false'): with everything off
 * the page still renders gracefully, showing the full grid in coming-soon state.
 *
 * Polling: while the MOST RECENT order is pending/processing, history refreshes
 * every 5s, hard-capped at 2 minutes per order, and stops on unmount/tab-hide.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Lightbulb, Loader2, RefreshCw, Wallet, WifiOff } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { cn, formatCurrency } from '@/lib/utils'
import { UTILITY_BILLER_KEYS, UTILITY_BILLERS, type UtilityBiller } from '@/lib/hubtel-utility/billers'
import { BILLER_UI } from './biller-ui'
import { UtilityBillerLogo } from '@/components/utility-biller-logo'
import { UtilityHistory } from './UtilityHistory'
import { UtilityFlowSheet, toLocalPhone } from './UtilityFlowSheet'
import type { UtilityConfig, UtilityOrderRow, UtilityOrderStatus, UtilitySavedAccount } from './types'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'

const POLL_INTERVAL_MS = 5_000
const POLL_CAP_MS = 120_000

const TIME_PERIODS = ['Today', 'Yesterday', 'This Week', 'This Month', 'All time'] as const

const STATUS_OPTIONS: Array<{ value: 'all' | UtilityOrderStatus; label: string }> = [
    { value: 'all', label: 'All statuses' },
    { value: 'pending', label: 'Pending' },
    { value: 'processing', label: 'Processing' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' },
    { value: 'refunded', label: 'Refunded' },
]

// Every surface a utility order can come from — 'api' is included so API-purchased
// orders are visible right here; there is no separate API-dashboard tab.
const SOURCE_OPTIONS: Array<{ value: 'all' | string; label: string }> = [
    { value: 'all', label: 'All sources' },
    { value: 'dashboard', label: 'Dashboard' },
    { value: 'storefront', label: 'Storefront' },
    { value: 'api', label: 'API' },
    { value: 'ussd', label: 'USSD' },
    { value: 'ussd_shop', label: 'USSD (shop)' },
]

/** Count-up animation for the wallet hero (mirrors app/dashboard/data-packages/page.tsx). */
function useCountUp(target: number, duration = 900) {
    const [value, setValue] = useState(0)
    useEffect(() => {
        if (target === 0) { setValue(0); return }
        let rafId: number
        let startTime: number | null = null
        const step = (ts: number) => {
            if (!startTime) startTime = ts
            const progress = Math.min((ts - startTime) / duration, 1)
            const eased = 1 - Math.pow(1 - progress, 3)
            setValue(target * eased)
            if (progress < 1) rafId = requestAnimationFrame(step)
            else setValue(target)
        }
        rafId = requestAnimationFrame(step)
        return () => cancelAnimationFrame(rafId)
    }, [target, duration])
    return value
}

export default function UtilitiesPage() {
    const { dbUser } = useAuth()

    // ── Config ───────────────────────────────────────────────────────────────
    const [config, setConfig] = useState<UtilityConfig | null>(null)
    const [configLoading, setConfigLoading] = useState(true)
    const [configError, setConfigError] = useState(false)

    const loadConfig = useCallback(async () => {
        setConfigLoading(true)
        setConfigError(false)
        try {
            const res = await fetch('/api/utilities/config')
            const data = await res.json().catch(() => null)
            if (res.ok && data?.success && data.data) {
                setConfig(data.data as UtilityConfig)
            } else {
                setConfigError(true)
            }
        } catch {
            setConfigError(true)
        } finally {
            setConfigLoading(false)
        }
    }, [])

    // ── Wallet ───────────────────────────────────────────────────────────────
    const [walletBalance, setWalletBalance] = useState<number | null>(null)
    const animatedBalance = useCountUp(walletBalance ?? 0)

    const loadWallet = useCallback(async () => {
        if (!dbUser) return
        const { data } = await supabase
            .from('wallets')
            .select('balance')
            .eq('user_id', dbUser.id)
            .single()
        setWalletBalance(((data as any)?.balance as number) || 0)
    }, [dbUser])

    // ── Saved accounts (My Accounts) ─────────────────────────────────────────
    const [savedAccounts, setSavedAccounts] = useState<UtilitySavedAccount[]>([])

    const loadSaved = useCallback(async () => {
        try {
            const res = await fetch('/api/utilities/saved')
            const data = await res.json().catch(() => null)
            if (res.ok && data?.success) setSavedAccounts(data.data?.accounts ?? [])
        } catch { /* non-critical — row simply hides */ }
    }, [])

    // ── History ──────────────────────────────────────────────────────────────
    const [orders, setOrders] = useState<UtilityOrderRow[]>([])
    const [historyLoading, setHistoryLoading] = useState(true)
    const [historyError, setHistoryError] = useState(false)

    // ── History filters (biller / status / source / period) ───────────────────
    const [billerFilter, setBillerFilter] = useState<'all' | UtilityBiller>('all')
    const [statusFilter, setStatusFilter] = useState<'all' | UtilityOrderStatus>('all')
    const [sourceFilter, setSourceFilter] = useState<'all' | string>('all')
    const [periodFilter, setPeriodFilter] = useState<typeof TIME_PERIODS[number]>('Today')

    // Resolves the active time-period selection into concrete from/to bounds — adapted
    // from app/dashboard/my-orders/page.tsx's getDateBounds() to this page's own state
    // names and period set (no 'Custom' option here).
    const getDateBounds = useCallback(() => {
        const now = new Date()
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const yesterday = new Date(today)
        yesterday.setDate(yesterday.getDate() - 1)
        const weekStart = new Date(today)
        weekStart.setDate(weekStart.getDate() - weekStart.getDay())
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
        const epoch = new Date('2000-01-01')
        const farFuture = new Date('2100-01-01')

        switch (periodFilter) {
            case 'Today':
                return { from: today, to: farFuture }
            case 'Yesterday':
                return { from: yesterday, to: today }
            case 'This Week':
                return { from: weekStart, to: farFuture }
            case 'This Month':
                return { from: monthStart, to: farFuture }
            case 'All time':
            default:
                return { from: epoch, to: farFuture }
        }
    }, [periodFilter])

    const loadHistory = useCallback(async (silent = false) => {
        if (!silent) { setHistoryLoading(true); setHistoryError(false) }
        try {
            const { from, to } = getDateBounds()
            const params = new URLSearchParams({ limit: '20' })
            if (billerFilter !== 'all') params.set('biller', billerFilter)
            if (statusFilter !== 'all') params.set('status', statusFilter)
            if (sourceFilter !== 'all') params.set('source', sourceFilter)
            params.set('from', from.toISOString())
            params.set('to', to.toISOString())

            const res = await fetch(`/api/utilities/history?${params.toString()}`)
            const data = await res.json().catch(() => null)
            if (res.ok && data?.success) {
                setOrders(data.data?.orders ?? [])
                setHistoryError(false)
            } else if (!silent) {
                setHistoryError(true)
            }
        } catch {
            if (!silent) setHistoryError(true)
        } finally {
            if (!silent) setHistoryLoading(false)
        }
    }, [billerFilter, statusFilter, sourceFilter, getDateBounds])

    useEffect(() => {
        if (!dbUser) return
        loadConfig()
        loadWallet()
        loadSaved()
    }, [dbUser, loadConfig, loadWallet, loadSaved])

    // Re-fetch history whenever the filters change (including the initial load).
    useEffect(() => {
        if (!dbUser) return
        loadHistory()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dbUser, billerFilter, statusFilter, sourceFilter, periodFilter])

    // ── Bounded status polling ───────────────────────────────────────────────
    // Anchored to the most recent order id: each new pending order gets its own
    // fresh 2-minute window; the interval never runs unbounded or while hidden.
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const pollAnchorRef = useRef<string | null>(null)
    const pollDeadlineRef = useRef<number>(0)

    useEffect(() => {
        const stop = () => {
            if (pollTimerRef.current) {
                clearInterval(pollTimerRef.current)
                pollTimerRef.current = null
            }
        }

        const latest = orders[0]
        const active = !!latest && (latest.status === 'pending' || latest.status === 'processing')
        if (!active) {
            stop()
            pollAnchorRef.current = null
            return
        }

        if (pollAnchorRef.current !== latest.id) {
            pollAnchorRef.current = latest.id
            pollDeadlineRef.current = Date.now() + POLL_CAP_MS
        }

        const start = () => {
            if (pollTimerRef.current) return
            if (Date.now() >= pollDeadlineRef.current) return
            pollTimerRef.current = setInterval(() => {
                if (Date.now() >= pollDeadlineRef.current) { stop(); return }
                loadHistory(true)
            }, POLL_INTERVAL_MS)
        }

        const onVisibility = () => {
            if (document.hidden) stop()
            else start()
        }

        if (!document.hidden) start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
            document.removeEventListener('visibilitychange', onVisibility)
            stop()
        }
    }, [orders, loadHistory])

    // ── Flow sheet ───────────────────────────────────────────────────────────
    const [activeBiller, setActiveBiller] = useState<UtilityBiller | null>(null)
    const [sheetOpen, setSheetOpen] = useState(false)
    const accountInputRef = useRef<HTMLInputElement>(null)

    const featureOn = config?.enabled === true
    const billerOn = (k: UtilityBiller) => featureOn && config?.billers[k] === true

    const handleBillerTap = (biller: UtilityBiller) => {
        if (!billerOn(biller)) return
        setActiveBiller(biller)
        setSheetOpen(true)
        // Focus inside the tap gesture so iOS opens the keyboard.
        // Double rAF: first waits for React to flush, second for DOM commit.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => { accountInputRef.current?.focus() })
        })
    }

    const handlePurchased = (newBalance: number | null) => {
        if (typeof newBalance === 'number') setWalletBalance(newBalance)
        else loadWallet()
        loadHistory(true)
        loadSaved() // auto-save may have added a new account
    }

    const userPhone = toLocalPhone((dbUser as any)?.phone_number ?? '')

    // ─────────────────────────────────────────────────────────────────────────
    return (
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-5 pb-28">
            {/* Header */}
            <div className="min-w-0">
                <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
                    <Lightbulb className="w-5 h-5 text-amber-500 shrink-0" /> Utility bills
                </h1>
                <p className="text-xs text-muted-foreground mt-0.5">
                    Pay ECG, Ghana Water and TV subscriptions straight from your wallet
                </p>
            </div>

            {/* Wallet hero */}
            <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Wallet className="w-3.5 h-3.5 shrink-0" /> Wallet balance
                        </div>
                        <div className="text-2xl font-bold text-foreground tabular-nums truncate mt-0.5">
                            {walletBalance !== null ? formatCurrency(animatedBalance) : '—'}
                        </div>
                    </div>
                    {config && !featureOn && !configLoading && (
                        <span className="shrink-0 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                            Coming soon
                        </span>
                    )}
                </div>
            </div>

            {/* Config failed — the page can't offer payments without limits/gates */}
            {configError && !configLoading && (
                <div className="rounded-2xl border border-border bg-card p-5 flex flex-col items-center gap-3 text-center">
                    <WifiOff className="w-7 h-7 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">Could not load utility services.</p>
                    <button
                        type="button"
                        onClick={loadConfig}
                        className="text-sm font-semibold text-foreground hover:underline inline-flex items-center gap-1.5"
                    >
                        <RefreshCw className="w-3.5 h-3.5" /> Try again
                    </button>
                </div>
            )}

            {/* Pay a bill — biller grid */}
            {!configError && (
                <div className="space-y-2">
                    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground px-0.5">
                        Pay a bill
                    </p>
                    {configLoading ? (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                            {[0, 1, 2, 3, 4].map((i) => (
                                <div key={i} className="rounded-2xl border border-border bg-card p-4 animate-pulse h-[104px]">
                                    <div className="w-10 h-10 rounded-xl bg-muted mb-3" />
                                    <div className="h-3.5 w-3/5 rounded bg-muted" />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                            {UTILITY_BILLER_KEYS.map((key) => {
                                const def = UTILITY_BILLERS[key]
                                const ui = BILLER_UI[key]
                                const enabled = billerOn(key)
                                return (
                                    <button
                                        key={key}
                                        type="button"
                                        disabled={!enabled}
                                        onClick={() => handleBillerTap(key)}
                                        className={cn(
                                            'relative flex flex-col items-start gap-2.5 rounded-2xl border p-4 text-left transition-all',
                                            enabled
                                                ? 'border-border bg-card shadow-sm hover:shadow-md hover:-translate-y-0.5 active:scale-[0.97] cursor-pointer'
                                                : 'border-border/60 bg-card opacity-55 cursor-not-allowed'
                                        )}
                                    >
                                        <UtilityBillerLogo biller={key} FallbackIcon={ui.Icon} badgeClassName={ui.badge} size={60} />
                                        <div className="min-w-0 w-full">
                                            <p className="text-xs font-semibold leading-tight truncate">
                                                {key === 'ecg' ? 'ECG' : def.label}
                                            </p>
                                            <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                                                {enabled ? def.accountLabel : 'Coming soon'}
                                            </p>
                                        </div>
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* Recent payments */}
            <div className="space-y-2">
                <div className="flex items-center justify-between px-0.5">
                    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                        Recent payments
                    </p>
                    <button
                        type="button"
                        onClick={() => loadHistory()}
                        disabled={historyLoading}
                        className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                        aria-label="Refresh payments"
                    >
                        {historyLoading
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <RefreshCw className="w-4 h-4" />}
                    </button>
                </div>

                {/* Filters */}
                <div className="rounded-xl border border-border p-3 flex flex-wrap gap-2">
                    <Select value={billerFilter} onValueChange={(v) => setBillerFilter(v as 'all' | UtilityBiller)}>
                        <SelectTrigger className="w-auto min-w-[120px] flex-1 sm:flex-none text-xs h-8">
                            <SelectValue placeholder="Biller" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All billers</SelectItem>
                            {UTILITY_BILLER_KEYS.map((key) => (
                                <SelectItem key={key} value={key}>
                                    {key === 'ecg' ? 'ECG' : UTILITY_BILLERS[key].label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'all' | UtilityOrderStatus)}>
                        <SelectTrigger className="w-auto min-w-[120px] flex-1 sm:flex-none text-xs h-8">
                            <SelectValue placeholder="Status" />
                        </SelectTrigger>
                        <SelectContent>
                            {STATUS_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v)}>
                        <SelectTrigger className="w-auto min-w-[120px] flex-1 sm:flex-none text-xs h-8">
                            <SelectValue placeholder="Source" />
                        </SelectTrigger>
                        <SelectContent>
                            {SOURCE_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Select value={periodFilter} onValueChange={(v) => setPeriodFilter(v as typeof TIME_PERIODS[number])}>
                        <SelectTrigger className="w-auto min-w-[120px] flex-1 sm:flex-none text-xs h-8">
                            <SelectValue placeholder="Period" />
                        </SelectTrigger>
                        <SelectContent>
                            {TIME_PERIODS.map((p) => (
                                <SelectItem key={p} value={p}>{p}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <UtilityHistory
                    orders={orders}
                    loading={historyLoading && orders.length === 0}
                    error={historyError}
                    onRetry={() => loadHistory()}
                />
            </div>

            {/* Flow sheet */}
            {config && (
                <UtilityFlowSheet
                    biller={activeBiller}
                    open={sheetOpen}
                    onClose={() => setSheetOpen(false)}
                    config={config}
                    walletBalance={walletBalance}
                    userPhone={userPhone}
                    savedAccounts={savedAccounts}
                    onSavedAccountsChanged={loadSaved}
                    accountInputRef={accountInputRef}
                    onPurchased={handlePurchased}
                />
            )}
        </div>
    )
}
