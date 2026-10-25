'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { Package, RefreshCw, Loader2, Search, ChevronLeft, ChevronRight } from 'lucide-react'
import { format } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { SettingsPanel } from './_components/settings-panel'
import { CatalogPanel } from './_components/catalog-panel'

type Tab = 'orders' | 'settings' | 'catalog'
type Action = 'sync' | 'retry' | 'refund'

interface BundleOrder {
    id: string
    reference_code: string
    status: string
    network: string
    kind: string
    bundle_label: string | null
    beneficiary_phone: string
    catalog_price: number
    discount_pct: number
    total_paid: number
    kf_order_ref: string | null
    commission_amount: number | null
    fulfillment_attempts: number
    fulfillment_metadata: Record<string, any>
    created_at: string
    users?: { first_name: string; last_name: string; email: string } | null
}

const STATUS_TABS = ['all', 'pending', 'processing', 'completed', 'failed', 'refunded']
const STATUS_STYLES: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    processing: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
    completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
    failed: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
    refunded: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
}

const ACTION_COPY: Record<Action, { title: string; body: string; confirm: string }> = {
    sync: {
        title: 'Sync with supplier',
        body: 'Checks the order with the supplier. If it is delivered or failed there, the order is updated to match (a failed order is refunded to the customer).',
        confirm: 'Sync',
    },
    refund: {
        title: 'Refund customer',
        body: 'The supplier is checked first. The wallet is refunded only if the supplier confirms the order failed or has no record of it. If it was delivered, the order is marked completed instead and nothing is refunded.',
        confirm: 'Refund',
    },
    retry: {
        title: 'Retry delivery',
        body: 'The supplier is checked first. If the order was not delivered and is not in flight, it is re-sent with the same reference, so the customer is never charged twice.',
        confirm: 'Retry',
    },
}

export default function AdminStandardBundlesPage() {
    const [tab, setTab] = useState<Tab>('orders')
    const [orders, setOrders] = useState<BundleOrder[]>([])
    const [loading, setLoading] = useState(true)
    const [status, setStatus] = useState('all')
    const [network, setNetwork] = useState('all')
    const [searchInput, setSearchInput] = useState('')
    const [search, setSearch] = useState('')
    const [page, setPage] = useState(1)
    const [totalPages, setTotalPages] = useState(1)
    const [total, setTotal] = useState(0)
    const [pending, setPending] = useState<{ order: BundleOrder; action: Action } | null>(null)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1) }, 400)
        return () => clearTimeout(t)
    }, [searchInput])

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const params = new URLSearchParams({ page: String(page), limit: '30' })
            if (status !== 'all') params.set('status', status)
            if (network !== 'all') params.set('network', network)
            if (search) params.set('search', search)
            const res = await fetch(`/api/admin/standard-bundles/orders?${params}`)
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load orders')
            setOrders(json.data.orders)
            setTotalPages(Math.max(1, json.data.totalPages))
            setTotal(json.data.total)
        } catch (e: any) {
            toast.error(e?.message || 'Failed to load orders')
        } finally {
            setLoading(false)
        }
    }, [page, status, network, search])

    useEffect(() => { if (tab === 'orders') load() }, [tab, load])

    const run = async () => {
        if (!pending) return
        const { order, action } = pending
        setBusy(true)
        try {
            const res = await fetch('/api/admin/standard-bundles/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: order.id, action }),
            })
            const json = await res.json().catch(() => null)
            if (!res.ok || !json?.success) {
                toast.error(json?.error || 'Action failed')
            } else if (action === 'refund' && json.data?.refunded) {
                toast.success(`Refunded GHS ${Number(json.data.amount).toFixed(2)} to the customer`)
            } else {
                toast.success(json.data?.message || 'Done')
            }
        } catch {
            toast.error('Network error. Check the order status before trying again.')
        } finally {
            setBusy(false)
            setPending(null)
            load()
        }
    }

    const canSync = (o: BundleOrder) => ['pending', 'processing', 'failed'].includes(o.status)
    const canRefund = (o: BundleOrder) => ['pending', 'processing', 'failed'].includes(o.status)
    const canRetry = (o: BundleOrder) => ['pending', 'failed'].includes(o.status)

    return (
        <div className="p-4 md:p-6 space-y-4 max-w-7xl mx-auto">
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <Package className="w-5 h-5 text-emerald-600" />
                    <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Standard Bundles</h1>
                </div>
                {tab === 'orders' && (
                    <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
                        <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} /> Refresh
                    </Button>
                )}
            </div>

            <div className="flex gap-1.5">
                {(['orders', 'settings', 'catalog'] as Tab[]).map((t) => (
                    <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={cn(
                            'px-3 h-9 rounded-lg text-sm font-medium capitalize border transition-colors',
                            tab === t
                                ? 'bg-slate-900 border-slate-900 text-white dark:bg-white dark:text-slate-900 dark:border-white'
                                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500',
                        )}
                    >{t === 'catalog' ? 'Catalog preview' : t}</button>
                ))}
            </div>

            {tab === 'settings' && <SettingsPanel />}
            {tab === 'catalog' && <CatalogPanel />}

            {tab === 'orders' && (
                <div className="space-y-3">
                    <div className="flex flex-col sm:flex-row gap-2">
                        <div className="relative flex-1">
                            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                            <Input
                                value={searchInput}
                                onChange={(e) => setSearchInput(e.target.value)}
                                placeholder="Search reference or phone"
                                className="pl-9 h-9"
                            />
                        </div>
                        <Select value={network} onValueChange={(v) => { setNetwork(v); setPage(1) }}>
                            <SelectTrigger className="sm:w-40 h-9 text-sm"><SelectValue placeholder="Network" /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All networks</SelectItem>
                                <SelectItem value="MTN">MTN</SelectItem>
                                <SelectItem value="Telecel">Telecel</SelectItem>
                                <SelectItem value="AT">AirtelTigo</SelectItem>
                                <SelectItem value="TelecelBroadband">Broadband</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {STATUS_TABS.map((s) => (
                            <button
                                key={s}
                                onClick={() => { setStatus(s); setPage(1) }}
                                className={cn(
                                    'px-3 h-8 rounded-lg text-xs font-medium capitalize border transition-colors',
                                    status === s
                                        ? 'bg-slate-900 border-slate-900 text-white dark:bg-white dark:text-slate-900 dark:border-white'
                                        : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500',
                                )}
                            >{s}</button>
                        ))}
                    </div>

                    {loading ? (
                        <div className="flex justify-center py-20"><Loader2 className="w-7 h-7 animate-spin text-emerald-500" /></div>
                    ) : orders.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 py-20 text-center text-sm text-slate-500">
                            No bundle orders match these filters.
                        </div>
                    ) : (
                        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                            <table className="w-full text-sm">
                                <thead className="bg-slate-50 dark:bg-slate-900 text-left text-xs text-slate-500">
                                    <tr>
                                        <th className="px-3 py-2 font-medium">Order</th>
                                        <th className="px-3 py-2 font-medium">Customer</th>
                                        <th className="px-3 py-2 font-medium">Bundle</th>
                                        <th className="px-3 py-2 font-medium text-right">Paid</th>
                                        <th className="px-3 py-2 font-medium text-right">Commission</th>
                                        <th className="px-3 py-2 font-medium">Status</th>
                                        <th className="px-3 py-2 font-medium text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                    {orders.map((o) => (
                                        <tr key={o.id} className="align-top">
                                            <td className="px-3 py-2">
                                                <p className="font-mono text-xs text-slate-900 dark:text-white">{o.reference_code}</p>
                                                <p className="text-xs text-slate-500">{format(new Date(o.created_at), 'dd MMM yyyy, HH:mm')}</p>
                                                {o.kf_order_ref && <p className="text-xs text-slate-400">Supplier ref {o.kf_order_ref}</p>}
                                            </td>
                                            <td className="px-3 py-2">
                                                <p className="text-slate-900 dark:text-white">{o.users ? `${o.users.first_name} ${o.users.last_name}` : '-'}</p>
                                                <p className="text-xs text-slate-500">To {o.beneficiary_phone}</p>
                                            </td>
                                            <td className="px-3 py-2">
                                                <p className="text-slate-900 dark:text-white">{o.bundle_label || o.kind}</p>
                                                <p className="text-xs text-slate-500">{o.network}, {o.kind}{o.discount_pct > 0 ? `, ${o.discount_pct}% off` : ''}</p>
                                            </td>
                                            <td className="px-3 py-2 text-right tabular-nums">GHS {Number(o.total_paid).toFixed(2)}</td>
                                            <td className="px-3 py-2 text-right tabular-nums">
                                                {o.commission_amount != null ? `GHS ${Number(o.commission_amount).toFixed(2)}` : '-'}
                                            </td>
                                            <td className="px-3 py-2">
                                                <span className={cn('inline-block px-2 py-0.5 rounded-md text-xs font-medium capitalize', STATUS_STYLES[o.status])}>{o.status}</span>
                                                {o.fulfillment_attempts > 0 && <p className="text-xs text-slate-500 mt-1">{o.fulfillment_attempts} attempt{o.fulfillment_attempts === 1 ? '' : 's'}</p>}
                                                {o.fulfillment_metadata?.exhausted_at && <p className="text-xs text-red-500 mt-1">Retries exhausted</p>}
                                            </td>
                                            <td className="px-3 py-2">
                                                <div className="flex justify-end gap-1.5">
                                                    {canSync(o) && <Button size="sm" variant="outline" className="h-8" onClick={() => setPending({ order: o, action: 'sync' })}>Sync</Button>}
                                                    {canRetry(o) && <Button size="sm" variant="outline" className="h-8" onClick={() => setPending({ order: o, action: 'retry' })}>Retry</Button>}
                                                    {canRefund(o) && <Button size="sm" variant="outline" className="h-8 text-red-600" onClick={() => setPending({ order: o, action: 'refund' })}>Refund</Button>}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    <div className="flex items-center justify-between text-xs text-slate-500">
                        <span>{total} order{total === 1 ? '' : 's'}</span>
                        <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" className="h-8" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
                                <ChevronLeft className="w-4 h-4" />
                            </Button>
                            <span>Page {page} of {totalPages}</span>
                            <Button size="sm" variant="outline" className="h-8" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
                                <ChevronRight className="w-4 h-4" />
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            <Dialog open={!!pending} onOpenChange={(open) => { if (!open && !busy) setPending(null) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{pending ? ACTION_COPY[pending.action].title : ''}</DialogTitle>
                        <DialogDescription>
                            {pending && (
                                <>
                                    Order {pending.order.reference_code} (GHS {Number(pending.order.total_paid).toFixed(2)}). {ACTION_COPY[pending.action].body}
                                </>
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2">
                        <Button variant="outline" onClick={() => setPending(null)} disabled={busy}>Cancel</Button>
                        <Button onClick={run} disabled={busy} className={pending?.action === 'refund' ? 'bg-red-600 hover:bg-red-700 text-white' : ''}>
                            {busy && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
                            {pending ? ACTION_COPY[pending.action].confirm : ''}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
