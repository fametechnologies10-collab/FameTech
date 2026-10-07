'use client'

/**
 * KFT SMS — Buy Credits + Ledger History.
 * Wallet hero, premium bundle grid (business-mode pricing aware), idempotent
 * purchase flow (client-generated clientKey reused on retry), full credit
 * ledger with kind icons. Read spec: GET /api/sms/account, POST /api/sms/purchase.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { cn, formatCurrency } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import type { SmsLedgerKind, SmsAccountMode } from '@/lib/sms-platform-types'
import {
    MessageSquare, ArrowLeft, RefreshCcw, Loader2, Coins, Crown, Wallet,
    TrendingUp, TrendingDown, Gift, Send, Undo2, Settings2, Receipt,
    AlertCircle, ShieldAlert, Sparkles, Building2, Info, ShoppingBag,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

interface BundleRow {
    id: string
    name: string
    credits: number
    price: number
    business_price: number | null
}

interface LedgerRow {
    delta: number
    balance_after: number | null
    kind: SmsLedgerKind
    reference: string | null
    created_at: string
}

interface AccountData {
    account: {
        id: string
        mode: SmsAccountMode
        status: 'active' | 'suspended'
        suspended_reason?: string | null
        default_sender: string | null
    }
    wallet: { credits: number; total_purchased: number; total_used: number }
    ledger: LedgerRow[]
    bundles: BundleRow[]
}

/** One purchase attempt = one clientKey. The key is generated when the confirm
 *  sheet opens and REUSED on every retry of that same attempt, so a lost
 *  response / double-tap can never double-debit (idempotent server-side). */
interface BuyIntent {
    bundle: BundleRow
    clientKey: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
    const then = new Date(iso).getTime()
    if (Number.isNaN(then)) return ''
    const secs = Math.floor((Date.now() - then) / 1000)
    if (secs < 60) return 'just now'
    const mins = Math.floor(secs / 60)
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d ago`
    return new Date(iso).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' })
}

const KIND_META: Record<SmsLedgerKind, { label: string; icon: React.ElementType; iconClass: string; bgClass: string }> = {
    purchase:     { label: 'Bundle purchase',  icon: Coins,     iconClass: 'text-emerald-600 dark:text-emerald-400', bgClass: 'bg-emerald-100 dark:bg-emerald-900/30' },
    debit:        { label: 'Campaign send',    icon: Send,      iconClass: 'text-blue-600 dark:text-blue-400',       bgClass: 'bg-blue-100 dark:bg-blue-900/30' },
    refund:       { label: 'Refund',           icon: Undo2,     iconClass: 'text-purple-600 dark:text-purple-400',   bgClass: 'bg-purple-100 dark:bg-purple-900/30' },
    bonus:        { label: 'Bonus credits',    icon: Gift,      iconClass: 'text-amber-600 dark:text-amber-400',     bgClass: 'bg-amber-100 dark:bg-amber-900/30' },
    admin_adjust: { label: 'Admin adjustment', icon: Settings2, iconClass: 'text-gray-600 dark:text-gray-400',       bgClass: 'bg-gray-100 dark:bg-gray-800' },
}

/** Debit/refund ledger rows carry the campaign id in `reference`. */
function referenceLabel(row: LedgerRow): string | null {
    if (!row.reference) return null
    if (row.kind === 'debit' || row.kind === 'refund') {
        return `Campaign ${row.reference.slice(0, 8)}…`
    }
    return row.reference.length > 28 ? `${row.reference.slice(0, 28)}…` : row.reference
}

const fadeUp = {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SmsCreditsPage() {
    const [data, setData]           = useState<AccountData | null>(null)
    const [loading, setLoading]     = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)

    const [buyIntent, setBuyIntent]   = useState<BuyIntent | null>(null)
    const [purchasing, setPurchasing] = useState(false)
    const [needsTopUp, setNeedsTopUp] = useState(false)
    // Any non-402 purchase failure (bundle-mode mismatch, blocked account,
    // network error…) — a toast alone can be missed, so the exact reason is
    // also surfaced inline inside the confirm dialog, next to Pay & Add Credits.
    const [purchaseError, setPurchaseError] = useState<string | null>(null)

    const fetchAccount = useCallback(async () => {
        setLoadError(null)
        try {
            const res  = await fetch('/api/sms/account')
            const json = await res.json()
            if (!json.success) throw new Error(json.error || 'Failed to load your SMS account')
            setData(json.data)
        } catch (err: any) {
            setLoadError(err.message || 'Failed to load your SMS account')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { fetchAccount() }, [fetchAccount])

    // ── Derived ──────────────────────────────────────────────────────────────

    const isBusiness = data?.account.mode === 'business'
    const suspended  = data?.account.status === 'suspended'

    /** The price the purchase RPC actually charges for this account's mode. */
    const effectivePrice = useCallback((b: BundleRow): number => (
        isBusiness && b.business_price != null ? b.business_price : b.price
    ), [isBusiness])

    /** "Best value" goes on the biggest bundle. */
    const bestValueId = useMemo(() => {
        if (!data?.bundles.length) return null
        return data.bundles.reduce((max, b) => (b.credits > max.credits ? b : max), data.bundles[0]).id
    }, [data])

    // ── Buy flow ─────────────────────────────────────────────────────────────

    const openBuy = (bundle: BundleRow) => {
        setNeedsTopUp(false)
        setPurchaseError(null)
        // Fresh attempt → fresh idempotency key (retries inside this dialog reuse it).
        setBuyIntent({ bundle, clientKey: crypto.randomUUID() })
    }

    const handlePurchase = async () => {
        if (!buyIntent) return
        setPurchasing(true)
        setNeedsTopUp(false)
        setPurchaseError(null)
        try {
            const res  = await fetch('/api/sms/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bundleId: buyIntent.bundle.id, clientKey: buyIntent.clientKey }),
            })
            const json = await res.json()
            if (!json.success) {
                if (res.status === 402) {
                    setNeedsTopUp(true)
                    toast.error('Insufficient wallet balance — top up your main wallet')
                    return
                }
                if (res.status === 404) {
                    toast.error('That bundle is no longer available')
                    setBuyIntent(null)
                    await fetchAccount()
                    return
                }
                if (res.status === 403) {
                    toast.error(json.error || 'Your SMS account is suspended')
                    setBuyIntent(null)
                    await fetchAccount()
                    return
                }
                // Any other rejection (e.g. bundle-mode mismatch, rate limit,
                // server error) — keep the dialog open and show the exact
                // reason inline, not just as a toast that can be missed.
                const msg = json.error || 'Purchase failed'
                setPurchaseError(msg)
                toast.error(msg)
                return
            }
            toast.success(`${(json.data.credits_added as number).toLocaleString()} credits added — new balance ${(json.data.balance as number).toLocaleString()}`)
            setBuyIntent(null)
            await fetchAccount()
        } catch (err: any) {
            // Keep the dialog (and clientKey) so a retry of this attempt stays idempotent.
            const msg = err.message || 'Purchase failed — you can safely retry'
            setPurchaseError(msg)
            toast.error(msg)
        } finally {
            setPurchasing(false)
        }
    }

    // ── Loading skeleton ─────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="space-y-5 pb-20 md:pb-6 max-w-3xl mx-auto">
                <div className="space-y-2">
                    <Skeleton className="h-8 w-40" />
                    <Skeleton className="h-4 w-64" />
                </div>
                <Skeleton className="h-40 w-full rounded-2xl" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-44 rounded-2xl" />)}
                </div>
                <Skeleton className="h-64 w-full rounded-2xl" />
            </div>
        )
    }

    // ── Error state ──────────────────────────────────────────────────────────

    if (loadError || !data) {
        return (
            <div className="max-w-md mx-auto text-center py-20 space-y-4">
                <div className="w-14 h-14 mx-auto rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                    <AlertCircle className="w-6 h-6 text-red-500" />
                </div>
                <div>
                    <p className="font-semibold">Could not load your SMS credits</p>
                    <p className="text-sm text-muted-foreground mt-1">{loadError || 'Something went wrong.'}</p>
                </div>
                <Button
                    onClick={() => { setLoading(true); fetchAccount() }}
                    variant="outline"
                    className="h-10 gap-2"
                >
                    <RefreshCcw className="w-4 h-4" /> Try again
                </Button>
            </div>
        )
    }

    const { wallet, ledger, bundles } = data

    return (
        <div className="space-y-5 pb-20 md:pb-6 max-w-3xl mx-auto">

            {/* ── Header ── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                    <Link href="/dashboard/sms">
                        <Button variant="ghost" size="sm" className="w-fit gap-2 -ml-2 h-10 text-muted-foreground hover:text-emerald-600">
                            <ArrowLeft className="w-4 h-4" /> Back to KFT SMS
                        </Button>
                    </Link>
                    <h1 className="text-xl font-bold flex items-center gap-2 mt-1">
                        <Coins className="w-5 h-5 text-emerald-600" /> SMS Credits
                    </h1>
                    <p className="text-muted-foreground text-sm mt-0.5">Buy credit bundles from your main wallet. 1 credit = 1 SMS segment.</p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchAccount()}
                    className="gap-1.5 w-fit shrink-0 h-10"
                >
                    <RefreshCcw className="w-3.5 h-3.5" /> Refresh
                </Button>
            </div>

            {/* ── Suspended banner ── */}
            {suspended && (
                <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900">
                    <ShieldAlert className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-red-700 dark:text-red-400">
                        <p className="font-bold">Your SMS account is suspended</p>
                        <p className="mt-0.5">
                            {data.account.suspended_reason || 'Purchases and sending are disabled.'} Contact support if you believe this is a mistake.
                        </p>
                    </div>
                </div>
            )}

            {/* ── Wallet hero ── */}
            <motion.div {...fadeUp} transition={{ duration: 0.3 }}>
                <Card className="rounded-2xl border-0 overflow-hidden bg-gradient-to-br from-emerald-600 via-emerald-600 to-teal-700 text-white shadow-lg">
                    <CardContent className="p-5 sm:p-6 relative">
                        {/* Decorative glow */}
                        <div className="pointer-events-none absolute -top-16 -right-16 w-48 h-48 rounded-full bg-white/10 blur-2xl" />
                        <div className="pointer-events-none absolute -bottom-20 -left-10 w-40 h-40 rounded-full bg-teal-300/10 blur-2xl" />

                        <div className="relative flex items-start justify-between gap-3">
                            <div>
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-100/90 flex items-center gap-1.5">
                                    <MessageSquare className="w-3.5 h-3.5" /> Credit balance
                                </p>
                                <p className="text-4xl sm:text-5xl font-bold tabular-nums mt-1.5">
                                    {wallet.credits.toLocaleString()}
                                    <span className="text-base sm:text-lg font-semibold text-emerald-100/80 ml-2">SMS</span>
                                </p>
                            </div>
                            <span className={cn(
                                'inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full shrink-0',
                                isBusiness ? 'bg-white/20 text-white' : 'bg-black/15 text-emerald-50',
                            )}>
                                {isBusiness ? <Building2 className="w-3 h-3" /> : <Sparkles className="w-3 h-3" />}
                                {isBusiness ? 'Business mode' : 'Platform mode'}
                            </span>
                        </div>

                        <div className="relative grid grid-cols-2 gap-2.5 mt-5">
                            <div className="rounded-xl bg-white/10 backdrop-blur-sm px-3.5 py-2.5">
                                <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-100/80 flex items-center gap-1">
                                    <TrendingUp className="w-3 h-3" /> Total purchased
                                </p>
                                <p className="text-lg font-bold tabular-nums mt-0.5">{wallet.total_purchased.toLocaleString()}</p>
                            </div>
                            <div className="rounded-xl bg-white/10 backdrop-blur-sm px-3.5 py-2.5">
                                <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-100/80 flex items-center gap-1">
                                    <TrendingDown className="w-3 h-3" /> Total used
                                </p>
                                <p className="text-lg font-bold tabular-nums mt-0.5">{wallet.total_used.toLocaleString()}</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </motion.div>

            {/* ── Bundles ── */}
            <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold flex items-center gap-1.5">
                        <ShoppingBag className="w-4 h-4 text-emerald-500" /> Buy Credits
                    </h3>
                    <Link href="/dashboard/wallet" className="text-[11px] font-semibold text-emerald-600 hover:text-emerald-700 inline-flex items-center gap-1 h-10 px-1">
                        <Wallet className="w-3 h-3" /> Top up main wallet
                    </Link>
                </div>

                {bundles.length === 0 ? (
                    <Card className="rounded-2xl">
                        <CardContent className="py-10 text-center text-sm text-muted-foreground">
                            No bundles are available right now — check back soon.
                        </CardContent>
                    </Card>
                ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 sm:gap-3">
                        {bundles.map((b, i) => {
                            const price     = effectivePrice(b)
                            const perSms    = price / b.credits
                            const bestValue = b.id === bestValueId
                            const bizSaving = isBusiness && b.business_price != null && b.business_price < b.price
                            return (
                                <motion.div key={b.id} {...fadeUp} transition={{ duration: 0.2, delay: Math.min(i, 8) * 0.03 }}>
                                    <Card className={cn(
                                        'relative rounded-xl border shadow-sm transition-all hover:shadow-md h-full',
                                        bestValue
                                            ? 'border-emerald-300 dark:border-emerald-800 ring-1 ring-emerald-200 dark:ring-emerald-900'
                                            : 'hover:border-emerald-200 dark:hover:border-emerald-900',
                                    )}>
                                        {bestValue && (
                                            <span className="absolute -top-2 left-2.5 inline-flex items-center gap-0.5 text-[8px] sm:text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow">
                                                <Crown className="w-2.5 h-2.5" /> Best
                                            </span>
                                        )}
                                        <CardContent className="p-2.5 sm:p-3 flex flex-col gap-1.5 sm:gap-2 h-full">
                                            <div>
                                                <p className="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Messages</p>
                                                <p className="text-sm sm:text-base font-bold tabular-nums leading-tight">
                                                    {b.credits.toLocaleString()}
                                                </p>
                                            </div>

                                            <div className="mt-auto">
                                                <p className="text-xs sm:text-sm font-bold text-emerald-600 tabular-nums leading-tight">
                                                    {formatCurrency(price)}
                                                    {bizSaving && (
                                                        <span className="block text-[9px] font-medium text-muted-foreground line-through">{formatCurrency(b.price)}</span>
                                                    )}
                                                </p>
                                                <p className="text-[8px] sm:text-[9px] text-muted-foreground leading-tight">
                                                    ≈ GHS {perSms.toFixed(3)}/SMS
                                                    {bizSaving && <span className="text-emerald-600 font-semibold"> · biz</span>}
                                                </p>
                                                {!isBusiness && b.business_price != null && b.business_price < b.price && (
                                                    <p className="text-[8px] text-muted-foreground/70 leading-tight">
                                                        {formatCurrency(b.business_price)} biz mode
                                                    </p>
                                                )}
                                            </div>

                                            <Button
                                                onClick={() => openBuy(b)}
                                                disabled={suspended || purchasing}
                                                size="sm"
                                                className="w-full h-7 sm:h-8 text-[11px] sm:text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-1 px-2"
                                            >
                                                <Coins className="w-3 h-3" /> Buy
                                            </Button>
                                        </CardContent>
                                    </Card>
                                </motion.div>
                            )
                        })}
                    </div>
                )}

                <div className="flex items-start gap-2 text-[11px] text-muted-foreground rounded-xl bg-muted/40 border p-3">
                    <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span>
                        Bundles are paid from your <strong>main wallet</strong>. One credit covers one SMS segment
                        (160 characters); longer messages use more segments per recipient. Failed deliveries are refunded as credits.
                    </span>
                </div>
            </div>

            {/* ── Ledger ── */}
            <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.1 }}>
                <Card className="rounded-2xl overflow-hidden">
                    <CardContent className="p-0">
                        <div className="px-4 py-3 border-b">
                            <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                <Receipt className="w-4 h-4 text-emerald-500" /> Credit History
                            </h3>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                                Campaign send and Refund entries reference the campaign they belong to.
                            </p>
                        </div>

                        {ledger.length === 0 ? (
                            <div className="py-12 text-center space-y-2">
                                <div className="w-12 h-12 mx-auto rounded-full bg-muted flex items-center justify-center">
                                    <Receipt className="w-5 h-5 text-muted-foreground/60" />
                                </div>
                                <p className="text-xs text-muted-foreground">No transactions yet — buy your first bundle above.</p>
                            </div>
                        ) : (
                            <div className="divide-y">
                                {ledger.map((row, i) => {
                                    const meta   = KIND_META[row.kind] ?? KIND_META.admin_adjust
                                    const Icon   = meta.icon
                                    const credit = row.delta > 0
                                    const ref    = referenceLabel(row)
                                    return (
                                        <div key={`${row.created_at}-${i}`} className="px-4 py-3 flex items-center gap-3">
                                            <div className={cn('w-9 h-9 rounded-full flex items-center justify-center shrink-0', meta.bgClass)}>
                                                <Icon className={cn('w-4 h-4', meta.iconClass)} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs font-semibold">{meta.label}</p>
                                                <p className="text-[11px] text-muted-foreground truncate">
                                                    {ref ? <span className="font-mono">{ref}</span> : '—'}
                                                    <span className="mx-1">·</span>
                                                    {timeAgo(row.created_at)}
                                                </p>
                                            </div>
                                            <div className="text-right shrink-0">
                                                <p className={cn(
                                                    'text-sm font-bold tabular-nums',
                                                    credit ? 'text-emerald-600' : 'text-red-500',
                                                )}>
                                                    {credit ? '+' : ''}{row.delta.toLocaleString()}
                                                </p>
                                                {row.balance_after != null && (
                                                    <p className="text-[10px] text-muted-foreground tabular-nums">
                                                        bal {row.balance_after.toLocaleString()}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </motion.div>

            {/* ── Buy confirm (explicit-choice dialog, never native confirm) ── */}
            <Dialog open={!!buyIntent} onOpenChange={open => { if (!open && !purchasing) { setBuyIntent(null); setNeedsTopUp(false); setPurchaseError(null) } }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined} hideCloseButton>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Coins className="w-4 h-4 text-emerald-600" /> Confirm Purchase
                        </DialogTitle>
                    </DialogHeader>

                    {buyIntent && (
                        <div className="space-y-4">
                            <p className="text-sm text-muted-foreground">
                                Pay <strong className="text-foreground">{formatCurrency(effectivePrice(buyIntent.bundle))}</strong> from
                                your main wallet for <strong className="text-foreground">{buyIntent.bundle.credits.toLocaleString()} credits</strong>?
                            </p>

                            <div className="rounded-xl bg-muted/40 p-4 space-y-2.5 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Bundle</span>
                                    <span className="font-semibold">{buyIntent.bundle.name}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Credits</span>
                                    <span className="font-bold text-emerald-600 tabular-nums">{buyIntent.bundle.credits.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between border-t pt-2">
                                    <span className="text-muted-foreground">You pay</span>
                                    <span className="font-bold tabular-nums">{formatCurrency(effectivePrice(buyIntent.bundle))}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Paying from</span>
                                    <span className="font-semibold flex items-center gap-1"><Wallet className="w-3 h-3" /> Main Wallet</span>
                                </div>
                            </div>

                            {needsTopUp && (
                                <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 p-3 space-y-2.5">
                                    <p className="text-xs text-red-700 dark:text-red-400 font-semibold flex items-start gap-1.5">
                                        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                        Insufficient wallet balance for this bundle.
                                    </p>
                                    <Link href="/dashboard/wallet" className="block">
                                        <Button variant="outline" className="w-full h-10 gap-2 border-red-200 dark:border-red-900 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30">
                                            <Wallet className="w-4 h-4" /> Top up wallet
                                        </Button>
                                    </Link>
                                </div>
                            )}

                            {/* Any other purchase failure — exact server reason, always visible
                                (not just a toast) so a rejected purchase is never mysterious. */}
                            {purchaseError && !needsTopUp && (
                                <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 p-3">
                                    <p className="text-xs text-red-700 dark:text-red-400 font-semibold flex items-start gap-1.5">
                                        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                        {purchaseError}
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    <DialogFooter className="gap-2">
                        <Button
                            variant="ghost"
                            className="h-11"
                            disabled={purchasing}
                            onClick={() => { setBuyIntent(null); setNeedsTopUp(false) }}
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={handlePurchase}
                            disabled={purchasing || !buyIntent}
                            className="h-11 bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                        >
                            {purchasing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />}
                            {purchasing ? 'Processing…' : 'Pay & Add Credits'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </div>
    )
}
