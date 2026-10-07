'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { getStatusBadgeClass, isRetryEligible } from '@/lib/order-status'
import { SUPPLIER_META, type SupplierTag } from '@/lib/order-supplier'
import { toggleSupplierNetwork } from '@/lib/fulfillment-supplier-toggle'
import { computeDateRange, DATE_FILTER_PRESETS, type DateFilterId } from '@/lib/admin-date-range'
import { MAX_BULK_RETRY } from '@/lib/refunds'
import { phoneSchema } from '@/lib/validation'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { RefreshCw, Wifi, Send, Loader2, Activity, Signal, Wallet, Plug, PlugZap, RotateCcw, Calendar as CalendarIcon, CheckCircle2, XCircle, Clock } from 'lucide-react'

// AT-iShare Console (SPFastIT) is denominated entirely in DATA, never currency.
// Every figure on this page is MB (converted to GB for display) — no `formatCurrency`
// and no "GHS" anywhere near it, on purpose. See app/api/admin/fulfillment/balance/route.ts.
const MB_PER_GB = 1000

function mbToGb(mb: number): string {
    return (mb / MB_PER_GB).toFixed(2)
}

interface ConsoleBalance {
    walletMb: number
    reservedMb: number
    availableMb: number
}

interface IShareOrder {
    id: string
    created_at: string
    phone_number: string
    network: string
    size: string
    price: number
    status: string
    supplier?: SupplierTag | null
    retry_count?: number | null
    shop_order_id?: string | null
    users?: {
        first_name: string
        last_name: string
        role: string
    } | null
    shop_name?: string | null
}

interface ManualSend {
    id: string
    phone: string
    bundle_mb: number
    status: string
    transaction_id: string | null
    created_at: string
}

export default function IShareFulfillmentPage() {
    const { dbUser } = useAuth()

    // Balance
    const [balance, setBalance] = useState<ConsoleBalance | null>(null)
    const [isLoadingBalance, setIsLoadingBalance] = useState(false)

    // Orders
    const [orders, setOrders] = useState<IShareOrder[]>([])
    const [isLoadingOrders, setIsLoadingOrders] = useState(true)

    // Date filter — same presets/behaviour as app/admin/fulfillment/page.tsx, driven by
    // the shared lib/admin-date-range.ts so the two pages can never compute different
    // ranges for the same preset.
    const [dateFilter, setDateFilter] = useState<DateFilterId>('today')
    const [customDate, setCustomDate] = useState('')

    // Supplier connect/disconnect — mirrors the Fulfillment Center's AT-iShare Console
    // row exactly, via the same atomic toggle_fulfillment_supplier_network RPC (see
    // lib/fulfillment-supplier-toggle.ts). Connecting here auto-disconnects every other
    // AT-iShare supplier; connecting another supplier from the Fulfillment Center
    // auto-disconnects this one — same invariant, same code path, either page.
    const [isConsoleConnected, setIsConsoleConnected] = useState(false)
    const [isLoadingConnection, setIsLoadingConnection] = useState(true)
    const [isTogglingConnection, setIsTogglingConnection] = useState(false)

    // Auto-Fulfillment master switch — the SAME global admin_settings.auto_fulfillment_enabled
    // flag every other supplier reads; not a per-supplier setting.
    const [globalEnabled, setGlobalEnabled] = useState(false)
    const [isSavingGlobal, setIsSavingGlobal] = useState(false)

    // Update tool (auto-complete cron) — same admin_settings keys as the Fulfillment
    // Center's "Auto-Complete" card.
    const [cronEnabled, setCronEnabled] = useState(false)
    const [cronThreshold, setCronThreshold] = useState(30)
    const [cronThresholdInput, setCronThresholdInput] = useState('30')
    const [isSavingCron, setIsSavingCron] = useState(false)

    // Refulfillment tool (auto-refulfill cron) — same admin_settings keys as the
    // Fulfillment Center's "Auto-Refulfill" card.
    const [autoRefulfillEnabled, setAutoRefulfillEnabled] = useState(false)
    const [autoRefulfillThreshold, setAutoRefulfillThreshold] = useState(5)
    const [autoRefulfillThresholdInput, setAutoRefulfillThresholdInput] = useState('5')
    const [isSavingAutoRefulfill, setIsSavingAutoRefulfill] = useState(false)

    // Sync
    const [isSyncing, setIsSyncing] = useState(false)
    const [syncCooldown, setSyncCooldown] = useState(false)

    // Free-form send
    const [sendPhone, setSendPhone] = useState('')
    const [sendSizeGb, setSendSizeGb] = useState('')
    const [isSending, setIsSending] = useState(false)

    // Recent manual sends — table may not exist yet (migration authored but not applied);
    // any query error degrades to an empty list, never a crashed page.
    const [manualSends, setManualSends] = useState<ManualSend[]>([])
    const [isLoadingManualSends, setIsLoadingManualSends] = useState(true)
    const [manualSendsUnavailable, setManualSendsUnavailable] = useState(false)

    // Manual selection + Update/Retry/Refulfill tools — SAME endpoints and eligibility
    // rule as app/admin/fulfillment/page.tsx (isRetryEligible from lib/order-status.ts,
    // /api/admin/orders/update-status, /api/admin/orders/retry,
    // /api/admin/fulfillment/refulfill). No new server-side code: all three already
    // operate on an explicit orderIds array, so scoping to "AT-iShare orders currently
    // on this page" is done client-side from the already network-filtered `orders` list —
    // never by widening what the shared endpoints accept.
    const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set())
    const [isUpdating, setIsUpdating] = useState(false)
    const [isRefulfilling, setIsRefulfilling] = useState(false)
    const [retryTarget, setRetryTarget] = useState<IShareOrder | null>(null)
    const [retryBusy, setRetryBusy] = useState(false)
    const [showBulkRetry, setShowBulkRetry] = useState(false)
    const [bulkRetryBusy, setBulkRetryBusy] = useState(false)

    const fetchBalance = useCallback(async () => {
        setIsLoadingBalance(true)
        try {
            const res = await fetch('/api/admin/fulfillment/balance?supplier=atishare_console')
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to fetch balance')
            setBalance({
                walletMb: data.atishare_console_wallet_mb ?? 0,
                reservedMb: data.atishare_console_reserved_mb ?? 0,
                availableMb: data.atishare_console_available_mb ?? 0,
            })
        } catch (error: any) {
            toast.error('Failed to fetch balance: ' + (error.message || 'Unknown error'))
        } finally {
            setIsLoadingBalance(false)
        }
    }, [])

    // limit=1000 matches app/admin/fulfillment/page.tsx's max load exactly (that route's
    // own default is also 1000 — passed explicitly here so the two pages can never
    // silently diverge if the route's default ever changes).
    const fetchOrders = useCallback(async (silent = false) => {
        if (!silent) setIsLoadingOrders(true)
        try {
            const { start, end } = computeDateRange(dateFilter, customDate)
            let url = '/api/admin/fulfillment?network=AT-iShare&status=All&channel=all&limit=1000'
            if (start) url += `&startDate=${start.toISOString()}`
            if (end) url += `&endDate=${end.toISOString()}`

            const res = await fetch(url)
            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}))
                throw new Error(errorData.error || 'Failed to fetch orders')
            }
            const data = await res.json()
            setOrders(data.orders || [])
        } catch (error: any) {
            if (!silent) toast.error('Failed to fetch orders: ' + (error.message || 'Unknown error'))
        } finally {
            if (!silent) setIsLoadingOrders(false)
        }
    }, [dateFilter, customDate])

    // Mirrors app/admin/fulfillment/page.tsx's fetchSettings — same admin_settings keys,
    // same tolerant string-or-object parse (fulfillment_settings has always been stored
    // double-encoded: a jsonb column holding a JSON *string*, not a jsonb object — see
    // the 20260822 migration's comment for why). Only the fields this page actually uses
    // are read.
    const fetchSettings = useCallback(async () => {
        setIsLoadingConnection(true)
        try {
            const { data, error } = await (supabase
                .from('admin_settings') as any)
                .select('key, value')
                .in('key', [
                    'auto_fulfillment_enabled',
                    'fulfillment_settings',
                    'auto_complete_data_enabled',
                    'auto_complete_data_threshold_mins',
                    'auto_refulfill_enabled',
                    'auto_refulfill_threshold_mins',
                ])

            if (error) throw error

            const map = (data || []).reduce((acc: any, row: any) => {
                acc[row.key] = row.value
                return acc
            }, {})

            setGlobalEnabled(map.auto_fulfillment_enabled === 'true' || map.auto_fulfillment_enabled === true)

            let atishareConsoleNetworks: Record<string, boolean> = {}
            try {
                if (map.fulfillment_settings) {
                    const parsed = typeof map.fulfillment_settings === 'string'
                        ? JSON.parse(map.fulfillment_settings)
                        : map.fulfillment_settings
                    atishareConsoleNetworks = parsed?.atishare_console_networks || {}
                }
            } catch (e) {
                console.error('[IShare] Failed to parse fulfillment_settings:', e)
            }
            setIsConsoleConnected(atishareConsoleNetworks['AT-iShare'] === true)

            const cronEnabledVal = map.auto_complete_data_enabled !== 'false' && map.auto_complete_data_enabled !== undefined
                ? map.auto_complete_data_enabled === 'true'
                : false
            const cronThresholdVal = parseInt(map.auto_complete_data_threshold_mins || '30', 10)
            setCronEnabled(cronEnabledVal)
            setCronThreshold(cronThresholdVal)
            setCronThresholdInput(String(cronThresholdVal))

            const autoRefulfillEnabledVal = map.auto_refulfill_enabled !== 'false' && map.auto_refulfill_enabled !== undefined
                ? map.auto_refulfill_enabled === 'true'
                : false
            const autoRefulfillThresholdVal = parseInt(map.auto_refulfill_threshold_mins || '5', 10)
            setAutoRefulfillEnabled(autoRefulfillEnabledVal)
            setAutoRefulfillThreshold(autoRefulfillThresholdVal)
            setAutoRefulfillThresholdInput(String(autoRefulfillThresholdVal))
        } catch (error) {
            console.error('[IShare] Failed to fetch settings:', error)
        } finally {
            setIsLoadingConnection(false)
        }
    }, [])

    // Connect/Disconnect — routes through the SAME atomic RPC the Fulfillment Center
    // uses (lib/fulfillment-supplier-toggle.ts). Connecting auto-disconnects every other
    // AT-iShare supplier server-side; this page just reflects whatever the RPC returns.
    const handleToggleConnection = async () => {
        setIsTogglingConnection(true)
        const result = await toggleSupplierNetwork('atishare_console', 'AT-iShare', !isConsoleConnected)
        setIsTogglingConnection(false)

        if (!result.success) {
            toast.error('Failed to update connection: ' + result.error)
            return
        }
        const nowConnected = result.settings.atishare_console_networks?.['AT-iShare'] === true
        setIsConsoleConnected(nowConnected)
        toast.success(nowConnected ? 'AT-iShare Console connected' : 'AT-iShare Console disconnected')
    }

    // Auto-Fulfillment master switch — same allowlisted quick-toggle route
    // app/admin/fulfillment/page.tsx's toggleGlobal now uses. This is a GLOBAL flag, not
    // per-supplier: flipping it here affects every supplier's auto-fulfillment, exactly
    // as it does from the Fulfillment Center.
    const handleToggleGlobal = async () => {
        const next = !globalEnabled
        const prev = globalEnabled
        setIsSavingGlobal(true)
        setGlobalEnabled(next) // optimistic
        try {
            const res = await fetch('/api/admin/settings/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'auto_fulfillment_enabled', value: next }),
            })
            const body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || 'Failed to update')
            toast.success(`Auto-Fulfillment ${next ? 'enabled' : 'disabled'}`)
        } catch (e: any) {
            setGlobalEnabled(prev) // revert
            toast.error(e.message || 'Failed to update setting')
        } finally {
            setIsSavingGlobal(false)
        }
    }

    // Update tool — identical admin_settings upsert pattern to
    // app/admin/fulfillment/page.tsx's saveCronSettings. Not supplier-specific (there is
    // nothing to enumerate/drift here, unlike the per-supplier network maps), so this is
    // duplicated rather than abstracted, matching how the Fulfillment Center itself
    // writes it.
    const saveCronSettings = async (enabled: boolean, thresholdMins: number) => {
        setIsSavingCron(true)
        try {
            const updates = [
                { key: 'auto_complete_data_enabled', value: String(enabled) },
                { key: 'auto_complete_data_threshold_mins', value: String(thresholdMins) },
            ]
            const { error } = await (supabase.from('admin_settings') as any).upsert(updates, { onConflict: 'key' })
            if (error) throw error
            setCronEnabled(enabled)
            setCronThreshold(thresholdMins)
            setCronThresholdInput(String(thresholdMins))
            toast.success('Auto-complete cron settings saved')
        } catch (error: any) {
            toast.error('Failed to save cron settings: ' + error.message)
        } finally {
            setIsSavingCron(false)
        }
    }

    // Refulfillment tool — identical admin_settings upsert pattern to
    // app/admin/fulfillment/page.tsx's saveAutoRefulfillSettings.
    const saveAutoRefulfillSettings = async (enabled: boolean, thresholdMins: number) => {
        setIsSavingAutoRefulfill(true)
        try {
            const updates = [
                { key: 'auto_refulfill_enabled', value: String(enabled) },
                { key: 'auto_refulfill_threshold_mins', value: String(thresholdMins) },
            ]
            const { error } = await (supabase.from('admin_settings') as any).upsert(updates, { onConflict: 'key' })
            if (error) throw error
            setAutoRefulfillEnabled(enabled)
            setAutoRefulfillThreshold(thresholdMins)
            setAutoRefulfillThresholdInput(String(thresholdMins))
            toast.success('Auto-refulfill cron settings saved')
        } catch (error: any) {
            toast.error('Failed to save cron settings: ' + error.message)
        } finally {
            setIsSavingAutoRefulfill(false)
        }
    }

    // Reads directly from atishare_console_manual_sends via the RLS-aware browser client
    // (same pattern the main Fulfillment Center uses for admin_settings). The table is
    // created by a migration this task deliberately does not apply, and is absent from
    // the generated Database type either way — cast to `any`, same convention already
    // used in app/api/admin/atishare-console/send/route.ts. Any error (missing table,
    // missing RLS policy, network failure) degrades to an empty list.
    const fetchManualSends = useCallback(async () => {
        setIsLoadingManualSends(true)
        try {
            const { data, error } = await (supabase as any)
                .from('atishare_console_manual_sends')
                .select('id, phone, bundle_mb, status, transaction_id, created_at')
                .order('created_at', { ascending: false })
                .limit(20)

            if (error) {
                setManualSends([])
                setManualSendsUnavailable(true)
                return
            }
            setManualSends((data || []) as ManualSend[])
            setManualSendsUnavailable(false)
        } catch {
            setManualSends([])
            setManualSendsUnavailable(true)
        } finally {
            setIsLoadingManualSends(false)
        }
    }, [])

    useEffect(() => {
        if (dbUser?.role === 'admin') {
            fetchBalance()
            fetchSettings()
            fetchManualSends()
        }
    }, [dbUser, fetchBalance, fetchSettings, fetchManualSends])

    // fetchOrders is memoized on [dateFilter, customDate] (see its useCallback above),
    // so this effect re-fires automatically whenever the date filter changes — no
    // separate "did the filter change" tracking needed, and no double-fetch on mount.
    useEffect(() => {
        if (dbUser?.role === 'admin') {
            fetchOrders()
        }
    }, [dbUser, fetchOrders])

    const handleSync = async () => {
        if (isSyncing || syncCooldown) return
        setIsSyncing(true)
        try {
            const res = await fetch('/api/admin/fulfillment/sync-atishare-console', { method: 'POST' })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Sync failed')

            toast.success(`${data.checked} checked, ${data.updated} updated, ${data.failed} failed`)
            if (Array.isArray(data.errors) && data.errors.length > 0) {
                const preview = data.errors.slice(0, 2).join('; ')
                toast.error(`${data.errors.length} error(s) during sync: ${preview}${data.errors.length > 2 ? '…' : ''}`)
            }
            await fetchOrders(true)
        } catch (error: any) {
            toast.error('Sync error: ' + (error.message || 'Unknown error'))
        } finally {
            setIsSyncing(false)
            setSyncCooldown(true)
            setTimeout(() => setSyncCooldown(false), 30000)
        }
    }

    // Retry-outcome copy — identical mapping to app/admin/fulfillment/page.tsx's
    // retryOutcomeMessage, so an admin sees the SAME explanation for the SAME
    // claim_order_retry outcome regardless of which page they retried from.
    const retryOutcomeMessage = (result: any): string => {
        const outcome = result?.outcome as string | undefined
        const messages: Record<string, string> = {
            insufficient_balance: `Insufficient wallet balance to fund this retry${result?.required != null && result?.available != null
                    ? ` — needs GHS ${Number(result.required).toFixed(2)}, wallet has GHS ${Number(result.available).toFixed(2)}`
                    : ''
                }.`,
            retry_locked: `This order is locked from further retries after 3 attempts${result?.until ? ` — try again after ${new Date(result.until).toLocaleString()}` : ', try again later'
                }.`,
            retry_too_soon: 'Please wait a few seconds before retrying this order again.',
            paystack_refund_no_wallet: "This order was refunded via Paystack — there is no wallet to charge for a retry.",
            not_retryable: result?.error || result?.message || 'This order is not in a retryable state.',
            admin_only: result?.error || result?.message || 'Only an admin can retry a failed order.',
            not_owner: result?.error || result?.message || 'You are not authorized to retry this order.',
            duplicate_attempt: 'This retry was already submitted — refresh and check the order status before trying again.',
            retry_already_in_progress: 'A previous retry for this order already succeeded or is in progress — refresh to see its current status.',
            owner_not_found: 'Could not find the shop owner to fund this retry.',
            no_wallet_user: 'This order has no wallet to charge for a retry.',
            invalid_charge_amount: 'Could not determine a valid retry price for this order.',
            invalid_actor_role: 'You are not authorized to perform this action.',
        }
        return (outcome && messages[outcome]) || result?.error || result?.message || 'Failed to retry order'
    }

    const handleRetry = (order: IShareOrder) => setRetryTarget(order)

    const submitRetry = async () => {
        if (!retryTarget || retryBusy) return
        setRetryBusy(true)
        try {
            const response = await fetch('/api/admin/orders/retry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: retryTarget.id }),
            })
            const result = await response.json()
            if (!response.ok || !result.success) {
                throw new Error(retryOutcomeMessage(result))
            }
            const data = result.data
            toast.success(
                data?.message ||
                (data?.chargedAmount ? `Retry dispatched — GHS ${Number(data.chargedAmount).toFixed(2)} charged` : 'Order retry dispatched')
            )
            setRetryTarget(null)
            await fetchOrders(true)
        } catch (error: any) {
            toast.error(error.message || 'Failed to retry order')
        } finally {
            setRetryBusy(false)
        }
    }

    // Selection filtered to retry-eligible orders only — same isRetryEligible gate the
    // Fulfillment Center uses.
    const retryEligibleSelected = orders.filter(o => selectedOrders.has(o.id) && isRetryEligible(o))
    const retryEligibleFailedCount = retryEligibleSelected.filter(o => o.status === 'failed').length
    const retryEligibleRefundedCount = retryEligibleSelected.filter(o => o.status === 'refunded').length

    const bulkRetry = async () => {
        const ids = retryEligibleSelected.map(o => o.id)
        if (ids.length === 0) { toast.error('No failed/refunded orders selected'); return }
        if (ids.length > MAX_BULK_RETRY) {
            toast.error(`Select at most ${MAX_BULK_RETRY} failed/refunded orders to retry at once`)
            return
        }
        setBulkRetryBusy(true)
        try {
            const response = await fetch('/api/admin/orders/retry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderIds: ids }),
            })
            const data = await response.json()
            if (!response.ok || !data.success) throw new Error(data.error || 'Bulk retry failed')
            const s = data.data?.summary ?? { ok: 0, skipped: 0, failed: 0, total: ids.length }
            toast.success(`Retried ${s.ok} · skipped ${s.skipped} · failed ${s.failed}`)
            setSelectedOrders(new Set())
            setShowBulkRetry(false)
            await fetchOrders(true)
        } catch (error: any) {
            toast.error(error.message || 'Bulk retry failed')
        } finally {
            setBulkRetryBusy(false)
        }
    }

    // Update — same /api/admin/orders/update-status endpoint the Fulfillment Center
    // uses, called only with the explicit selected order ids.
    const bulkUpdateStatus = async (newStatus: 'pending' | 'processing' | 'completed' | 'failed') => {
        if (selectedOrders.size === 0) {
            toast.error('No orders selected')
            return
        }
        setIsUpdating(true)
        try {
            const orderIds = Array.from(selectedOrders)
            const response = await fetch('/api/admin/orders/update-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderIds, status: newStatus }),
            })
            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Update failed')
            toast.success(`${orderIds.length} order(s) marked as ${newStatus}`)
            setSelectedOrders(new Set())
            await fetchOrders(true)
        } catch (error: any) {
            toast.error('Update failed: ' + error.message)
        } finally {
            setIsUpdating(false)
        }
    }

    // Refulfill — same /api/admin/fulfillment/refulfill endpoint the Fulfillment Center
    // uses. That route accepts only an explicit orderIds array (or, with none, refulfills
    // ALL pending orders platform-wide — every network, not just AT-iShare). This page is
    // scoped to AT-iShare, so it NEVER calls the route with an empty payload; "Refulfill
    // Pending" here always sends the ids of pending orders already visible in the
    // network=AT-iShare-filtered `orders` list, and "Refulfill Selected" sends the
    // checkbox selection. Both stay correctly scoped without any change to the shared
    // route or the bulk refulfillment engine.
    const refulfillOrders = async (ids: string[]) => {
        if (ids.length === 0) { toast.error('No eligible orders'); return }
        setIsRefulfilling(true)
        try {
            const response = await fetch('/api/admin/fulfillment/refulfill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderIds: ids }),
            })
            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Refulfillment failed')
            toast.success(`Refulfillment complete: ${data.fulfilled} processing, ${data.skipped} skipped, ${data.failed} failed/reverted`)
            setSelectedOrders(new Set())
            await fetchOrders(true)
        } catch (error: any) {
            toast.error('Refulfillment failed: ' + (error.message || 'Unknown error'))
        } finally {
            setIsRefulfilling(false)
        }
    }

    const pendingOrderIds = orders.filter(o => o.status === 'pending').map(o => o.id)

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault()
        if (isSending) return

        const phoneCheck = phoneSchema.safeParse(sendPhone.trim())
        if (!phoneCheck.success) {
            toast.error(phoneCheck.error.issues[0]?.message || 'Enter a valid Ghanaian phone number')
            return
        }
        const sizeGbNum = Number(sendSizeGb)
        if (!Number.isFinite(sizeGbNum) || sizeGbNum <= 0 || sizeGbNum > 100) {
            toast.error('Enter a bundle size between 0.1 and 100 GB')
            return
        }

        setIsSending(true)
        try {
            const res = await fetch('/api/admin/atishare-console/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: phoneCheck.data, sizeGb: sizeGbNum }),
            })
            const data = await res.json()

            if (res.status === 409) {
                toast.error(data.error || 'An identical send was made in the last minute. Wait a moment before repeating it.')
                return
            }
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Send failed')
            }

            const dup = data.data?.duplicate === true
            toast.success(
                `${sizeGbNum} GB sent to ${phoneCheck.data}${dup ? ' (vendor returned an existing transaction)' : ''}`
            )
            setSendPhone('')
            setSendSizeGb('')
            await fetchManualSends()
            await fetchBalance()
        } catch (error: any) {
            toast.error(error.message || 'Send failed')
        } finally {
            setIsSending(false)
        }
    }

    if (dbUser?.role !== 'admin') {
        return (
            <div className="flex flex-col items-center justify-center h-[60vh]">
                <Activity className="w-12 h-12 text-destructive mb-4" />
                <h1 className="text-2xl font-bold">Access Denied</h1>
                <p className="text-muted-foreground">Admin privileges required.</p>
            </div>
        )
    }

    const supplierMeta = SUPPLIER_META.atishare_console

    return (
        <div className="px-2 py-4 md:p-8 max-w-[1400px] mx-auto space-y-6">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2.5">
                        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">iShare Fulfillment Center</h1>
                        <span className={cn(
                            "inline-flex items-center rounded-md border text-[10px] font-medium tracking-wide h-5 px-2",
                            supplierMeta.badgeClass
                        )}>
                            {supplierMeta.label}
                        </span>
                    </div>
                    <p className="text-xs md:text-sm text-muted-foreground">
                        Dedicated console for the AT-iShare Console (SPFastIT) supplier — balances, orders, and manual sends
                    </p>
                </div>
                <Button onClick={() => fetchOrders()} disabled={isLoadingOrders} variant="outline" size="sm" className="h-9 md:h-10 text-xs md:text-sm w-fit">
                    <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingOrders ? 'animate-spin' : ''}`} />
                    Refresh
                </Button>
            </div>

            {/* Supplier connection + Auto-Fulfillment — same invariant, same RPC, same
                global flag as the main Fulfillment Center's controls. Connecting here
                auto-disconnects every other AT-iShare supplier server-side; disconnecting
                leaves AT-iShare with no active supplier until another is enabled. */}
            <Card className={cn(
                "border-l-4 shadow-md transition-colors",
                isConsoleConnected ? "border-l-indigo-500" : "border-l-gray-300 dark:border-l-gray-600"
            )}>
                <CardContent className="p-3 md:p-5">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5">
                            <div className={cn(
                                "p-2 rounded-lg shrink-0",
                                isConsoleConnected ? "bg-indigo-100 dark:bg-indigo-900/30" : "bg-muted"
                            )}>
                                {isConsoleConnected
                                    ? <PlugZap className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                                    : <Plug className="w-4 h-4 text-muted-foreground" />}
                            </div>
                            <div>
                                <p className="text-xs md:text-sm font-semibold text-foreground leading-tight">
                                    AT-iShare Console {isConsoleConnected ? '— Connected' : '— Disconnected'}
                                </p>
                                <p className="text-[10px] text-muted-foreground hidden md:block mt-0.5">
                                    {isConsoleConnected
                                        ? 'Serving AT-iShare orders. Disconnecting leaves AT-iShare with no active supplier.'
                                        : 'Not serving AT-iShare orders. Connecting disconnects any other AT-iShare supplier.'}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-4 flex-wrap">
                            <Button
                                onClick={handleToggleConnection}
                                disabled={isLoadingConnection || isTogglingConnection}
                                variant={isConsoleConnected ? 'outline' : 'default'}
                                size="sm"
                                className={cn("h-8 text-xs px-3", isConsoleConnected && "border-indigo-500 text-indigo-600")}
                            >
                                {isTogglingConnection ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
                                {isConsoleConnected ? 'Disconnect' : 'Connect'}
                            </Button>
                            <div className="flex items-center gap-2 border-l pl-4">
                                <span className="text-[10px] md:text-xs font-semibold">Auto-Fulfillment</span>
                                <Switch
                                    checked={globalEnabled}
                                    onCheckedChange={handleToggleGlobal}
                                    disabled={isSavingGlobal}
                                    className="scale-90"
                                />
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Balance Card */}
            <Card className="bg-gradient-to-br from-indigo-600 to-indigo-800 text-white border-none shadow-lg">
                <CardContent className="p-4 md:p-6">
                    <div className="flex flex-col gap-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <div className="bg-white/20 p-2 md:p-2.5 rounded-lg shrink-0">
                                    <Wallet className="w-4 h-4 md:w-5 md:h-5" />
                                </div>
                                <p className="text-xs md:text-sm font-bold uppercase tracking-wider opacity-95">Console Balance</p>
                            </div>
                            <Button
                                onClick={fetchBalance}
                                disabled={isLoadingBalance}
                                variant="secondary"
                                size="sm"
                                className="bg-white/20 hover:bg-white/30 text-white border-white/30 h-7 md:h-8 text-[10px] md:text-xs px-2 md:px-3"
                            >
                                <RefreshCw className={`w-3 h-3 mr-1.5 ${isLoadingBalance ? 'animate-spin' : ''}`} />
                                Refresh
                            </Button>
                        </div>

                        <div>
                            <p className="text-[10px] md:text-xs uppercase tracking-wider opacity-80">Available</p>
                            <p className="text-3xl md:text-4xl font-bold leading-tight">
                                {balance ? `${mbToGb(balance.availableMb)} GB` : (isLoadingBalance ? '…' : '— GB')}
                            </p>
                        </div>

                        <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/20">
                            <div>
                                <p className="text-[10px] md:text-xs uppercase tracking-wider opacity-70">Wallet</p>
                                <p className="text-base md:text-lg font-semibold">
                                    {balance ? `${mbToGb(balance.walletMb)} GB` : '— GB'}
                                </p>
                            </div>
                            <div>
                                <p className="text-[10px] md:text-xs uppercase tracking-wider opacity-70">Reserved</p>
                                <p className="text-base md:text-lg font-semibold">
                                    {balance ? `${mbToGb(balance.reservedMb)} GB` : '— GB'}
                                </p>
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Free-form send */}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base md:text-lg">
                            <Send className="w-4 h-4 md:w-5 md:h-5" />
                            Free-form Send
                        </CardTitle>
                        <p className="text-xs md:text-sm text-muted-foreground">
                            Manually push a data bundle to any AT-iShare number, outside the normal order flow.
                        </p>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleSend} className="space-y-4">
                            <div className="space-y-1.5">
                                <Label htmlFor="ishare-send-phone">Phone number</Label>
                                <Input
                                    id="ishare-send-phone"
                                    placeholder="0241234567"
                                    value={sendPhone}
                                    onChange={(e) => setSendPhone(e.target.value)}
                                    disabled={isSending}
                                    inputMode="tel"
                                    autoComplete="off"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="ishare-send-size">Size (GB)</Label>
                                <Input
                                    id="ishare-send-size"
                                    type="number"
                                    step="0.1"
                                    min="0.1"
                                    max="100"
                                    placeholder="1.0"
                                    value={sendSizeGb}
                                    onChange={(e) => setSendSizeGb(e.target.value)}
                                    disabled={isSending}
                                />
                            </div>
                            <Button type="submit" disabled={isSending} className="w-full">
                                {isSending ? (
                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                ) : (
                                    <Send className="w-4 h-4 mr-2" />
                                )}
                                {isSending ? 'Sending…' : 'Send Bundle'}
                            </Button>
                        </form>
                    </CardContent>
                </Card>

                {/* Sync + Recent manual sends */}
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0">
                        <CardTitle className="flex items-center gap-2 text-base md:text-lg">
                            <Signal className="w-4 h-4 md:w-5 md:h-5" />
                            Recent Manual Sends
                        </CardTitle>
                        <Button onClick={handleSync} disabled={isSyncing || syncCooldown} variant="outline" size="sm" className="h-8 text-xs">
                            {isSyncing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5 mr-1.5" />}
                            {syncCooldown ? 'Wait…' : 'Sync Status'}
                        </Button>
                    </CardHeader>
                    <CardContent>
                        {isLoadingManualSends ? (
                            <p className="text-sm text-muted-foreground">Loading…</p>
                        ) : manualSends.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                {manualSendsUnavailable
                                    ? 'Manual send history is not available yet.'
                                    : 'No manual sends yet.'}
                            </p>
                        ) : (
                            <div className="space-y-2 max-h-[320px] overflow-y-auto">
                                {manualSends.map((send) => (
                                    <div key={send.id} className="flex items-center justify-between gap-2 rounded-md border p-2.5 text-xs md:text-sm">
                                        <div className="min-w-0">
                                            <p className="font-semibold truncate">{send.phone}</p>
                                            <p className="text-[10px] md:text-xs text-muted-foreground">
                                                {new Date(send.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <span className="font-medium">{mbToGb(send.bundle_mb)} GB</span>
                                            <span className={cn(
                                                "inline-flex items-center rounded-md text-[10px] font-medium uppercase tracking-wider h-5 px-2",
                                                getStatusBadgeClass(send.status)
                                            )}>
                                                {send.status}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* Update + Refulfillment tools — identical admin_settings keys and behaviour
                to the Fulfillment Center's "Auto-Complete" and "Auto-Refulfill" cards. */}
            <div className="grid grid-cols-2 gap-3 md:gap-4">
                <Card className="border-l-4 border-l-violet-500 shadow-md">
                    <CardContent className="p-3 md:p-5">
                        <div className="flex flex-col gap-3">
                            <div className="flex items-start justify-between gap-2">
                                <div className="flex items-start gap-2">
                                    <div className="bg-violet-100 dark:bg-violet-900/30 p-2 rounded-lg mt-0.5 shrink-0">
                                        <RefreshCw className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                                    </div>
                                    <div>
                                        <p className="text-xs md:text-sm font-semibold text-foreground leading-tight">Update</p>
                                        <p className="text-[10px] text-muted-foreground hidden md:block mt-0.5">Marks processing orders older than threshold as completed.</p>
                                    </div>
                                </div>
                                <div className={cn(
                                    "shrink-0 text-[10px] font-semibold px-2 py-1 rounded-full",
                                    cronEnabled ? "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400" : "bg-muted text-muted-foreground"
                                )}>
                                    {cronEnabled ? `On·${cronThreshold}m` : 'Off'}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                                <Switch
                                    checked={cronEnabled}
                                    onCheckedChange={(val) => saveCronSettings(val, cronThreshold)}
                                    disabled={isSavingCron}
                                    className="scale-90"
                                />
                                <Input
                                    type="number"
                                    min={5}
                                    max={1440}
                                    value={cronThresholdInput}
                                    onChange={(e) => setCronThresholdInput(e.target.value)}
                                    className="w-14 md:w-20 h-7 text-xs font-medium focus:ring-violet-500"
                                />
                                <Button
                                    size="sm"
                                    className="h-7 text-[10px] md:text-xs bg-violet-600 hover:bg-violet-700 text-white px-2"
                                    disabled={isSavingCron}
                                    onClick={() => {
                                        const val = parseInt(cronThresholdInput, 10)
                                        if (!isNaN(val) && val >= 5) saveCronSettings(cronEnabled, val)
                                        else toast.error('Threshold must be at least 5 minutes')
                                    }}
                                >
                                    {isSavingCron ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card className="border-l-4 border-l-orange-500 shadow-md">
                    <CardContent className="p-3 md:p-5">
                        <div className="flex flex-col gap-3">
                            <div className="flex items-start justify-between gap-2">
                                <div className="flex items-start gap-2">
                                    <div className="bg-orange-100 dark:bg-orange-900/30 p-2 rounded-lg mt-0.5 shrink-0">
                                        <RotateCcw className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                                    </div>
                                    <div>
                                        <p className="text-xs md:text-sm font-semibold text-foreground leading-tight">Refulfillment</p>
                                        <p className="text-[10px] text-muted-foreground hidden md:block mt-0.5">Retries pending orders, skips within cooldown.</p>
                                    </div>
                                </div>
                                <div className={cn(
                                    "shrink-0 text-[10px] font-semibold px-2 py-1 rounded-full",
                                    autoRefulfillEnabled ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" : "bg-muted text-muted-foreground"
                                )}>
                                    {autoRefulfillEnabled ? `On·${autoRefulfillThreshold}m` : 'Off'}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                                <Switch
                                    checked={autoRefulfillEnabled}
                                    onCheckedChange={(val) => saveAutoRefulfillSettings(val, autoRefulfillThreshold)}
                                    disabled={isSavingAutoRefulfill}
                                    className="scale-90"
                                />
                                <Input
                                    type="number"
                                    min={1}
                                    max={1440}
                                    value={autoRefulfillThresholdInput}
                                    onChange={(e) => setAutoRefulfillThresholdInput(e.target.value)}
                                    className="w-14 md:w-20 h-7 text-xs font-medium focus:ring-orange-500"
                                />
                                <Button
                                    size="sm"
                                    className="h-7 text-[10px] md:text-xs bg-orange-600 hover:bg-orange-700 text-white px-2"
                                    disabled={isSavingAutoRefulfill}
                                    onClick={() => {
                                        const val = parseInt(autoRefulfillThresholdInput, 10)
                                        if (!isNaN(val) && val >= 1) saveAutoRefulfillSettings(autoRefulfillEnabled, val)
                                        else toast.error('Cooldown must be at least 1 minute')
                                    }}
                                >
                                    {isSavingAutoRefulfill ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Bulk action bar — same three tools (Update, Retry, Refulfill) and the same
                underlying endpoints as the Fulfillment Center's selection toolbar, scoped
                to whatever is checked below. */}
            {selectedOrders.size > 0 && (
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 rounded-xl border bg-muted/30 p-3">
                    <div className="flex items-center gap-2">
                        <Badge variant="default" className="rounded-full px-2 text-[10px]">{selectedOrders.size}</Badge>
                        <span className="text-xs font-semibold">selected</span>
                    </div>
                    <div className="flex gap-2 flex-wrap justify-end">
                        <Button
                            size="sm"
                            onClick={() => bulkUpdateStatus('pending')}
                            className="h-8 text-[11px] px-2.5 bg-amber-500 hover:bg-amber-600 text-black font-bold shadow-sm disabled:opacity-50"
                            disabled={isUpdating || isRefulfilling || orders.some(o => selectedOrders.has(o.id) && o.status === 'processing')}
                            title={orders.some(o => selectedOrders.has(o.id) && o.status === 'processing') ? 'Cannot revert processing orders to pending' : ''}
                        >
                            <Clock className="w-3.5 h-3.5 mr-1" /> Pending
                        </Button>
                        <Button size="sm" onClick={() => bulkUpdateStatus('processing')} className="h-8 text-[11px] px-2.5 bg-yellow-500 hover:bg-yellow-600 text-black font-bold shadow-sm" disabled={isUpdating || isRefulfilling}>
                            <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reprocess
                        </Button>
                        <Button size="sm" onClick={() => bulkUpdateStatus('completed')} className="h-8 text-[11px] px-2.5 bg-green-600 hover:bg-green-700 font-bold shadow-sm" disabled={isUpdating || isRefulfilling}>
                            <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Complete
                        </Button>
                        <Button size="sm" onClick={() => bulkUpdateStatus('failed')} variant="destructive" className="h-8 text-[11px] px-2.5 font-bold shadow-sm" disabled={isUpdating || isRefulfilling}>
                            <XCircle className="w-3.5 h-3.5 mr-1" /> Fail
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => refulfillOrders(Array.from(selectedOrders))}
                            className="h-8 text-[11px] px-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-sm"
                            disabled={isRefulfilling || isUpdating}
                        >
                            {isRefulfilling ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 mr-1" />}
                            Refulfill Selected
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => setShowBulkRetry(true)}
                            className="h-8 text-[11px] px-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold shadow-sm"
                            disabled={isUpdating || isRefulfilling || retryEligibleSelected.length === 0}
                            title={retryEligibleSelected.length === 0 ? 'Select at least one failed/refunded order' : ''}
                        >
                            <RotateCcw className="w-3.5 h-3.5 mr-1" /> Retry Selected
                        </Button>
                    </div>
                </div>
            )}

            {/* AT-iShare order list */}
            <Card>
                <CardHeader>
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                        <div>
                            <div className="flex items-center gap-2 flex-wrap">
                                <CardTitle className="text-base md:text-lg">AT-iShare Orders</CardTitle>
                                <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={() => setSelectedOrders(new Set())} disabled={selectedOrders.size === 0}>
                                    Clear
                                </Button>
                                <Button variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={() => setSelectedOrders(new Set(orders.map(o => o.id)))} disabled={orders.length === 0}>
                                    Select Page
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 text-[10px] px-2 border-indigo-400 text-indigo-600"
                                    onClick={() => refulfillOrders(pendingOrderIds)}
                                    disabled={isRefulfilling || pendingOrderIds.length === 0}
                                >
                                    {isRefulfilling ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <RotateCcw className="w-3 h-3 mr-1" />}
                                    Refulfill Pending ({pendingOrderIds.length})
                                </Button>
                            </div>
                            <p className="text-xs md:text-sm text-muted-foreground">Every order on the AT-iShare network, newest first.</p>
                        </div>
                        {/* Date filter — same presets and behaviour as the Fulfillment Center,
                            via the shared lib/admin-date-range.ts. */}
                        <div className="flex flex-wrap items-center gap-1.5">
                            {DATE_FILTER_PRESETS.map(range => (
                                <Button
                                    key={range.id}
                                    variant={dateFilter === range.id ? 'default' : 'outline'}
                                    size="sm"
                                    className="h-7 text-[10px] px-2"
                                    onClick={() => setDateFilter(range.id)}
                                >
                                    <CalendarIcon className="w-3 h-3 mr-1 opacity-60" />
                                    {range.label}
                                </Button>
                            ))}
                            {dateFilter === 'custom' && (
                                <Input
                                    type="date"
                                    value={customDate}
                                    onChange={(e) => setCustomDate(e.target.value)}
                                    className="h-7 text-xs w-[140px]"
                                />
                            )}
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    {isLoadingOrders ? (
                        <p className="text-sm text-muted-foreground">Loading orders…</p>
                    ) : orders.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No AT-iShare orders found.</p>
                    ) : (
                        <div className="space-y-2">
                            {orders.map((order) => (
                                <div
                                    key={order.id}
                                    onClick={() => {
                                        // Don't hijack a text-selection drag (e.g. copying the phone number)
                                        // into a row-select toggle — same guard the Fulfillment Center uses.
                                        if (window.getSelection()?.toString()) return
                                        const next = new Set(selectedOrders)
                                        next.has(order.id) ? next.delete(order.id) : next.add(order.id)
                                        setSelectedOrders(next)
                                    }}
                                    className={cn(
                                        "flex flex-col md:flex-row md:items-center justify-between gap-2 rounded-lg border p-3 text-xs md:text-sm cursor-pointer transition-colors",
                                        selectedOrders.has(order.id)
                                            ? "bg-primary/10 border-primary"
                                            : "hover:border-primary/20 hover:bg-accent/50"
                                    )}
                                >
                                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                                        <Checkbox checked={selectedOrders.has(order.id)} className="pointer-events-none shrink-0" />
                                        <p className="font-semibold truncate">{order.phone_number}</p>
                                        <Badge variant="outline" className="text-[10px] px-1.5 font-black leading-none py-1 bg-secondary/50">
                                            {order.size}
                                        </Badge>
                                        <p className="text-muted-foreground truncate">
                                            {order.users?.first_name
                                                ? `${order.users.first_name} ${order.users.last_name || ''}`
                                                : (order.shop_name || 'N/A')}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2 flex-wrap shrink-0">
                                        <span className={cn(
                                            "inline-flex items-center rounded-md text-[10px] font-medium uppercase tracking-wider h-5 px-2",
                                            getStatusBadgeClass(order.status)
                                        )}>
                                            {order.status}
                                        </span>
                                        <span className={cn(
                                            "inline-flex items-center rounded-md border text-[10px] font-medium tracking-wide h-5 px-2",
                                            (SUPPLIER_META[order.supplier ?? 'na'] ?? SUPPLIER_META.na).badgeClass
                                        )}>
                                            {(SUPPLIER_META[order.supplier ?? 'na'] ?? SUPPLIER_META.na).label}
                                        </span>
                                        {isRetryEligible(order) && (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-5 px-2 text-[10px] font-bold"
                                                onClick={(e) => { e.stopPropagation(); handleRetry(order) }}
                                            >
                                                <RotateCcw className="w-3 h-3 mr-1" /> Retry
                                            </Button>
                                        )}
                                        <p className="text-[10px] md:text-xs text-muted-foreground whitespace-nowrap">
                                            {new Date(order.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Single-order retry — controlled, iOS-PWA safe (no native confirm). Same copy
                and gating as app/admin/fulfillment/page.tsx's dialog. */}
            <Dialog open={!!retryTarget} onOpenChange={(o) => { if (!o && !retryBusy) setRetryTarget(null) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Retry order</DialogTitle>
                        <DialogDescription>
                            {retryTarget?.phone_number ? `${retryTarget.phone_number} · ` : ''}Status: {retryTarget?.status}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        {retryTarget?.status === 'refunded' ? (
                            <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md p-2.5">
                                <RefreshCw className="w-4 h-4 mt-0.5 shrink-0" />
                                <span>This order was refunded — retrying will charge <b>today&apos;s price</b> to the {retryTarget?.shop_order_id ? "shop owner's" : "buyer's"} funding wallet. The exact amount charged will be confirmed after the retry succeeds.</span>
                            </div>
                        ) : (
                            <div className="flex items-start gap-2 text-sm text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-md p-2.5">
                                <RotateCcw className="w-4 h-4 mt-0.5 shrink-0" />
                                <span>This order failed and was never refunded — retrying re-dispatches it at no charge.</span>
                            </div>
                        )}
                        <p className="text-sm text-muted-foreground">
                            Retry attempts used: <b>{retryTarget?.retry_count ?? 0} / 3</b>
                            {(retryTarget?.retry_count ?? 0) >= 3 ? ' — further retries are locked for 24h after the last attempt.' : ''}
                        </p>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setRetryTarget(null)} disabled={retryBusy}>Cancel</Button>
                        <Button onClick={submitRetry} disabled={retryBusy}>
                            {retryBusy ? 'Retrying…' : 'Confirm retry'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Bulk retry confirmation — controlled, capped, iOS-PWA safe. Selection is
                pre-filtered to failed/refunded orders (retryEligibleSelected) before this
                opens, so counts here reflect exactly what will be sent. */}
            <Dialog open={showBulkRetry} onOpenChange={(o) => { if (!o && !bulkRetryBusy) setShowBulkRetry(false) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Retry {retryEligibleSelected.length} order(s)?</DialogTitle>
                        <DialogDescription>
                            Only failed/refunded orders in your selection are included — other selected rows are ignored automatically.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1.5 text-sm text-muted-foreground">
                        <p>• <b>{retryEligibleRefundedCount}</b> refunded order(s) — these <span className="text-amber-600 dark:text-amber-400 font-medium">WILL be charged</span> at today&apos;s price to their funding wallet (the buyer&apos;s, or the shop owner&apos;s for shop orders).</p>
                        <p>• <b>{retryEligibleFailedCount}</b> failed order(s) — no money moves, these are simply re-dispatched.</p>
                        <p>• Individual orders may still be skipped server-side for cooldown or attempt-cap reasons.</p>
                        {retryEligibleSelected.length > MAX_BULK_RETRY && (
                            <p className="text-red-600 font-medium">You can retry at most {MAX_BULK_RETRY} orders at once. Deselect some first.</p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setShowBulkRetry(false)} disabled={bulkRetryBusy}>Cancel</Button>
                        <Button
                            onClick={bulkRetry}
                            disabled={bulkRetryBusy || retryEligibleSelected.length === 0 || retryEligibleSelected.length > MAX_BULK_RETRY}
                        >
                            {bulkRetryBusy ? 'Processing…' : `Retry ${Math.min(retryEligibleSelected.length, MAX_BULK_RETRY)} order(s)`}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
