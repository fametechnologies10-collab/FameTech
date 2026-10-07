// app/dashboard/commission/page.tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    Loader2, ArrowRightLeft, Banknote, Clock, Percent, AlertTriangle, UserCheck, RotateCw,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { TransactionRow } from '@/components/dashboard/commission-transaction-row'

// Shared color code for any not-yet-credited/at-risk status badge across this page — completed/
// earned always renders green elsewhere (TYPE_META), this map is for everything that ISN'T that:
// in-flight (amber), and dead-with-no-payout (red). Order-status values are whatever each order
// table's own `status` column holds (pending/processing/queued/failed/cancelled/refunded/reversed).
const ORDER_STATUS_COLOR: Record<string, string> = {
    pending: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',
    processing: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',
    queued: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',
    paystack_pending: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',
    failed: 'text-red-600 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
    cancelled: 'text-red-600 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
    refunded: 'text-red-600 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
    reversed: 'text-red-600 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
}
const ORDER_STATUS_LABEL: Record<string, string> = {
    pending: 'Pending', processing: 'Processing', queued: 'Queued', paystack_pending: 'Processing',
    failed: 'Failed', cancelled: 'Cancelled', refunded: 'Refunded', reversed: 'Refunded',
}

/** Parses and validates a transfer amount against the available balance. Shared by the
 *  inline dialog feedback and the submit handler so both paths can never disagree. */
function validateTransferAmount(raw: string, balance: number): { amount: number; error: string | null } {
    const trimmed = raw.trim()
    const amount = Number(trimmed)
    if (trimmed === '') return { amount: 0, error: null }
    if (!Number.isFinite(amount) || amount <= 0) return { amount, error: 'Enter a valid amount' }
    if (amount > balance) return { amount, error: `Amount exceeds your available balance of ${formatCurrency(balance)}` }
    return { amount, error: null }
}

interface WalletData {
    has_wallet: boolean
    has_commission_key: boolean
    balance: number
    total_earned: number
    total_withdrawn: number
    has_shop_wallet: boolean
    has_active_sub_agents: boolean
}

export default function CommissionWalletPage() {
    const { dbUser } = useAuth()
    const [wallet, setWallet] = useState<WalletData | null>(null)
    const [transactions, setTransactions] = useState<any[]>([])
    const [pendingOrders, setPendingOrders] = useState<any[]>([])
    const [subAgentPending, setSubAgentPending] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    // Distinguishes the very first load (full-page spinner is correct — there's nothing
    // to show yet) from a manual refresh of already-loaded data (the page must stay put;
    // only the refresh icon should spin). Without this, clicking "Refresh" hit the same
    // `if (loading) return <spinner/>` gate as initial mount and blanked the whole page —
    // including the refresh button itself — on every refresh.
    const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
    const [walletError, setWalletError] = useState(false)
    const [transferOpen, setTransferOpen] = useState(false)
    const [transferDestination, setTransferDestination] = useState<'main' | 'shop'>('main')
    const [transferAmount, setTransferAmount] = useState('')
    const [transferring, setTransferring] = useState(false)

    const fetchAll = useCallback(async () => {
        if (!dbUser) return
        setLoading(true)
        setWalletError(false)
        try {
            const [walletRes, txRes] = await Promise.all([
                fetch('/api/commission/wallet').then(r => r.json()),
                fetch('/api/commission/transactions').then(r => r.json()),
            ])
            if (walletRes.success) {
                setWallet(walletRes.data)
            } else {
                setWallet(null)
                setWalletError(true)
            }
            if (txRes.success) {
                setTransactions(txRes.data.transactions)
                setPendingOrders(txRes.data.pending_orders)
                setSubAgentPending(txRes.data.sub_agent_pending || [])
            }
        } catch (e) {
            console.error('Error loading commission wallet:', e)
            setWallet(null)
            setWalletError(true)
        } finally {
            setLoading(false)
            setHasLoadedOnce(true)
        }
    }, [dbUser])

    useEffect(() => { fetchAll() }, [fetchAll])

    // Defensive: if the shop wallet disappears (or was never there) while 'shop' is
    // selected, fall back to 'main' rather than leaving the Select pointing at a
    // filtered-out option.
    useEffect(() => {
        if (transferDestination === 'shop' && !wallet?.has_shop_wallet) {
            setTransferDestination('main')
        }
    }, [wallet?.has_shop_wallet, transferDestination])

    const { amount: parsedTransferAmount, error: transferError } = validateTransferAmount(transferAmount, wallet?.balance ?? 0)
    const transferCanSubmit = transferAmount.trim() !== '' && !transferError && parsedTransferAmount > 0

    const openTransferDialog = () => {
        setTransferDestination('main')
        setTransferAmount('')
        setTransferOpen(true)
    }

    const handleTransfer = async () => {
        if (!transferCanSubmit) {
            toast.error(transferError || 'Enter a valid amount')
            return
        }
        setTransferring(true)
        try {
            const res = await fetch('/api/commission/transfer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ destination: transferDestination, amount: parsedTransferAmount }),
            })
            const data = await res.json()
            if (data.success) {
                toast.success(`Transferred ${formatCurrency(parsedTransferAmount)} to your ${transferDestination === 'main' ? 'main' : 'shop'} wallet`)
                setTransferOpen(false)
                setTransferAmount('')
                fetchAll()
            } else {
                toast.error(data.error || 'Transfer failed')
            }
        } catch {
            toast.error('Transfer failed')
        } finally {
            setTransferring(false)
        }
    }

    if (loading && !hasLoadedOnce) {
        return <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
    }

    // A manual refresh sets loading=true again but the page is already populated (and
    // walletError may be stale from before this refresh) — never blank a populated page
    // on refresh; the spinning refresh icon is the only affordance the user needs.
    if (walletError && !loading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6 px-4">
                <div className="w-20 h-20 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                    <AlertTriangle className="w-10 h-10 text-red-600 dark:text-red-400" />
                </div>
                <div>
                    <h2 className="text-2xl font-bold mb-2">Couldn't load your commission wallet</h2>
                    <p className="text-muted-foreground max-w-sm">
                        Something went wrong while fetching your commission balance. Your earnings are safe — try again.
                    </p>
                </div>
                <Button size="lg" onClick={fetchAll} className="gap-2">
                    Retry
                </Button>
            </div>
        )
    }

    // Show the "get a key" wall ONLY to users who have neither an approved commission key NOR any
    // existing wallet. A dashboard-sourced utility purchase by an agent/dealer credits
    // commission_wallets without any API key involved (see credit_commission_wallet's
    // source IN ('api','dashboard') claim), so gating on the key alone would hide real money from
    // the very users this branch was built to pay. An active recruited sub-agent also unlocks the
    // dashboard immediately, since recruiting one is itself a path to future commission earnings.
    if (!wallet?.has_commission_key && !wallet?.has_wallet && !wallet?.has_active_sub_agents) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6 px-4">
                <div className="w-20 h-20 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                    <Percent className="w-10 h-10 text-violet-600 dark:text-violet-400" />
                </div>
                <div>
                    <h2 className="text-2xl font-bold mb-2">No Commission Earnings Yet</h2>
                    <p className="text-muted-foreground max-w-sm">
                        Generate a Commission Services API key to pay utility bills (ECG, DSTV, Ghana Water and more)
                        and earn a share of the platform's commission on every payment.
                    </p>
                </div>
                <Link href="/dashboard/api">
                    <Button size="lg" className="bg-violet-600 hover:bg-violet-700 text-white gap-2">
                        Get a Commission Services Key
                    </Button>
                </Link>
            </div>
        )
    }

    return (
        <div className="p-4 md:p-6 space-y-6 max-w-4xl mx-auto">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-bold">Commission Wallet</h1>
                    <p className="text-muted-foreground text-sm">Earnings from Commission Services utility bill payments — separate from your shop wallet.</p>
                </div>
                <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={fetchAll}
                    disabled={loading}
                    title="Refresh"
                    aria-label="Refresh"
                >
                    <RotateCw className={cn('w-4 h-4', loading && 'animate-spin')} />
                </Button>
            </div>

            <div className="rounded-2xl bg-gradient-to-br from-violet-700 to-violet-900 p-5 text-white shadow-md">
                <p className="text-violet-200 text-xs font-medium mb-1">Commission Balance</p>
                <p className="text-3xl font-bold tabular-nums">{formatCurrency(wallet.balance)}</p>
                <div className="flex gap-4 mt-2 text-[11px] text-violet-200/90">
                    <span>Earned: {formatCurrency(wallet.total_earned)}</span>
                    <span>Withdrawn: {formatCurrency(wallet.total_withdrawn)}</span>
                </div>
                <div className="flex gap-2 mt-4">
                    <Button
                        size="sm"
                        className="flex-1 bg-white text-violet-700 hover:bg-violet-50 font-semibold disabled:opacity-60"
                        onClick={openTransferDialog}
                        disabled={wallet.balance <= 0}
                    >
                        <ArrowRightLeft className="w-4 h-4 mr-1.5" /> Transfer
                    </Button>
                    <Link href="/dashboard/commission/withdraw" className="flex-1">
                        <Button size="sm" className="w-full bg-white/10 border border-white/30 hover:bg-white/20 text-white font-semibold">
                            <Banknote className="w-4 h-4 mr-1.5" /> Withdraw
                        </Button>
                    </Link>
                </div>
            </div>

            {pendingOrders.length > 0 && (
                <Card>
                    <CardHeader><CardTitle className="text-base flex items-center gap-2"><Clock className="w-4 h-4 text-amber-500" /> Pending Commission</CardTitle></CardHeader>
                    <CardContent className="space-y-2">
                        <p className="text-xs text-muted-foreground mb-2">These orders haven't completed yet — no commission has been credited.</p>
                        {pendingOrders.map((o) => (
                            <div key={o.id} className="text-sm border rounded-lg p-2.5 space-y-1">
                                <div className="flex items-center justify-between">
                                    {o.product === 'airtime' ? (
                                        <span className="capitalize">Airtime — {String(o.network).replace('_', ' ')} — {formatCurrency(Number(o.amount))}</span>
                                    ) : (
                                        <span className="capitalize">{o.biller.replace('_', ' ')} — bill amount {formatCurrency(Number(o.amount))}</span>
                                    )}
                                    <Badge variant="outline" className="text-[10px] capitalize">{o.status}</Badge>
                                </div>
                                <p className="text-[11px] text-muted-foreground">
                                    Commission is calculated when this completes (your share: {o.commission_share_percent_estimate}% of the platform commission).
                                </p>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            )}

            {subAgentPending.length > 0 && (
                <Card>
                    <CardHeader><CardTitle className="text-base flex items-center gap-2"><UserCheck className="w-4 h-4 text-amber-500" /> Sub-Agent Orders Awaiting Credit</CardTitle></CardHeader>
                    <CardContent className="space-y-2">
                        <p className="text-xs text-muted-foreground mb-2">
                            Sales from your sub-agents that haven't been credited to you yet — shown here for transparency, no amount has moved.
                        </p>
                        {subAgentPending.map((o) => {
                            const statusKey = o.order_status || 'pending'
                            return (
                                <div key={o.id} className="text-sm border rounded-lg p-2.5 flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate">{o.item_detail || 'Sub-agent order'}</p>
                                        <p className="text-xs text-muted-foreground">{formatDate(o.created_at)}</p>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <p className="text-sm font-semibold tabular-nums">{formatCurrency(Number(o.amount))}</p>
                                        <Badge
                                            variant="outline"
                                            className={cn('text-[10px] mt-0.5', ORDER_STATUS_COLOR[statusKey] || ORDER_STATUS_COLOR.pending)}
                                        >
                                            {ORDER_STATUS_LABEL[statusKey] || statusKey}
                                        </Badge>
                                    </div>
                                </div>
                            )
                        })}
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                    {transactions.length === 0 ? (
                        <p className="text-center py-10 text-sm text-muted-foreground">No movements yet.</p>
                    ) : (
                        <>
                            {transactions.slice(0, 10).map((r) => <TransactionRow key={r.id} r={r} />)}
                            {transactions.length > 10 && (
                                <Link
                                    href="/dashboard/commission/history"
                                    className="block text-center text-sm font-medium text-violet-600 hover:text-violet-700 pt-2"
                                >
                                    View all history
                                </Link>
                            )}
                        </>
                    )}
                </CardContent>
            </Card>

            <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
                <DialogContent>
                    <DialogHeader><DialogTitle>Transfer Commission</DialogTitle></DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>Destination</Label>
                            <Select value={transferDestination} onValueChange={(v) => setTransferDestination(v as 'main' | 'shop')}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="main">Main Wallet</SelectItem>
                                    {wallet.has_shop_wallet && <SelectItem value="shop">Shop Wallet</SelectItem>}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <Label>Amount (GHS)</Label>
                                <span className="text-xs text-muted-foreground">Available: {formatCurrency(wallet.balance)}</span>
                            </div>
                            <Input type="number" value={transferAmount} onChange={(e) => setTransferAmount(e.target.value)} placeholder="0.00" />
                            {transferError && (
                                <p className="text-xs text-red-600">{transferError}</p>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">Instant, no fee.</p>
                    </div>
                    <DialogFooter>
                        <Button onClick={handleTransfer} disabled={transferring || !transferCanSubmit}>
                            {transferring ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Transfer'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
