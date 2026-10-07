'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatCurrency, cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
    ShoppingCart, Clock, CheckCircle2, XCircle, TrendingUp,
    Search, ArrowLeft, AlertCircle, RefreshCcw, MessageSquare, Loader2, FileText, Coins, Smartphone, Hourglass, RefreshCw, AlertTriangle, IdCard, Ban, Zap
} from 'lucide-react'

// Mashup orders share airtime's shape (package_id == null); distinguish by
// package_size, same detection the storefront success page already uses.
const isMashupOrder = (packageSize?: string | null) => !!packageSize?.toLowerCase().includes('mashup')
import { toast } from '@/lib/toast'
import Link from 'next/link'
import { format, differenceInHours } from 'date-fns'
import { getRetryTag, isConfirmReceivedEligible, getSelfCompletedTag } from '@/lib/order-status'
import { pageToRange, escapeLikePattern, ORDER_HISTORY_PAGE_SIZE } from '@/lib/pagination'
import { PaginationControls } from '@/components/shared/pagination-controls'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { MomoDetailsModal } from '@/components/shared/momo-details-modal'
import { isMomoLookupEligible } from '@/lib/momo-eligibility'
import { UTILITY_BILLER_KEYS, UTILITY_BILLERS, type UtilityBiller } from '@/lib/hubtel-utility/billers'

interface ShopOrder {
    id: string
    guest_phone: string
    network?: string
    package_size?: string
    type_name?: string
    quantity?: number
    selling_price: number
    profit: number
    status: string
    created_at: string
    order_type?: string
    package_id?: string | null
    is_rc?: boolean
    is_utility?: boolean
    biller?: UtilityBiller
    // 'ussd' (data/airtime) or 'ussd_shop' (results checker) = sold via USSD;
    // 'website'/null = sold online. Drives the USSD tag in the table.
    source?: string
    reference_code?: string
    orders?: {
        id: string
        status?: string
        refunded_at?: string | null
        retry_count?: number | null
        retry_from_status?: string | null
        retry_of_order_id?: string | null
        retried_by_role?: string | null
        self_completed_at?: string | null
        self_completed_by_role?: string | null
        complaints: any[]
    }[]
    rc_complaints?: any[]
    // AFA rows live in their own table (afa_orders) — never carry the applicant's
    // full name or Ghana Card number here, only what the list is allowed to render.
    is_afa?: boolean
}

interface ShopFees {
    mtn: number
    telecel: number
    at: number
}

// True when an order came in over USSD (data/airtime = 'ussd', RC = 'ussd_shop').
const isUssdOrder = (source?: string) => source === 'ussd' || source === 'ussd_shop'

// The mirrored `orders` row (or its latest retry descendant, spliced into orders[0] in
// fetchOrders) is the source of truth for status — shop_orders.status only stays in sync
// with it for the ORIGINAL order, not across a retry. RC/voucher orders have no mirror,
// so they fall back to their own status field.
const effectiveStatus = (order: ShopOrder) => order.orders?.[0]?.status || order.status

// Small violet pill marking a USSD order in the owner's order views.
const UssdTag = () => (
    <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
        <Smartphone className="w-2.5 h-2.5" /> USSD
    </span>
)

const statusConfig: Record<string, { label: string; color: string; icon: any }> = {
    pending: { label: 'Pending', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400', icon: Clock },
    queued: { label: 'Queued', color: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-400', icon: Hourglass },
    processing: { label: 'Processing', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400', icon: Clock },
    completed: { label: 'Completed', color: 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400', icon: CheckCircle2 },
    failed: { label: 'Failed', color: 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400', icon: XCircle },
    refunded: { label: 'Refunded', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400', icon: AlertCircle },
    // afa_orders.status also includes 'cancelled' (no shop_orders/RC equivalent) —
    // without this entry it would silently fall through to the raw string label.
    cancelled: { label: 'Cancelled', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800/40 dark:text-gray-400', icon: Ban },
}

// Trimmed to exactly the columns this page reads from shop_orders_effective
// (see the order-card JSX and effectiveStatus/isRetryable below) instead of
// select('*') — smaller payload per page load.
const SHOP_ORDER_SELECT = 'id, guest_phone, network, package_size, selling_price, profit, status, created_at, package_id, source, effective_status, current_order_id, current_refunded_at, current_retry_count, current_retry_from_status, current_retry_of_order_id, current_retried_by_role, current_self_completed_at, current_self_completed_by_role'

interface ShopOrderStatsRow {
    total_count: number
    pending_count: number
    queued_count: number
    processing_count: number
    completed_count: number
    failed_count: number
    refunded_count: number
    revenue: number
    profit: number
}

interface VoucherStatsRow {
    total_count: number
    pending_count: number
    processing_count: number
    completed_count: number
    failed_count: number
    refunded_count: number
    revenue: number
    profit: number
}

export default function ShopOrdersPage() {
    const { dbUser, isAdmin, isSubAdmin } = useAuth()
    const router = useRouter()

    // Data state
    const [orders, setOrders] = useState<ShopOrder[]>([])
    const [totalCount, setTotalCount] = useState(0)
    const [page, setPage] = useState(1)
    const [shopId, setShopId] = useState<string | null>(null)
    const [initialLoading, setInitialLoading] = useState(true)
    const [loading, setLoading] = useState(true)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [fees, setFees] = useState<ShopFees>({ mtn: 0, telecel: 0, at: 0 })
    const [hasNoRcMargin, setHasNoRcMargin] = useState(false)
    const [activeTab, setActiveTab] = useState<'all' | 'data' | 'airtime' | 'vouchers' | 'afa' | 'utility'>('all')

    // Filter state
    const [filterStatus, setFilterStatus] = useState<string>('all')
    const [filterNetwork, setFilterNetwork] = useState<string>('all')
    const [filterSource, setFilterSource] = useState<'all' | 'storefront' | 'ussd'>('all')
    const [filterDate, setFilterDate] = useState<'today' | '7d' | '30d' | 'all'>('today')
    const [utilityBillerFilter, setUtilityBillerFilter] = useState<'all' | UtilityBiller>('all')
    const [searchPhone, setSearchPhone] = useState('')
    const [debouncedSearchPhone, setDebouncedSearchPhone] = useState('')

    // Stats — computed server-side across the full filtered set (not just this page).
    const [stats, setStats] = useState({ total: 0, pending: 0, queued: 0, processing: 0, completed: 0, refunded: 0, revenue: 0, profit: 0 })

    // Complaint state
    const [selectedOrder, setSelectedOrder] = useState<ShopOrder | null>(null)
    const [complaintDescription, setComplaintDescription] = useState('')
    const [isSubmitting, setIsSubmitting] = useState(false)

    // Retry state — refunded storefront/USSD orders can be retried from the owner's
    // Flexy-Wallet. Only data-bundle shop orders are retryable (RC/vouchers and airtime
    // have no matching data_packages row for retry pricing, so they're excluded below).
    const [retryTarget, setRetryTarget] = useState<ShopOrder | null>(null)
    const [retryBusy, setRetryBusy] = useState(false)

    // MoMo details modal state — shown only for failed/refunded, non-RC shop orders.
    const [momoOrderId, setMomoOrderId] = useState<string | null>(null)
    const [momoModalOpen, setMomoModalOpen] = useState(false)

    // Debounce the phone search before it drives a server query — search is now
    // server-side (ilike), so firing a request per keystroke would hammer the DB.
    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearchPhone(searchPhone.trim()), 350)
        return () => clearTimeout(t)
    }, [searchPhone])

    // One-time (per dbUser) shop profile + fees + RC margin lookup — kept separate
    // from the paginated orders fetch so paging/filtering doesn't redo it every time.
    useEffect(() => {
        if (!dbUser) return
        (async () => {
            const { data: shopData, error: shopErr } = await (supabase as any)
                .from('shop_profiles')
                .select('id, airtime_fee_mtn, airtime_fee_telecel, airtime_fee_at, results_checker_markup_customer')
                .eq('owner_id', dbUser.id)
                .maybeSingle()

            if (shopErr || !shopData) {
                setShopId(null)
                setInitialLoading(false)
                setLoading(false)
                return
            }

            setFees({
                mtn: shopData.airtime_fee_mtn || 0,
                telecel: shopData.airtime_fee_telecel || 0,
                at: shopData.airtime_fee_at || 0
            })

            // RC margin counts as "set" if EITHER the legacy single markup > 0 OR any
            // per-exam markup row > 0 (per-exam markups override the legacy field —
            // mirrors app/api/shop/results-checker/initialize/route.ts L179-193).
            const { data: rcMarkupRows } = await (supabase as any)
                .from('shop_rc_markups')
                .select('markup')
                .eq('shop_id', shopData.id)
            const legacyRcMarkup = parseFloat(String(shopData.results_checker_markup_customer ?? 0)) || 0
            const anyPerExamMarkup = (rcMarkupRows || []).some((r: any) => (parseFloat(String(r.markup)) || 0) > 0)
            setHasNoRcMargin(legacyRcMarkup <= 0 && !anyPerExamMarkup)

            setShopId(shopData.id)
        })()
    }, [dbUser])

    // Any filter/tab change resets to page 1 — paging stays meaningful only within a fixed filter set.
    useEffect(() => {
        setPage(1)
    }, [activeTab, filterStatus, filterNetwork, filterSource, filterDate, debouncedSearchPhone, utilityBillerFilter])

    useEffect(() => {
        if (!shopId) return
        fetchOrders(page)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shopId, page, activeTab, filterStatus, filterNetwork, filterSource, filterDate, debouncedSearchPhone, utilityBillerFilter])

    const getDateFrom = (): string | null => {
        const now = new Date()
        if (filterDate === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
        if (filterDate === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
        if (filterDate === '30d') return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
        return null // 'all'
    }

    const fetchOrders = async (pageNum: number = page) => {
        if (!shopId) {
            setOrders([])
            setTotalCount(0)
            setLoading(false)
            setInitialLoading(false)
            return
        }

        setLoading(true)
        try {
            const dateFrom = getDateFrom()
            const search = debouncedSearchPhone ? escapeLikePattern(debouncedSearchPhone) : null
            const { from, to } = pageToRange(pageNum)

            if (activeTab === 'afa') {
                // AFA registrations live in their own table (afa_orders) — independent,
                // separately-paginated query, same pattern as the vouchers branch above.
                // Select only what this list is allowed to render: never full_name or
                // ghana_card (Ghana Card number) — the privacy guarantee for this feature.
                let afaQuery = (supabase as any)
                    .from('afa_orders')
                    .select('id, phone, selling_price, profit, status, created_at, reference_code', { count: 'exact' })
                    .eq('shop_id', shopId)

                if (filterStatus !== 'all') afaQuery = afaQuery.eq('status', filterStatus)
                if (dateFrom) afaQuery = afaQuery.gte('created_at', dateFrom)
                if (search) afaQuery = afaQuery.ilike('phone', `%${search}%`)

                const { data, error, count } = await afaQuery
                    .order('created_at', { ascending: false })
                    .range(from, to)

                if (error) throw error

                const mapped: ShopOrder[] = (data || []).map((o: any) => ({
                    id: o.id,
                    guest_phone: o.phone,
                    selling_price: o.selling_price || 0,
                    profit: o.profit || 0,
                    status: o.status,
                    created_at: o.created_at,
                    reference_code: o.reference_code,
                    is_afa: true,
                }))
                setOrders(mapped)
                setTotalCount(count || 0)

                // No dedicated stats RPC for AFA yet — pull the full filtered set
                // (unpaginated) and reduce client-side. AFA volume is expected to stay
                // low, unlike data/airtime/vouchers which have their own RPCs.
                let statsQuery = (supabase as any)
                    .from('afa_orders')
                    .select('status, selling_price, profit')
                    .eq('shop_id', shopId)
                if (filterStatus !== 'all') statsQuery = statsQuery.eq('status', filterStatus)
                if (dateFrom) statsQuery = statsQuery.gte('created_at', dateFrom)
                if (search) statsQuery = statsQuery.ilike('phone', `%${search}%`)
                const { data: statsRows } = await statsQuery
                const allRows: any[] = statsRows || []
                setStats({
                    total: allRows.length,
                    pending: allRows.filter(r => r.status === 'pending').length,
                    queued: 0,
                    processing: allRows.filter(r => r.status === 'processing').length,
                    completed: allRows.filter(r => r.status === 'completed').length,
                    refunded: 0,
                    revenue: allRows.reduce((s, r) => s + (r.selling_price || 0), 0),
                    profit: allRows.reduce((s, r) => s + (r.profit || 0), 0),
                })
            } else if (activeTab === 'utility') {
                // Utility bills (ECG/Ghana Water/DSTV/GOtv/StarTimes) live in their own
                // table with an owner-only RLS policy, and storefront utility orders always
                // insert user_id: null — so the browser-client RLS read never returns rows
                // for a shop owner. Read via the server route instead (service-role, scoped
                // to this shop's shop_id), which also computes stats over the SAME filtered
                // query used for the list.
                const params = new URLSearchParams()
                if (filterStatus !== 'all') params.set('status', filterStatus)
                if (utilityBillerFilter !== 'all') params.set('biller', utilityBillerFilter)
                if (filterSource !== 'all') params.set('source', filterSource)
                if (dateFrom) params.set('from', dateFrom)
                if (search) params.set('search', search)
                params.set('limit', String(ORDER_HISTORY_PAGE_SIZE))
                params.set('offset', String(from))

                const res = await fetch(`/api/shop/utility-orders?${params.toString()}`)
                const json = await res.json().catch(() => null)
                if (!json?.success) throw new Error(json?.error || 'Failed to load utility orders')

                const mapped: ShopOrder[] = (json.data.orders || []).map((o: any) => ({
                    id: o.id,
                    guest_phone: o.destination_phone || '',
                    type_name: o.account_name || o.account_number,
                    selling_price: Number(o.amount),
                    profit: Number(o.partner_commission_amount) || 0,
                    status: o.status,
                    created_at: o.created_at,
                    is_utility: true,
                    biller: o.biller,
                    source: o.source,
                }))
                setOrders(mapped)
                setTotalCount(json.data.total || 0)
                setStats(json.data.stats) // full replace — matches both sibling branches,
                // fixes the "stale stats bleed across tabs" defect (previously a partial spread).
                setLoading(false)
                setInitialLoading(false) // the shared `finally` block below is skipped by this
                // early return, so this must be set here explicitly to match its end state.
                return
            } else if (activeTab === 'vouchers') {
                // Vouchers (results checker) live in their own table — a separate,
                // independently paginated query, not merged with data/airtime.
                let rcQuery = (supabase as any)
                    .from('results_checker_orders')
                    .select('id, customer_phone, type_name, quantity, unit_price, shop_markup, status, created_at, results_checker_complaints(id, status)', { count: 'exact' })
                    .eq('shop_id', shopId)
                    .neq('payment_status', 'pending_payment')

                if (filterStatus !== 'all') rcQuery = rcQuery.eq('status', filterStatus)
                if (dateFrom) rcQuery = rcQuery.gte('created_at', dateFrom)
                if (search) rcQuery = rcQuery.ilike('customer_phone', `%${search}%`)

                const { data, error, count } = await rcQuery
                    .order('created_at', { ascending: false })
                    .range(from, to)

                if (error) throw error

                const mapped: ShopOrder[] = (data || []).map((o: any) => ({
                    id: o.id,
                    guest_phone: o.customer_phone,
                    type_name: o.type_name,
                    quantity: o.quantity,
                    selling_price: o.unit_price * o.quantity,
                    profit: o.shop_markup * o.quantity,
                    status: o.status,
                    created_at: o.created_at,
                    is_rc: true,
                    rc_complaints: o.results_checker_complaints || [],
                }))
                setOrders(mapped)
                setTotalCount(count || 0)

                const { data: statsRow, error: statsErr } = await (supabase as any)
                    .rpc('get_shop_voucher_stats', {
                        p_shop_id: shopId,
                        p_status: filterStatus === 'all' ? null : filterStatus,
                        p_search: search,
                        p_date_from: dateFrom,
                    })
                    .maybeSingle()

                if (!statsErr && statsRow) {
                    const s = statsRow as VoucherStatsRow
                    setStats({
                        total: Number(s.total_count) || 0,
                        pending: Number(s.pending_count) || 0,
                        queued: 0,
                        processing: Number(s.processing_count) || 0,
                        completed: Number(s.completed_count) || 0,
                        refunded: Number(s.refunded_count) || 0,
                        revenue: Number(s.revenue) || 0,
                        profit: Number(s.profit) || 0,
                    })
                }
            } else {
                // "All" = data + airtime only (vouchers have their own tab/table above) —
                // keeps every tab's pagination scoped to a single table.
                let query = (supabase as any)
                    .from('shop_orders_effective')
                    .select(SHOP_ORDER_SELECT, { count: 'exact' })
                    .eq('shop_id', shopId)

                if (activeTab === 'data') query = query.not('package_id', 'is', null)
                if (activeTab === 'airtime') query = query.is('package_id', null)
                if (filterStatus !== 'all') query = query.eq('effective_status', filterStatus)
                if (filterNetwork !== 'all') query = query.ilike('network', filterNetwork)
                if (filterSource === 'storefront') query = query.or('source.is.null,source.not.in.(ussd,ussd_shop)')
                if (filterSource === 'ussd') query = query.in('source', ['ussd', 'ussd_shop'])
                if (dateFrom) query = query.gte('created_at', dateFrom)
                if (search) query = query.ilike('guest_phone', `%${search}%`)

                const { data, error, count } = await query
                    .order('created_at', { ascending: false })
                    .range(from, to)

                if (error) throw error

                const rows = data || []

                // Complaints for the CURRENT order in each row's retry chain (mirror or
                // latest retry descendant) — a small follow-up query scoped to just this
                // page's ~20 rows, since shop_orders_effective is a view and PostgREST
                // can't reliably embed a relationship through it.
                const currentOrderIds = rows.map((o: any) => o.current_order_id).filter(Boolean)
                const complaintsByOrderId = new Map<string, any[]>()
                if (currentOrderIds.length > 0) {
                    const { data: complaintRows } = await (supabase as any)
                        .from('complaints')
                        .select('id, order_id, status')
                        .in('order_id', currentOrderIds)
                    for (const c of complaintRows || []) {
                        const arr = complaintsByOrderId.get(c.order_id) || []
                        arr.push(c)
                        complaintsByOrderId.set(c.order_id, arr)
                    }
                }

                const mapped: ShopOrder[] = rows.map((o: any) => ({
                    id: o.id,
                    guest_phone: o.guest_phone,
                    network: o.network,
                    package_size: o.package_size,
                    selling_price: o.selling_price,
                    profit: o.profit,
                    status: o.status,
                    created_at: o.created_at,
                    package_id: o.package_id,
                    source: o.source,
                    orders: o.current_order_id ? [{
                        id: o.current_order_id,
                        status: o.effective_status,
                        refunded_at: o.current_refunded_at,
                        retry_count: o.current_retry_count,
                        retry_from_status: o.current_retry_from_status,
                        retry_of_order_id: o.current_retry_of_order_id,
                        retried_by_role: o.current_retried_by_role,
                        self_completed_at: o.current_self_completed_at,
                        self_completed_by_role: o.current_self_completed_by_role,
                        complaints: complaintsByOrderId.get(o.current_order_id) || [],
                    }] : [],
                }))

                setOrders(mapped)
                setTotalCount(count || 0)

                const { data: statsRow, error: statsErr } = await (supabase as any)
                    .rpc('get_shop_orders_stats', {
                        p_shop_id: shopId,
                        p_tab: activeTab,
                        p_status: filterStatus === 'all' ? null : filterStatus,
                        p_network: filterNetwork === 'all' ? null : filterNetwork,
                        p_source: filterSource === 'all' ? null : filterSource,
                        p_search: search,
                        p_date_from: dateFrom,
                    })
                    .maybeSingle()

                if (!statsErr && statsRow) {
                    const s = statsRow as ShopOrderStatsRow
                    setStats({
                        total: Number(s.total_count) || 0,
                        pending: Number(s.pending_count) || 0,
                        queued: Number(s.queued_count) || 0,
                        processing: Number(s.processing_count) || 0,
                        completed: Number(s.completed_count) || 0,
                        refunded: Number(s.refunded_count) || 0,
                        revenue: Number(s.revenue) || 0,
                        profit: Number(s.profit) || 0,
                    })
                }
            }
        } catch (err) {
            console.error('Error fetching orders:', err)
            toast.error('Failed to load orders')
            setOrders([])
            setTotalCount(0)
        } finally {
            setLoading(false)
            setInitialLoading(false)
        }
    }

    const submitComplaint = async () => {
        if (!selectedOrder || !complaintDescription) return

        setIsSubmitting(true)
        try {
            // First, find the mirrored order ID
            const { data: mirror, error: mirrorErr } = await (supabase as any)
                .from('orders')
                .select('id, reference_code')
                .eq('shop_order_id', selectedOrder.id)
                .maybeSingle()

            if (mirrorErr || !mirror) {
                throw new Error('Could not find linked order record')
            }

            const response = await fetch('/api/complaints/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    order_id: mirror.id,
                    title: `[Shop: ${dbUser?.first_name}] Issue with order ${mirror.reference_code}`,
                    description: complaintDescription,
                    priority: 'medium',
                })
            })

            if (!response.ok) {
                const errorData = await response.json()
                throw new Error(errorData.error || 'Failed to submit complaint')
            }

            const { complaint: newComplaint } = await response.json()

            toast.success('Complaint submitted successfully')

            // Optimistic Update: Add the complaint to the local state
            setOrders(prevOrders => prevOrders.map(o => {
                if (o.id === selectedOrder.id) {
                    return {
                        ...o,
                        orders: [{
                            id: mirror.id,
                            complaints: [newComplaint]
                        }]
                    }
                }
                return o
            }))

            setSelectedOrder(null)
            setComplaintDescription('')
        } catch (error: any) {
            console.error('Complaint submission error:', error)
            toast.error(error.message || 'Failed to submit complaint')
        } finally {
            setIsSubmitting(false)
        }
    }

    const isWithin48Hours = (createdAt: string) => {
        const orderDate = new Date(createdAt)
        const now = new Date()
        return differenceInHours(now, orderDate) < 48
    }

    const handleRefresh = async () => {
        setIsRefreshing(true)
        await fetchOrders()
        setIsRefreshing(false)
        toast.success('Orders updated')
    }

    // A shop order is retryable when it's a data bundle (not RC/voucher, not airtime —
    // retry pricing needs a network+size match against data_packages), has a mirrored
    // `orders` row (source of truth for status), and that mirror is refunded.
    const isRetryable = (order: ShopOrder) => {
        if (order.is_rc) return false
        if (order.package_id == null) return false
        const mirror = order.orders?.[0]
        return !!mirror?.id && mirror.status === 'refunded'
    }

    const handleRetry = (order: ShopOrder) => {
        setRetryTarget(order)
    }

    const submitRetry = async () => {
        const mirrorOrderId = retryTarget?.orders?.[0]?.id
        if (!retryTarget || !mirrorOrderId || retryBusy) return
        setRetryBusy(true)
        try {
            const response = await fetch('/api/orders/retry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: mirrorOrderId }),
            })
            const result = await response.json().catch(() => ({}))

            if (!response.ok || !result?.success) {
                const outcome = result?.outcome as string | undefined
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
                    paystack_refund_no_wallet: 'This order was refunded via Paystack — there is no wallet to charge for a retry.',
                    not_retryable: result?.currentStatus ? `This order is currently "${result.currentStatus}" and can't be retried.` : 'This order is not in a retryable state.',
                    not_owner: result?.error || 'You are not authorized to retry this order.',
                    duplicate_attempt: 'This retry was already submitted — please refresh and check the order status before trying again.',
                    retry_already_in_progress: 'A previous retry for this order already succeeded or is in progress — refresh to see its current status.',
                    owner_not_found: 'Could not find the shop owner to fund this retry. Contact support.',
                    no_wallet_user: 'This order has no wallet to charge for a retry. Contact support.',
                    invalid_charge_amount: 'Could not determine a valid retry price for this order. Contact support.',
                }
                throw new Error((outcome && messages[outcome]) || result?.error || 'Failed to retry order')
            }

            const data = result.data
            toast.success(
                data?.message ||
                (data?.chargedAmount != null ? `Retry dispatched — GHS ${Number(data.chargedAmount).toFixed(2)} charged from your wallet` : 'Order retry dispatched')
            )
            setRetryTarget(null)
            fetchOrders()
        } catch (error: any) {
            console.error('Shop retry error:', error)
            toast.error(error?.message || 'Failed to retry order')
        } finally {
            setRetryBusy(false)
        }
    }

    // Self-service "Confirm Received" is scoped to data-bundle shop orders only, same
    // as isRetryable above — RC/voucher rows (order.is_rc) and airtime rows
    // (package_id == null) are excluded even though airtime orders DO have a mirrored
    // `orders` row (shop_orders_effective left-joins it for every shop_orders row, not
    // just data bundles) whose status could otherwise satisfy isConfirmReceivedEligible.
    const isShopConfirmReceivedEligible = (order: ShopOrder) => {
        if (order.is_rc) return false
        if (order.package_id == null) return false
        const mirror = order.orders?.[0]
        return isConfirmReceivedEligible({ status: mirror?.status || order.status })
    }

    // Confirm-received state — mirrors the retry state/handler pair above. The order id
    // is read from the mirror row (order.orders?.[0]?.id), same as submitRetry's
    // mirrorOrderId, since this page's rows are ShopOrder wrappers and the shop owner is
    // often not orders.user_id (the USSD/guest caller is) — ownership for shop owners is
    // resolved server-side in claim_self_order_complete via shop_order_id -> shop_id -> owner_id.
    const [confirmTarget, setConfirmTarget] = useState<ShopOrder | null>(null)
    const [confirmBusy, setConfirmBusy] = useState(false)

    const handleConfirmReceived = (order: ShopOrder) => {
        setConfirmTarget(order)
    }

    const submitConfirmReceived = async () => {
        const mirrorOrderId = confirmTarget?.orders?.[0]?.id
        if (!confirmTarget || !mirrorOrderId || confirmBusy) return
        setConfirmBusy(true)
        try {
            const response = await fetch('/api/orders/confirm-received', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: mirrorOrderId }),
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
            fetchOrders()
        } catch (error: any) {
            console.error('Shop confirm received error:', error)
            toast.error(error?.message || 'Failed to confirm order received')
        } finally {
            setConfirmBusy(false)
        }
    }

    const hasNoAirtimeFees = fees.mtn === 0 && fees.telecel === 0 && fees.at === 0

    if (initialLoading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                    <Link href="/dashboard/shop">
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                            <ArrowLeft className="w-4 h-4" />
                        </Button>
                    </Link>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <ShoppingCart className="w-6 h-6 text-emerald-600" />
                        Shop Orders
                    </h1>
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRefresh}
                        disabled={isRefreshing}
                        className="gap-2"
                    >
                        <RefreshCcw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
                        Refresh
                    </Button>
                </div>
            </div>

            {/* Tabs & Filters Section */}
            <div className="space-y-4">
                {/* Tabs */}
                <div className="flex p-1 bg-muted rounded-xl w-full sm:w-fit border shadow-sm overflow-x-auto">
                    {([
                        { id: 'all', label: 'All', icon: TrendingUp, active: 'text-emerald-600' },
                        { id: 'data', label: 'Data', icon: ShoppingCart, active: 'text-emerald-600' },
                        { id: 'airtime', label: 'Airtime', icon: RefreshCcw, active: 'text-purple-600' },
                        { id: 'vouchers', label: 'Vouchers', icon: FileText, active: 'text-amber-600' },
                        { id: 'afa', label: 'AFA', icon: IdCard, active: 'text-teal-600' },
                        { id: 'utility', label: 'Utility Bills', icon: Coins, active: 'text-sky-600' },
                    ] as const).map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                "flex-1 sm:flex-none px-4 sm:px-5 py-2 text-sm font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap",
                                activeTab === tab.id ? cn("bg-white dark:bg-gray-800 shadow-sm", tab.active) : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <tab.icon className="w-4 h-4" />
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* Airtime Warning Banner */}
                {activeTab === 'airtime' && hasNoAirtimeFees && (
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-xl bg-purple-50 border border-purple-100 dark:bg-purple-900/10 dark:border-purple-900/20">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center shrink-0">
                                <AlertCircle className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                            </div>
                            <div>
                                <h3 className="text-sm font-bold text-purple-900 dark:text-purple-100 uppercase tracking-tight">No Profit Gained</h3>
                                <p className="text-xs text-purple-700 dark:text-purple-400">You haven't set any airtime fees yet. Customers can still buy airtime, but you won't earn any commission on these orders.</p>
                            </div>
                        </div>
                        <Link href="/dashboard/shop/pricing">
                            <Button size="sm" className="bg-purple-600 hover:bg-purple-700 text-white gap-2 shadow-lg shadow-purple-200 dark:shadow-none whitespace-nowrap">
                                Set Fees & Start Earning
                            </Button>
                        </Link>
                    </div>
                )}

                {/* Vouchers Warning Banner — only when NO margin is set anywhere */}
                {activeTab === 'vouchers' && hasNoRcMargin && (
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-xl bg-amber-50 border border-amber-100 dark:bg-amber-900/10 dark:border-amber-900/20">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center shrink-0">
                                <Coins className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                            </div>
                            <div>
                                <h3 className="text-sm font-bold text-amber-900 dark:text-amber-100 uppercase tracking-tight">No Profit Gained</h3>
                                <p className="text-xs text-amber-700 dark:text-amber-400">You haven&apos;t set any Results Checker margin yet. Customers can still buy vouchers, but you won&apos;t earn any profit on these orders.</p>
                            </div>
                        </div>
                        <Link href="/dashboard/shop/pricing">
                            <Button size="sm" className="bg-amber-600 hover:bg-amber-700 text-white gap-2 whitespace-nowrap">
                                Set Margin &amp; Start Earning
                            </Button>
                        </Link>
                    </div>
                )}

                <div className="space-y-3 bg-muted/30 p-4 rounded-xl border">
                    {/* Search */}
                    <div className="relative w-full lg:w-64">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                            placeholder="Search phone number..."
                            title="Search phone number"
                            aria-label="Search phone number"
                            value={searchPhone}
                            onChange={(e) => setSearchPhone(e.target.value)}
                            className="pl-9 h-9 bg-background"
                        />
                    </div>

                    {/* Date Filter — own row */}
                    <div className="flex bg-muted rounded-lg p-1 w-full lg:w-fit overflow-x-auto">
                        {[
                            { id: 'today', label: 'Today' },
                            { id: '7d', label: '7 Days' },
                            { id: '30d', label: '30 Days' },
                            { id: 'all', label: 'All' },
                        ].map((f) => (
                            <button
                                key={f.id}
                                onClick={() => setFilterDate(f.id as any)}
                                className={cn(
                                    "flex-1 lg:flex-none px-3 py-1.5 text-xs font-medium rounded-md transition-all whitespace-nowrap",
                                    filterDate === f.id ? "bg-white dark:bg-gray-800 shadow-sm text-emerald-600" : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>

                    {/* Network + Status + Source Filters — own row */}
                    <div className="flex w-full overflow-x-auto gap-2">
                        {/* Network Filter — hidden on vouchers/afa tabs; utility tab shows a biller select instead */}
                        {activeTab === 'utility' ? (
                        <select
                            title="Filter by Biller"
                            aria-label="Filter by Biller"
                            className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shrink-0"
                            value={utilityBillerFilter}
                            onChange={(e) => setUtilityBillerFilter(e.target.value as any)}
                        >
                            <option value="all">All Billers</option>
                            {UTILITY_BILLER_KEYS.map((b) => (
                                <option key={b} value={b}>{UTILITY_BILLERS[b].label}</option>
                            ))}
                        </select>
                        ) : activeTab !== 'vouchers' && activeTab !== 'afa' && (
                        <select
                            title="Filter by Network"
                            aria-label="Filter by Network"
                            className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shrink-0"
                            value={filterNetwork}
                            onChange={(e) => setFilterNetwork(e.target.value)}
                        >
                            <option value="all">All Networks</option>
                            <option value="mtn">MTN</option>
                            <option value="telecel">Telecel</option>
                            <option value="at">AT</option>
                        </select>
                        )}

                        {/* Status Filter */}
                        <select
                            title="Filter by Status"
                            aria-label="Filter by Status"
                            className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shrink-0"
                            value={filterStatus}
                            onChange={(e) => setFilterStatus(e.target.value)}
                        >
                            <option value="all">All Status</option>
                            <option value="pending">Pending</option>
                            {activeTab !== 'afa' && <option value="queued">Queued</option>}
                            <option value="completed">Completed</option>
                            <option value="processing">Processing</option>
                            {activeTab === 'afa' ? (
                                <option value="cancelled">Cancelled</option>
                            ) : (
                                <>
                                    <option value="failed">Failed</option>
                                    <option value="refunded">Refunded</option>
                                </>
                            )}
                        </select>

                        {/* Source Filter — hidden on afa tab (no USSD/storefront split yet) */}
                        {activeTab !== 'afa' && (
                        <select
                            title="Filter by Source"
                            aria-label="Filter by Source"
                            className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shrink-0"
                            value={filterSource}
                            onChange={(e) => setFilterSource(e.target.value as any)}
                        >
                            <option value="all">All Sources</option>
                            <option value="storefront">Storefront</option>
                            <option value="ussd">USSD</option>
                        </select>
                        )}
                    </div>
                </div>
            </div>

            {/* Stats Cards — compact */}
            <div className="grid grid-cols-3 lg:grid-cols-8 gap-2">
                {[
                    { label: 'Orders', value: stats.total, icon: ShoppingCart, color: 'text-blue-600' },
                    { label: 'Pending', value: stats.pending, icon: Clock, color: 'text-yellow-600' },
                    { label: 'Queued', value: stats.queued, icon: Hourglass, color: 'text-indigo-600' },
                    { label: 'Processing', value: stats.processing, icon: Clock, color: 'text-orange-600' },
                    { label: 'Completed', value: stats.completed, icon: CheckCircle2, color: 'text-green-600' },
                    { label: 'Refunded', value: stats.refunded, icon: AlertCircle, color: 'text-purple-600' },
                    { label: 'Revenue', value: formatCurrency(stats.revenue), icon: TrendingUp,
                        color: activeTab === 'airtime' ? 'text-purple-600' : activeTab === 'vouchers' ? 'text-amber-600' : 'text-emerald-600' },
                    { label: (activeTab === 'vouchers' || activeTab === 'utility') ? 'Commission' : 'Profit', value: formatCurrency(stats.profit), icon: (activeTab === 'vouchers' || activeTab === 'utility') ? Coins : TrendingUp,
                        color: activeTab === 'airtime' ? 'text-purple-600' : activeTab === 'vouchers' ? 'text-amber-600' : 'text-emerald-600' },
                ].map((stat) => (
                    <Card key={stat.label} className="border shadow-sm rounded-xl">
                        <CardContent className="p-3">
                            <div className="flex items-center gap-1.5 mb-1">
                                <stat.icon className={cn('w-3.5 h-3.5', stat.color)} />
                                <p className="text-[11px] text-muted-foreground font-medium">{stat.label}</p>
                            </div>
                            <p className="text-sm sm:text-base font-bold tabular-nums truncate">{stat.value}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* Orders List & Table */}
            <Card>
                <CardHeader className="p-4 border-b">
                    <CardTitle className="text-base">Order History</CardTitle>
                </CardHeader>

                <CardContent className="p-0">
                    {/* Desktop Table View */}
                    <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b text-xs text-muted-foreground bg-gray-50/50 dark:bg-gray-900/50">
                                    <th className="text-left px-4 py-3 font-medium">Date</th>
                                    <th className="text-left px-4 py-3 font-medium">Customer</th>
                                    <th className="text-left px-4 py-3 font-medium">Package</th>
                                    <th className="text-right px-4 py-3 font-medium">Price</th>
                                    <th className="text-right px-4 py-3 font-medium">Profit</th>
                                    <th className="text-center px-4 py-3 font-medium">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    <tr>
                                        <td colSpan={6} className="text-center py-10">
                                            <Loader2 className="w-6 h-6 mx-auto text-muted-foreground animate-spin" />
                                        </td>
                                    </tr>
                                ) : orders.length === 0 ? (
                                    <tr>
                                        <td colSpan={6} className="text-center py-10 text-muted-foreground">
                                            No orders found matching your filters.
                                        </td>
                                    </tr>
                                ) : (
                                    orders.map((order) => {
                                        const displayStatus = effectiveStatus(order)
                                        const StatusIcon = statusConfig[displayStatus]?.icon || Clock
                                        return (
                                            <tr key={order.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                                <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">
                                                    {new Date(order.created_at).toLocaleDateString()}
                                                    <br />
                                                    {new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                </td>
                                                <td className="px-4 py-3 font-mono text-xs">{order.guest_phone}</td>
                                                <td className="px-4 py-3 text-xs font-medium">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        {order.is_utility ? (
                                                            <span className="flex items-center gap-1.5">
                                                                <Coins className="w-3 h-3 text-sky-600" />
                                                                {order.biller ? (UTILITY_BILLERS[order.biller]?.label ?? order.biller) : 'Utility'} · {order.type_name}
                                                            </span>
                                                        ) : order.is_rc ? (
                                                            <span className="flex items-center gap-1.5">
                                                                <TrendingUp className="w-3 h-3 text-amber-600" />
                                                                {order.quantity}x {order.type_name}
                                                            </span>
                                                        ) : order.is_afa ? (
                                                            <span className="flex items-center gap-1.5">
                                                                <IdCard className="w-3 h-3 text-teal-600" />
                                                                AFA Registration
                                                            </span>
                                                        ) : order.package_id == null && isMashupOrder(order.package_size) ? (
                                                            <span className="flex items-center gap-1.5">
                                                                <Zap className="w-3 h-3 text-amber-500 fill-current" />
                                                                MTN Mashup Bundle
                                                            </span>
                                                        ) : order.package_id == null ? (
                                                            <span className="flex items-center gap-1.5">
                                                                <RefreshCcw className="w-3 h-3 text-purple-600" />
                                                                {order.network} Airtime
                                                            </span>
                                                        ) : (
                                                            <span>{order.network} {order.package_size}</span>
                                                        )}
                                                        {isUssdOrder(order.source) && <UssdTag />}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 text-right font-medium">{formatCurrency(order.selling_price)}</td>
                                                <td className="px-4 py-3 text-right text-emerald-600 font-semibold">
                                                    {order.status === 'failed' ? <span className="text-muted-foreground">—</span> : formatCurrency(order.profit)}
                                                </td>
                                                <td className="px-4 py-3 text-center">
                                                    <div className="flex flex-col items-center gap-2">
                                                        <span className={cn(
                                                            'inline-flex items-center gap-1 text-[10px] uppercase font-bold px-2 py-0.5 rounded-full',
                                                            statusConfig[displayStatus]?.color || 'bg-gray-100 text-gray-600'
                                                        )}>
                                                            <StatusIcon className="w-3 h-3" />
                                                            {statusConfig[displayStatus]?.label || displayStatus}
                                                        </span>

                                                        {(() => {
                                                            const retryTag = getRetryTag(order.orders?.[0] || {})
                                                            const selfCompletedTag = getSelfCompletedTag(order.orders?.[0] || {})
                                                            const tag = selfCompletedTag || retryTag
                                                            return tag ? (
                                                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium uppercase ${tag.badge}`}>
                                                                    {tag.label}
                                                                </span>
                                                            ) : null
                                                        })()}

                                                        {/* Complaint Status, Retry Button, Confirm Received, or Complain Button */}
                                                        {(() => {
                                                            const orderComplaints = order.is_rc ? (order.rc_complaints || []) : (order.orders?.[0]?.complaints || [])
                                                            if (orderComplaints.length > 0) {
                                                                const complaintStatus = orderComplaints[0].status
                                                                return (
                                                                    <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 border border-blue-100 dark:border-blue-800">
                                                                        <MessageSquare className="w-2.5 h-2.5" />
                                                                        <span className="text-[9px] font-bold uppercase">
                                                                            Complaint: {complaintStatus.replace('_', ' ')}
                                                                        </span>
                                                                    </div>
                                                                )
                                                            }
                                                            if (isRetryable(order)) {
                                                                return (
                                                                    <Button
                                                                        size="sm"
                                                                        variant="ghost"
                                                                        className="h-6 px-2 text-[10px] text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                                                        onClick={() => handleRetry(order)}
                                                                    >
                                                                        <RefreshCw className="w-3 h-3 mr-1" />
                                                                        Retry
                                                                    </Button>
                                                                )
                                                            }
                                                            if (isShopConfirmReceivedEligible(order)) {
                                                                return (
                                                                    <Button
                                                                        size="sm"
                                                                        variant="ghost"
                                                                        className="h-6 px-2 text-[10px] text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                                                                        onClick={() => handleConfirmReceived(order)}
                                                                    >
                                                                        <CheckCircle2 className="w-3 h-3 mr-1" />
                                                                        Confirm Received
                                                                    </Button>
                                                                )
                                                            }
                                                            if (order.status === 'completed' && !order.is_rc && !order.is_afa && !order.is_utility && isWithin48Hours(order.created_at)) {
                                                                return (
                                                                    <Button
                                                                        size="sm"
                                                                        variant="ghost"
                                                                        className="h-6 px-2 text-[10px] text-orange-600 hover:text-orange-700 hover:bg-orange-50"
                                                                        onClick={() => {
                                                                            setSelectedOrder(order)
                                                                            setComplaintDescription('')
                                                                        }}
                                                                    >
                                                                        <MessageSquare className="w-3 h-3 mr-1" />
                                                                        Complain
                                                                    </Button>
                                                                )
                                                            }
                                                            return null
                                                        })()}

                                                        {!order.is_rc && !order.is_afa && !order.is_utility && isMomoLookupEligible({ status: effectiveStatus(order) }) && (
                                                            <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                className="h-6 px-2 text-[10px] text-purple-600 hover:text-purple-700 hover:bg-purple-50"
                                                                onClick={() => { setMomoOrderId(order.id); setMomoModalOpen(true) }}
                                                            >
                                                                <Smartphone className="w-3 h-3 mr-1" />
                                                                View MoMo
                                                            </Button>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Mobile Card View */}
                    <div className="md:hidden divide-y">
                        {loading ? (
                            <div className="text-center py-10">
                                <Loader2 className="w-6 h-6 mx-auto text-muted-foreground animate-spin" />
                            </div>
                        ) : orders.length === 0 ? (
                            <div className="text-center py-10 text-muted-foreground">
                                No orders found matching your filters.
                            </div>
                        ) : (
                            orders.map((order) => {
                                const displayStatus = order.orders?.[0]?.status || order.status
                                const StatusIcon = statusConfig[displayStatus]?.icon || Clock
                                return (
                                    <div key={order.id} className="p-4 space-y-4 hover:bg-muted/30 transition-colors">
                                        <div className="flex justify-between items-start">
                                            <div>
                                                <p className="font-bold text-sm flex items-center gap-2 flex-wrap">
                                                    {order.is_utility ? (
                                                        <><Coins className="w-3.5 h-3.5 text-sky-600" /> {order.biller ? (UTILITY_BILLERS[order.biller]?.label ?? order.biller) : 'Utility'} · {order.type_name}</>
                                                    ) : order.is_rc ? (
                                                        <><TrendingUp className="w-3.5 h-3.5 text-amber-600" /> {order.quantity}x {order.type_name}</>
                                                    ) : order.is_afa ? (
                                                        <><IdCard className="w-3.5 h-3.5 text-teal-600" /> AFA Registration</>
                                                    ) : order.package_id == null && isMashupOrder(order.package_size) ? (
                                                        <><Zap className="w-3.5 h-3.5 text-amber-500 fill-current" /> MTN Mashup Bundle</>
                                                    ) : order.order_type === 'airtime' || order.package_id == null ? (
                                                        <><RefreshCcw className="w-3.5 h-3.5 text-purple-600" /> {order.network} Airtime</>
                                                    ) : (
                                                        <>{order.network} {order.package_size}</>
                                                    )}
                                                    {isUssdOrder(order.source) && <UssdTag />}
                                                </p>
                                                <p className="text-xs font-mono text-muted-foreground mt-0.5">{order.guest_phone}</p>
                                            </div>
                                            <div className="flex flex-col items-end gap-2">
                                                <span className={cn(
                                                    'inline-flex items-center gap-1 text-[10px] uppercase font-bold px-2 py-0.5 rounded-full',
                                                    statusConfig[displayStatus]?.color || 'bg-gray-100 text-gray-600'
                                                )}>
                                                    <StatusIcon className="w-3 h-3" />
                                                    {statusConfig[displayStatus]?.label || displayStatus}
                                                </span>
                                                {(() => {
                                                    const retryTag = getRetryTag(order.orders?.[0] || {})
                                                    const selfCompletedTag = getSelfCompletedTag(order.orders?.[0] || {})
                                                    const tag = selfCompletedTag || retryTag
                                                    return tag ? (
                                                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium uppercase ${tag.badge}`}>
                                                            {tag.label}
                                                        </span>
                                                    ) : null
                                                })()}
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-4">
                                            <div className="space-y-1">
                                                <p className="text-[10px] uppercase text-muted-foreground font-medium">Date & Time</p>
                                                <p className="text-xs">
                                                    {new Date(order.created_at).toLocaleDateString()} at {new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                </p>
                                            </div>
                                            <div className="space-y-1 text-right">
                                                <p className="text-[10px] uppercase text-muted-foreground font-medium">Earnings</p>
                                                <div className="flex items-center justify-end gap-2">
                                                    <span className="text-xs font-medium">{formatCurrency(order.selling_price)}</span>
                                                    <span className="text-xs font-bold text-emerald-600">({formatCurrency(order.profit)})</span>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Action Area for Mobile */}
                                        <div className="pt-2 space-y-2">
                                            {(() => {
                                                const orderComplaints = order.is_rc ? (order.rc_complaints || []) : (order.orders?.[0]?.complaints || [])
                                                if (orderComplaints.length > 0) {
                                                    const complaintStatus = orderComplaints[0].status
                                                    return (
                                                        <div className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 border border-blue-100 dark:border-blue-800 w-full">
                                                            <MessageSquare className="w-3.5 h-3.5" />
                                                            <span className="text-[11px] font-bold uppercase tracking-wide">
                                                                Complaint: {complaintStatus.replace('_', ' ')}
                                                            </span>
                                                        </div>
                                                    )
                                                }
                                                if (isRetryable(order)) {
                                                    return (
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="w-full h-9 text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50 border-blue-200 dark:border-blue-900"
                                                            onClick={() => handleRetry(order)}
                                                        >
                                                            <RefreshCw className="w-3.5 h-3.5 mr-2" />
                                                            Retry Order
                                                        </Button>
                                                    )
                                                }
                                                if (isShopConfirmReceivedEligible(order)) {
                                                    return (
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="w-full h-9 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 border-emerald-200 dark:border-emerald-900"
                                                            onClick={() => handleConfirmReceived(order)}
                                                        >
                                                            <CheckCircle2 className="w-3.5 h-3.5 mr-2" />
                                                            Confirm Received
                                                        </Button>
                                                    )
                                                }
                                                if (order.status === 'completed' && !order.is_rc && !order.is_afa && !order.is_utility && isWithin48Hours(order.created_at)) {
                                                    return (
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="w-full h-9 text-xs text-orange-600 hover:text-orange-700 hover:bg-orange-50 border-orange-200 dark:border-orange-900"
                                                            onClick={() => {
                                                                setSelectedOrder(order)
                                                                setComplaintDescription('')
                                                            }}
                                                        >
                                                            <MessageSquare className="w-3.5 h-3.5 mr-2" />
                                                            File a Complaint
                                                        </Button>
                                                    )
                                                }
                                                return null
                                            })()}

                                            {!order.is_rc && !order.is_afa && !order.is_utility && isMomoLookupEligible({ status: effectiveStatus(order) }) && (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="w-full h-9 text-xs text-purple-600 hover:text-purple-700 hover:bg-purple-50 border-purple-200 dark:border-purple-900"
                                                    onClick={() => { setMomoOrderId(order.id); setMomoModalOpen(true) }}
                                                >
                                                    <Smartphone className="w-3.5 h-3.5 mr-2" />
                                                    View MoMo Details
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                )
                            })
                        )}
                    </div>
                </CardContent>
            </Card>

            <PaginationControls
                page={page}
                pageSize={ORDER_HISTORY_PAGE_SIZE}
                totalCount={totalCount}
                onPageChange={setPage}
                loading={loading}
            />

            <MomoDetailsModal
                open={momoModalOpen}
                onOpenChange={setMomoModalOpen}
                fetchUrl={momoOrderId ? `/api/shop/orders/${momoOrderId}/momo-details` : null}
            />

            {/* Complaint Dialog */}
            <Dialog open={!!selectedOrder} onOpenChange={() => setSelectedOrder(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>File a Complaint</DialogTitle>
                        <DialogDescription>
                            Describe the issue for order to {selectedOrder?.guest_phone}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="p-4 rounded-xl bg-muted/50 text-sm">
                            <div className="flex justify-between">
                                <span>Phone:</span>
                                <span className="font-mono">{selectedOrder?.guest_phone}</span>
                            </div>
                            <div className="flex justify-between mt-1">
                                <span>Package:</span>
                                <span>{selectedOrder?.network} {selectedOrder?.package_size}</span>
                            </div>
                            <div className="flex justify-between mt-1">
                                <span>Price:</span>
                                <span>{formatCurrency(selectedOrder?.selling_price || 0)}</span>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>Issue Description</Label>
                            <Textarea
                                placeholder="Describe the problem your customer is facing..."
                                value={complaintDescription}
                                onChange={(e) => setComplaintDescription(e.target.value)}
                                rows={4}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setSelectedOrder(null)}>
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

            {/* Retry Confirm Dialog — charges the shop owner's Flexy-Wallet, not the customer */}
            <Dialog open={!!retryTarget} onOpenChange={(o) => { if (!o && !retryBusy) setRetryTarget(null) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Retry order</DialogTitle>
                        <DialogDescription>
                            {retryTarget?.network} {retryTarget?.package_size} · {retryTarget?.guest_phone}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md p-2.5">
                            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                            <span>Today&apos;s cost price will be charged to your Flexy-Wallet — this may differ from what you originally paid. You&apos;ll see the exact amount charged once the retry succeeds.</span>
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
                            {confirmTarget?.network} {confirmTarget?.package_size} · {confirmTarget?.guest_phone}
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
        </div>
    )
}
