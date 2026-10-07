'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatCurrency, cn } from '@/lib/utils'
import { STATUS_CONFIG, ORDER_STATUSES, getRetryTag, isConfirmReceivedEligible, getSelfCompletedTag } from '@/lib/order-status'
import { pageToRange, escapeLikePattern, ORDER_HISTORY_PAGE_SIZE } from '@/lib/pagination'
import { PaginationControls } from '@/components/shared/pagination-controls'
import { NetworkIcon } from '@/components/network-icon'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RefundConfirm } from '@/components/refunds/RefundConfirm'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    Phone,
    ShoppingCart,
    Loader2,
    MessageSquare,
    Wifi,
    AlertTriangle,
    RefreshCw,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { Order, DataPackage, Complaint } from '@/types/supabase'
import { format, differenceInHours } from 'date-fns'


interface OrderWithComplaints extends Order {
    complaints?: Complaint[]
}

const NETWORKS = ['All', 'MTN', 'Telecel', 'AT-iShare', 'AT-BigTime']
const TIME_PERIODS = ['Today', 'Yesterday', 'This Week', 'This Month', 'Custom']

// Trimmed to exactly the columns this page reads (see getRetryTag, getProductName,
// and the order-card JSX) instead of select('*') — smaller payload per page load.
const ORDER_SELECT = 'id, network, phone_number, price, reference_code, shop_order_id, size, source, status, created_at, updated_at, payment_status, category, retry_count, retry_from_status, retry_of_order_id, retried_by_role, self_completed_at, self_completed_by_role, complaints(id, status)'

interface MyOrderStatsRow {
    total_count: number
    pending_count: number
    queued_count: number
    processing_count: number
    completed_count: number
    failed_count: number
    refunded_count: number
    total_amount: number
    total_data_gb: number
}

export default function MyOrdersPage() {
    const { dbUser } = useAuth()
    const [orders, setOrders] = useState<OrderWithComplaints[]>([])
    const [totalCount, setTotalCount] = useState(0)
    const [page, setPage] = useState(1)
    const [statusCounts, setStatusCounts] = useState<Record<string, number>>({ All: 0 })
    const [stats, setStats] = useState({ totalOrders: 0, totalAmount: 0, totalData: '0' })

    const [initialLoading, setInitialLoading] = useState(true)
    const [isLoading, setIsLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState('')
    const [debouncedSearch, setDebouncedSearch] = useState('')
    const [networkFilter, setNetworkFilter] = useState('All')
    const [statusFilter, setStatusFilter] = useState('All')
    const [timePeriod, setTimePeriod] = useState('Today')
    const [categoryFilter, setCategoryFilter] = useState<'All' | 'data' | 'mtn_mashup'>('All')
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false)

    // Complaint dialog — creates a support thread linked to the order
    const [complaintOrder, setComplaintOrder] = useState<Order | null>(null)
    const [complaintDescription, setComplaintDescription] = useState('')
    const [complaintPhone, setComplaintPhone] = useState('')
    const [complaintWhatsapp, setComplaintWhatsapp] = useState('')
    const [isSubmitting, setIsSubmitting] = useState(false)
    // order_id → support thread status, for the "Complaint: …" chip on order cards
    const [orderThreads, setOrderThreads] = useState<Record<string, { id: string; status: string }>>({})

    // Debounce the phone search before it drives a server query — search is now
    // server-side (ilike), so firing a request per keystroke would hammer the DB.
    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 350)
        return () => clearTimeout(t)
    }, [searchQuery])

    // Any filter change resets to page 1 — paging stays meaningful only within a fixed filter set.
    useEffect(() => {
        setPage(1)
    }, [debouncedSearch, networkFilter, statusFilter, timePeriod, categoryFilter, customStart, customEnd])

    useEffect(() => {
        if (dbUser) {
            fetchData(page)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dbUser, page, debouncedSearch, networkFilter, statusFilter, timePeriod, categoryFilter, customStart, customEnd])

    // Resolves the active time-period selection into concrete bounds for the server query.
    // Previously this filter ran client-side over a fetch hard-capped at the last 30 days,
    // so "This Month" or a Custom range further back silently showed incomplete data —
    // resolving real bounds server-side fixes that as a side effect.
    const getDateBounds = () => {
        const now = new Date()
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const yesterday = new Date(today)
        yesterday.setDate(yesterday.getDate() - 1)
        const weekStart = new Date(today)
        weekStart.setDate(weekStart.getDate() - weekStart.getDay())
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
        const epoch = new Date('2000-01-01')
        const farFuture = new Date('2100-01-01')

        switch (timePeriod) {
            case 'Today':
                return { from: today, to: farFuture }
            case 'Yesterday':
                return { from: yesterday, to: today }
            case 'This Week':
                return { from: weekStart, to: farFuture }
            case 'This Month':
                return { from: monthStart, to: farFuture }
            case 'Custom': {
                if (!customStart || !customEnd) return { from: epoch, to: farFuture }
                const start = new Date(customStart)
                const end = new Date(customEnd)
                end.setHours(23, 59, 59, 999)
                return { from: start, to: end }
            }
            case 'All':
            default:
                return { from: epoch, to: farFuture }
        }
    }

    const fetchData = async (pageNum: number = page) => {
        if (!dbUser) return
        setIsLoading(true)
        try {
            const { from: dateFrom, to: dateTo } = getDateBounds()
            const { from, to } = pageToRange(pageNum)
            const searchPattern = debouncedSearch ? escapeLikePattern(debouncedSearch) : null

            let query = supabase
                .from('orders')
                .select(ORDER_SELECT, { count: 'exact' })
                .eq('user_id', dbUser.id as any)
                .is('shop_order_id', null) // Exclude mirrored shop orders from storefront
                .gte('created_at', dateFrom.toISOString())
                .lte('created_at', dateTo.toISOString())

            if (networkFilter !== 'All') query = query.eq('network', networkFilter)
            if (categoryFilter !== 'All') query = query.eq('category', categoryFilter)
            if (statusFilter !== 'All') query = query.eq('status', statusFilter)
            if (searchPattern) query = query.ilike('phone_number', `%${searchPattern}%`)

            const { data, error, count } = await query
                .order('created_at', { ascending: false })
                .range(from, to)

            if (error) throw error
            setOrders((data as any) || [])
            setTotalCount(count || 0)

            // Stats + per-status counts across the FULL filtered set (everything except
            // status, so the chip counts stay accurate no matter which chip is active) —
            // not just the current page.
            const { data: statsRow, error: statsErr } = await (supabase as any)
                .rpc('get_my_orders_stats', {
                    p_user_id: dbUser.id,
                    p_date_from: dateFrom.toISOString(),
                    p_date_to: dateTo.toISOString(),
                    p_network: networkFilter === 'All' ? null : networkFilter,
                    p_category: categoryFilter === 'All' ? null : categoryFilter,
                    p_search: searchPattern,
                })
                .maybeSingle()

            if (!statsErr && statsRow) {
                const s = statsRow as MyOrderStatsRow
                setStatusCounts({
                    All: Number(s.total_count) || 0,
                    pending: Number(s.pending_count) || 0,
                    queued: Number(s.queued_count) || 0,
                    processing: Number(s.processing_count) || 0,
                    completed: Number(s.completed_count) || 0,
                    failed: Number(s.failed_count) || 0,
                    refunded: Number(s.refunded_count) || 0,
                })
                const totalDataGB = Number(s.total_data_gb) || 0
                setStats({
                    totalOrders: Number(s.total_count) || 0,
                    totalAmount: Number(s.total_amount) || 0,
                    totalData: totalDataGB.toFixed(totalDataGB >= 1 ? 0 : 2),
                })
            }

            // Support threads linked to orders on THIS page (RLS-scoped to this user)
            const orderIds = (data || []).map((o: any) => o.id)
            if (orderIds.length > 0) {
                const { data: threadRows } = await (supabase as any)
                    .from('support_threads')
                    .select('id, order_id, status')
                    .in('order_id', orderIds)
                const map: Record<string, { id: string; status: string }> = {}
                for (const t of threadRows || []) {
                    if (t.order_id) map[t.order_id] = { id: t.id, status: t.status }
                }
                setOrderThreads(map)
            } else {
                setOrderThreads({})
            }
        } catch (error) {
            console.error('Error fetching data:', error)
            toast.error('Failed to load orders')
        } finally {
            setIsLoading(false)
            setInitialLoading(false)
        }
    }

    // Complaint eligibility = within 48h of DELIVERY (completion), not order placement.
    // Callers pass updated_at for completed orders so manually-fulfilled products
    // (e.g. Special MTN Mashup) that complete long after creation still get the window.
    const isWithin48Hours = (timestamp: string) => {
        const ref = new Date(timestamp)
        const now = new Date()
        return differenceInHours(now, ref) < 48
    }

    // Get product name based on category/network for consistent display
    const getProductName = (order: Order) => {
        // Special MTN Mashup orders are a curated category, not a plain data bundle.
        if ((order as any).category === 'mtn_mashup') return 'Special MTN Mashup'
        const networkNames: Record<string, string> = {
            'MTN': 'MTN Data Bundle',
            'Telecel': 'Telecel Data Bundle',
            'AT-iShare': 'AT Premium Bundle',
            'AT-BigTime': 'AT BigTime Bundle',
        }
        return networkNames[order.network] || `${order.network} Bundle`
    }

    const handleComplaint = (order: Order) => {
        setComplaintOrder(order)
        setComplaintDescription('')
        setComplaintPhone((dbUser as any)?.phone_number || '')
        setComplaintWhatsapp('')
    }

    // Self-service refund for the user's OWN pending, non-shop orders. Idempotent server-side;
    // throws on failure so the RefundConfirm panel stays open for a retry.
    const handleSelfRefund = async (order: OrderWithComplaints, reason: string) => {
        const response = await fetch('/api/user/orders/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: order.id, reason }),
        })
        const json = await response.json().catch(() => ({}))
        if (!response.ok || !json?.success) {
            toast.error(json?.error || 'Refund failed. Please try again.')
            throw new Error(json?.error || 'refund_failed')
        }
        setOrders(prev => Array.isArray(prev)
            ? prev.map(o => o.id === order.id ? { ...o, status: 'refunded', payment_status: 'refunded' } : o)
            : prev)
        toast.success('Refunded to your wallet.')
    }

    // Self-service retry for the user's OWN refunded orders (gated on status alone — the
    // server decides true ownership, since ussd_shop orders carry the USSD caller in user_id
    // while the shop owner is the rightful retrier). Retrying a refunded order creates a BRAND
    // NEW order row, so on success we refetch the whole list instead of mutating in place —
    // the original row stays 'refunded' (now tagged as retried) alongside the new pending row.
    const [retryTarget, setRetryTarget] = useState<OrderWithComplaints | null>(null)
    const [retryBusy, setRetryBusy] = useState(false)

    const handleRetry = (order: OrderWithComplaints) => {
        setRetryTarget(order)
    }

    const submitRetry = async () => {
        if (!retryTarget || retryBusy) return
        setRetryBusy(true)
        try {
            const response = await fetch('/api/orders/retry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: retryTarget.id }),
            })
            const result = await response.json().catch(() => ({}))

            if (!response.ok || !result?.success) {
                const outcome = result?.outcome as string | undefined
                // result.retryAfter is an ISO timestamp (lib/retry-service.ts uses
                // .toISOString()), not a seconds count — convert to a remaining-seconds
                // delta from now, floored at 0, before interpolating.
                const retryAfterSeconds = result?.retryAfter
                    ? Math.max(0, Math.ceil((new Date(result.retryAfter).getTime() - Date.now()) / 1000))
                    : null
                const messages: Record<string, string> = {
                    insufficient_balance: `Insufficient wallet balance to fund this retry${result?.required != null && result?.available != null
                        ? ` — needs GHS ${Number(result.required).toFixed(2)}, wallet has GHS ${Number(result.available).toFixed(2)}`
                        : ''
                        }.`,
                    retry_locked: `This order is locked from further retries${result?.until ? ` — try again after ${new Date(result.until).toLocaleString()}` : ', try again later'
                        }.`,
                    retry_too_soon: `Please wait a bit before retrying this order again${retryAfterSeconds != null ? ` (try again in ${retryAfterSeconds}s)` : ''}.`,
                    paystack_refund_no_wallet: "This order was refunded to your card via Paystack — there is no wallet to charge for a retry.",
                    not_retryable: result?.currentStatus ? `This order is currently "${result.currentStatus}" and can't be retried.` : 'This order is not in a retryable state.',
                    admin_only: result?.error || 'This order can only be retried by an admin.',
                    not_owner: result?.error || 'You are not authorized to retry this order.',
                    duplicate_attempt: 'This retry was already submitted — please refresh and check the order status before trying again.',
                    retry_already_in_progress: 'A previous retry for this order already succeeded or is in progress — refresh to see its current status.',
                    owner_not_found: 'Could not find the shop owner to fund this retry. Contact support.',
                    no_wallet_user: 'This order has no wallet to charge for a retry. Contact support.',
                    invalid_charge_amount: 'Could not determine a valid retry price for this order. Contact support.',
                    invalid_actor_role: 'You are not authorized to perform this action.',
                }
                throw new Error((outcome && messages[outcome]) || result?.error || 'Failed to retry order')
            }

            const data = result.data
            toast.success(
                data?.message ||
                (data?.chargedAmount != null ? `Retry dispatched — ${formatAmount(Number(data.chargedAmount))} charged` : 'Order retry dispatched')
            )
            setRetryTarget(null)
            fetchData()
        } catch (error: any) {
            console.error('Retry error:', error)
            toast.error(error?.message || 'Failed to retry order')
        } finally {
            setRetryBusy(false)
        }
    }

    // Self-service "Confirm Received" for the user's OWN processing orders —
    // gated on status alone (isConfirmReceivedEligible), mirrors the retry
    // dialog's controlled-Dialog pattern (no native confirm(), iOS-PWA safe).
    const [confirmTarget, setConfirmTarget] = useState<OrderWithComplaints | null>(null)
    const [confirmBusy, setConfirmBusy] = useState(false)

    const handleConfirmReceived = (order: OrderWithComplaints) => {
        setConfirmTarget(order)
    }
    const submitConfirmReceived = async () => {
        if (!confirmTarget || confirmBusy) return
        setConfirmBusy(true)
        try {
            const response = await fetch('/api/orders/confirm-received', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: confirmTarget.id }),
            })
            const result = await response.json().catch(() => ({}))
            if (!response.ok || !result?.success) {
                const messages: Record<string, string> = {
                    not_eligible: result?.currentStatus
                        ? `This order is currently "${result.currentStatus}" and can't be confirmed received.`
                        : 'This order is not eligible to be marked complete.',
                    not_owner: result?.error || 'You are not authorized to confirm this order.',
                    order_not_found: 'Order not found — it may have already been updated. Please refresh.',
                }
                const outcome = result?.outcome as string | undefined
                throw new Error((outcome && messages[outcome]) || result?.error || 'Failed to confirm order received')
            }
            toast.success(result?.data?.outcome === 'already_completed'
                ? 'This order was already marked complete'
                : 'Order marked as completed — thanks for confirming!')
            setConfirmTarget(null)
            fetchData()
        } catch (error: any) {
            console.error('Confirm received error:', error)
            toast.error(error?.message || 'Failed to confirm order received')
        } finally {
            setConfirmBusy(false)
        }
    }

    const GH_PHONE_RE = /^(0|\+233)[2-9][0-9]{8}$/

    const submitComplaint = async () => {
        if (!complaintOrder || !complaintDescription) return
        if (!GH_PHONE_RE.test(complaintPhone.trim())) { toast.error('Enter a valid phone number'); return }
        if (!GH_PHONE_RE.test(complaintWhatsapp.trim())) { toast.error('Enter a valid WhatsApp number'); return }

        setIsSubmitting(true)
        try {
            const response = await fetch('/api/support/threads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    order_id: complaintOrder.id,
                    subject: `Issue with order ${complaintOrder.reference_code}`,
                    category: 'order',
                    message: complaintDescription,
                    phone_number: complaintPhone.trim(),
                    whatsapp_number: complaintWhatsapp.trim(),
                })
            })

            const json = await response.json().catch(() => ({}))
            if (!response.ok || !json?.success) {
                throw new Error(json?.error || 'Failed to submit complaint')
            }

            toast.success('Complaint submitted — track the conversation in Support & Complaints')
            setOrderThreads(prev => ({ ...prev, [complaintOrder.id]: { id: json.data.thread.id, status: 'open' } }))
            setComplaintOrder(null)
        } catch (error: any) {
            toast.error(error?.message || 'Failed to submit complaint')
        } finally {
            setIsSubmitting(false)
        }
    }

    const getStatusBadgeClass = (status: string) => {
        switch (status) {
            case 'completed':
                return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
            case 'processing':
                return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
            case 'failed':
                return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
            case 'refunded':
                return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
            case 'queued':
                return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
            case 'pending':
                return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
            default:
                return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
        }
    }

    // const getNetworkIcon = (network: string) => { ... } // Removed

    const formatOrderDate = (dateStr: string) => {
        return format(new Date(dateStr), 'MMM dd, yyyy HH:mm')
    }

    // Format amount for display (no truncation)
    const formatAmount = (amount: number) => {
        return `₵${amount.toFixed(2)}`
    }

    if (initialLoading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="space-y-6 pb-8">
            {/* Header */}
            <div className="text-center space-y-1 relative">
                <h1 className="text-2xl font-bold">My Order History</h1>
                <p className="text-sm text-muted-foreground">View and manage your order transactions</p>

            </div>

            {/* Summary Stats - Yellow/Gold Theme */}
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
                <div className="bg-[#1a1a1a] rounded-xl p-3 sm:p-4 text-center text-white">
                    <p className="text-base sm:text-lg font-bold">{stats.totalOrders}</p>
                    <p className="text-[10px] sm:text-xs text-gray-400">Total Orders</p>
                </div>
                <div className="bg-[#FACC15] rounded-xl p-3 sm:p-4 text-center text-black">
                    <p className="text-base sm:text-lg font-bold">{formatAmount(stats.totalAmount)}</p>
                    <p className="text-[10px] sm:text-xs text-black/70">Total Amount</p>
                </div>
                <div className="bg-[#1a1a1a] rounded-xl p-3 sm:p-4 text-center text-white">
                    <p className="text-base sm:text-lg font-bold">{stats.totalData} GB</p>
                    <p className="text-[10px] sm:text-xs text-gray-400">Total Data</p>
                </div>
            </div>

            {/* Status filter cards — 3 per row; tap to filter, tap the active one to clear */}
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
                {ORDER_STATUSES.map((s) => {
                    const cfg = STATUS_CONFIG[s]
                    const Icon = cfg.Icon
                    const active = statusFilter === s
                    return (
                        <button
                            key={s}
                            onClick={() => setStatusFilter(active ? 'All' : s)}
                            className={cn(
                                'rounded-xl border p-3 text-left transition-all active:scale-95',
                                active
                                    ? cn(cfg.cardBg, 'ring-2 ring-foreground/20 border-transparent')
                                    : 'bg-card border-border hover:border-muted-foreground/30'
                            )}
                        >
                            <Icon className={cn('w-4 h-4 mb-1.5', cfg.iconColor)} />
                            <p className={cn('text-lg sm:text-xl font-bold leading-none', active && cfg.iconColor)}>{statusCounts[s] ?? 0}</p>
                            <p className="text-[11px] text-muted-foreground mt-1 truncate">{cfg.label}</p>
                        </button>
                    )
                })}
            </div>

            {/* Time Period Filters — All in one row, compact/abbreviated to fit 6 on mobile */}
            <div className="grid grid-cols-6 gap-1 sm:gap-2">
                {([['All', 'All'], ['Today', 'Today'], ['Yesterday', 'Yest.'], ['This Week', 'Week'], ['This Month', 'Month']] as const).map(([value, label]) => (
                    <button
                        key={value}
                        onClick={() => setTimePeriod(value)}
                        className={`px-1 py-2 text-[10px] sm:text-xs rounded-lg border transition-all whitespace-nowrap overflow-hidden text-ellipsis ${timePeriod === value
                            ? 'bg-[#1a1a1a] text-white border-[#1a1a1a] dark:bg-[#FACC15] dark:text-black dark:border-[#FACC15]'
                            : 'bg-transparent border-gray-300 dark:border-gray-600 hover:border-gray-500'
                            }`}
                    >
                        {label}
                    </button>
                ))}
                <button
                    onClick={() => setIsCustomDialogOpen(true)}
                    className={`px-1 py-2 text-[10px] sm:text-xs rounded-lg border transition-all whitespace-nowrap overflow-hidden text-ellipsis ${timePeriod === 'Custom'
                        ? 'bg-[#1a1a1a] text-white border-[#1a1a1a] dark:bg-[#FACC15] dark:text-black dark:border-[#FACC15]'
                        : 'bg-transparent border-gray-300 dark:border-gray-600 hover:border-gray-500'
                        }`}
                >
                    {timePeriod === 'Custom' && customStart && customEnd
                        ? `${new Date(customStart).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}-${new Date(customEnd).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}`
                        : 'Custom'}
                </button>
            </div>

            {/* Custom Range Inputs REMOVED - using Dialog now */}


            {/* Filters */}
            <div id="order-filters" className="space-y-4">
                {/* Search by Phone */}
                <div className="space-y-2">
                    <Label className="text-sm font-medium">Search by Phone</Label>
                    <div className="relative">
                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                            placeholder="Enter phone number"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-10"
                        />
                    </div>
                </div>

                {/* Category Segment Filter */}
                <div className="flex bg-gray-100 dark:bg-zinc-800 rounded-xl p-1 gap-1">
                    {([['All', 'All'], ['data', 'Data'], ['mtn_mashup', 'MTN Mashup']] as const).map(([val, label]) => (
                        <button
                            key={val}
                            onClick={() => setCategoryFilter(val)}
                            className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all duration-150 ${
                                categoryFilter === val
                                    ? 'bg-white dark:bg-zinc-900 text-foreground shadow-sm'
                                    : 'text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {/* Filter Dropdowns — status dropdown stays in sync with the cards above */}
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label className="text-sm font-medium">Filter by Status</Label>
                        <Select value={statusFilter} onValueChange={setStatusFilter}>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="All Statuses" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="All">All Statuses</SelectItem>
                                {ORDER_STATUSES.map((status) => (
                                    <SelectItem key={status} value={status}>
                                        {STATUS_CONFIG[status].label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label className="text-sm font-medium">Filter by Network</Label>
                        <Select value={networkFilter} onValueChange={setNetworkFilter}>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="All Networks" />
                            </SelectTrigger>
                            <SelectContent>
                                {NETWORKS.map((network) => (
                                    <SelectItem key={network} value={network}>
                                        {network === 'All' ? 'All Networks' : network}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </div>

            {/* Order Cards */}
            <div id="orders-table" className="space-y-4">
                {isLoading ? (
                    <Card className="shadow-md dark:shadow-gray-900/50">
                        <CardContent className="py-12 text-center">
                            <Loader2 className="w-8 h-8 mx-auto text-muted-foreground animate-spin" />
                        </CardContent>
                    </Card>
                ) : orders.length === 0 ? (
                    <Card className="shadow-md dark:shadow-gray-900/50">
                        <CardContent className="py-12 text-center">
                            <ShoppingCart className="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
                            <p className="text-muted-foreground">No orders found</p>
                        </CardContent>
                    </Card>
                ) : (
                    orders.map((order) => (
                        <Card key={order.id} className="overflow-hidden border shadow-md hover:shadow-lg transition-shadow dark:shadow-gray-900/50 dark:hover:shadow-gray-900/70">
                            <CardContent className="p-4 space-y-4">
                                {/* Header Row */}
                                <div className="flex items-start justify-between">
                                    <div className="flex items-center gap-3">
                                        <NetworkIcon network={order.network} size={48} />
                                        <div>
                                            <p className="font-semibold text-base">{getProductName(order)}</p>
                                            <p className="text-sm text-muted-foreground">{order.phone_number}</p>
                                        </div>
                                    </div>
                                    <div className="flex flex-col items-end gap-1">
                                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${getStatusBadgeClass(order.status ?? 'pending')}`}>
                                            {(order.status ?? 'pending').charAt(0).toUpperCase() + (order.status ?? 'pending').slice(1)}
                                        </span>
                                        {(() => {
                                            const retryTag = getRetryTag(order as any)
                                            const selfCompletedTag = getSelfCompletedTag(order as any)
                                            return selfCompletedTag ? (
                                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium uppercase ${selfCompletedTag.badge}`}>
                                                    {selfCompletedTag.label}
                                                </span>
                                            ) : retryTag ? (
                                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium uppercase ${retryTag.badge}`}>
                                                    {retryTag.label}
                                                </span>
                                            ) : null
                                        })()}
                                    </div>
                                </div>

                                {/* Details */}
                                <div className="space-y-2 text-sm border-t border-b py-3">
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Order Date:</span>
                                        <span className="font-medium">{formatOrderDate(order.created_at ?? '')}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Data Bundle:</span>
                                        <span className="font-medium">{order.size}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Amount:</span>
                                        <span className="font-medium">{formatCurrency(order.price)}</span>
                                    </div>
                                </div>

                                {/* Reference code + source badge */}
                                {order.reference_code && (
                                    <div className="flex items-center gap-2 -mt-1">
                                        <span className={cn(
                                            "inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide",
                                            order.source === 'api'
                                                ? "bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300"
                                                : "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
                                        )}>
                                            {order.source === 'api' ? 'API' : 'Web'}
                                        </span>
                                        <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">{order.reference_code}</span>
                                    </div>
                                )}

                                {/* Footer - Show complain button for orders within 24 hours */}
                                <div className="flex items-center justify-between">
                                    <span className="text-sm text-muted-foreground">{order.status}</span>
                                    {/* Action Area */}
                                    {orderThreads[order.id] || (order.complaints && order.complaints.length > 0) ? (
                                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 border border-blue-100 dark:border-blue-800">
                                            <MessageSquare className="w-3.5 h-3.5" />
                                            <span className="text-xs font-medium capitalize">
                                                Complaint: {(orderThreads[order.id]?.status
                                                    ?? order.complaints?.[0]?.status
                                                    ?? 'pending').replace('_', ' ')}
                                            </span>
                                        </div>
                                    ) : (order.status === 'pending' || order.status === 'queued') && !order.shop_order_id ? (
                                        <RefundConfirm
                                            label="Refund"
                                            confirmLabel="Refund to my wallet"
                                            warning="This will cancel the pending order and credit the amount back to your wallet."
                                            onConfirm={(reason) => handleSelfRefund(order, reason)}
                                        />
                                    ) : order.status === 'refunded' ? (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => handleRetry(order)}
                                            className="text-blue-600 border-blue-200 hover:bg-blue-50 dark:text-blue-400 dark:border-blue-800 dark:hover:bg-blue-900/20"
                                        >
                                            <RefreshCw className="w-4 h-4 mr-1" />
                                            Retry
                                        </Button>
                                    ) : isConfirmReceivedEligible(order as any) ? (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => handleConfirmReceived(order)}
                                        >
                                            Confirm Received
                                        </Button>
                                    ) : (
                                        order.status === 'completed' && isWithin48Hours(order.updated_at ?? order.created_at ?? '') && (
                                            <Button
                                                id="complaint-button"
                                                size="sm"
                                                variant="outline"
                                                onClick={() => handleComplaint(order)}
                                                className="text-orange-600 border-orange-200 hover:bg-orange-50 dark:text-orange-400 dark:border-orange-800 dark:hover:bg-orange-900/20"
                                            >
                                                <MessageSquare className="w-4 h-4 mr-1" />
                                                Complain
                                            </Button>
                                        )
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    ))
                )}
            </div>

            <PaginationControls
                page={page}
                pageSize={ORDER_HISTORY_PAGE_SIZE}
                totalCount={totalCount}
                onPageChange={setPage}
                loading={isLoading}
            />

            {/* Complaint Dialog */}
            <Dialog open={!!complaintOrder} onOpenChange={() => setComplaintOrder(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>File a Complaint</DialogTitle>
                        <DialogDescription>
                            Describe the issue with your order
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="p-4 rounded-xl bg-muted/50 text-sm">
                            <div className="flex justify-between">
                                <span>Phone:</span>
                                <span>{complaintOrder?.phone_number}</span>
                            </div>
                            <div className="flex justify-between mt-1">
                                <span>Package:</span>
                                <span>{complaintOrder?.size}</span>
                            </div>
                            <div className="flex justify-between mt-1">
                                <span>Amount:</span>
                                <span>{formatCurrency(complaintOrder?.price || 0)}</span>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>Description</Label>
                            <Textarea
                                placeholder="Describe your issue..."
                                value={complaintDescription}
                                onChange={(e) => setComplaintDescription(e.target.value)}
                                rows={4}
                            />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="space-y-2">
                                <Label>Phone number</Label>
                                <Input
                                    value={complaintPhone}
                                    onChange={(e) => setComplaintPhone(e.target.value)}
                                    placeholder="0241234567"
                                    inputMode="tel"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>WhatsApp number</Label>
                                <Input
                                    value={complaintWhatsapp}
                                    onChange={(e) => setComplaintWhatsapp(e.target.value)}
                                    placeholder="0241234567"
                                    inputMode="tel"
                                />
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Our team replies in Support &amp; Complaints. We may reach you on WhatsApp if we need more details.
                        </p>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setComplaintOrder(null)}>
                            Cancel
                        </Button>
                        <Button onClick={submitComplaint} disabled={isSubmitting || !complaintDescription}>
                            {isSubmitting ? (
                                <>
                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                    Submitting...
                                </>
                            ) : (
                                'Submit Complaint'
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Retry confirm dialog — controlled, iOS-PWA safe (no native confirm) */}
            <Dialog open={!!retryTarget} onOpenChange={(o) => { if (!o && !retryBusy) setRetryTarget(null) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Retry order</DialogTitle>
                        <DialogDescription>
                            {retryTarget?.reference_code ? `Ref ${retryTarget.reference_code} · ` : ''}{retryTarget?.size} · {retryTarget?.phone_number}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md p-2.5">
                            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                            <span>Today&apos;s price will be charged to your wallet — this may differ from what you originally paid. You&apos;ll see the exact amount charged once the retry succeeds.</span>
                        </div>
                        <div className="flex items-start gap-2 text-sm text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-md p-2.5">
                            <RefreshCw className="w-4 h-4 mt-0.5 shrink-0" />
                            <span>For MTN numbers, we recommend waiting 24 hours after a failed order before retrying, so the number can be verified into the MTN UP2U account.</span>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setRetryTarget(null)} disabled={retryBusy}>Cancel</Button>
                        <Button onClick={submitRetry} disabled={retryBusy}>
                            {retryBusy ? 'Retrying…' : 'Confirm retry'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Confirm-received dialog — controlled, iOS-PWA safe (no native confirm) */}
            <Dialog open={!!confirmTarget} onOpenChange={(o) => { if (!o && !confirmBusy) setConfirmTarget(null) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Confirm order received?</DialogTitle>
                        <DialogDescription>
                            {confirmTarget?.reference_code ? `Ref ${confirmTarget.reference_code} · ` : ''}{confirmTarget?.size} · {confirmTarget?.phone_number}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="text-sm text-muted-foreground space-y-2">
                        <span>Did the customer confirm they received this order before marking it complete? This can&apos;t be undone.</span>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirmTarget(null)} disabled={confirmBusy}>Cancel</Button>
                        <Button onClick={submitConfirmReceived} disabled={confirmBusy}>
                            {confirmBusy ? 'Confirming…' : 'Yes, mark complete'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Custom Date Filter Dialog */}
            <Dialog open={isCustomDialogOpen} onOpenChange={setIsCustomDialogOpen}>
                <DialogContent className="sm:max-w-sm rounded-[24px]">
                    <DialogHeader>
                        <DialogTitle>Select Date Range</DialogTitle>
                        <DialogDescription>
                            Filter your order history by date.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="u-start">Start Date</Label>
                            <Input
                                id="u-start"
                                type="date"
                                value={customStart}
                                onChange={(e) => setCustomStart(e.target.value)}
                                className="rounded-xl"
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="u-end">End Date</Label>
                            <Input
                                id="u-end"
                                type="date"
                                value={customEnd}
                                onChange={(e) => setCustomEnd(e.target.value)}
                                className="rounded-xl"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsCustomDialogOpen(false)} className="rounded-xl">Cancel</Button>
                        <Button
                            onClick={() => {
                                if (customStart && customEnd) {
                                    setTimePeriod('Custom')
                                    setIsCustomDialogOpen(false)
                                } else {
                                    toast.error('Please select both dates')
                                }
                            }}
                            className="rounded-xl bg-[#1a1a1a] text-white hover:bg-black dark:bg-[#FACC15] dark:text-black dark:hover:bg-yellow-500"
                        >
                            Apply Filter
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div >
    )
}
