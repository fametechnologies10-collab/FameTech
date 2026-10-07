'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/lib/toast'
import { Loader2, RefreshCw, Wallet, Smartphone, CheckCircle2, AlertTriangle } from 'lucide-react'

// =============================================================================
// Admin USSD Refund Queue (P0-6)
// Failed-but-paid USSD orders the team must refund (Option B: Hubtel always told
// 'success', so it never auto-refunds). MoMo = mark refunded after paying out;
// wallet = one-click credit-to-wallet (idempotent).
// =============================================================================

interface RefundRow {
    id: string
    session_id: string
    mobile: string
    service_type: 'data' | 'results_checker' | 'afa'
    amount: number
    payment_method: 'momo' | 'wallet'
    hubtel_order_id: string | null
    user_id: string | null
    reason: string | null
    created_at: string
}

const SERVICE_LABEL: Record<string, string> = {
    data: 'Data Bundle',
    results_checker: 'Results Checker',
    afa: 'AFA Registration',
}

export default function USSDRefundsPage() {
    const [rows, setRows] = useState<RefundRow[]>([])
    const [loading, setLoading] = useState(true)
    const [busyId, setBusyId] = useState<string | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/admin/ussd-refunds', { cache: 'no-store' })
            const json = await res.json()
            if (!res.ok) throw new Error(json?.error || 'Failed to load')
            setRows(json.data ?? [])
        } catch (err: any) {
            toast.error(err?.message || 'Failed to load refunds')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const resolve = useCallback(async (row: RefundRow) => {
        const verb = row.payment_method === 'wallet' ? 'Refund to wallet' : 'Mark as refunded'
        if (!window.confirm(`${verb}: GHS ${Number(row.amount).toFixed(2)} for ${row.mobile}?`)) return
        setBusyId(row.id)
        try {
            const res = await fetch('/api/admin/ussd-refunds', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: row.id }),
            })
            const json = await res.json()
            if (!res.ok) throw new Error(json?.error || 'Action failed')
            toast.success(row.payment_method === 'wallet' ? 'Wallet credited' : 'Marked refunded')
            setRows((prev) => prev.filter((r) => r.id !== row.id))
        } catch (err: any) {
            toast.error(err?.message || 'Action failed')
            load()
        } finally {
            setBusyId(null)
        }
    }, [load])

    const totalPending = rows.reduce((s, r) => s + Number(r.amount), 0)

    return (
        <div className="space-y-6 p-4 md:p-6">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-bold">USSD Refund Queue</h1>
                    <p className="text-sm text-muted-foreground">
                        Paid USSD orders that failed to deliver. Refund the customer, then clear it.
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={load} disabled={loading}>
                    <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                </Button>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Pending refunds: {rows.length}</CardTitle>
                    <CardDescription>Total owed: GHS {totalPending.toFixed(2)}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    {loading ? (
                        <div className="flex items-center justify-center py-12 text-muted-foreground">
                            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
                        </div>
                    ) : rows.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                            <CheckCircle2 className="h-8 w-8 mb-2 text-green-500" />
                            No pending refunds. 🎉
                        </div>
                    ) : (
                        rows.map((row) => (
                            <div
                                key={row.id}
                                className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <span className="font-semibold">{row.mobile}</span>
                                        <Badge variant={row.payment_method === 'wallet' ? 'secondary' : 'outline'}>
                                            {row.payment_method === 'wallet' ? (
                                                <><Wallet className="h-3 w-3 mr-1" /> Wallet</>
                                            ) : (
                                                <><Smartphone className="h-3 w-3 mr-1" /> MoMo</>
                                            )}
                                        </Badge>
                                        <Badge variant="outline">{SERVICE_LABEL[row.service_type] ?? row.service_type}</Badge>
                                    </div>
                                    <div className="text-lg font-bold">GHS {Number(row.amount).toFixed(2)}</div>
                                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                        <AlertTriangle className="h-3 w-3" />
                                        {row.reason || 'fulfillment failed'} · {new Date(row.created_at).toLocaleString()}
                                    </div>
                                </div>
                                <Button
                                    onClick={() => resolve(row)}
                                    disabled={busyId === row.id}
                                    className="shrink-0"
                                >
                                    {busyId === row.id ? (
                                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                    ) : row.payment_method === 'wallet' ? (
                                        <Wallet className="h-4 w-4 mr-2" />
                                    ) : (
                                        <CheckCircle2 className="h-4 w-4 mr-2" />
                                    )}
                                    {row.payment_method === 'wallet' ? 'Refund to wallet' : 'Mark refunded'}
                                </Button>
                            </div>
                        ))
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
