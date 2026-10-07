'use client'

import { useEffect, useState } from 'react'
import { formatCurrency, cn, normalizeWhatsAppNumber } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Plus, Pencil, Trash2, Loader2, Copy, Check, Clock, RotateCcw, CheckCircle2, XCircle } from 'lucide-react'
import { toast } from '@/lib/toast'
import { DataPackage } from '@/types/supabase'

interface MashupOrder {
    id: string
    created_at: string | null
    phone_number: string
    size: string
    price: number
    status: string
    payment_status: string | null
    reference_code: string
    fulfillment_note: string | null
    users?: { first_name: string | null; last_name: string | null; phone_number: string | null } | null
}

interface FormData {
    size: string
    price: number
    agent_price: number
    dealer_price: number
    cost_price: number
    description: string
    is_available: boolean
    sort_order: number
}

const defaultFormData: FormData = {
    size: '', price: 0, agent_price: 0, dealer_price: 0, cost_price: 0,
    description: '', is_available: true, sort_order: 0,
}

const ORDER_STATUSES = ['All', 'pending', 'processing', 'completed', 'failed']

export default function AdminMtnMashupPage() {
    // Packages
    const [packages, setPackages] = useState<DataPackage[]>([])
    const [isLoadingPkgs, setIsLoadingPkgs] = useState(true)
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [editing, setEditing] = useState<DataPackage | null>(null)
    const [formData, setFormData] = useState<FormData>(defaultFormData)
    const [isSaving, setIsSaving] = useState(false)
    const [deletingId, setDeletingId] = useState<string | null>(null)

    // Orders
    const [orders, setOrders] = useState<MashupOrder[]>([])
    const [isLoadingOrders, setIsLoadingOrders] = useState(true)
    const [statusFilter, setStatusFilter] = useState('All')
    const [updatingId, setUpdatingId] = useState<string | null>(null)
    const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set())
    const [isBulkUpdating, setIsBulkUpdating] = useState(false)
    const [copiedId, setCopiedId] = useState<string | null>(null)

    useEffect(() => { fetchPackages() }, [])
    useEffect(() => { fetchOrders() }, [statusFilter])

    const fetchPackages = async () => {
        try {
            const res = await fetch('/api/admin/mtn-mashup/packages')
            if (!res.ok) throw new Error('Failed to load packages')
            const data = await res.json()
            setPackages(Array.isArray(data) ? data : [])
        } catch { toast.error('Failed to load packages') }
        finally { setIsLoadingPkgs(false) }
    }

    const fetchOrders = async () => {
        setIsLoadingOrders(true)
        try {
            const res = await fetch(`/api/admin/mtn-mashup/orders?status=${encodeURIComponent(statusFilter)}`)
            if (!res.ok) throw new Error('Failed to load orders')
            const data = await res.json()
            setOrders(Array.isArray(data) ? data : [])
        } catch { toast.error('Failed to load orders') }
        finally { setIsLoadingOrders(false) }
    }

    const openCreate = () => { setEditing(null); setFormData(defaultFormData); setIsDialogOpen(true) }
    const openEdit = (pkg: DataPackage) => {
        setEditing(pkg)
        setFormData({
            size: pkg.size,
            price: pkg.price,
            agent_price: pkg.agent_price ?? 0,
            dealer_price: pkg.dealer_price ?? 0,
            cost_price: pkg.cost_price ?? 0,
            description: pkg.description || '',
            is_available: pkg.is_available ?? false,
            sort_order: pkg.sort_order ?? 0,
        })
        setIsDialogOpen(true)
    }

    const handleSave = async () => {
        if (!formData.size || !formData.price) { toast.error('Name and price are required'); return }
        if (formData.agent_price > 0 && formData.agent_price < formData.cost_price) { toast.error('Agent price cannot be lower than cost price'); return }
        if (formData.dealer_price > 0 && formData.dealer_price < formData.cost_price) { toast.error('Dealer price cannot be lower than cost price'); return }
        setIsSaving(true)
        try {
            const method = editing ? 'PUT' : 'POST'
            const payload = editing ? { ...formData, id: editing.id } : formData
            const res = await fetch('/api/admin/mtn-mashup/packages', {
                method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to save')
            toast.success(editing ? 'Package updated' : 'Package created')
            setIsDialogOpen(false)
            fetchPackages()
        } catch (e: any) { toast.error(e.message || 'Failed to save') }
        finally { setIsSaving(false) }
    }

    const handleDelete = async (id: string) => {
        if (!confirm('Delete this Mashup package?')) return
        setDeletingId(id)
        try {
            const res = await fetch(`/api/admin/mtn-mashup/packages?id=${id}`, { method: 'DELETE' })
            if (!res.ok) throw new Error('Failed to delete')
            toast.success('Package deleted'); fetchPackages()
        } catch { toast.error('Failed to delete') }
        finally { setDeletingId(null) }
    }

    // "Mark failed" REFUNDS the buyer, so it needs confirmation. Native confirm() silently
    // returns false in an iOS PWA — use a controlled dialog instead.
    const [failConfirm, setFailConfirm] = useState<{ mode: 'single' | 'bulk'; orderId?: string } | null>(null)

    const doUpdateStatus = async (orderId: string, status: string) => {
        setUpdatingId(orderId)
        try {
            const res = await fetch('/api/admin/mtn-mashup/orders', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId, status }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to update')
            toast.success(status === 'failed' && data.refunded ? 'Order failed & wallet refunded' : `Order marked ${status}`)
            fetchOrders()
        } catch (e: any) { toast.error(e.message || 'Failed to update') }
        finally { setUpdatingId(null) }
    }

    const updateStatus = async (orderId: string, status: string) => {
        if (status === 'failed') { setFailConfirm({ mode: 'single', orderId }); return }
        await doUpdateStatus(orderId, status)
    }

    const doBulkUpdateStatus = async (status: 'pending' | 'processing' | 'completed' | 'failed') => {
        setIsBulkUpdating(true)
        try {
            const orderIds = Array.from(selectedOrders)
            const res = await fetch('/api/admin/mtn-mashup/orders', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderIds, status }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Bulk update failed')
            toast.success(`${data.updated ?? 0} order(s) marked ${status}${data.refunded ? ` · ${data.refunded} refunded` : ''}`)
            setSelectedOrders(new Set())
            fetchOrders()
        } catch (e: any) { toast.error(e.message || 'Bulk update failed') }
        finally { setIsBulkUpdating(false) }
    }

    const bulkUpdateStatus = async (status: 'pending' | 'processing' | 'completed' | 'failed') => {
        if (selectedOrders.size === 0) { toast.error('No orders selected'); return }
        if (status === 'failed') { setFailConfirm({ mode: 'bulk' }); return }
        await doBulkUpdateStatus(status)
    }

    const toggleSelect = (id: string) => {
        setSelectedOrders(prev => {
            const next = new Set(prev)
            next.has(id) ? next.delete(id) : next.add(id)
            return next
        })
    }

    // Copy the beneficiary phone for manual fulfillment; auto-advance pending -> processing.
    const copyPhone = async (order: MashupOrder, e: React.MouseEvent) => {
        e.stopPropagation()
        try {
            // Copy the normalized number (no spaces) so it pastes cleanly into a dialler/USSD.
            await navigator.clipboard.writeText(normalizeWhatsAppNumber(order.phone_number || ''))
            setCopiedId(order.id)
            setTimeout(() => setCopiedId(c => (c === order.id ? null : c)), 1500)
            toast.success('Phone copied')
            if (order.status === 'pending') {
                await updateStatus(order.id, 'processing')
            }
        } catch { toast.error('Copy failed') }
    }

    const statusClass = (s: string) =>
        s === 'completed' ? 'bg-green-100 text-green-700'
        : s === 'processing' ? 'bg-blue-100 text-blue-700'
        : s === 'failed' ? 'bg-red-100 text-red-700'
        : s === 'refunded' ? 'bg-purple-100 text-purple-700'
        : 'bg-yellow-100 text-yellow-700'

    return (
        <div className="p-4 md:p-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold">Special MTN Mashup</h1>
                <p className="text-sm text-muted-foreground">Configure curated MTN packages and process orders manually.</p>
            </div>

            <Tabs defaultValue="packages">
                <TabsList className="w-full grid grid-cols-2">
                    <TabsTrigger value="packages">Packages</TabsTrigger>
                    <TabsTrigger value="orders">Orders</TabsTrigger>
                </TabsList>

                {/* ── Packages tab ── */}
                <TabsContent value="packages" className="mt-6 space-y-4">
                    <div className="flex justify-end">
                        <Button onClick={openCreate}><Plus className="w-4 h-4 mr-2" />Add Mashup Package</Button>
                    </div>
                    {isLoadingPkgs ? (
                        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                    ) : packages.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-12">No Mashup packages yet.</p>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                            {packages.map(pkg => (
                                <Card key={pkg.id} className={pkg.is_available ? '' : 'opacity-60'}>
                                    <CardContent className="p-4 space-y-2">
                                        <div className="flex items-start justify-between">
                                            <p className="font-bold">{pkg.size}</p>
                                            <span className={`text-[10px] px-2 py-0.5 rounded-full ${pkg.is_available ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                                                {pkg.is_available ? 'Available' : 'Hidden'}
                                            </span>
                                        </div>
                                        <p className="text-xs text-muted-foreground line-clamp-2">{pkg.description || '—'}</p>
                                        <div className="text-sm space-y-0.5">
                                            <p>Price: <b>{formatCurrency(pkg.price)}</b></p>
                                            <p className="text-green-700">Agent: {formatCurrency(pkg.agent_price ?? 0)}</p>
                                            <p className="text-violet-700">Dealer: {formatCurrency(pkg.dealer_price ?? 0)}</p>
                                            <p className="text-muted-foreground">Cost: {formatCurrency(pkg.cost_price ?? 0)}</p>
                                        </div>
                                        <div className="flex gap-2 pt-1">
                                            <Button size="sm" variant="outline" onClick={() => openEdit(pkg)}><Pencil className="w-3 h-3 mr-1" />Edit</Button>
                                            <Button size="sm" variant="outline" onClick={() => handleDelete(pkg.id)} disabled={deletingId === pkg.id}>
                                                {deletingId === pkg.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}
                </TabsContent>

                {/* ── Orders tab ── */}
                <TabsContent value="orders" className="mt-6 space-y-4">
                    <div className="flex flex-wrap items-end justify-between gap-3">
                        <div className="w-48">
                            <Label className="text-xs">Filter by status</Label>
                            <Select value={statusFilter} onValueChange={setStatusFilter}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {ORDER_STATUSES.map(s => <SelectItem key={s} value={s}>{s === 'All' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>)}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex gap-2">
                            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setSelectedOrders(new Set())} disabled={selectedOrders.size === 0}>
                                Clear
                            </Button>
                            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setSelectedOrders(new Set(orders.map(o => o.id)))} disabled={orders.length === 0}>
                                Select Page
                            </Button>
                        </div>
                    </div>

                    {/* Bulk actions bar — mirrors the fulfillment page selection update */}
                    {selectedOrders.size > 0 && (
                        <div className="sticky top-20 z-30 flex items-center justify-between flex-wrap gap-2 bg-primary/10 dark:bg-primary/20 backdrop-blur-md border border-primary/20 p-2 md:p-3 rounded-xl shadow-lg">
                            <div className="flex items-center gap-2">
                                <span className="inline-flex items-center justify-center min-w-6 h-6 px-2 rounded-full bg-primary text-primary-foreground text-xs font-bold">{selectedOrders.size}</span>
                                <span className="text-[10px] md:text-xs font-bold uppercase">Selected</span>
                            </div>
                            <div className="flex gap-2 flex-wrap justify-end">
                                <Button size="sm" onClick={() => bulkUpdateStatus('pending')} className="h-9 text-xs px-3 bg-amber-500 hover:bg-amber-600 text-black font-bold" disabled={isBulkUpdating}>
                                    <Clock className="w-3.5 h-3.5 mr-1.5" /> Pending
                                </Button>
                                <Button size="sm" onClick={() => bulkUpdateStatus('processing')} className="h-9 text-xs px-3 bg-blue-600 hover:bg-blue-700 text-white font-bold" disabled={isBulkUpdating}>
                                    <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Processing
                                </Button>
                                <Button size="sm" onClick={() => bulkUpdateStatus('completed')} className="h-9 text-xs px-3 bg-green-600 hover:bg-green-700 font-bold" disabled={isBulkUpdating}>
                                    <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Complete
                                </Button>
                                <Button size="sm" onClick={() => bulkUpdateStatus('failed')} variant="destructive" className="h-9 text-xs px-3 font-bold" disabled={isBulkUpdating}>
                                    <XCircle className="w-3.5 h-3.5 mr-1.5" /> Fail (refund)
                                </Button>
                            </div>
                        </div>
                    )}

                    {isLoadingOrders ? (
                        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                    ) : orders.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-12">No orders.</p>
                    ) : (
                        <div className="space-y-3">
                            {orders.map(o => {
                                const selected = selectedOrders.has(o.id)
                                return (
                                    <div
                                        key={o.id}
                                        onClick={() => toggleSelect(o.id)}
                                        className={cn(
                                            'flex items-center gap-3 p-3 md:p-4 border-2 rounded-xl transition-all duration-150 cursor-pointer select-none',
                                            selected ? 'bg-primary/10 border-primary shadow-md' : 'bg-card border-transparent hover:border-primary/20 hover:bg-accent/50'
                                        )}
                                    >
                                        <Checkbox checked={selected} className="scale-110 pointer-events-none shrink-0" />
                                        <div className="flex-1 flex flex-col md:flex-row md:items-center md:justify-between gap-2 min-w-0">
                                            <div className="space-y-0.5 min-w-0">
                                                <p className="font-semibold">{o.size} · {formatCurrency(o.price)}</p>
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-sm text-muted-foreground">To: {o.phone_number}</span>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => copyPhone(o, e)}
                                                        title="Copy phone (auto-marks pending as processing)"
                                                        className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-border bg-muted hover:bg-muted/70 active:scale-95 transition-all"
                                                    >
                                                        {copiedId === o.id ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
                                                    </button>
                                                </div>
                                                <p className="text-xs text-muted-foreground truncate">
                                                    {o.users?.first_name || 'Customer'} {o.users?.last_name || ''} · Ref {o.reference_code}
                                                </p>
                                                {o.created_at && (
                                                    <p className="text-xs text-muted-foreground">{new Date(o.created_at).toLocaleString()}</p>
                                                )}
                                            </div>
                                            <span className={cn('shrink-0 px-3 py-1 rounded-full text-xs font-medium', statusClass(o.status))}>
                                                {o.status}{o.payment_status === 'refunded' ? ' · refunded' : ''}
                                                {updatingId === o.id ? '…' : ''}
                                            </span>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </TabsContent>
            </Tabs>

            {/* Create / Edit package dialog */}
            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                <DialogContent className="flex flex-col max-h-[90dvh]">
                    <DialogHeader className="flex-shrink-0">
                        <DialogTitle>{editing ? 'Edit Mashup Package' : 'Create Mashup Package'}</DialogTitle>
                        <DialogDescription>MTN-only curated package with role-based pricing.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4 overflow-y-auto flex-1 pr-1">
                        <div className="space-y-2">
                            <Label>Package name (e.g. &quot;5GB + 100min Combo&quot;)</Label>
                            <Input value={formData.size} onChange={e => setFormData(p => ({ ...p, size: e.target.value }))} placeholder="5GB + 100min" />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Selling Price (GHS)</Label>
                                <Input type="number" value={formData.price} onChange={e => setFormData(p => ({ ...p, price: parseFloat(e.target.value) || 0 }))} />
                            </div>
                            <div className="space-y-2">
                                <Label>Cost Price (GHS)</Label>
                                <Input type="number" value={formData.cost_price} onChange={e => setFormData(p => ({ ...p, cost_price: parseFloat(e.target.value) || 0 }))} />
                            </div>
                            <div className="space-y-2">
                                <Label>Agent Price (GHS)</Label>
                                <Input type="number" value={formData.agent_price} onChange={e => setFormData(p => ({ ...p, agent_price: parseFloat(e.target.value) || 0 }))} />
                                <p className="text-[10px] text-muted-foreground">Optional; falls back to selling price if 0</p>
                            </div>
                            <div className="space-y-2">
                                <Label className="text-violet-700">Dealer Price (GHS)</Label>
                                <Input type="number" value={formData.dealer_price} onChange={e => setFormData(p => ({ ...p, dealer_price: parseFloat(e.target.value) || 0 }))} />
                                <p className="text-[10px] text-muted-foreground">Optional; falls back to agent/selling price if 0</p>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>Sort Order</Label>
                            <Input type="number" value={formData.sort_order} onChange={e => setFormData(p => ({ ...p, sort_order: parseInt(e.target.value) || 0 }))} />
                        </div>
                        <div className="space-y-2">
                            <Label>Description</Label>
                            <Textarea value={formData.description} onChange={e => setFormData(p => ({ ...p, description: e.target.value }))} placeholder="What the customer gets…" />
                        </div>
                        <div className="flex items-center gap-2">
                            <Switch checked={formData.is_available} onCheckedChange={c => setFormData(p => ({ ...p, is_available: c }))} />
                            <Label>Available for purchase</Label>
                        </div>
                    </div>
                    <DialogFooter className="flex-shrink-0 pt-2 border-t">
                        <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
                        <Button onClick={handleSave} disabled={isSaving}>
                            {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                            {editing ? 'Update' : 'Create'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Fail & refund confirmation — controlled (iOS-PWA safe, no native confirm) */}
            <Dialog open={!!failConfirm} onOpenChange={(o) => { if (!o) setFailConfirm(null) }}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Mark failed &amp; refund?</DialogTitle>
                        <DialogDescription>
                            {failConfirm?.mode === 'bulk'
                                ? `Mark ${selectedOrders.size} order(s) as failed and refund each buyer's wallet. This cannot be undone.`
                                : "Mark this order as failed and refund the buyer's wallet. This cannot be undone."}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setFailConfirm(null)}>Cancel</Button>
                        <Button
                            variant="destructive"
                            disabled={isBulkUpdating || !!updatingId}
                            onClick={async () => {
                                const fc = failConfirm
                                setFailConfirm(null)
                                if (!fc) return
                                if (fc.mode === 'bulk') await doBulkUpdateStatus('failed')
                                else if (fc.orderId) await doUpdateStatus(fc.orderId, 'failed')
                            }}
                        >
                            Fail &amp; refund
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
