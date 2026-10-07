'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import {
    CheckCircle2, XCircle, Loader2, Eye, Download, Clock,
    Copy, Check, ShieldCheck, Users, LayoutList, Search, Filter, RefreshCw, Ban
} from 'lucide-react'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    format,
    parseISO,
    startOfDay,
    endOfDay,
    subDays,
    startOfWeek,
    startOfMonth,
} from 'date-fns'

// Translate the UI time period into an ISO range. Mirrors app/admin/airtime/page.tsx's periodRange().
function periodRange(timePeriod: string, customStart: string, customEnd: string): { start: string | null; end: string | null } {
    const now = new Date()
    switch (timePeriod) {
        case 'Today':      return { start: startOfDay(now).toISOString(), end: endOfDay(now).toISOString() }
        case 'Yesterday':  return { start: startOfDay(subDays(now, 1)).toISOString(), end: endOfDay(subDays(now, 1)).toISOString() }
        case 'This Week':  return { start: startOfWeek(now).toISOString(), end: endOfDay(now).toISOString() }
        case 'This Month': return { start: startOfMonth(now).toISOString(), end: endOfDay(now).toISOString() }
        case 'Custom':     return customStart && customEnd
            ? { start: startOfDay(new Date(customStart)).toISOString(), end: endOfDay(new Date(customEnd)).toISOString() }
            : { start: null, end: null }
        default:           return { start: null, end: null }
    }
}

function formatDob(dob: string | undefined | null): string {
    if (!dob) return '—'
    try {
        return format(parseISO(dob), 'dd MMM yyyy')
    } catch {
        return dob
    }
}

function resolveApplicantName(app: AfarOrder): string {
    if (app.users) {
        const name = [app.users.first_name, app.users.last_name].filter(Boolean).join(' ').trim()
        if (name) return name
        if (app.users.email) return app.users.email
    }
    return app.source === 'api' ? 'API applicant' : 'Guest'
}

type AfarOrder = {
    id: string
    user_id: string | null
    full_name: string
    phone: string
    id_type?: string
    id_number?: string
    date_of_birth?: string
    ghana_card?: string
    location: string
    region: string
    occupation: string
    status: 'pending' | 'processing' | 'completed' | 'cancelled' | 'refunded'
    notes?: string
    payment_amount?: number
    created_at: string
    source?: 'web' | 'ussd' | 'api' | 'shop' | 'ussd_shop'
    payment_method?: string
    shop_id?: string | null
    cost_price?: number | null
    selling_price?: number | null
    profit?: number | null
    refund_method?: string | null
    refunded_at?: string | null
    // Joined
    users?: { first_name: string | null; last_name: string | null; email: string | null } | null
    shop_profiles?: { shop_name: string | null } | null
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
    pending: { label: 'Pending', color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400', icon: Clock },
    processing: { label: 'Processing', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400', icon: Clock },
    completed: { label: 'Completed', color: 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400', icon: CheckCircle2 },
    cancelled: { label: 'Cancelled', color: 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400', icon: XCircle },
    refunded: { label: 'Refunded', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400', icon: Ban },
}

// One-click copy helper (shows a brief checkmark)
function CopyField({ label, value }: { label: string; value: string }) {
    const [copied, setCopied] = useState(false)
    const copy = () => {
        navigator.clipboard.writeText(value).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1800)
        })
    }
    return (
        <div className="flex items-center justify-between py-2 border-b last:border-0">
            <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
                <p className="text-sm font-medium mt-0.5">{value || '—'}</p>
            </div>
            <button
                onClick={copy}
                className="ml-2 p-1.5 rounded-md hover:bg-muted transition-colors"
                title={`Copy ${label}`}
            >
                {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
            </button>
        </div>
    )
}

export default function AdminAfaManagementPage() {
    const [applications, setApplications] = useState<AfarOrder[]>([])
    // `initialLoading` gates the whole-page spinner (first mount only). `loading` tracks every
    // subsequent filter-driven refetch and is scoped to the table/list area only — a filter click
    // must not unmount the stats cards or the filter row itself. See fix round 1 in task-5-report.md.
    const [initialLoading, setInitialLoading] = useState(true)
    const [loading, setLoading] = useState(true)
    const [selectedApp, setSelectedApp] = useState<AfarOrder | null>(null)
    const [updatingId, setUpdatingId] = useState<string | null>(null)
    const [downloading, setDownloading] = useState(false)
    const [refundingId, setRefundingId] = useState<string | null>(null)
    const [refundConfirmApp, setRefundConfirmApp] = useState<AfarOrder | null>(null)
    const [refreshCooldown, setRefreshCooldown] = useState(0)
    const [isRefreshing, setIsRefreshing] = useState(false)

    // Filter state
    const [searchQuery, setSearchQuery] = useState('')
    const [statusFilter, setStatusFilter] = useState('all')
    const [regionFilter, setRegionFilter] = useState('all')
    const [timePeriod, setTimePeriod] = useState<'All' | 'Today' | 'Yesterday' | 'This Week' | 'This Month' | 'Custom'>('All')
    const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false)
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [sourceFilter, setSourceFilter] = useState<'all' | 'web' | 'ussd' | 'ussd_shop' | 'shop' | 'api'>('all')
    const [paymentFilter, setPaymentFilter] = useState<'all' | 'momo' | 'wallet'>('all')

    const fetchApplications = useCallback(async () => {
        setLoading(true)
        let query = (supabase
            .from('afa_orders') as any)
            .select(`
                *,
                users!afa_orders_user_id_fkey ( first_name, last_name, email ),
                shop_profiles!afa_orders_shop_id_fkey ( shop_name )
            `)
            .order('created_at', { ascending: false })

        if (statusFilter !== 'all') query = query.eq('status', statusFilter)
        if (regionFilter !== 'all') query = query.eq('region', regionFilter)
        if (sourceFilter !== 'all') query = query.eq('source', sourceFilter)
        if (paymentFilter !== 'all') query = query.eq('payment_method', paymentFilter)

        const { start, end } = periodRange(timePeriod, customStart, customEnd)
        if (start) query = query.gte('created_at', start)
        if (end) query = query.lte('created_at', end)

        const { data, error } = await query
        if (!error) setApplications(data || [])
        setLoading(false)
        setInitialLoading(false)
    }, [statusFilter, regionFilter, sourceFilter, paymentFilter, timePeriod, customStart, customEnd])

    useEffect(() => {
        fetchApplications()
    }, [fetchApplications])

    // Cooldown countdown
    useEffect(() => {
        if (refreshCooldown <= 0) return
        const timer = setInterval(() => {
            setRefreshCooldown(prev => (prev <= 1 ? 0 : prev - 1))
        }, 1000)
        return () => clearInterval(timer)
    }, [refreshCooldown])

    const handleManualRefresh = async () => {
        if (isRefreshing || refreshCooldown > 0) return
        setIsRefreshing(true)
        await fetchApplications()
        setIsRefreshing(false)
        setRefreshCooldown(60)
    }

    const updateStatus = async (id: string, status: string) => {
        setUpdatingId(id)
        try {
            // Routed through a real server-side API route rather than a direct
            // supabase-js write: the write now goes through admin gating,
            // allowlist validation, and lib/admin-audit.ts (see
            // app/api/admin/afa-orders/[id]/status/route.ts). The old direct
            // client-side .update() had RLS as its only authorization and left
            // no audit trail — a gap recorded during the API v2 build.
            const res = await fetch(`/api/admin/afa-orders/${id}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            })
            const json = await res.json().catch(() => null)

            if (!res.ok || !json?.success) {
                console.error('Update error:', json?.error)
                toast.error(json?.error || 'Failed to update status. Please check your permissions.')
            } else {
                toast.success(`Status updated to "${status}"`)
                setApplications(prev => prev.map(a => a.id === id ? { ...a, status: status as any } : a))
            }
        } catch (err) {
            console.error('Unexpected error updating status:', err)
            toast.error('An unexpected error occurred while updating.')
        } finally {
            setUpdatingId(null)
        }
    }

    const handleRefund = async (app: AfarOrder, confirmProcessing = false) => {
        setRefundingId(app.id)
        try {
            const res = await fetch(`/api/admin/afa-orders/${app.id}/refund`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirmProcessing }),
            })
            const json = await res.json().catch(() => null)
            if (!res.ok || !json?.success) {
                if (json?.error === 'needs_confirmation') {
                    setRefundConfirmApp(app)
                    return
                }
                toast.error(json?.message || json?.error || 'Refund failed')
                return
            }
            toast.success(json.data?.message || 'Refund processed')
            setApplications(prev => prev.map(a => a.id === app.id ? { ...a, status: 'refunded' } : a))
            setRefundConfirmApp(null)
            if (selectedApp?.id === app.id) setSelectedApp(prev => prev ? { ...prev, status: 'refunded' } : prev)
        } catch (err) {
            console.error('Refund error:', err)
            toast.error('An unexpected error occurred while refunding.')
        } finally {
            setRefundingId(null)
        }
    }

    const handleDownload = async (app: AfarOrder) => {
        setDownloading(true)
        try {
            // Build a clean text file with all form details
            const idNumber = app.id_number || app.ghana_card || 'N/A'
            const idType = app.id_type || 'Ghana Card'
            const lines = [
                '============================================',
                '     MTN AFA REGISTRATION — APPLICATION    ',
                '============================================',
                '',
                `Full Name        : ${app.full_name}`,
                `Phone Number     : ${app.phone}`,
                `ID Type          : ${idType}`,
                `ID Number        : ${idNumber}`,
                ...(app.date_of_birth ? [`Date of Birth    : ${formatDob(app.date_of_birth)}`] : []),
                `Region           : ${app.region}`,
                `City / Town      : ${app.location}`,
                `Occupation       : ${app.occupation || 'Farmer'}`,
                `Notes            : ${app.notes || 'None'}`,
                '',
                `Payment Amount   : GHS ${app.payment_amount?.toFixed(2) ?? '—'}`,
                `Status           : ${app.status.toUpperCase()}`,
                `Submitted On     : ${format(new Date(app.created_at), 'dd MMM yyyy, hh:mm a')}`,
                '',
                '============================================',
                'Submitted via KingFlexy Dashboard',
                '============================================',
            ]

            const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = `AFA_${app.full_name.replace(/\s+/g, '_')}_${app.id.slice(0, 8)}.txt`
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
            URL.revokeObjectURL(url)

            // Auto-update status to "processing" after download
            await updateStatus(app.id, 'processing')
            toast.success('Application downloaded and marked as Processing.')
        } catch (err) {
            toast.error('Download failed')
        } finally {
            setDownloading(false)
        }
    }

    // Stats
    const stats = {
        total: applications.length,
        pending: applications.filter(a => a.status === 'pending').length,
        processing: applications.filter(a => a.status === 'processing').length,
        completed: applications.filter(a => a.status === 'completed').length,
        cancelled: applications.filter(a => a.status === 'cancelled').length,
    }

    if (initialLoading) {
        return (
            <div className="flex items-center justify-center py-24">
                <Loader2 className="w-8 h-8 animate-spin" />
            </div>
        )
    }

    return (
        <div className="space-y-6">

            {/* ─── Page Header ─── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>Admin Console</span>
                    </div>
                    <h1 className="text-2xl font-bold">MTN AFA Applications</h1>
                    <p className="text-sm text-muted-foreground">Manage and process incoming permanent registration applications.</p>
                </div>
                <button
                    onClick={handleManualRefresh}
                    disabled={isRefreshing || refreshCooldown > 0}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors self-start sm:self-center"
                >
                    {isRefreshing ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Refreshing...</>
                    ) : refreshCooldown > 0 ? (
                        <><RefreshCw className="w-3.5 h-3.5" /> Refresh ({refreshCooldown}s)</>
                    ) : (
                        <><RefreshCw className="w-3.5 h-3.5" /> Refresh</>
                    )}
                </button>
            </div>

            {/* ─── Stats Overview ─── */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {[
                    { label: 'Total', value: stats.total, icon: LayoutList, color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-900/20' },
                    { label: 'Pending', value: stats.pending, icon: Clock, color: 'text-yellow-600', bg: 'bg-yellow-50 dark:bg-yellow-900/20' },
                    { label: 'Processing', value: stats.processing, icon: Clock, color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-900/20' },
                    { label: 'Completed', value: stats.completed, icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50 dark:bg-green-900/20' },
                    { label: 'Cancelled', value: stats.cancelled, icon: XCircle, color: 'text-red-600', bg: 'bg-red-50 dark:bg-red-900/20' },
                ].map(s => (
                    <Card key={s.label} className="border shadow-sm">
                        <CardContent className="p-4">
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${s.bg}`}>
                                <s.icon className={`w-4 h-4 ${s.color}`} />
                            </div>
                            <p className="text-xs text-muted-foreground">{s.label}</p>
                            <p className="text-xl font-bold mt-0.5">{s.value}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* ─── Filters ─── */}
            <Card className="border shadow-sm">
                <CardContent className="p-4 flex flex-col sm:flex-row gap-3">
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                            placeholder="Search by name, phone, or ID..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className="pl-9 h-10"
                        />
                    </div>
                    <Select value={regionFilter} onValueChange={setRegionFilter}>
                        <SelectTrigger className="h-10 sm:w-[180px]">
                            <SelectValue placeholder="All Regions" />
                        </SelectTrigger>
                        <SelectContent className="max-h-[300px]">
                            <SelectItem value="all">All Regions</SelectItem>
                            {['Greater Accra', 'Ashanti', 'Western', 'Eastern', 'Central', 'Northern', 'Volta', 'Upper East', 'Upper West', 'Bono', 'Bono East', 'Ahafo', 'Savannah', 'North East', 'Oti', 'Western North'].map(r => (
                                <SelectItem key={r} value={r}>{r}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                        <SelectTrigger className="h-10 sm:w-[180px]">
                            <SelectValue placeholder="All Statuses" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Statuses</SelectItem>
                            <SelectItem value="pending">Pending</SelectItem>
                            <SelectItem value="processing">Processing</SelectItem>
                            <SelectItem value="completed">Completed</SelectItem>
                            <SelectItem value="cancelled">Cancelled</SelectItem>
                            <SelectItem value="refunded">Refunded</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as typeof sourceFilter)}>
                        <SelectTrigger className="h-10 sm:w-[150px]">
                            <SelectValue placeholder="All Sources" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Sources</SelectItem>
                            <SelectItem value="web">Web</SelectItem>
                            <SelectItem value="ussd">USSD</SelectItem>
                            <SelectItem value="ussd_shop">USSD Shop</SelectItem>
                            <SelectItem value="shop">Shop</SelectItem>
                            <SelectItem value="api">API</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={paymentFilter} onValueChange={(v) => setPaymentFilter(v as typeof paymentFilter)}>
                        <SelectTrigger className="h-10 sm:w-[150px]">
                            <SelectValue placeholder="All Payment Methods" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Payments</SelectItem>
                            <SelectItem value="momo">MoMo</SelectItem>
                            <SelectItem value="wallet">Wallet</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={timePeriod} onValueChange={val => {
                        if (val === 'Custom') setIsCustomDialogOpen(true)
                        else setTimePeriod(val as typeof timePeriod)
                    }}>
                        <SelectTrigger className="h-10 sm:w-[150px]">
                            <SelectValue placeholder="Period" />
                        </SelectTrigger>
                        <SelectContent>
                            {(['All', 'Today', 'Yesterday', 'This Week', 'This Month', 'Custom'] as const).map(p => (
                                <SelectItem key={p} value={p}>{p}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardContent>
            </Card>

            {/* ─── Applications Table ─── */}
            <Card>
                <CardHeader className="p-4 border-b">
                    <CardTitle className="text-base flex items-center gap-2">
                        <Users className="w-4 h-4" />
                        Registration Submissions
                    </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    {(() => {
                        // A filter-driven refetch (status/region/source/payment/date change) only
                        // toggles `loading`, not `initialLoading` — scope the spinner to this table
                        // area so the stats cards and filter row above stay mounted throughout.
                        if (loading) {
                            return (
                                <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
                                    <Loader2 className="w-6 h-6 animate-spin" />
                                    <p className="text-sm">Loading applications…</p>
                                </div>
                            )
                        }

                        // Status/region/source/payment/date filters are already applied server-side
                        // in fetchApplications — only the free-text search runs client-side here,
                        // since it spans columns (id_number/ghana_card) that don't index cleanly
                        // into a single Supabase filter.
                        const filteredApps = applications.filter(app => {
                            const q = searchQuery.toLowerCase()
                            const matchSearch = !q ||
                                                app.full_name.toLowerCase().includes(q) ||
                                                app.phone.includes(q) ||
                                                (app.id_number && app.id_number.toLowerCase().includes(q)) ||
                                                (app.ghana_card && app.ghana_card.toLowerCase().includes(q))

                            return matchSearch
                        })

                        if (filteredApps.length === 0) {
                            return (
                                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                                    <ShieldCheck className="w-10 h-10 opacity-20" />
                                    <p className="text-sm">No applications found matching your criteria.</p>
                                </div>
                            )
                        }

                        return (
                            <>
                                {/* Desktop Table */}
                                <div className="hidden md:block overflow-x-auto">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Applicant</TableHead>
                                                <TableHead>ID Type</TableHead>
                                                <TableHead>Location</TableHead>
                                                <TableHead>Fee</TableHead>
                                                <TableHead>Submitted</TableHead>
                                                <TableHead>Status</TableHead>
                                                <TableHead className="text-right">Action</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {filteredApps.map(app => {
                                            const cfg = STATUS_CONFIG[app.status] || STATUS_CONFIG.pending
                                            const StatusIcon = cfg.icon
                                            return (
                                                <TableRow key={app.id} className="hover:bg-muted/30">
                                                    <TableCell>
                                                        <div className="font-medium">{app.full_name}</div>
                                                        <div className="text-xs text-muted-foreground">{app.phone}</div>
                                                        <div className="flex items-center gap-1.5 mt-0.5">
                                                            <span className="text-xs text-muted-foreground">{resolveApplicantName(app)}</span>
                                                            {app.shop_profiles?.shop_name && (
                                                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400">
                                                                    {app.shop_profiles.shop_name}
                                                                </span>
                                                            )}
                                                            {app.source === 'api' && (
                                                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400">
                                                                    API
                                                                </span>
                                                            )}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-sm">
                                                        {app.id_type || 'Ghana Card'}
                                                    </TableCell>
                                                    <TableCell className="text-sm text-muted-foreground">
                                                        {app.location}, {app.region}
                                                    </TableCell>
                                                    <TableCell className="text-sm font-medium">
                                                        {app.payment_amount != null ? `GHS ${app.payment_amount.toFixed(2)}` : '—'}
                                                    </TableCell>
                                                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                                                        {format(new Date(app.created_at), 'dd MMM yyyy')}
                                                    </TableCell>
                                                    <TableCell>
                                                        <div className="flex items-center gap-1.5">
                                                            <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${cfg.color}`}>
                                                                <StatusIcon className="w-3 h-3" />
                                                                {cfg.label}
                                                            </span>
                                                            {app.source === 'ussd' && (
                                                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                                                                    USSD
                                                                </span>
                                                            )}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="gap-1.5"
                                                            onClick={() => setSelectedApp(app)}
                                                        >
                                                            <Eye className="w-3.5 h-3.5" />
                                                            View
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            )
                                        })}
                                    </TableBody>
                                </Table>
                            </div>

                            {/* Mobile Cards */}
                            <div className="md:hidden divide-y">
                                {filteredApps.map(app => {
                                    const cfg = STATUS_CONFIG[app.status] || STATUS_CONFIG.pending
                                    const StatusIcon = cfg.icon
                                    return (
                                        <div key={app.id} className="p-4 flex items-center gap-3 hover:bg-muted/20">
                                            <div className="flex-1 min-w-0">
                                                <p className="font-medium truncate">{app.full_name}</p>
                                                <p className="text-xs text-muted-foreground">{app.phone}</p>
                                                <p className="text-xs text-muted-foreground mt-0.5">{app.id_type || 'Ghana Card'} • {app.location}</p>
                                                <div className="flex items-center gap-1.5 mt-0.5">
                                                    <span className="text-xs text-muted-foreground">{resolveApplicantName(app)}</span>
                                                    {app.shop_profiles?.shop_name && (
                                                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400">
                                                            {app.shop_profiles.shop_name}
                                                        </span>
                                                    )}
                                                    {app.source === 'api' && (
                                                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400">
                                                            API
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-1.5 mt-1">
                                                    <span className={`inline-flex items-center gap-1 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full ${cfg.color}`}>
                                                        <StatusIcon className="w-2.5 h-2.5" />
                                                        {cfg.label}
                                                    </span>
                                                    {app.source === 'ussd' && (
                                                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                                                            USSD
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <Button size="sm" variant="outline" onClick={() => setSelectedApp(app)}>
                                                <Eye className="w-3.5 h-3.5" />
                                            </Button>
                                        </div>
                                    )
                                })}
                            </div>
                            </>
                        )
                    })()}
                </CardContent>
            </Card>

            {/* ─── Application Detail Modal ─── */}
            <Dialog open={!!selectedApp} onOpenChange={(open) => { if (!open) setSelectedApp(null) }}>
                <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                    {selectedApp && (() => {
                        const cfg = STATUS_CONFIG[selectedApp.status] || STATUS_CONFIG.pending
                        const StatusIcon = cfg.icon
                        const idNumber = selectedApp.id_number || selectedApp.ghana_card || 'N/A'
                        const idType = selectedApp.id_type || 'Ghana Card'
                        const isUpdating = updatingId === selectedApp.id

                        return (
                            <>
                                <DialogHeader>
                                    <DialogTitle className="flex items-center gap-2">
                                        <ShieldCheck className="w-5 h-5 text-yellow-500" />
                                        Application Details
                                    </DialogTitle>
                                    <DialogDescription>
                                        MTN AFA Permanent Registration — Submitted {format(new Date(selectedApp.created_at), 'dd MMM yyyy, hh:mm a')}
                                    </DialogDescription>
                                </DialogHeader>

                                {/* Status Badge */}
                                <div className="flex items-center justify-between py-1">
                                    <span className={`inline-flex items-center gap-1.5 text-xs font-bold uppercase px-3 py-1 rounded-full ${cfg.color}`}>
                                        <StatusIcon className="w-3.5 h-3.5" />
                                        {cfg.label}
                                    </span>
                                    {selectedApp.payment_amount != null && (
                                        <span className="text-sm font-semibold text-muted-foreground">
                                            Fee Paid: GHS {selectedApp.payment_amount.toFixed(2)}
                                        </span>
                                    )}
                                </div>

                                {/* Field Data */}
                                <div className="rounded-xl border bg-muted/30 dark:bg-muted/10 px-4 py-1 space-y-0">
                                    <CopyField label="Full Name" value={selectedApp.full_name} />
                                    <CopyField label="Phone Number" value={selectedApp.phone} />
                                    <CopyField label="ID Type" value={idType} />
                                    <CopyField label="ID Number" value={idNumber} />
                                    {selectedApp.date_of_birth && (
                                        <CopyField label="Date of Birth" value={formatDob(selectedApp.date_of_birth)} />
                                    )}
                                    <CopyField label="Region" value={selectedApp.region} />
                                    <CopyField label="City / Town" value={selectedApp.location} />
                                    <CopyField label="Occupation" value={selectedApp.occupation || 'Farmer'} />
                                    {selectedApp.notes && (
                                        <CopyField label="Notes" value={selectedApp.notes} />
                                    )}
                                </div>

                                {selectedApp.shop_id && selectedApp.selling_price != null && (
                                    <div className="rounded-xl border bg-muted/30 dark:bg-muted/10 px-4 py-2 mt-2 text-xs space-y-1">
                                        <div className="flex justify-between"><span className="text-muted-foreground">Cost</span><span>GHS {selectedApp.cost_price?.toFixed(2) ?? '—'}</span></div>
                                        <div className="flex justify-between"><span className="text-muted-foreground">Selling price</span><span>GHS {selectedApp.selling_price?.toFixed(2) ?? '—'}</span></div>
                                        <div className="flex justify-between"><span className="text-muted-foreground">Shop profit</span><span>GHS {selectedApp.profit?.toFixed(2) ?? '—'}</span></div>
                                    </div>
                                )}

                                {/* ─── Download Button ─── */}
                                <Button
                                    className="w-full gap-2 bg-yellow-500 hover:bg-yellow-600 text-white"
                                    onClick={() => handleDownload(selectedApp)}
                                    disabled={downloading}
                                >
                                    {downloading ? (
                                        <><Loader2 className="w-4 h-4 animate-spin" /> Downloading...</>
                                    ) : (
                                        <><Download className="w-4 h-4" /> Download Application & Set Processing</>
                                    )}
                                </Button>

                                {/* ─── Status Controls ─── */}
                                <div className="space-y-2">
                                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Update Status</p>
                                    <div className="grid grid-cols-2 gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5 border-yellow-300 text-yellow-700 hover:bg-yellow-50 dark:border-yellow-800 dark:text-yellow-400 dark:hover:bg-yellow-900/20"
                                            disabled={isUpdating || selectedApp.status === 'pending' || selectedApp.status === 'refunded'}
                                            onClick={() => updateStatus(selectedApp.id, 'pending')}
                                        >
                                            {isUpdating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
                                            Pending
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5 border-blue-300 text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-900/20"
                                            disabled={isUpdating || selectedApp.status === 'processing' || selectedApp.status === 'refunded'}
                                            onClick={() => updateStatus(selectedApp.id, 'processing')}
                                        >
                                            {isUpdating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
                                            Processing
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5 border-green-300 text-green-700 hover:bg-green-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/20"
                                            disabled={isUpdating || selectedApp.status === 'completed' || selectedApp.status === 'refunded'}
                                            onClick={() => updateStatus(selectedApp.id, 'completed')}
                                        >
                                            {isUpdating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                                            Completed
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5 border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
                                            disabled={isUpdating || selectedApp.status === 'cancelled' || selectedApp.status === 'refunded'}
                                            onClick={() => updateStatus(selectedApp.id, 'cancelled')}
                                        >
                                            {isUpdating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                                            Cancelled
                                        </Button>
                                    </div>
                                    {selectedApp.status === 'refunded' && (
                                        <p className="text-xs text-muted-foreground italic">
                                            This order has been refunded — status is locked.
                                        </p>
                                    )}
                                </div>

                                {/* ─── Refund ─── */}
                                {['pending', 'processing', 'completed'].includes(selectedApp.status) && (
                                    <div className="pt-2">
                                        {!selectedApp.shop_id && (selectedApp.payment_method ?? 'momo') !== 'wallet' ? (
                                            <p className="text-xs text-muted-foreground italic">
                                                Refund not available — this was a guest MoMo payment with no wallet or Paystack transaction to reverse. Refund manually via Hubtel.
                                            </p>
                                        ) : (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="w-full gap-1.5 border-purple-300 text-purple-700 hover:bg-purple-50 dark:border-purple-800 dark:text-purple-400 dark:hover:bg-purple-900/20"
                                                disabled={refundingId === selectedApp.id}
                                                onClick={() => handleRefund(selectedApp)}
                                            >
                                                {refundingId === selectedApp.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                                                {selectedApp.shop_id ? 'Refund shop owner (cost)' : 'Refund to wallet'}
                                            </Button>
                                        )}
                                    </div>
                                )}
                            </>
                        )
                    })()}
                </DialogContent>
            </Dialog>

            {/* ─── Custom Date Range Dialog ─── */}
            <Dialog open={isCustomDialogOpen} onOpenChange={setIsCustomDialogOpen}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Custom range</DialogTitle>
                        <DialogDescription>Select a specific date range to filter applications.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="afa-custom-start" className="text-xs font-medium text-muted-foreground">Start date</Label>
                            <Input id="afa-custom-start" type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} className="h-9 text-sm" />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="afa-custom-end" className="text-xs font-medium text-muted-foreground">End date</Label>
                            <Input id="afa-custom-end" type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} className="h-9 text-sm" />
                        </div>
                    </div>
                    <DialogFooter className="gap-2 sm:gap-2">
                        <Button variant="outline" onClick={() => setIsCustomDialogOpen(false)} className="h-9 flex-1">Cancel</Button>
                        <Button
                            onClick={() => { setTimePeriod('Custom'); setIsCustomDialogOpen(false) }}
                            className="h-9 flex-1"
                            disabled={!customStart || !customEnd}
                        >
                            Apply filter
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ─── Refund Confirmation Dialog ─── */}
            <Dialog open={!!refundConfirmApp} onOpenChange={(open) => { if (!open) setRefundConfirmApp(null) }}>
                <DialogContent className="max-w-sm">
                    {refundConfirmApp && (
                        <>
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                    <Ban className="w-5 h-5 text-purple-500" />
                                    Confirm Refund
                                </DialogTitle>
                                <DialogDescription>
                                    This order (<span className="font-medium">{refundConfirmApp.full_name}</span>) is currently <span className="font-medium">processing</span>. Refunding now may reverse a payment for work already underway.
                                </DialogDescription>
                            </DialogHeader>
                            <div className="flex gap-2 pt-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="flex-1"
                                    onClick={() => setRefundConfirmApp(null)}
                                    disabled={refundingId === refundConfirmApp.id}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="flex-1 gap-1.5 border-purple-300 text-purple-700 hover:bg-purple-50 dark:border-purple-800 dark:text-purple-400 dark:hover:bg-purple-900/20"
                                    disabled={refundingId === refundConfirmApp.id}
                                    onClick={() => handleRefund(refundConfirmApp, true)}
                                >
                                    {refundingId === refundConfirmApp.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                                    Refund anyway
                                </Button>
                            </div>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    )
}
