'use client'

/**
 * /admin/utilities — Utility Bills admin console (ECG / Ghana Water / DSTV /
 * GOtv / StarTimes). Mirrors app/admin/airtime/page.tsx's layout language,
 * theme-adaptive styling, stat-card idiom and controlled-Dialog confirm
 * pattern (see its per-order refund Dialog around line 1693) — this page
 * uses the SAME "no native confirm()" approach via a shared ActionConfirmDialog,
 * plus a Sheet-based detail drawer (mirrors app/admin/users/page.tsx's
 * `<Sheet>` detail panel).
 *
 * Data/actions ONLY via the Phase C routes:
 *   GET/POST /api/admin/utilities/settings   (8 keys + hubtel_commission_paused)
 *   GET      /api/admin/utilities            (filters + stats over the same window)
 *   PATCH    /api/admin/utilities             ({ action, order_id })
 *
 * Settings note: `hubtel_utility_billers` is the master per-biller ON/OFF
 * switch — it gates BOTH order creation (app/api/utilities/create/route.ts)
 * AND auto-fulfillment eligibility (lib/utility-fulfillment.ts's
 * isUtilityAutoFulfillmentEnabled), independently of utility_auto_fulfillment_enabled.
 * So the 5 per-biller switches are left independently editable here — not
 * gated behind the auto-fulfillment master switch.
 */

import { useCallback, useEffect, useState } from 'react'
import {
    Lightbulb, AlertTriangle, RefreshCw, Loader2, XCircle,
    Search, Calendar, Coins, Wallet, Users, Package, Info,
    Eye, X, Copy, Repeat2, RotateCcw, ChevronLeft, ChevronRight,
    Smartphone,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
    Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { format, parseISO } from 'date-fns'
import { getStatusBadgeClass, getStatusLabel } from '@/lib/order-status'
import { UTILITY_BILLER_KEYS, UTILITY_BILLERS, type UtilityBiller } from '@/lib/hubtel-utility/billers'
import { BILLER_UI } from '@/app/dashboard/utilities/biller-ui'
import { UtilityBillerLogo } from '@/components/utility-biller-logo'
import { MomoDetailsModal } from '@/components/shared/momo-details-modal'
import { isMomoLookupEligible } from '@/lib/momo-eligibility'
import CommissionWalletsTab from './commission-wallets-tab'
import RefundQueueTab from './refund-queue-tab'

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 25

type UtilityOrderStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded'
const STATUS_FILTER_OPTIONS: Array<'all' | UtilityOrderStatus> = ['all', 'pending', 'processing', 'completed', 'failed', 'refunded']

const SOURCE_KEYS = ['dashboard', 'storefront', 'api', 'ussd', 'ussd_shop'] as const
const SOURCE_LABELS: Record<string, string> = {
    dashboard: 'Dashboard',
    storefront: 'Storefront',
    api: 'Developer API',
    ussd: 'USSD',
    ussd_shop: 'USSD Shop',
}

type ToggleKey =
    | 'utility_bills_enabled'
    | 'utility_auto_fulfillment_enabled'
    | 'storefront_utilities_enabled'
    | 'ussd_utility_enabled'
    | 'commission_transfer_enabled'
    | 'hubtel_receive_enabled_utility'

type ActionType = 'refulfill' | 'status_sync' | 'refund'

// ─── Types ──────────────────────────────────────────────────────────────────

interface UtilityOrder {
    id: string
    user_id: string | null
    shop_id: string | null
    api_key_id: string | null
    source: string
    biller: UtilityBiller
    account_number: string
    account_name: string | null
    destination_phone: string | null
    customer_email: string | null
    amount: number
    payment_method: string
    payment_reference: string | null
    payment_status: string
    status: UtilityOrderStatus
    reference_code: string
    fulfillment_attempts: number
    fulfillment_request_id: string | null
    commission_amount: number | null
    partner_commission_amount: number | null
    commission_credited_at: string | null
    fulfillment_metadata: any
    created_at: string
    updated_at: string
    // Joined server-side (app/api/admin/utilities/route.ts) — null for a guest/USSD order
    // with no user_id, or a non-shop-attributed order with no shop_id.
    shop_name: string | null
    users: { first_name: string; last_name: string } | null
}

interface UtilityOrderStats {
    total_orders: number
    total_amount: number
    completed: number
    pending: number
    processing: number
    failed: number
    refunded: number
    total_commission: number
    total_partner_commission: number
}

const ZERO_STATS: UtilityOrderStats = {
    total_orders: 0, total_amount: 0, completed: 0, pending: 0, processing: 0,
    failed: 0, refunded: 0, total_commission: 0, total_partner_commission: 0,
}

interface UtilitySettingsState {
    utility_bills_enabled: string
    utility_auto_fulfillment_enabled: string
    hubtel_utility_billers: Record<UtilityBiller, boolean>
    storefront_utilities_enabled: string
    ussd_utility_enabled: string
    utility_commission_partner_percent: string
    utility_min_amount: string
    utility_max_amount: string
    hubtel_commission_paused: string
    commission_withdrawal_fee_percent: string
    commission_withdrawal_fee_flat: string
    commission_min_withdrawal_amount: string
    commission_transfer_enabled: string
    hubtel_receive_enabled_utility: string
}

const DEFAULT_BILLERS: Record<UtilityBiller, boolean> = {
    ecg: false, ghana_water: false, dstv: false, gotv: false, startimes: false,
}

const DEFAULT_SETTINGS: UtilitySettingsState = {
    utility_bills_enabled: 'false',
    utility_auto_fulfillment_enabled: 'false',
    hubtel_utility_billers: DEFAULT_BILLERS,
    storefront_utilities_enabled: 'false',
    ussd_utility_enabled: 'false',
    utility_commission_partner_percent: '40',
    utility_min_amount: '1',
    utility_max_amount: '1000',
    hubtel_commission_paused: 'false',
    commission_withdrawal_fee_percent: '2',
    commission_withdrawal_fee_flat: '0',
    commission_min_withdrawal_amount: '20',
    commission_transfer_enabled: 'true',
    hubtel_receive_enabled_utility: 'false',
}

function mergeSettings(raw: any): UtilitySettingsState {
    const rawBillers = raw?.hubtel_utility_billers
    const billers = rawBillers && typeof rawBillers === 'object' && !Array.isArray(rawBillers)
        ? { ...DEFAULT_BILLERS, ...rawBillers }
        : DEFAULT_BILLERS
    return { ...DEFAULT_SETTINGS, ...(raw || {}), hubtel_utility_billers: billers }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function billerLabel(biller: UtilityBiller): string {
    return UTILITY_BILLERS[biller]?.label ?? biller
}

/**
 * True when an order's account_name is blank because the customer typed the meter number
 * manually instead of using "Find my meters" — NOT because a lookup failed to find one.
 * ECG-only: every other biller's account_name always comes from a mandatory account-query
 * lookup at checkout (queryBy: 'account'), so a null there is a genuine data gap, not this
 * known "no name confirmation exists for a hand-typed meter" case (see
 * docs/reference/hubtel-ecg-meter-topup.md — Hubtel's own top-up API never returns one).
 */
function isUnverifiedMeterName(o: Pick<UtilityOrder, 'biller' | 'account_name'>): boolean {
    return o.biller === 'ecg' && !o.account_name
}

/** GHS amount at 4dp tolerance (commission math is rounded to 1e4) — trims trailing zeros but keeps at least 2dp. */
function fmt4(n: number | null | undefined): string {
    const v = Number(n || 0)
    const full = v.toFixed(4)
    const trimmed = full.replace(/0+$/, '').replace(/\.$/, '')
    const dot = trimmed.indexOf('.')
    if (dot === -1) return v.toFixed(2)
    return trimmed.length - dot - 1 < 2 ? v.toFixed(2) : trimmed
}

function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—'
    try { return format(parseISO(iso), 'MMM d, yyyy · p') } catch { return iso }
}

function isRefundQueued(o: UtilityOrder): boolean {
    return o.fulfillment_metadata?.manual?.action === 'refund_queued'
}
// Both gated on payment_status === 'paid', mirroring canRefund below — a pending/failed
// order with no confirmed payment is an abandoned/in-flight checkout, not something to
// dispatch or status-check. The backend (dispatchUtilityCore) already refuses to fulfill
// an unpaid order, so this was never a money-safety hole — but offering a dead-end action
// button on a live admin panel is its own kind of bug (root-caused after a near-miss: an
// admin almost clicked Refulfill on an order that was never actually paid).
function canRefulfill(o: UtilityOrder): boolean {
    return (o.status === 'pending' || o.status === 'failed') && o.payment_status === 'paid' && !isRefundQueued(o)
}
function canStatusSync(o: UtilityOrder): boolean {
    return (o.fulfillment_attempts || 0) > 0 && (o.status === 'pending' || o.status === 'processing' || o.status === 'failed') && o.payment_status === 'paid' && !isRefundQueued(o)
}
function canRefund(o: UtilityOrder): boolean {
    return (o.status === 'pending' || o.status === 'failed') && o.payment_status === 'paid'
}

// ─── Biller badge ───────────────────────────────────────────────────────────

function BillerBadge({ biller }: { biller: UtilityBiller }) {
    const ui = BILLER_UI[biller]
    const Icon = ui?.Icon ?? Package
    return (
        <span className={cn('inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium whitespace-nowrap', ui?.badge ?? 'bg-slate-100 text-slate-600')}>
            <Icon className="w-3.5 h-3.5 shrink-0" /> {billerLabel(biller)}
        </span>
    )
}

// ─── Stat Card ──────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, sub, accent, className }: {
    icon: React.ReactNode; label: string; value: string; sub?: React.ReactNode; accent?: string; className?: string
}) {
    return (
        <div className={cn('rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm min-w-0', className)}>
            <div className="flex items-center gap-2 mb-2 text-slate-500 dark:text-slate-400">
                {icon}
                <span className="text-xs font-medium truncate">{label}</span>
            </div>
            <p className={cn('text-lg font-semibold tabular-nums truncate', accent || 'text-slate-900 dark:text-white')}>{value}</p>
            {sub && <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">{sub}</div>}
        </div>
    )
}

// ─── Pause Banner ───────────────────────────────────────────────────────────

function PauseBanner({ paused, onResumeClick }: { paused: boolean; onResumeClick: () => void }) {
    if (!paused) return null
    return (
        <div className="rounded-2xl border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
                <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                    <p className="text-sm font-semibold text-red-800 dark:text-red-300">Hubtel Commission paused (float or credentials)</p>
                    <p className="text-xs text-red-700/80 dark:text-red-400/80 mt-0.5">Utilities AND airtime dispatch are held until this is resumed.</p>
                </div>
            </div>
            <Button
                size="sm" variant="outline"
                className="h-9 shrink-0 border-red-300 text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/50"
                onClick={onResumeClick}
            >
                Resume
            </Button>
        </div>
    )
}

// ─── Settings row primitives ────────────────────────────────────────────────

function ToggleRow({ label, description, checked, saving, onChange }: {
    label: string; description?: string; checked: boolean; saving?: boolean; onChange: (v: boolean) => void
}) {
    return (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
            <div className="min-w-0">
                <Label className="text-sm font-medium text-slate-900 dark:text-white flex items-center gap-1.5">
                    {label} {saving && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
                </Label>
                {description && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>}
            </div>
            <Switch checked={checked} disabled={saving} onCheckedChange={onChange} />
        </div>
    )
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function AdminUtilitiesPage() {
    // ── Settings state ──────────────────────────────────────────────────────
    const [settings, setSettings] = useState<UtilitySettingsState>(DEFAULT_SETTINGS)
    const [settingsLoading, setSettingsLoading] = useState(true)
    const [settingsError, setSettingsError] = useState(false)
    const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set())

    const [percentDraft, setPercentDraft] = useState(DEFAULT_SETTINGS.utility_commission_partner_percent)
    const [minDraft, setMinDraft] = useState(DEFAULT_SETTINGS.utility_min_amount)
    const [maxDraft, setMaxDraft] = useState(DEFAULT_SETTINGS.utility_max_amount)
    useEffect(() => setPercentDraft(settings.utility_commission_partner_percent), [settings.utility_commission_partner_percent])
    useEffect(() => setMinDraft(settings.utility_min_amount), [settings.utility_min_amount])
    useEffect(() => setMaxDraft(settings.utility_max_amount), [settings.utility_max_amount])

    const [commissionFeePercentDraft, setCommissionFeePercentDraft] = useState(DEFAULT_SETTINGS.commission_withdrawal_fee_percent)
    const [commissionFeeFlatDraft, setCommissionFeeFlatDraft] = useState(DEFAULT_SETTINGS.commission_withdrawal_fee_flat)
    const [commissionMinWithdrawalDraft, setCommissionMinWithdrawalDraft] = useState(DEFAULT_SETTINGS.commission_min_withdrawal_amount)
    useEffect(() => setCommissionFeePercentDraft(settings.commission_withdrawal_fee_percent), [settings.commission_withdrawal_fee_percent])
    useEffect(() => setCommissionFeeFlatDraft(settings.commission_withdrawal_fee_flat), [settings.commission_withdrawal_fee_flat])
    useEffect(() => setCommissionMinWithdrawalDraft(settings.commission_min_withdrawal_amount), [settings.commission_min_withdrawal_amount])

    const [resumeConfirmOpen, setResumeConfirmOpen] = useState(false)
    const [resuming, setResuming] = useState(false)

    // ── Orders state ────────────────────────────────────────────────────────
    const [orders, setOrders] = useState<UtilityOrder[]>([])
    const [stats, setStats] = useState<UtilityOrderStats>(ZERO_STATS)
    const [total, setTotal] = useState(0)
    const [ordersLoading, setOrdersLoading] = useState(true)
    const [ordersError, setOrdersError] = useState(false)
    const [page, setPage] = useState(0)

    const [statusFilter, setStatusFilter] = useState<'all' | UtilityOrderStatus>('all')
    const [billerFilter, setBillerFilter] = useState<'all' | UtilityBiller>('all')
    const [sourceFilter, setSourceFilter] = useState<'all' | string>('all')
    // Defaults to 'paid' — an unpaid/abandoned checkout still creates a utility_orders row
    // (required so the Hubtel Direct Pay rail has somewhere to write a fast customer
    // approval that lands before our own initiate-call even returns), but it should never
    // clutter the default admin view or be mistaken for a real pending fulfillment. See
    // canRefulfill/canStatusSync below for the matching action-gating fix.
    const [paymentFilter, setPaymentFilter] = useState<'paid' | 'unpaid' | 'all'>('paid')
    const [searchInput, setSearchInput] = useState('')
    const [debouncedSearch, setDebouncedSearch] = useState('')
    const [fromDate, setFromDate] = useState('')
    const [toDate, setToDate] = useState('')

    const [selectedOrder, setSelectedOrder] = useState<UtilityOrder | null>(null)
    // Per-order in-flight tracking as a Set — a scalar id would be overwritten when a
    // second order's action starts, silently re-enabling the first order's buttons.
    const [busyOrders, setBusyOrders] = useState<Set<string>>(new Set())
    const [actionConfirm, setActionConfirm] = useState<{ type: ActionType; order: UtilityOrder } | null>(null)
    // MoMo details modal state — mirrors app/admin/fulfillment/page.tsx's momoOrderId/
    // momoModalOpen pattern for shop data orders.
    const [momoOrderId, setMomoOrderId] = useState<string | null>(null)
    const [momoModalOpen, setMomoModalOpen] = useState(false)

    // ── Data loaders ────────────────────────────────────────────────────────

    const loadSettings = useCallback(async () => {
        setSettingsLoading(true)
        setSettingsError(false)
        try {
            const res = await fetch('/api/admin/utilities/settings')
            const d = await res.json().catch(() => ({}))
            if (!res.ok) { setSettingsError(true); toast.error(d.error || 'Failed to load settings'); return }
            setSettings(mergeSettings(d.settings))
        } catch (e) {
            console.error(e); setSettingsError(true); toast.error('Network error loading settings')
        } finally {
            setSettingsLoading(false)
        }
    }, [])

    const loadOrders = useCallback(async () => {
        setOrdersLoading(true)
        setOrdersError(false)
        try {
            const params = new URLSearchParams()
            if (statusFilter !== 'all') params.set('status', statusFilter)
            if (billerFilter !== 'all') params.set('biller', billerFilter)
            if (sourceFilter !== 'all') params.set('source', sourceFilter)
            if (paymentFilter !== 'all') {
                params.set('payment', paymentFilter)
            } else {
                // Explicit admin choice to see EVERY payment state — including abandoned/
                // never-paid checkouts — must actually mean all of them. Without this, "All"
                // sends no `payment` param and silently falls into the route's own default
                // (hide unpaid) exclusion, contradicting what the admin just picked.
                params.set('include_abandoned', 'true')
            }
            if (debouncedSearch) params.set('search', debouncedSearch)
            if (fromDate) params.set('from', fromDate)
            // End date inclusive: the route compares .lte('created_at', to) — a bare
            // YYYY-MM-DD means midnight, which would exclude the selected day's orders.
            if (toDate) params.set('to', `${toDate}T23:59:59.999Z`)
            params.set('limit', String(PAGE_SIZE))
            params.set('offset', String(page * PAGE_SIZE))

            const res = await fetch(`/api/admin/utilities?${params.toString()}`)
            const d = await res.json().catch(() => ({}))
            if (!d.success) { setOrdersError(true); toast.error(d.error || 'Failed to load utility orders'); return }
            setOrders(d.data?.orders || [])
            setStats(d.data?.stats || ZERO_STATS)
            setTotal(typeof d.data?.total === 'number' ? d.data.total : 0)
        } catch (e) {
            console.error(e); setOrdersError(true); toast.error('Network error loading utility orders')
        } finally {
            setOrdersLoading(false)
        }
    }, [statusFilter, billerFilter, sourceFilter, paymentFilter, debouncedSearch, fromDate, toDate, page])

    useEffect(() => { loadSettings() }, [loadSettings])
    useEffect(() => { loadOrders() }, [loadOrders])

    // Debounce search input -> debouncedSearch (also resets to page 0).
    useEffect(() => {
        const t = setTimeout(() => {
            setDebouncedSearch(searchInput.trim())
            setPage(0)
        }, 350)
        return () => clearTimeout(t)
    }, [searchInput])

    // Keep an open drawer's order in sync with the freshest fetched row (post-action refetch).
    useEffect(() => {
        setSelectedOrder(prev => {
            if (!prev) return prev
            const fresh = orders.find(o => o.id === prev.id)
            return fresh || prev
        })
    }, [orders])

    // ── Settings commit (optimistic + rollback) ─────────────────────────────

    async function commitSettings(patch: Record<string, any>, successMessage?: string): Promise<boolean> {
        const keys = Object.keys(patch)
        // Scoped rollback: snapshot ONLY the keys this call patches, captured inside the
        // functional updater so concurrent in-flight saves of OTHER keys are never wiped
        // by this call's revert (whole-object closure snapshots would clobber them).
        const previousPatchedValues: Record<string, any> = {}
        setSettings(s => {
            for (const k of keys) previousPatchedValues[k] = (s as any)[k]
            return { ...s, ...patch }
        })
        setSavingKeys(s => new Set([...s, ...keys]))
        const rollback = () => setSettings(s => ({ ...s, ...previousPatchedValues }))
        try {
            const res = await fetch('/api/admin/utilities/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            })
            const d = await res.json().catch(() => ({}))
            if (!res.ok || !d.success) {
                rollback()
                toast.error(d.error || 'Failed to save setting')
                return false
            }
            toast.success(successMessage || 'Setting saved')
            return true
        } catch {
            rollback()
            toast.error('Network error saving setting')
            return false
        } finally {
            setSavingKeys(s => { const next = new Set(s); keys.forEach(k => next.delete(k)); return next })
        }
    }

    const handleToggle = (key: ToggleKey, checked: boolean) => {
        const labels: Record<ToggleKey, string> = {
            utility_bills_enabled: 'Utility bills ' + (checked ? 'enabled' : 'disabled'),
            utility_auto_fulfillment_enabled: 'Auto-fulfillment ' + (checked ? 'enabled' : 'disabled'),
            storefront_utilities_enabled: 'Storefront access ' + (checked ? 'enabled' : 'disabled'),
            ussd_utility_enabled: 'USSD access ' + (checked ? 'enabled' : 'disabled'),
            commission_transfer_enabled: 'Commission transfers ' + (checked ? 'enabled' : 'disabled'),
            hubtel_receive_enabled_utility: checked
                ? 'Hubtel Direct Pay enabled — utility bills now charge via Hubtel (no Paystack fee)'
                : 'Hubtel Direct Pay disabled — utility bills now charge via Paystack',
        }
        commitSettings({ [key]: checked ? 'true' : 'false' }, labels[key])
    }

    const handleBillerToggle = (biller: UtilityBiller, checked: boolean) => {
        const nextBillers = { ...settings.hubtel_utility_billers, [biller]: checked }
        commitSettings({ hubtel_utility_billers: nextBillers }, `${billerLabel(biller)} ${checked ? 'enabled' : 'disabled'}`)
    }

    async function commitPercent() {
        const n = Number(percentDraft)
        if (!Number.isFinite(n)) { toast.error('Enter a valid percentage'); setPercentDraft(settings.utility_commission_partner_percent); return }
        await commitSettings({ utility_commission_partner_percent: n }, 'Partner commission % updated')
    }
    async function commitMin() {
        const n = Number(minDraft)
        if (!Number.isFinite(n)) { toast.error('Enter a valid minimum amount'); setMinDraft(settings.utility_min_amount); return }
        await commitSettings({ utility_min_amount: n }, 'Minimum amount updated')
    }
    async function commitMax() {
        const n = Number(maxDraft)
        if (!Number.isFinite(n)) { toast.error('Enter a valid maximum amount'); setMaxDraft(settings.utility_max_amount); return }
        await commitSettings({ utility_max_amount: n }, 'Maximum amount updated')
    }

    async function commitCommissionFeePercent() {
        const n = Number(commissionFeePercentDraft)
        if (!Number.isFinite(n) || n < 0 || n > 100) { toast.error('Enter a valid percentage (0–100)'); setCommissionFeePercentDraft(settings.commission_withdrawal_fee_percent); return }
        await commitSettings({ commission_withdrawal_fee_percent: n }, 'Withdrawal fee % updated')
    }
    async function commitCommissionFeeFlat() {
        const n = Number(commissionFeeFlatDraft)
        if (!Number.isFinite(n) || n < 0) { toast.error('Enter a valid flat fee'); setCommissionFeeFlatDraft(settings.commission_withdrawal_fee_flat); return }
        await commitSettings({ commission_withdrawal_fee_flat: n }, 'Withdrawal flat fee updated')
    }
    async function commitCommissionMinWithdrawal() {
        const n = Number(commissionMinWithdrawalDraft)
        if (!Number.isFinite(n) || n < 0) { toast.error('Enter a valid minimum amount'); setCommissionMinWithdrawalDraft(settings.commission_min_withdrawal_amount); return }
        await commitSettings({ commission_min_withdrawal_amount: n }, 'Minimum withdrawal updated')
    }

    async function handleResume() {
        setResuming(true)
        try {
            const res = await fetch('/api/admin/utilities/settings', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'resume' }),
            })
            const d = await res.json().catch(() => ({}))
            if (!res.ok || !d.success) { toast.error(d.error || 'Failed to resume'); return }
            toast.success('Hubtel commission resumed')
            setResumeConfirmOpen(false)
            loadSettings()
        } catch {
            toast.error('Network error resuming commission')
        } finally {
            setResuming(false)
        }
    }

    // ── Order actions ────────────────────────────────────────────────────────

    async function performAction(type: ActionType, order: UtilityOrder) {
        setBusyOrders(s => new Set(s).add(order.id))
        try {
            const res = await fetch('/api/admin/utilities', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: type, order_id: order.id }),
            })
            const d = await res.json().catch(() => ({}))
            if (!d.success) { toast.error(d.error || 'Action failed'); return }

            if (type === 'refulfill') toast.success('Refulfillment dispatched to Hubtel')
            else if (type === 'refund') {
                toast.success(d.data?.queued ? 'Refund queued for manual MoMo payout' : 'Refund processed')
            }
            else {
                const state = d.data?.state
                if (state === 'completed') toast.success('Confirmed delivered — order marked completed')
                else if (state === 'failed') toast.error('Hubtel reports this order failed')
                else toast.success(`Status checked — still ${state || 'pending'}`)
            }
        } catch {
            toast.error('Network error performing action')
        } finally {
            setBusyOrders(s => { const next = new Set(s); next.delete(order.id); return next })
            setActionConfirm(null)
            loadOrders()
        }
    }

    // ── Filters ──────────────────────────────────────────────────────────────

    const clearFilters = () => {
        setStatusFilter('all'); setBillerFilter('all'); setSourceFilter('all')
        setPaymentFilter('paid') // back to the baseline, not 'all' — see paymentFilter's declaration
        setSearchInput(''); setDebouncedSearch('')
        setFromDate(''); setToDate('')
        setPage(0)
    }
    const filtersActive = statusFilter !== 'all' || billerFilter !== 'all' || sourceFilter !== 'all'
        || paymentFilter !== 'paid' || debouncedSearch !== '' || fromDate !== '' || toDate !== ''

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    const paused = settings.hubtel_commission_paused === 'true'

    // ── Render ───────────────────────────────────────────────────────────────

    return (
        <div className="max-w-7xl mx-auto px-4 py-6 space-y-5 min-h-screen pb-24">
            {/* ── Header ──────────────────────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                        <Lightbulb className="w-5 h-5 text-amber-500 shrink-0" />
                        Utility Bills
                    </h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                        ECG, Ghana Water, DSTV, GOtv &amp; StarTimes — gates, economics &amp; orders
                    </p>
                </div>
                <Button
                    variant="outline" size="sm" className="h-9"
                    onClick={() => { loadSettings(); loadOrders() }}
                    disabled={settingsLoading || ordersLoading}
                >
                    <RefreshCw className={cn('w-4 h-4 mr-2', (settingsLoading || ordersLoading) && 'animate-spin')} />
                    Refresh
                </Button>
            </div>

            <Tabs defaultValue="orders">
                <TabsList>
                    <TabsTrigger value="orders">Orders</TabsTrigger>
                    <TabsTrigger value="settings">Settings</TabsTrigger>
                    <TabsTrigger value="refunds">Refund Queue</TabsTrigger>
                    <TabsTrigger value="commission">Commission Wallets</TabsTrigger>
                </TabsList>
                <TabsContent value="orders" className="space-y-5">

            {/* ── Stats row ───────────────────────────────────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <StatCard
                    icon={<Coins className="w-4 h-4" />}
                    label="Total sales"
                    value={`GHS ${stats.total_amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    sub={`${stats.total_orders} order${stats.total_orders !== 1 ? 's' : ''} in view`}
                    accent="text-emerald-600 dark:text-emerald-400"
                />
                <StatCard
                    icon={<Package className="w-4 h-4" />}
                    label="Orders"
                    value={String(stats.total_orders)}
                    sub={<span><span className="text-emerald-500">{stats.completed} completed</span> · <span className="text-blue-500">{stats.pending + stats.processing} in flight</span></span>}
                />
                <StatCard
                    icon={<Wallet className="w-4 h-4" />}
                    label="Hubtel commission earned"
                    value={`GHS ${fmt4(stats.total_commission)}`}
                    sub="Across filtered window"
                    accent="text-emerald-600 dark:text-emerald-400"
                />
                <StatCard
                    icon={<Users className="w-4 h-4" />}
                    label="Partner share paid"
                    value={`GHS ${fmt4(stats.total_partner_commission)}`}
                    sub={`${settings.utility_commission_partner_percent}% split configured`}
                />
                <StatCard
                    className="col-span-2 sm:col-span-1"
                    icon={<XCircle className="w-4 h-4" />}
                    label="Failed / Refunded"
                    value={String(stats.failed + stats.refunded)}
                    sub={`${stats.failed} failed · ${stats.refunded} refunded`}
                    accent={(stats.failed + stats.refunded) > 0 ? 'text-amber-500' : 'text-slate-400'}
                />
            </div>

            {/* ── Orders ──────────────────────────────────────────────────── */}
            <div className="space-y-4">
                {/* Filter bar */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm p-3 space-y-2.5">
                    <div className="flex flex-col lg:flex-row gap-2">
                        <div className="relative flex-1 min-w-0">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                            <Input
                                placeholder="Search reference, account number, or name…"
                                value={searchInput}
                                onChange={(e) => setSearchInput(e.target.value)}
                                className="pl-9 h-9 text-sm"
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-2 lg:flex lg:w-auto">
                            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as any); setPage(0) }}>
                                <SelectTrigger className="h-9 text-sm lg:w-36"><SelectValue placeholder="Status" /></SelectTrigger>
                                <SelectContent>
                                    {STATUS_FILTER_OPTIONS.map((s) => (
                                        <SelectItem key={s} value={s}>{s === 'all' ? 'All statuses' : getStatusLabel(s)}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Select value={billerFilter} onValueChange={(v) => { setBillerFilter(v as any); setPage(0) }}>
                                <SelectTrigger className="h-9 text-sm lg:w-36"><SelectValue placeholder="Biller" /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All billers</SelectItem>
                                    {UTILITY_BILLER_KEYS.map((b) => <SelectItem key={b} value={b}>{billerLabel(b)}</SelectItem>)}
                                </SelectContent>
                            </Select>
                            <Select value={sourceFilter} onValueChange={(v) => { setSourceFilter(v); setPage(0) }}>
                                <SelectTrigger className="h-9 text-sm lg:w-36"><SelectValue placeholder="Source" /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All sources</SelectItem>
                                    {SOURCE_KEYS.map((s) => <SelectItem key={s} value={s}>{SOURCE_LABELS[s]}</SelectItem>)}
                                </SelectContent>
                            </Select>
                            {/* Defaults to Paid (see paymentFilter's declaration) — an abandoned/unpaid
                                checkout still creates a row (Hubtel rail needs it to exist before the
                                charge fires) but should never look like a real pending order by default. */}
                            <Select value={paymentFilter} onValueChange={(v) => { setPaymentFilter(v as any); setPage(0) }}>
                                <SelectTrigger className="h-9 text-sm lg:w-36"><SelectValue placeholder="Payment" /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="paid">Paid only</SelectItem>
                                    <SelectItem value="unpaid">Unpaid only</SelectItem>
                                    <SelectItem value="all">All (incl. unpaid)</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                            <Calendar className="w-3.5 h-3.5" /> From
                        </div>
                        <Input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setPage(0) }} className="h-8 text-xs w-auto" />
                        <span className="text-xs text-slate-400">to</span>
                        <Input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); setPage(0) }} className="h-8 text-xs w-auto" />
                        {filtersActive && (
                            <Button variant="ghost" size="sm" className="h-8 text-xs ml-auto" onClick={clearFilters}>
                                <X className="w-3.5 h-3.5 mr-1" /> Clear all
                            </Button>
                        )}
                    </div>
                </div>

                {/* Table / states */}
                {ordersLoading ? (
                    <div className="flex flex-col items-center justify-center py-24 gap-3">
                        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
                        <p className="text-sm text-slate-500 dark:text-slate-400">Loading orders…</p>
                    </div>
                ) : ordersError ? (
                    <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 py-16 text-center">
                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">Could not load utility orders.</p>
                        <Button size="sm" variant="outline" onClick={loadOrders}><RefreshCw className="w-4 h-4 mr-2" /> Retry</Button>
                    </div>
                ) : orders.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 py-24 text-center px-4">
                        <Lightbulb className="w-10 h-10 mx-auto mb-3 text-slate-300 dark:text-slate-700" />
                        <p className="text-sm font-semibold text-slate-900 dark:text-white">No utility orders yet — the feature ships dark until you enable it above.</p>
                        {filtersActive && <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Try adjusting or clearing your filters.</p>}
                    </div>
                ) : (
                    <>
                        {/* Mobile-first responsive cards — one grid per order, matching
                            app/admin/fulfillment's row pattern (2 cols on mobile, more on desktop)
                            instead of a horizontally-scrolling <table>. */}
                        <div className="space-y-3">
                            {orders.map((o) => {
                                const purchaserName = o.users?.first_name
                                    ? `${o.users.first_name} ${o.users.last_name || ''}`.trim()
                                    : (o.shop_name || 'Guest')
                                const isPaid = o.payment_status === 'paid'
                                return (
                                    <div
                                        key={o.id}
                                        onClick={() => {
                                            if (window.getSelection()?.toString()) return
                                            setSelectedOrder(o)
                                        }}
                                        className="group relative flex flex-wrap md:flex-nowrap items-center gap-3 p-3 border-2 border-transparent rounded-xl bg-white dark:bg-slate-900 shadow-sm hover:border-primary/20 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-all duration-200 cursor-pointer"
                                    >
                                        <div className="flex-1 min-w-0 grid grid-cols-2 md:grid-cols-6 items-center gap-x-2 gap-y-3 md:gap-4 p-1">
                                            <div className="space-y-0.5">
                                                <p className="text-[10px] md:text-[11px] uppercase font-medium text-slate-500 dark:text-slate-400">Biller</p>
                                                <div className="flex items-center gap-1.5">
                                                    <UtilityBillerLogo biller={o.biller} FallbackIcon={(BILLER_UI[o.biller]?.Icon) ?? Package} badgeClassName={BILLER_UI[o.biller]?.badge ?? 'bg-slate-100 text-slate-500'} size={24} rounded="lg" />
                                                    <span className="text-[13px] md:text-sm font-medium truncate">{billerLabel(o.biller)}</span>
                                                </div>
                                            </div>
                                            <div className="space-y-0.5 min-w-0">
                                                <p className="text-[10px] md:text-[11px] uppercase font-medium text-slate-500 dark:text-slate-400">Account</p>
                                                {isUnverifiedMeterName(o) ? (
                                                    <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 truncate" title="Customer typed this meter number manually — Hubtel's ECG top-up API returns no account-holder name to confirm it against.">
                                                        Unverified — entered manually
                                                    </p>
                                                ) : (
                                                    <p className="text-[13px] md:text-sm font-medium truncate">{o.account_name || '—'}</p>
                                                )}
                                                <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate">{o.account_number}</p>
                                            </div>
                                            <div className="space-y-0.5 min-w-0">
                                                <p className="text-[10px] md:text-[11px] uppercase font-medium text-slate-500 dark:text-slate-400">Purchaser</p>
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <p className="font-bold text-[11px] md:text-xs truncate max-w-[100px] md:max-w-full" title={purchaserName}>
                                                        {purchaserName}
                                                    </p>
                                                    {o.source === 'api' && (
                                                        <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-violet-100 text-violet-700 hover:bg-violet-100 border-violet-200">API</Badge>
                                                    )}
                                                    {(o.source === 'ussd' || o.source === 'ussd_shop') && (
                                                        <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-blue-100 text-blue-700 hover:bg-blue-100 border-blue-200">USSD</Badge>
                                                    )}
                                                    {o.source === 'storefront' && (
                                                        <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-cyan-100 text-cyan-700 hover:bg-cyan-100 border-cyan-200">Storefront</Badge>
                                                    )}
                                                    {o.source === 'dashboard' && (
                                                        <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-slate-100 text-slate-700 hover:bg-slate-100 border-slate-200">Dashboard</Badge>
                                                    )}
                                                    {o.shop_name && o.users?.first_name && (
                                                        <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-blue-100 text-blue-700 hover:bg-blue-100 border-blue-200">
                                                            Shop: {o.shop_name}
                                                        </Badge>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="space-y-0.5">
                                                <p className="text-[10px] md:text-[11px] uppercase font-medium text-slate-500 dark:text-slate-400">Status</p>
                                                <div className="flex items-center gap-1 flex-wrap">
                                                    <span className={cn(
                                                        'inline-flex items-center rounded-md text-[10px] md:text-[11px] font-medium h-5 px-2',
                                                        isPaid ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                                                    )}>
                                                        {isPaid ? 'Paid' : 'Unpaid'}
                                                    </span>
                                                    <span className={cn('inline-flex items-center rounded-md text-[10px] md:text-[11px] font-medium h-5 px-2', getStatusBadgeClass(o.status))}>
                                                        {getStatusLabel(o.status)}
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="space-y-0.5">
                                                <p className="text-[10px] md:text-[11px] uppercase font-medium text-slate-500 dark:text-slate-400">Time</p>
                                                <p className="text-[11px] md:text-[12px] font-bold opacity-80">{fmtDate(o.created_at)}</p>
                                            </div>
                                            <div className="space-y-0.5 md:text-right">
                                                <p className="text-[10px] md:text-[11px] uppercase font-medium text-slate-500 dark:text-slate-400">Amount</p>
                                                <p className="text-[13px] md:text-sm font-semibold tabular-nums">GHS {Number(o.amount).toFixed(2)}</p>
                                                {Number(o.commission_amount) > 0 && (
                                                    <p className="text-[10px] text-emerald-600 dark:text-emerald-400 tabular-nums">+{fmt4(o.commission_amount)} comm.</p>
                                                )}
                                            </div>
                                        </div>

                                        <div className="w-full md:w-auto flex items-center gap-1 flex-wrap" onClick={(e) => e.stopPropagation()}>
                                            <Button variant="ghost" size="icon" className="h-7 w-7" title="View details" onClick={() => setSelectedOrder(o)}>
                                                <Eye className="w-3.5 h-3.5" />
                                            </Button>
                                            {canRefulfill(o) && (
                                                <Button variant="outline" size="sm" className="h-7 px-2 text-xs gap-1 text-emerald-700 border-emerald-200 dark:text-emerald-300 dark:border-emerald-900"
                                                    disabled={busyOrders.has(o.id)}
                                                    onClick={() => setActionConfirm({ type: 'refulfill', order: o })}>
                                                    {busyOrders.has(o.id) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Repeat2 className="w-3.5 h-3.5" />} Refulfill
                                                </Button>
                                            )}
                                            {canStatusSync(o) && (
                                                <Button variant="outline" size="sm" className="h-7 px-2 text-xs gap-1 text-blue-700 border-blue-200 dark:text-blue-300 dark:border-blue-900"
                                                    disabled={busyOrders.has(o.id)}
                                                    onClick={() => setActionConfirm({ type: 'status_sync', order: o })}>
                                                    {busyOrders.has(o.id) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Sync
                                                </Button>
                                            )}
                                            {canRefund(o) && (
                                                <Button variant="outline" size="sm" className="h-7 px-2 text-xs gap-1 text-amber-700 border-amber-200 dark:text-amber-300 dark:border-amber-900"
                                                    disabled={busyOrders.has(o.id)}
                                                    onClick={() => setActionConfirm({ type: 'refund', order: o })}>
                                                    {busyOrders.has(o.id) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Refund
                                                </Button>
                                            )}
                                            {isMomoLookupEligible({ status: o.status }) && (
                                                <Button variant="outline" size="sm" className="h-7 px-2 text-xs gap-1 text-purple-600 hover:text-purple-700 hover:bg-purple-50 border-purple-200 dark:border-purple-900"
                                                    onClick={(e) => { e.stopPropagation(); setMomoOrderId(o.id); setMomoModalOpen(true) }}>
                                                    <Smartphone className="w-3.5 h-3.5" /> View MoMo
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>

                        {/* Pagination */}
                        <div className="flex items-center justify-between gap-3">
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                            </p>
                            <div className="flex items-center gap-2">
                                <Button variant="outline" size="sm" className="h-8" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>
                                    <ChevronLeft className="w-4 h-4" />
                                </Button>
                                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">Page {page + 1} of {totalPages}</span>
                                <Button variant="outline" size="sm" className="h-8" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(p => p + 1)}>
                                    <ChevronRight className="w-4 h-4" />
                                </Button>
                            </div>
                        </div>
                    </>
                )}
            </div>

                </TabsContent>
                <TabsContent value="settings" className="space-y-5">

            {/* ── Pause banner ────────────────────────────────────────────── */}
            <PauseBanner paused={paused} onResumeClick={() => setResumeConfirmOpen(true)} />

            {/* ── Controls ────────────────────────────────────────────────── */}
            {settingsLoading ? (
                <div className="flex items-center justify-center py-16">
                    <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
                </div>
            ) : settingsError ? (
                <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 py-10 text-center">
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">Could not load settings.</p>
                    <Button size="sm" variant="outline" onClick={loadSettings}><RefreshCw className="w-4 h-4 mr-2" /> Retry</Button>
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    {/* Feature gates */}
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm p-4 space-y-3">
                        <div>
                            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Feature gates</h2>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Master switches &amp; per-biller availability</p>
                        </div>
                        <ToggleRow
                            label="Utility bills enabled"
                            description="Master switch — turns the whole feature on or off"
                            checked={settings.utility_bills_enabled === 'true'}
                            saving={savingKeys.has('utility_bills_enabled')}
                            onChange={(v) => handleToggle('utility_bills_enabled', v)}
                        />
                        <ToggleRow
                            label="Auto-fulfillment"
                            description="Dispatch paid orders to Hubtel automatically"
                            checked={settings.utility_auto_fulfillment_enabled === 'true'}
                            saving={savingKeys.has('utility_auto_fulfillment_enabled')}
                            onChange={(v) => handleToggle('utility_auto_fulfillment_enabled', v)}
                        />
                        <div className="pt-1 space-y-2">
                            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Enabled billers</p>
                            <p className="text-[11px] text-slate-400 dark:text-slate-500 -mt-1">Controls which billers customers can pay, and which are eligible for auto-fulfillment.</p>
                            {UTILITY_BILLER_KEYS.map((biller) => {
                                const ui = BILLER_UI[biller]
                                return (
                                    <div key={biller} className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                                        <div className="flex items-center gap-2.5 min-w-0">
                                            <UtilityBillerLogo
                                                biller={biller}
                                                FallbackIcon={ui?.Icon ?? Package}
                                                badgeClassName={ui?.badge ?? 'bg-slate-100 text-slate-500'}
                                                size={28}
                                                rounded="lg"
                                            />
                                            <span className="text-sm font-medium text-slate-900 dark:text-white truncate">{billerLabel(biller)}</span>
                                        </div>
                                        <Switch
                                            checked={!!settings.hubtel_utility_billers[biller]}
                                            disabled={savingKeys.has('hubtel_utility_billers')}
                                            onCheckedChange={(v) => handleBillerToggle(biller, v)}
                                        />
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    {/* Surfaces */}
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm p-4 space-y-3 lg:self-start">
                        <div>
                            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Surfaces</h2>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Where customers can pay a bill</p>
                        </div>
                        <ToggleRow
                            label="Storefront"
                            description="Allow shop storefronts to sell utility bills"
                            checked={settings.storefront_utilities_enabled === 'true'}
                            saving={savingKeys.has('storefront_utilities_enabled')}
                            onChange={(v) => handleToggle('storefront_utilities_enabled', v)}
                        />
                        <ToggleRow
                            label="USSD"
                            description="Allow utility bill payment over USSD"
                            checked={settings.ussd_utility_enabled === 'true'}
                            saving={savingKeys.has('ussd_utility_enabled')}
                            onChange={(v) => handleToggle('ussd_utility_enabled', v)}
                        />
                        <div className="pt-1 space-y-2 border-t border-slate-100 dark:border-slate-800 mt-1">
                            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 pt-2">Storefront payment rail</p>
                            <p className="text-[11px] text-slate-400 dark:text-slate-500 -mt-1">
                                ON: charges via Hubtel Direct Pay — no Paystack fee (bills are zero-markup, commission-only).
                                OFF: falls back to Paystack Mobile Money — same rail as every other product, customer bears the ~2% fee.
                            </p>
                            <ToggleRow
                                label="Hubtel Direct Pay"
                                description="Charge storefront utility bills via Hubtel instead of Paystack"
                                checked={settings.hubtel_receive_enabled_utility === 'true'}
                                saving={savingKeys.has('hubtel_receive_enabled_utility')}
                                onChange={(v) => handleToggle('hubtel_receive_enabled_utility', v)}
                            />
                        </div>
                    </div>

                    {/* Economics */}
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm p-4 space-y-4 lg:self-start">
                        <div>
                            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Economics</h2>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Partner split &amp; transaction limits</p>
                        </div>

                        <div className="space-y-1.5">
                            <Label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                                Partner commission split {savingKeys.has('utility_commission_partner_percent') && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
                            </Label>
                            <div className="relative">
                                <Input
                                    type="number" min="0" max="100" step="1"
                                    value={percentDraft}
                                    onChange={(e) => setPercentDraft(e.target.value)}
                                    onBlur={commitPercent}
                                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                    className="h-9 pr-8 text-sm tabular-nums"
                                />
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">%</span>
                            </div>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                Partner keeps {Number.isFinite(Number(percentDraft)) ? Math.min(100, Math.max(0, Number(percentDraft))) : 0}%
                                {' · '}
                                Platform keeps {Number.isFinite(Number(percentDraft)) ? 100 - Math.min(100, Math.max(0, Number(percentDraft))) : 100}%
                            </p>
                        </div>

                        <div className="space-y-1.5">
                            <Label className="text-xs font-medium text-slate-500 dark:text-slate-400">Transaction limits (GHS)</Label>
                            <div className="grid grid-cols-2 gap-2">
                                <div className="relative">
                                    <Input
                                        type="number" min="1" step="1"
                                        value={minDraft}
                                        onChange={(e) => setMinDraft(e.target.value)}
                                        onBlur={commitMin}
                                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                        className="h-9 pr-10 text-sm tabular-nums"
                                        placeholder="Min"
                                    />
                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">Min</span>
                                </div>
                                <div className="relative">
                                    <Input
                                        type="number" min="1" step="1"
                                        value={maxDraft}
                                        onChange={(e) => setMaxDraft(e.target.value)}
                                        onBlur={commitMax}
                                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                        className="h-9 pr-10 text-sm tabular-nums"
                                        placeholder="Max"
                                    />
                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">Max</span>
                                </div>
                            </div>
                            <p className="text-xs text-slate-500 dark:text-slate-400">1 ≤ min ≤ max ≤ 10,000</p>
                        </div>
                    </div>

                    {/* Commission Wallet */}
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm p-4 space-y-4 lg:col-span-3">
                        <div>
                            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Commission Wallet</h2>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Withdrawal fees, minimum payout &amp; internal transfers — separate from utility order settings above</p>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div className="space-y-1.5">
                                <Label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                                    Withdrawal fee % {savingKeys.has('commission_withdrawal_fee_percent') && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
                                </Label>
                                <div className="relative">
                                    <Input
                                        type="number" min="0" max="100" step="0.1"
                                        value={commissionFeePercentDraft}
                                        onChange={(e) => setCommissionFeePercentDraft(e.target.value)}
                                        onBlur={commitCommissionFeePercent}
                                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                        className="h-9 pr-8 text-sm tabular-nums"
                                    />
                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">%</span>
                                </div>
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                                    Withdrawal flat fee (GHS) {savingKeys.has('commission_withdrawal_fee_flat') && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
                                </Label>
                                <Input
                                    type="number" min="0" step="0.01"
                                    value={commissionFeeFlatDraft}
                                    onChange={(e) => setCommissionFeeFlatDraft(e.target.value)}
                                    onBlur={commitCommissionFeeFlat}
                                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                    className="h-9 text-sm tabular-nums"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                                    Min withdrawal (GHS) {savingKeys.has('commission_min_withdrawal_amount') && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
                                </Label>
                                <Input
                                    type="number" min="0" step="1"
                                    value={commissionMinWithdrawalDraft}
                                    onChange={(e) => setCommissionMinWithdrawalDraft(e.target.value)}
                                    onBlur={commitCommissionMinWithdrawal}
                                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                    className="h-9 text-sm tabular-nums"
                                />
                            </div>
                        </div>
                        <ToggleRow
                            label="Internal transfers enabled"
                            description="Allow shop owners to transfer between their commission and shop wallets"
                            checked={settings.commission_transfer_enabled === 'true'}
                            saving={savingKeys.has('commission_transfer_enabled')}
                            onChange={(v) => handleToggle('commission_transfer_enabled', v)}
                        />
                    </div>
                </div>
            )}

            {/* ── Ops note ────────────────────────────────────────────────── */}
            <div className="rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/20 p-3 flex gap-2.5">
                <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                <p className="text-xs text-blue-700 dark:text-blue-300 leading-snug">
                    Status checks route through the Fixie static-IP proxy (Hubtel allowlists it). Each utility sale can use 2–3 proxied calls
                    (lookup, Ghana Water session, status check) vs ~1 for airtime — watch Fixie volume as utilities grow.
                </p>
            </div>

                </TabsContent>
                <TabsContent value="refunds">
                    <RefundQueueTab />
                </TabsContent>
                <TabsContent value="commission">
                    <CommissionWalletsTab />
                </TabsContent>
            </Tabs>

            {/* ── Detail drawer ───────────────────────────────────────────── */}
            <Sheet open={!!selectedOrder} onOpenChange={(open) => { if (!open) setSelectedOrder(null) }}>
                <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
                    {selectedOrder && (
                        <>
                            <SheetHeader>
                                <SheetTitle className="flex items-center gap-2">
                                    <BillerBadge biller={selectedOrder.biller} />
                                </SheetTitle>
                                <SheetDescription className="font-mono text-xs">{selectedOrder.reference_code}</SheetDescription>
                            </SheetHeader>

                            <div className="space-y-5 mt-5">
                                <div className="flex justify-between items-center gap-2 text-sm">
                                    <span className="text-slate-500 dark:text-slate-400">Purchaser</span>
                                    <span className="font-medium text-slate-900 dark:text-white truncate max-w-[60%] text-right">
                                        {selectedOrder.users?.first_name
                                            ? `${selectedOrder.users.first_name} ${selectedOrder.users.last_name || ''}`.trim()
                                            : (selectedOrder.shop_name || 'Guest')}
                                    </span>
                                </div>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium', getStatusBadgeClass(selectedOrder.status))}>
                                        {getStatusLabel(selectedOrder.status)}
                                    </span>
                                    <Badge variant="outline" className="text-xs">{SOURCE_LABELS[selectedOrder.source] || selectedOrder.source}</Badge>
                                    <Badge variant="outline" className="text-xs capitalize">{selectedOrder.payment_method}</Badge>
                                </div>

                                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2 text-sm">
                                    <div className="flex justify-between items-center gap-2">
                                        <span className="text-slate-500 dark:text-slate-400">Amount</span>
                                        <span className="font-semibold tabular-nums text-slate-900 dark:text-white">GHS {Number(selectedOrder.amount).toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between items-center gap-2">
                                        <span className="text-slate-500 dark:text-slate-400">Hubtel commission</span>
                                        <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">GHS {fmt4(selectedOrder.commission_amount)}</span>
                                    </div>
                                    <div className="flex justify-between items-center gap-2">
                                        <span className="text-slate-500 dark:text-slate-400">Partner share</span>
                                        <span className="font-medium tabular-nums text-slate-700 dark:text-slate-300">GHS {fmt4(selectedOrder.partner_commission_amount)}</span>
                                    </div>
                                    <div className="flex justify-between items-center gap-2">
                                        <span className="text-slate-500 dark:text-slate-400">Commission credited</span>
                                        <span className="font-medium text-slate-700 dark:text-slate-300 text-xs">{fmtDate(selectedOrder.commission_credited_at)}</span>
                                    </div>
                                </div>

                                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2 text-sm">
                                    <div className="flex justify-between items-center gap-2">
                                        <span className="text-slate-500 dark:text-slate-400">Account name</span>
                                        {isUnverifiedMeterName(selectedOrder) ? (
                                            <span className="font-semibold text-amber-600 dark:text-amber-400 truncate max-w-[60%] text-right" title="Customer typed this meter number manually — Hubtel's ECG top-up API returns no account-holder name to confirm it against.">
                                                Unverified — entered manually
                                            </span>
                                        ) : (
                                            <span className="font-medium text-slate-900 dark:text-white truncate max-w-[60%] text-right">{selectedOrder.account_name || '—'}</span>
                                        )}
                                    </div>
                                    <div className="flex justify-between items-center gap-2">
                                        <span className="text-slate-500 dark:text-slate-400">Account number</span>
                                        <span className="font-mono font-medium text-slate-900 dark:text-white flex items-center gap-1">
                                            {selectedOrder.account_number}
                                            <button
                                                onClick={() => { navigator.clipboard.writeText(selectedOrder.account_number); toast.success('Copied') }}
                                                className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                                                aria-label="Copy account number"
                                            ><Copy className="w-3.5 h-3.5" /></button>
                                        </span>
                                    </div>
                                    {selectedOrder.destination_phone && (
                                        <div className="flex justify-between items-center gap-2">
                                            <span className="text-slate-500 dark:text-slate-400">Destination phone</span>
                                            <span className="font-mono font-medium text-slate-900 dark:text-white">{selectedOrder.destination_phone}</span>
                                        </div>
                                    )}
                                    {selectedOrder.customer_email && (
                                        <div className="flex justify-between items-center gap-2">
                                            <span className="text-slate-500 dark:text-slate-400">Email</span>
                                            <span className="font-medium text-slate-900 dark:text-white truncate max-w-[60%] text-right">{selectedOrder.customer_email}</span>
                                        </div>
                                    )}
                                    <div className="flex justify-between items-center gap-2">
                                        <span className="text-slate-500 dark:text-slate-400">Payment status</span>
                                        <span className={cn(
                                            'inline-flex items-center rounded-md text-[11px] font-medium h-5 px-2 capitalize',
                                            selectedOrder.payment_status === 'paid'
                                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                                                : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                                        )}>
                                            {selectedOrder.payment_status}
                                        </span>
                                    </div>
                                    {selectedOrder.payment_reference && (
                                        <div className="flex justify-between items-center gap-2">
                                            <span className="text-slate-500 dark:text-slate-400">Payment reference</span>
                                            <span className="font-mono text-xs text-slate-900 dark:text-white truncate max-w-[60%] text-right">{selectedOrder.payment_reference}</span>
                                        </div>
                                    )}
                                    <div className="flex justify-between items-center gap-2">
                                        <span className="text-slate-500 dark:text-slate-400">Fulfillment attempts</span>
                                        <span className="font-medium text-slate-900 dark:text-white">{selectedOrder.fulfillment_attempts ?? 0}</span>
                                    </div>
                                    <div className="flex justify-between items-center gap-2">
                                        <span className="text-slate-500 dark:text-slate-400">Created</span>
                                        <span className="font-medium text-slate-900 dark:text-white text-xs">{fmtDate(selectedOrder.created_at)}</span>
                                    </div>
                                    <div className="flex justify-between items-center gap-2">
                                        <span className="text-slate-500 dark:text-slate-400">Updated</span>
                                        <span className="font-medium text-slate-900 dark:text-white text-xs">{fmtDate(selectedOrder.updated_at)}</span>
                                    </div>
                                </div>

                                <div>
                                    <p className="text-xs uppercase font-bold text-slate-400 dark:text-slate-500 tracking-wider mb-2">Fulfillment metadata</p>
                                    <pre className="text-[11px] leading-relaxed font-mono bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-slate-700 dark:text-slate-300">
                                        {selectedOrder.fulfillment_metadata ? JSON.stringify(selectedOrder.fulfillment_metadata, null, 2) : '—'}
                                    </pre>
                                </div>

                                {(canRefulfill(selectedOrder) || canStatusSync(selectedOrder) || canRefund(selectedOrder) || isMomoLookupEligible({ status: selectedOrder.status })) && (
                                    <div className="flex items-center gap-2 flex-wrap pt-1">
                                        {canRefulfill(selectedOrder) && (
                                            <Button size="sm" variant="outline" className="flex-1 h-9 text-xs gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900 dark:text-emerald-300"
                                                disabled={busyOrders.has(selectedOrder.id)}
                                                onClick={() => setActionConfirm({ type: 'refulfill', order: selectedOrder })}>
                                                <Repeat2 className="w-3.5 h-3.5" /> Refulfill
                                            </Button>
                                        )}
                                        {canStatusSync(selectedOrder) && (
                                            <Button size="sm" variant="outline" className="flex-1 h-9 text-xs gap-1.5 border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:text-blue-300"
                                                disabled={busyOrders.has(selectedOrder.id)}
                                                onClick={() => setActionConfirm({ type: 'status_sync', order: selectedOrder })}>
                                                <RefreshCw className="w-3.5 h-3.5" /> Status sync
                                            </Button>
                                        )}
                                        {canRefund(selectedOrder) && (
                                            <Button size="sm" variant="outline" className="flex-1 h-9 text-xs gap-1.5 border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-900 dark:text-amber-300"
                                                disabled={busyOrders.has(selectedOrder.id)}
                                                onClick={() => setActionConfirm({ type: 'refund', order: selectedOrder })}>
                                                <RotateCcw className="w-3.5 h-3.5" /> Refund
                                            </Button>
                                        )}
                                        {isMomoLookupEligible({ status: selectedOrder.status }) && (
                                            <Button size="sm" variant="outline" className="flex-1 h-9 text-xs gap-1.5 border-purple-200 text-purple-600 hover:bg-purple-50 dark:border-purple-900"
                                                onClick={() => { setMomoOrderId(selectedOrder.id); setMomoModalOpen(true) }}>
                                                <Smartphone className="w-3.5 h-3.5" /> View MoMo
                                            </Button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </SheetContent>
            </Sheet>

            <MomoDetailsModal
                open={momoModalOpen}
                onOpenChange={setMomoModalOpen}
                fetchUrl={momoOrderId ? `/api/admin/utility-orders/${momoOrderId}/momo-details` : null}
            />

            {/* ── Action confirm dialog (refulfill / status_sync / refund) ──── */}
            <Dialog open={!!actionConfirm} onOpenChange={(o) => { if (!o && !(actionConfirm && busyOrders.has(actionConfirm.order.id))) setActionConfirm(null) }}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {actionConfirm?.type === 'refund' ? 'Refund this order?'
                                : actionConfirm?.type === 'status_sync' ? 'Sync status with Hubtel?'
                                    : 'Refulfill this order?'}
                        </DialogTitle>
                        <DialogDescription>
                            {actionConfirm ? `${billerLabel(actionConfirm.order.biller)} · GHS ${Number(actionConfirm.order.amount).toFixed(2)} · ${actionConfirm.order.reference_code}` : ''}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="text-sm text-muted-foreground">
                        {actionConfirm?.type === 'refulfill' && <p>Re-dispatches this order to Hubtel. Only pending or failed orders are eligible.</p>}
                        {actionConfirm?.type === 'status_sync' && <p>Checks Hubtel&apos;s Transaction Status for this order&apos;s last attempt and applies the verdict.</p>}
                        {actionConfirm?.type === 'refund' && (
                            <p>Refunds GHS {actionConfirm ? Number(actionConfirm.order.amount).toFixed(2) : ''} — credited instantly to the buyer&apos;s wallet if eligible, otherwise queued for the team to send a manual MoMo payout.</p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setActionConfirm(null)} disabled={!!actionConfirm && busyOrders.has(actionConfirm.order.id)}>Cancel</Button>
                        <Button
                            variant={actionConfirm?.type === 'refund' ? 'destructive' : 'default'}
                            disabled={!!actionConfirm && busyOrders.has(actionConfirm.order.id)}
                            onClick={() => actionConfirm && performAction(actionConfirm.type, actionConfirm.order)}
                        >
                            {actionConfirm && busyOrders.has(actionConfirm.order.id)
                                ? <Loader2 className="w-4 h-4 animate-spin" />
                                : actionConfirm?.type === 'refund' ? 'Refund' : actionConfirm?.type === 'status_sync' ? 'Sync' : 'Refulfill'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Resume confirm dialog ──────────────────────────────────── */}
            <Dialog open={resumeConfirmOpen} onOpenChange={(o) => { if (!o && !resuming) setResumeConfirmOpen(false) }}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Resume Hubtel Commission?</DialogTitle>
                        <DialogDescription>
                            Clears the low-float/credentials pause flag shared with airtime. Auto-fulfillment resumes for both utilities and airtime immediately.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setResumeConfirmOpen(false)} disabled={resuming}>Cancel</Button>
                        <Button onClick={handleResume} disabled={resuming}>
                            {resuming ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Resume'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
