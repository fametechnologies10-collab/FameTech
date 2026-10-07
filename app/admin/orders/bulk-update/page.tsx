'use client'

import { useMemo, useRef, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getStatusBadgeClass, shouldShowRefundOverlay, REFUND_OVERLAY_BADGE_CLASS } from '@/lib/order-status'
import { MAX_BULK_REFUND, isRefundable } from '@/lib/refunds'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
    Activity,
    Search,
    Loader2,
    CheckCircle2,
    XCircle,
    Clock,
    RotateCcw,
    RefreshCw,
    RadioTower,
    Upload,
    FileText,
    AlertTriangle,
    Package,
    Download,
} from 'lucide-react'

interface LookupOrder {
    id: string
    created_at: string
    phone_number: string
    network: string
    size: string
    price: number
    status: string
    fulfillment_method: string | null
    reference_code: string | null
    refunded_at: string | null
    payment_status: string | null
    shop_order_id: string | null
    source: string | null
    users: { first_name: string; last_name: string } | null
}

// Suppliers the selection-sync button knows how to re-check. Anything else (or a mixed
// selection) disables the button — see syncEligibility below.
const SYNC_SUPPORTED_SUPPLIERS = new Set(['agentportal', 'hendylinks'])

const NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime']
const BROWSE_STATUSES = ['All', 'Pending', 'Queued', 'Processing', 'Completed', 'Failed', 'Refunded']
type UploadMode = 'paste' | 'file'

function parseManualRows(text: string): { phoneNumber: string; size: string }[] {
    return text
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
            const parts = line.split(/[,\t]/).map(p => p.trim())
            return { phoneNumber: parts[0] || '', size: parts[1] || '' }
        })
        .filter(r => r.phoneNumber)
}

export default function BulkOrderUpdatePage() {
    const { dbUser } = useAuth()
    const fileInputRef = useRef<HTMLInputElement>(null)

    // Filters
    const [network, setNetwork] = useState('All')
    const [status, setStatus] = useState('All')
    const [dateFrom, setDateFrom] = useState('')
    const [dateTo, setDateTo] = useState('')

    // Lookup input
    const [uploadMode, setUploadMode] = useState<UploadMode>('paste')
    const [pasteText, setPasteText] = useState('')
    const [file, setFile] = useState<File | null>(null)

    // Results
    const [isSearching, setIsSearching] = useState(false)
    const [searched, setSearched] = useState(false)
    const [orders, setOrders] = useState<LookupOrder[]>([])
    const [notFound, setNotFound] = useState<string[]>([])
    const [sizeMismatch, setSizeMismatch] = useState<Array<{ phoneNumber: string; expectedSize: string; foundSizes: string[] }>>([])
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

    // Actions
    const [isUpdating, setIsUpdating] = useState(false)
    const [showBulkRefund, setShowBulkRefund] = useState(false)
    const [bulkRefundBusy, setBulkRefundBusy] = useState(false)
    const [isSyncing, setIsSyncing] = useState(false)

    const parsedPasteRows = useMemo(() => parseManualRows(pasteText), [pasteText])

    const handleSearch = async () => {
        setIsSearching(true)
        try {
            let response: Response
            if (uploadMode === 'file' && file) {
                const form = new FormData()
                form.set('file', file)
                form.set('mode', file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'excel')
                form.set('network', network)
                form.set('status', status)
                form.set('dateFrom', dateFrom)
                form.set('dateTo', dateTo)
                response = await fetch('/api/admin/orders/bulk-lookup', { method: 'POST', body: form })
            } else {
                response = await fetch('/api/admin/orders/bulk-lookup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rows: parsedPasteRows, network, status, dateFrom, dateTo }),
                })
            }
            const data = await response.json()
            if (!response.ok || !data.success) throw new Error(data.error || 'Lookup failed')

            const found: LookupOrder[] = data.data.orders || []
            setOrders(found)
            setNotFound(data.data.notFound || [])
            setSizeMismatch(data.data.sizeMismatch || [])
            setSelectedIds(new Set(found.map(o => o.id))) // select all by default
            setSearched(true)
        } catch (error: any) {
            toast.error(error.message || 'Lookup failed')
        } finally {
            setIsSearching(false)
        }
    }

    const allSelected = orders.length > 0 && selectedIds.size === orders.length
    const toggleSelectAll = () => {
        setSelectedIds(allSelected ? new Set() : new Set(orders.map(o => o.id)))
    }
    const toggleOne = (id: string) => {
        const next = new Set(selectedIds)
        next.has(id) ? next.delete(id) : next.add(id)
        setSelectedIds(next)
    }

    const bulkUpdateStatus = async (newStatus: 'pending' | 'processing' | 'completed' | 'failed') => {
        if (selectedIds.size === 0) { toast.error('No orders selected'); return }
        setIsUpdating(true)
        try {
            const orderIds = Array.from(selectedIds)
            const response = await fetch('/api/admin/orders/update-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderIds, status: newStatus }),
            })
            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Update failed')
            toast.success(`${data.count ?? orderIds.length} order(s) marked as ${newStatus}`)
            await handleSearch()
        } catch (error: any) {
            toast.error('Update failed: ' + error.message)
        } finally {
            setIsUpdating(false)
        }
    }

    // Sequential chunked refund — same idempotent per-order path as the fulfillment page,
    // just split into MAX_BULK_REFUND-sized batches since this grid can hold more than that.
    const bulkRefund = async () => {
        const ids = Array.from(selectedIds)
        if (ids.length === 0) { toast.error('No orders selected'); return }
        setBulkRefundBusy(true)
        try {
            let ok = 0, skipped = 0, failed = 0
            for (let i = 0; i < ids.length; i += MAX_BULK_REFUND) {
                const chunk = ids.slice(i, i + MAX_BULK_REFUND)
                const response = await fetch('/api/admin/orders/bulk-refund', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderIds: chunk, mechanism: 'owner_wallet', confirmProcessing: true }),
                })
                const data = await response.json()
                if (!response.ok || !data.success) throw new Error(data.error || 'Bulk refund failed')
                const s = data.data?.summary ?? { ok: 0, skipped: 0, failed: 0 }
                ok += s.ok; skipped += s.skipped; failed += s.failed
            }
            toast.success(`Refunded ${ok} · skipped ${skipped} · failed ${failed}`)
            setShowBulkRefund(false)
            await handleSearch()
        } catch (error: any) {
            toast.error(error.message || 'Bulk refund failed')
        } finally {
            setBulkRefundBusy(false)
        }
    }

    // Re-checks the selected orders directly against their supplier — a targeted lookup, not
    // the account-wide "Sync <Supplier>" buttons on the Fulfillment page, which sweep a bounded
    // recent window and can miss an older order an admin is specifically re-opening.
    const syncSelection = async () => {
        const ids = Array.from(selectedIds)
        if (ids.length === 0) { toast.error('No orders selected'); return }
        setIsSyncing(true)
        try {
            const response = await fetch('/api/admin/orders/sync-selection', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderIds: ids }),
            })
            const data = await response.json()
            if (!response.ok || !data.success) throw new Error(data.error || 'Sync failed')
            const stillInFlightNote = typeof data.stillInFlight === 'number' && data.stillInFlight > 0 ? ` · ${data.stillInFlight} still in flight` : ''
            const wipedNote = typeof data.wiped === 'number' && data.wiped > 0 ? ` · ${data.wiped} released to pending (no supplier found)` : ''
            toast.success(`Checked ${data.checked} · updated ${data.updated}${stillInFlightNote}${wipedNote}`)
            if (Array.isArray(data.notFoundInDbIds) && data.notFoundInDbIds.length > 0) {
                toast.error(`${data.notFoundInDbIds.length} selected order(s) no longer exist and were skipped`)
            }
            if (Array.isArray(data.errors) && data.errors.length > 0) {
                toast.error(`${data.errors.length} order(s) had errors — check logs`)
            }
            await handleSearch()
        } catch (error: any) {
            toast.error('Sync failed: ' + error.message)
        } finally {
            setIsSyncing(false)
        }
    }

    // Two columns, no header row — beneficiary number and bare data size (e.g. "1GB" -> "1"),
    // matching the format suppliers expect when re-uploading a fulfillment sheet.
    const exportSelected = async () => {
        const rows = orders
            .filter(o => selectedIds.has(o.id))
            .map(o => [{ v: o.phone_number || '', t: 's' as const }, (o.size || '').replace(/GB/i, '').trim()])
        if (rows.length === 0) { toast.error('No orders selected'); return }

        // @ts-ignore
        const { utils, writeFile } = await import('xlsx-js-style')
        const worksheet = utils.aoa_to_sheet(rows)
        worksheet['!cols'] = [{ wch: 25 }, { wch: 15 }]

        const BORDER_COLOR = 'CCCCCC'
        const range = utils.decode_range(worksheet['!ref'] || 'A1:B1')
        for (let R = range.s.r; R <= range.e.r; ++R) {
            for (let C = range.s.c; C <= range.e.c; ++C) {
                const cellAddress = utils.encode_cell({ r: R, c: C })
                if (!worksheet[cellAddress]) continue
                worksheet[cellAddress].s = {
                    font: { sz: 12, bold: false, color: { rgb: '000000' } },
                    alignment: { horizontal: 'center', vertical: 'center' },
                    border: {
                        bottom: { style: 'thin', color: { rgb: BORDER_COLOR } },
                        right: { style: 'thin', color: { rgb: BORDER_COLOR } },
                        left: { style: 'thin', color: { rgb: BORDER_COLOR } },
                        top: { style: 'thin', color: { rgb: BORDER_COLOR } },
                    },
                }
            }
        }

        const workbook = utils.book_new()
        utils.book_append_sheet(workbook, worksheet, 'Orders')
        writeFile(workbook, `bulk_orders_export_${new Date().toISOString().substring(0, 10)}.xlsx`)
    }

    const selectedOrders = orders.filter(o => selectedIds.has(o.id))
    const refundEligibleCount = selectedOrders.filter(o => isRefundable(o, 'admin').ok).length
    const hasProcessingSelected = selectedOrders.some(o => o.status === 'processing')

    // Sync is only meaningful against ONE supplier's lookup endpoint at a time — a mixed
    // selection has no single place to check. Mirrors the same-supplier constraint the API
    // route enforces server-side; this is just the UI's early, friendlier rejection.
    const selectedSuppliers = new Set(selectedOrders.map(o => o.fulfillment_method).filter(Boolean))
    const singleSupplier = selectedSuppliers.size === 1 ? Array.from(selectedSuppliers)[0] as string : null
    const canSync = selectedOrders.length > 0 && singleSupplier !== null && SYNC_SUPPORTED_SUPPLIERS.has(singleSupplier)
    const syncDisabledReason =
        selectedOrders.length === 0 ? '' :
        selectedSuppliers.size > 1 ? 'Select orders from a single supplier to sync' :
        singleSupplier === null ? 'Selected orders have no supplier recorded' :
        !SYNC_SUPPORTED_SUPPLIERS.has(singleSupplier) ? `Sync isn't supported yet for ${singleSupplier}` : ''

    if (dbUser?.role !== 'admin') {
        return (
            <div className="flex flex-col items-center justify-center h-[60vh]">
                <Activity className="w-12 h-12 text-destructive mb-4" />
                <h1 className="text-2xl font-bold">Access Denied</h1>
                <p className="text-muted-foreground">Admin privileges required.</p>
            </div>
        )
    }

    return (
        <div className="px-2 py-4 md:p-8 max-w-[1400px] mx-auto space-y-6">
            <div>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Bulk Order Update</h1>
                <p className="text-xs md:text-sm text-muted-foreground">
                    Look up orders by filters or by an uploaded/pasted list, then apply a status change or refund to the whole set at once.
                </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Left: filters + lookup input */}
                <div className="lg:col-span-1 space-y-4">
                    <Card className="shadow-sm">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-sm font-bold">Filters</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase font-bold text-muted-foreground">Network</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {['All', ...NETWORKS].map(n => (
                                        <Button key={n} variant={network === n ? 'default' : 'outline'} size="sm"
                                            className="h-7 text-[10px] px-2.5" onClick={() => setNetwork(n)}>
                                            {n}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase font-bold text-muted-foreground">Status</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {BROWSE_STATUSES.map(s => (
                                        <Button key={s} variant={status === s ? 'default' : 'outline'} size="sm"
                                            className="h-7 text-[10px] px-2.5" onClick={() => setStatus(s)}>
                                            {s}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                                <div className="space-y-1.5">
                                    <label className="text-[10px] uppercase font-bold text-muted-foreground">From</label>
                                    <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 text-xs" />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-[10px] uppercase font-bold text-muted-foreground">To</label>
                                    <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 text-xs" />
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="shadow-sm">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-sm font-bold">Pull Specific Orders (optional)</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <div className="flex gap-1.5">
                                <Button variant={uploadMode === 'paste' ? 'default' : 'outline'} size="sm" className="h-7 text-[10px] flex-1"
                                    onClick={() => setUploadMode('paste')}>
                                    <FileText className="w-3 h-3 mr-1" /> Paste
                                </Button>
                                <Button variant={uploadMode === 'file' ? 'default' : 'outline'} size="sm" className="h-7 text-[10px] flex-1"
                                    onClick={() => setUploadMode('file')}>
                                    <Upload className="w-3 h-3 mr-1" /> CSV / Excel
                                </Button>
                            </div>

                            {uploadMode === 'paste' ? (
                                <>
                                    <Textarea
                                        value={pasteText}
                                        onChange={e => setPasteText(e.target.value)}
                                        placeholder={'One beneficiary per line — size is optional:\n0551617309\t1\n0551617309\t4\n0509542032'}
                                        className="text-xs h-28 font-mono"
                                    />
                                    <p className="text-[10px] text-muted-foreground">
                                        BeneficiaryNumber, or BeneficiaryNumber and Size — comma or tab separated. Size only narrows
                                        the match to that data size (e.g. 1 = 1GB); leave it out to pull every order for that number.
                                    </p>
                                    {pasteText.trim() && (
                                        <p className="text-[10px] text-muted-foreground">{parsedPasteRows.length} row(s) parsed</p>
                                    )}
                                </>
                            ) : (
                                <>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".csv,.xlsx,.xls"
                                        onChange={e => setFile(e.target.files?.[0] || null)}
                                        className="text-xs w-full file:mr-2 file:h-7 file:rounded-md file:border-0 file:bg-secondary file:px-2.5 file:text-[10px] file:font-bold"
                                    />
                                    <p className="text-[10px] text-muted-foreground">
                                        Columns: beneficiary number, size (size column optional; with or without a header row).
                                    </p>
                                    {file && <p className="text-[10px] font-medium">{file.name}</p>}
                                </>
                            )}
                        </CardContent>
                    </Card>

                    <Button onClick={handleSearch} disabled={isSearching || (uploadMode === 'file' && !file)} className="w-full h-10 font-bold">
                        {isSearching ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
                        Find Orders
                    </Button>

                    {(notFound.length > 0 || sizeMismatch.length > 0) && (
                        <Card className="border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 shadow-sm">
                            <CardContent className="p-3 space-y-2 text-[11px]">
                                <div className="flex items-center gap-1.5 font-bold text-amber-700 dark:text-amber-400">
                                    <AlertTriangle className="w-3.5 h-3.5" /> Unmatched rows
                                </div>
                                {notFound.length > 0 && (
                                    <p><span className="font-semibold">{notFound.length} not found:</span> {notFound.slice(0, 15).join(', ')}{notFound.length > 15 ? '…' : ''}</p>
                                )}
                                {sizeMismatch.length > 0 && (
                                    <p>
                                        <span className="font-semibold">{sizeMismatch.length} size mismatch:</span>{' '}
                                        {sizeMismatch.slice(0, 8).map(m => `${m.phoneNumber} (expected ${m.expectedSize}, found ${m.foundSizes.join('/')})`).join('; ')}
                                        {sizeMismatch.length > 8 ? '…' : ''}
                                    </p>
                                )}
                            </CardContent>
                        </Card>
                    )}
                </div>

                {/* Right: results + bulk actions */}
                <div className="lg:col-span-2 space-y-4">
                    {selectedIds.size > 0 && (
                        <div className="sticky top-20 z-30 flex items-center justify-between bg-primary/10 dark:bg-primary/20 backdrop-blur-md border border-primary/20 p-2 md:p-3 rounded-xl shadow-lg flex-wrap gap-2">
                            <div className="flex items-center gap-2">
                                <Badge variant="default" className="rounded-full px-2 text-[10px]">{selectedIds.size}</Badge>
                                <span className="text-[10px] md:text-xs font-bold uppercase">Selected</span>
                            </div>
                            <div className="flex gap-2 md:gap-3 flex-wrap justify-end">
                                <Button size="sm" onClick={() => bulkUpdateStatus('pending')}
                                    className="h-9 text-xs px-3 bg-amber-500 hover:bg-amber-600 text-black font-bold disabled:opacity-50"
                                    disabled={isUpdating || hasProcessingSelected}
                                    title={hasProcessingSelected ? 'Cannot revert processing orders to pending' : ''}>
                                    <Clock className="w-3.5 h-3.5 mr-1.5" /> Pending
                                </Button>
                                <Button size="sm" onClick={() => bulkUpdateStatus('processing')} className="h-9 text-xs px-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold" disabled={isUpdating}>
                                    <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Processing
                                </Button>
                                <Button size="sm" onClick={() => bulkUpdateStatus('completed')} className="h-9 text-xs px-3 bg-green-600 hover:bg-green-700 font-bold" disabled={isUpdating}>
                                    <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Complete
                                </Button>
                                <Button size="sm" onClick={() => bulkUpdateStatus('failed')} variant="destructive" className="h-9 text-xs px-3 font-bold" disabled={isUpdating}>
                                    <XCircle className="w-3.5 h-3.5 mr-1.5" /> Fail
                                </Button>
                                <Button size="sm" onClick={() => setShowBulkRefund(true)} className="h-9 text-xs px-3 bg-purple-600 hover:bg-purple-700 text-white font-bold" disabled={isUpdating}>
                                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refund
                                </Button>
                                <Button size="sm" onClick={syncSelection} className="h-9 text-xs px-3 bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50"
                                    disabled={isSyncing || !canSync} title={syncDisabledReason}>
                                    {isSyncing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RadioTower className="w-3.5 h-3.5 mr-1.5" />}
                                    Sync
                                </Button>
                            </div>
                        </div>
                    )}

                    <Card className="shadow-md">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
                            <CardTitle className="text-lg font-bold">
                                Results {orders.length > 0 && <span className="text-muted-foreground font-normal text-sm">({orders.length})</span>}
                            </CardTitle>
                            <div className="flex gap-2">
                                <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={exportSelected} disabled={selectedIds.size === 0}>
                                    <Download className="w-3 h-3 mr-1" /> Export
                                </Button>
                                <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={toggleSelectAll} disabled={orders.length === 0}>
                                    {allSelected ? 'Unselect All' : 'Select All'}
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="px-1 md:px-6">
                            {!searched ? (
                                <div className="text-center py-20 border-2 border-dashed rounded-xl m-2">
                                    <Search className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
                                    <h3 className="text-sm font-bold">Set your filters or paste order numbers</h3>
                                    <p className="text-muted-foreground text-xs">Then hit Find Orders.</p>
                                </div>
                            ) : orders.length === 0 ? (
                                <div className="text-center py-20 border-2 border-dashed rounded-xl m-2">
                                    <Package className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
                                    <h3 className="text-sm font-bold">No Records Found</h3>
                                    <p className="text-muted-foreground text-xs">Try adjusting your filters or list.</p>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {orders.map(order => (
                                        <div
                                            key={order.id}
                                            onClick={() => toggleOne(order.id)}
                                            className={cn(
                                                'group relative flex items-center gap-3 p-3 border-2 rounded-xl transition-all duration-200 cursor-pointer select-none',
                                                selectedIds.has(order.id)
                                                    ? 'bg-primary/10 border-primary shadow-md'
                                                    : 'bg-card border-transparent hover:border-primary/20 hover:bg-accent/50'
                                            )}
                                        >
                                            <Checkbox checked={selectedIds.has(order.id)} className="scale-110 pointer-events-none" />
                                            <div className="flex-1 grid grid-cols-2 md:grid-cols-5 items-center gap-x-2 gap-y-2 p-1">
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] uppercase font-medium text-muted-foreground">Beneficiary</p>
                                                    <p className="text-[12px] font-medium text-primary">{order.phone_number}</p>
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] uppercase font-medium text-muted-foreground">Ref</p>
                                                    <p className="text-[12px] font-medium truncate">{order.reference_code || order.id.slice(0, 8)}</p>
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] uppercase font-medium text-muted-foreground">Bundle</p>
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        <Badge variant="outline" className="text-[10px] px-1.5 font-black leading-none py-1 bg-secondary/50">{order.network}</Badge>
                                                        <span className="text-[12px] font-medium">{order.size}</span>
                                                    </div>
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] uppercase font-medium text-muted-foreground">Status</p>
                                                    <div className="flex items-center gap-1 flex-wrap">
                                                        <Badge className={cn('text-[10px] px-1.5 py-0.5 font-bold', getStatusBadgeClass(order.status))}>{order.status}</Badge>
                                                        {shouldShowRefundOverlay(order) && (
                                                            <Badge className={cn('text-[9px] px-1.5 py-0.5 font-bold', REFUND_OVERLAY_BADGE_CLASS)}>Refunded</Badge>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] uppercase font-medium text-muted-foreground">Date</p>
                                                    <p className="text-[12px]">{new Date(order.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

            <Dialog open={showBulkRefund} onOpenChange={setShowBulkRefund}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Refund {selectedIds.size} order(s)?</DialogTitle>
                        <DialogDescription>
                            {refundEligibleCount} of {selectedIds.size} selected are refund-eligible — already-refunded or completed orders are skipped automatically and cannot be double-refunded.
                            {selectedIds.size > MAX_BULK_REFUND ? ` Processed in batches of ${MAX_BULK_REFUND}.` : ''}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowBulkRefund(false)} disabled={bulkRefundBusy}>Cancel</Button>
                        <Button onClick={bulkRefund} disabled={bulkRefundBusy} className="bg-purple-600 hover:bg-purple-700 text-white">
                            {bulkRefundBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                            Confirm Refund
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
