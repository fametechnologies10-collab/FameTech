'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, RotateCcw, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import { format, parseISO } from 'date-fns'
import { UTILITY_BILLERS, type UtilityBiller } from '@/lib/hubtel-utility/billers'

interface QueueRow {
    id: string
    utility_order_id: string
    source: string
    biller: UtilityBiller
    amount: number
    momo_number: string | null
    shop_id: string | null
    reason: string | null
    status: string
    created_at: string
}

function fmtDate(iso: string) {
    try { return format(parseISO(iso), 'MMM d, yyyy · p') } catch { return iso }
}

export default function RefundQueueTab() {
    const [rows, setRows] = useState<QueueRow[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)
    const [confirmRow, setConfirmRow] = useState<QueueRow | null>(null)
    const [busy, setBusy] = useState(false)

    const load = useCallback(async () => {
        setLoading(true); setError(false)
        try {
            const res = await fetch('/api/admin/utility-refunds')
            const d = await res.json().catch(() => ({}))
            if (!d.success) { setError(true); toast.error(d.error || 'Failed to load refund queue'); return }
            setRows(d.data || [])
        } catch {
            setError(true); toast.error('Network error loading refund queue')
        } finally {
            setLoading(false)
        }
    }, [])
    useEffect(() => { load() }, [load])

    async function resolve(row: QueueRow) {
        setBusy(true)
        try {
            const res = await fetch('/api/admin/utility-refunds', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: row.id }),
            })
            const d = await res.json().catch(() => ({}))
            if (!d.success) { toast.error(d.error || 'Failed to mark refunded'); return }
            toast.success('Marked refunded')
            setConfirmRow(null)
            load()
        } catch {
            toast.error('Network error')
        } finally {
            setBusy(false)
        }
    }

    if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-emerald-500" /></div>
    if (error) return (
        <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 py-16 text-center">
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">Could not load the refund queue.</p>
            <Button size="sm" variant="outline" onClick={load}><RefreshCw className="w-4 h-4 mr-2" /> Retry</Button>
        </div>
    )
    if (rows.length === 0) return (
        <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 py-24 text-center px-4">
            <Package className="w-10 h-10 mx-auto mb-3 text-slate-300 dark:text-slate-700" />
            <p className="text-sm font-semibold text-slate-900 dark:text-white">No refunds waiting</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Guest and shop-attributed refunds that can't be one-click wallet-credited land here.</p>
        </div>
    )

    return (
        <>
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                            <tr>
                                {['Queued', 'Biller', 'Source', 'Contact phone', 'Amount', ''].map((h) => (
                                    <th key={h} className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap">{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {rows.map((r) => (
                                <tr key={r.id}>
                                    <td className="px-3 py-2.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                                    <td className="px-3 py-2.5">{UTILITY_BILLERS[r.biller]?.label ?? r.biller}</td>
                                    <td className="px-3 py-2.5 text-xs">{r.source}</td>
                                    <td className="px-3 py-2.5">
                                        <div className="font-mono text-xs">{r.momo_number || '—'}</div>
                                        {r.reason && (
                                            <div className="text-[11px] text-amber-600 dark:text-amber-500 mt-0.5 max-w-[260px] whitespace-normal">{r.reason}</div>
                                        )}
                                    </td>
                                    <td className="px-3 py-2.5 font-semibold tabular-nums">GHS {Number(r.amount).toFixed(2)}</td>
                                    <td className="px-3 py-2.5">
                                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs gap-1" onClick={() => setConfirmRow(r)}>
                                            <RotateCcw className="w-3.5 h-3.5" /> Mark refunded
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            <Dialog open={!!confirmRow} onOpenChange={(o) => { if (!o && !busy) setConfirmRow(null) }}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Mark refunded?</DialogTitle>
                        <DialogDescription>
                            Confirms you already sent GHS {confirmRow ? Number(confirmRow.amount).toFixed(2) : ''} to {confirmRow?.momo_number || 'the customer'} outside the app.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirmRow(null)} disabled={busy}>Cancel</Button>
                        <Button disabled={busy} onClick={() => confirmRow && resolve(confirmRow)}>
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Mark refunded'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}
