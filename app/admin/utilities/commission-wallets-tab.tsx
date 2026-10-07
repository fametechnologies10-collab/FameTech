'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import { Loader2, Wallet, Users, Banknote, CheckCircle2, XCircle } from 'lucide-react'
import { toast } from '@/lib/toast'
import { formatCurrency } from '@/lib/utils'

interface CommissionWalletRow {
    id: string; owner_id: string; balance: number; total_earned: number; total_withdrawn: number
    email?: string; name?: string
}

// Status matters here: a `pending` withdrawal has not been sent yet and can
// still be approved or rejected. A `paystack_pending` withdrawal has already
// been handed to Paystack — money may be in flight — so it must NEVER be
// rejected (that would refund the user while Paystack still pays them out,
// a double payout) and should not be approved again either.
type WithdrawalStatus = 'pending' | 'paystack_pending'

interface PendingWithdrawal {
    id: string
    amount: number
    fee: number
    net_amount: number
    status: WithdrawalStatus
    momo_number: string
    network: string
    account_name: string
    created_at: string
    owner_id: string
    owner_email: string
    owner_name: string
}

const STATUS_LABEL: Record<WithdrawalStatus, string> = {
    pending: 'Pending',
    paystack_pending: 'In flight (Paystack)',
}

export default function CommissionWalletsTab() {
    const [wallets, setWallets] = useState<CommissionWalletRow[]>([])
    const [pending, setPending] = useState<PendingWithdrawal[]>([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState(false)
    const [confirmTx, setConfirmTx] = useState<{ id: string; action: 'approve' | 'reject'; withdrawal: PendingWithdrawal } | null>(null)
    const [processing, setProcessing] = useState(false)

    const load = useCallback(async () => {
        setLoading(true)
        setLoadError(false)
        try {
            const res = await fetch('/api/admin/commission-wallets').then(r => r.json())
            if (res.success) {
                setWallets(res.data.wallets)
                setPending(res.data.pending_withdrawals)
            } else {
                setLoadError(true)
                toast.error(res.error || 'Failed to load commission wallets')
            }
        } catch (e) {
            console.error('Failed to load commission wallets:', e)
            setLoadError(true)
            toast.error('Network error loading commission wallets')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const totalBalance = wallets.reduce((s, w) => s + w.balance, 0)
    const totalPaid = wallets.reduce((s, w) => s + w.total_withdrawn, 0)
    const pendingValue = pending.reduce((s, p) => s + p.amount, 0)

    const handleConfirm = async () => {
        if (!confirmTx) return
        setProcessing(true)
        try {
            const res = await fetch('/api/admin/commission-wallets', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: confirmTx.action, transaction_id: confirmTx.id }),
            })
            const data = await res.json()
            if (data.success) {
                toast.success(confirmTx.action === 'approve' ? 'Withdrawal approved and sent to Paystack' : 'Withdrawal rejected and refunded')
                setConfirmTx(null)
                load()
            } else {
                toast.error(data.error || 'Action failed')
                setConfirmTx(null)
                load()
            }
        } catch {
            toast.error('Action failed')
            setConfirmTx(null)
            load()
        } finally {
            setProcessing(false)
        }
    }

    if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>

    if (loadError) {
        return (
            <div className="rounded-xl border border-dashed py-16 text-center">
                <p className="text-sm text-muted-foreground mb-3">Could not load commission wallets.</p>
                <Button size="sm" variant="outline" onClick={load}>Retry</Button>
            </div>
        )
    }

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Card><CardContent className="p-3.5">
                    <div className="flex items-center gap-1.5 mb-1"><Wallet className="w-3.5 h-3.5 text-violet-500" /><p className="text-[11px] font-medium text-muted-foreground">Wallets</p></div>
                    <p className="text-lg font-bold">{wallets.length}</p>
                </CardContent></Card>
                <Card><CardContent className="p-3.5">
                    <div className="flex items-center gap-1.5 mb-1"><Banknote className="w-3.5 h-3.5 text-emerald-500" /><p className="text-[11px] font-medium text-muted-foreground">Outstanding balance</p></div>
                    <p className="text-lg font-bold">{formatCurrency(totalBalance)}</p>
                </CardContent></Card>
                <Card><CardContent className="p-3.5">
                    <div className="flex items-center gap-1.5 mb-1"><CheckCircle2 className="w-3.5 h-3.5 text-blue-500" /><p className="text-[11px] font-medium text-muted-foreground">Total paid out</p></div>
                    <p className="text-lg font-bold">{formatCurrency(totalPaid)}</p>
                </CardContent></Card>
                <Card><CardContent className="p-3.5">
                    <div className="flex items-center gap-1.5 mb-1"><Users className="w-3.5 h-3.5 text-amber-500" /><p className="text-[11px] font-medium text-muted-foreground">Pending withdrawals</p></div>
                    <p className="text-lg font-bold">{pending.length} <span className="text-xs font-normal text-muted-foreground">({formatCurrency(pendingValue)})</span></p>
                </CardContent></Card>
            </div>

            <Card>
                <CardHeader><CardTitle className="text-base">Pending Withdrawals</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                    {pending.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-6">No pending withdrawal requests.</p>
                    ) : pending.map((p) => {
                        const isActionable = p.status === 'pending'
                        return (
                            <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <p className="text-sm font-medium truncate">{p.account_name} — {p.network} {p.momo_number}</p>
                                        <Badge variant={isActionable ? 'pending' : 'processing'} className="text-[10px]">
                                            {STATUS_LABEL[p.status] ?? p.status}
                                        </Badge>
                                    </div>
                                    <p className="text-xs text-muted-foreground truncate">
                                        {p.owner_name || p.owner_email || 'Unknown owner'}
                                        {p.owner_name && p.owner_email ? ` · ${p.owner_email}` : ''}
                                    </p>
                                    <p className="text-xs text-muted-foreground">{new Date(p.created_at).toLocaleString('en-GB')}</p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <div className="text-right">
                                        <p className="text-sm font-semibold">{formatCurrency(p.amount)}</p>
                                        <p className="text-[10px] text-muted-foreground">requested amount</p>
                                        <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                                            Payout {formatCurrency(p.net_amount)} · fee {formatCurrency(p.fee)}
                                        </p>
                                    </div>
                                    {isActionable ? (
                                        <>
                                            <Button size="sm" variant="outline" className="h-8 text-emerald-600 border-emerald-300" onClick={() => setConfirmTx({ id: p.id, action: 'approve', withdrawal: p })}>
                                                <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Approve
                                            </Button>
                                            <Button size="sm" variant="outline" className="h-8 text-red-600 border-red-300" onClick={() => setConfirmTx({ id: p.id, action: 'reject', withdrawal: p })}>
                                                <XCircle className="w-3.5 h-3.5 mr-1" /> Reject
                                            </Button>
                                        </>
                                    ) : (
                                        <Button size="sm" variant="outline" className="h-8" disabled title="In flight with Paystack — resolved by reconciliation, not by this action">
                                            In flight — resolved by reconciliation
                                        </Button>
                                    )}
                                </div>
                            </div>
                        )
                    })}
                </CardContent>
            </Card>

            <Card>
                <CardHeader><CardTitle className="text-base">Wallets</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                    {wallets.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-6">No commission wallets yet.</p>
                    ) : wallets.map((w) => (
                        <div key={w.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                            <div className="min-w-0">
                                <p className="text-sm font-medium truncate">{w.name || w.email}</p>
                                <p className="text-xs text-muted-foreground">{w.email}</p>
                            </div>
                            <div className="text-right shrink-0 text-sm">
                                <p className="font-semibold">{formatCurrency(w.balance)}</p>
                                <p className="text-xs text-muted-foreground">Earned {formatCurrency(w.total_earned)} · Paid {formatCurrency(w.total_withdrawn)}</p>
                            </div>
                        </div>
                    ))}
                </CardContent>
            </Card>

            <Dialog open={!!confirmTx} onOpenChange={(open) => !open && setConfirmTx(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{confirmTx?.action === 'approve' ? 'Approve Withdrawal' : 'Reject Withdrawal'}</DialogTitle>
                        <DialogDescription>
                            {confirmTx?.action === 'approve'
                                ? `This sends a real Paystack Mobile Money transfer of ${confirmTx ? formatCurrency(confirmTx.withdrawal.net_amount) : ''} (net of ${confirmTx ? formatCurrency(confirmTx.withdrawal.fee) : ''} fee, from a ${confirmTx ? formatCurrency(confirmTx.withdrawal.amount) : ''} request) to the requested account. This cannot be undone.`
                                : 'This refunds the requested amount back to the user\'s commission wallet balance.'}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmTx(null)} disabled={processing}>Cancel</Button>
                        <Button onClick={handleConfirm} disabled={processing} className={confirmTx?.action === 'reject' ? 'bg-red-600 hover:bg-red-700' : ''}>
                            {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
