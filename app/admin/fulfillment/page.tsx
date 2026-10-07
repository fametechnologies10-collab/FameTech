'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { getStatusBadgeClass, shouldShowRefundOverlay, REFUND_OVERLAY_BADGE_CLASS, getRetryTag, isRetryEligible, getSelfCompletedTag } from '@/lib/order-status'
import { SUPPLIER_META, SUPPLIER_FILTERS, type SupplierTag, SUPPLIER_NETWORK_SETTING_KEYS, type SupplierKey } from '@/lib/order-supplier'
import { toggleSupplierNetwork } from '@/lib/fulfillment-supplier-toggle'
import { computeDateRange, type DateFilterId, DATE_FILTER_PRESETS } from '@/lib/admin-date-range'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
    RefreshCw,
    CheckCircle2,
    XCircle,
    Package,
    Activity,
    Server,
    Filter,
    RotateCcw,
    Clock,
    Search,
    Calendar as CalendarIcon,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    MoreHorizontal,
    Loader2,
    Smartphone,
    RadioTower
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MAX_BULK_REFUND, MAX_BULK_RETRY } from '@/lib/refunds'
import { formatCurrency, cn } from '@/lib/utils'
import { format } from 'date-fns'
import { MomoDetailsModal } from '@/components/shared/momo-details-modal'
import { isMomoLookupEligible } from '@/lib/momo-eligibility'

interface Order {
    id: string
    created_at: string
    phone_number: string
    network: string
    size: string
    price: number
    status: string
    user_id: string
    shop_name?: string
    source?: string
    shop_order_id?: string | null
    retry_count?: number | null
    retry_from_status?: string | null
    retry_of_order_id?: string | null
    retried_by_role?: string | null
    self_completed_at?: string | null
    self_completed_by_role?: string | null
    supplier?: SupplierTag | null
    users: {
        first_name: string
        last_name: string
        role: string
    }
    mtn_fulfillment_tracking: Array<{
        transaction_id: string | null
        api_response?: any
        retry_count?: number
    }>
}

interface FulfillmentSettings {
    is_global_enabled: boolean
    networks: Record<string, boolean>
    codecraft_networks: Record<string, boolean>
    xpress_networks: Record<string, boolean>
    ghdata_networks: Record<string, boolean>
    agentportal_networks: Record<string, boolean>
    bundleportal_networks: Record<string, boolean>
    hendylinks_networks: Record<string, boolean>
    atishare_console_networks: Record<string, boolean>
    spfastit_networks: Record<string, boolean>
    mtn_codecraft_fallback: 'none' | 'datakazina' | 'xpress' | 'ghdata' | 'agentportal' | 'bundleportal' | 'hendylinks'
    mtn_agentportal_fallback: 'none' | 'datakazina' | 'codecraft' | 'xpress' | 'ghdata' | 'bundleportal' | 'hendylinks'
    mtn_bundleportal_fallback: 'none' | 'datakazina' | 'codecraft' | 'xpress' | 'ghdata' | 'agentportal' | 'hendylinks'
    mtn_hendylinks_fallback: 'none' | 'datakazina' | 'codecraft' | 'xpress' | 'ghdata' | 'agentportal' | 'bundleportal'
}

const NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime']

// Used only by the Bundle Portal network-toggle row below — mirrors
// resolveBundlePortalNetwork() in lib/bundleportal-service.ts, the actual source of
// truth. AT-BigTime is deliberately excluded there (Bundle Portal's docs never confirm
// it), so its card in that row is rendered disabled rather than toggleable. Declared at
// module scope (not inline in JSX) because TSX doesn't allow a `const` between elements;
// this is the closest a scoped, page-local constant can get to "next to the row".
const BUNDLEPORTAL_SUPPORTED_NETWORKS = ['MTN', 'Telecel', 'AT-iShare']

// Used only by the AT-iShare Console network-toggle row below — this supplier (SPFastIT)
// serves AT-iShare exclusively; the service layer hard-rejects every other network (see
// lib/atishare-console-service.ts). Unlike BUNDLEPORTAL_SUPPORTED_NETWORKS above, the row
// doesn't render disabled cards for the unsupported networks at all — offering a control
// for MTN/Telecel/AT-BigTime here would present something that can never work, not just
// something that's off.
const ATISHARE_CONSOLE_SUPPORTED_NETWORKS = ['AT-iShare']

// This supplier is Telecel only in this codebase (MTN pricing rejected as not
// competitive) — presenting a toggle for MTN/AT-iShare/AT-BigTime here would offer
// something that can never work, not just something that's off.
const SPFASTIT_SUPPORTED_NETWORKS = ['Telecel']
const PAGE_SIZE = 10

// Suppliers app/api/admin/orders/sync-selection knows how to re-check — see that route.
// A mixed-supplier selection has no single lookup endpoint to check against, so the "Sync"
// button below requires every selected order to share one of these.
const SYNC_SUPPORTED_SUPPLIERS = new Set<SupplierTag>(['agentportal', 'hendylinks', 'spfastit'])

// Order channel (origin) — a clean 3-way partition for the Channel filter buttons.
// Actual filtering now happens server-side in /api/admin/fulfillment (see the `channel`
// query param); this type + list only drive the filter UI and state below.
type OrderChannel = 'web' | 'shop' | 'ussd'
const CHANNELS: Array<{ key: 'all' | OrderChannel; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'web', label: 'Web' },
    { key: 'shop', label: 'Shop' },
    { key: 'ussd', label: 'USSD' },
]

export default function FulfillmentPage() {
    const { dbUser } = useAuth()

    // Data State
    const [orders, setOrders] = useState<Order[]>([])
    const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set())
    const [isLoadingOrders, setIsLoadingOrders] = useState(true)
    const [isUpdating, setIsUpdating] = useState(false)
    const [isRefulfilling, setIsRefulfilling] = useState(false)
    const [isSyncingSelection, setIsSyncingSelection] = useState(false)

    // Filter State
    const [networkFilter, setNetworkFilter] = useState('All')
    const [statusFilter, setStatusFilter] = useState('All')
    const [channelFilter, setChannelFilter] = useState<'all' | OrderChannel>('all') // server-side (origin) — sent to /api/admin/fulfillment
    const [supplierFilter, setSupplierFilter] = useState<'all' | SupplierTag | 'na'>('all') // client-side (derived tag)
    const [dateFilter, setDateFilter] = useState<DateFilterId>('today')
    const [customDate, setCustomDate] = useState<string>('') // Changed to string for input date
    const [searchQuery, setSearchQuery] = useState('')

    // Pagination State (Disabled for total load)
    const [ordersCount, setOrdersCount] = useState(0)

    // Settings state — defaults all networks to false until loaded from DB
    const [settings, setSettings] = useState<FulfillmentSettings>({
        is_global_enabled: true,
        networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        codecraft_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        xpress_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        ghdata_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        agentportal_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        bundleportal_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        hendylinks_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        atishare_console_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        spfastit_networks: NETWORKS.reduce((acc, n) => ({ ...acc, [n]: false }), {}),
        mtn_codecraft_fallback: 'none',
        mtn_agentportal_fallback: 'none',
        mtn_bundleportal_fallback: 'none',
        mtn_hendylinks_fallback: 'none',
    })
    const [isSavingSettings, setIsSavingSettings] = useState(false)
    const [networkConfigOpen, setNetworkConfigOpen] = useState(false)

    // MTN Express Delivery (DataKazina, MTN-only) — flipped via the audited
    // /api/admin/settings/toggle route so it stays in sync with the dashboard
    // System Control Center and keeps the admin_settings audit trail.
    const [mtnExpressEnabled, setMtnExpressEnabled] = useState(false)
    const [isSavingExpress, setIsSavingExpress] = useState(false)

    // Balance state
    const [balance, setBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [codecraftBalance, setCodecraftBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [xpressBalance, setXpressBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [ghdataBalance, setGhdataBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [agentportalBalance, setAgentportalBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [bundleportalBalance, setBundleportalBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [hendylinksBalance, setHendylinksBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [spfastitBalance, setSpfastitBalance] = useState<{ amount: number; currency: string } | null>(null)
    const [isLoadingBalance, setIsLoadingBalance] = useState(false)

    // Sync CodeCraft Status state
    const [isSyncing, setIsSyncing] = useState(false)
    const [syncCooldown, setSyncCooldown] = useState(false)
    
    // Sync Dakazina Status state
    const [isSyncingDakazina, setIsSyncingDakazina] = useState(false)
    const [dakazinaSyncCooldown, setDakazinaSyncCooldown] = useState(false)

    // Sync Xpress Status state
    const [isSyncingXpress, setIsSyncingXpress] = useState(false)
    const [xpressSyncCooldown, setXpressSyncCooldown] = useState(false)

    // Sync GhData Status state
    const [isSyncingGhData, setIsSyncingGhData] = useState(false)
    const [ghdataSyncCooldown, setGhdataSyncCooldown] = useState(false)

    // Sync AgentPortal Status state
    const [isSyncingAgentPortal, setIsSyncingAgentPortal] = useState(false)
    const [agentportalSyncCooldown, setAgentportalSyncCooldown] = useState(false)

    // Sync HendyLinks Status state
    const [isSyncingHendyLinks, setIsSyncingHendyLinks] = useState(false)
    const [hendylinksSyncCooldown, setHendylinksSyncCooldown] = useState(false)

    // Sync SPFastIT Status state
    const [isSyncingSpfastit, setIsSyncingSpfastit] = useState(false)
    const [spfastitSyncCooldown, setSpfastitSyncCooldown] = useState(false)

    // Individual balance loading states
    const [isLoadingDKBalance, setIsLoadingDKBalance] = useState(false)
    const [isLoadingCCBalance, setIsLoadingCCBalance] = useState(false)
    const [isLoadingXPBalance, setIsLoadingXPBalance] = useState(false)
    const [isLoadingGHBalance, setIsLoadingGHBalance] = useState(false)
    const [isLoadingAPBalance, setIsLoadingAPBalance] = useState(false)
    const [isLoadingBPBalance, setIsLoadingBPBalance] = useState(false)
    const [isLoadingHLBalance, setIsLoadingHLBalance] = useState(false)
    const [isLoadingSFBalance, setIsLoadingSFBalance] = useState(false)

    // Realtime live indicator
    const [isLive, setIsLive] = useState(false)

    // Auto-Complete Cron state
    const [cronEnabled, setCronEnabled] = useState(false)
    const [cronThreshold, setCronThreshold] = useState(30)
    const [cronThresholdInput, setCronThresholdInput] = useState('30')
    const [isSavingCron, setIsSavingCron] = useState(false)

    // New Cron for Auto-Refulfill
    const [autoRefulfillEnabled, setAutoRefulfillEnabled] = useState(false)
    const [autoRefulfillThreshold, setAutoRefulfillThreshold] = useState(5)
    const [autoRefulfillThresholdInput, setAutoRefulfillThresholdInput] = useState('5')
    const [isSavingAutoRefulfill, setIsSavingAutoRefulfill] = useState(false)

    useEffect(() => {
        if (dbUser?.role === 'admin') {
            fetchSettings()
            fetchBalance()
        }
    }, [dbUser])

    // Reset when filters change
    useEffect(() => {
        fetchOrders(true)
    }, [networkFilter, statusFilter, channelFilter, dateFilter, customDate, searchQuery]) // eslint-disable-line react-hooks/exhaustive-deps

    // Determine Date Range — delegates to lib/admin-date-range.ts so this page and
    // app/admin/ishare/page.tsx compute identical ranges from identical presets.
    const getDateRange = () => computeDateRange(dateFilter, customDate)

    const fetchSettings = async () => {
        try {
            const { data } = await supabase
                .from('admin_settings')
                .select('key, value')
                .in('key', [
                    'auto_fulfillment_enabled', 
                    'fulfillment_settings', 
                    'auto_complete_data_enabled', 
                    'auto_complete_data_threshold_mins',
                    'auto_refulfill_enabled',
                    'auto_refulfill_threshold_mins',
                    'mtn_express_delivery_enabled',
                    'mtn_codecraft_fallback',
                    'mtn_agentportal_fallback',
                    'mtn_bundleportal_fallback',
                    'mtn_hendylinks_fallback'
                ])

            const map = (data || []).reduce((acc: any, curr: any) => {
                acc[curr.key] = curr.value
                return acc
            }, {})

            const dbFulfillmentSettings = typeof map.fulfillment_settings === 'string'
                ? JSON.parse(map.fulfillment_settings)
                : map.fulfillment_settings || {}

            const dbNetworks: Record<string, boolean> = dbFulfillmentSettings.networks || {}
            const dbCodecraftNetworks: Record<string, boolean> = dbFulfillmentSettings.codecraft_networks || {}
            const dbXpressNetworks: Record<string, boolean> = dbFulfillmentSettings.xpress_networks || {}
            const dbGhdataNetworks: Record<string, boolean> = dbFulfillmentSettings.ghdata_networks || {}
            const dbAgentportalNetworks: Record<string, boolean> = dbFulfillmentSettings.agentportal_networks || {}
            const dbBundleportalNetworks: Record<string, boolean> = dbFulfillmentSettings.bundleportal_networks || {}
            const dbHendylinksNetworks: Record<string, boolean> = dbFulfillmentSettings.hendylinks_networks || {}
            const dbAtishareConsoleNetworks: Record<string, boolean> = dbFulfillmentSettings.atishare_console_networks || {}
            const dbSpfastitNetworks: Record<string, boolean> = dbFulfillmentSettings.spfastit_networks || {}

            setSettings({
                is_global_enabled: map.auto_fulfillment_enabled !== 'false',
                networks: NETWORKS.reduce((acc, n) => ({
                    ...acc,
                    [n]: dbNetworks[n] === true
                }), {} as Record<string, boolean>),
                codecraft_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc,
                    [n]: dbCodecraftNetworks[n] === true
                }), {} as Record<string, boolean>),
                xpress_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc,
                    [n]: dbXpressNetworks[n] === true
                }), {} as Record<string, boolean>),
                ghdata_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc,
                    [n]: dbGhdataNetworks[n] === true
                }), {} as Record<string, boolean>),
                agentportal_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc,
                    [n]: dbAgentportalNetworks[n] === true
                }), {} as Record<string, boolean>),
                bundleportal_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc, [n]: dbBundleportalNetworks[n] === true
                }), {} as Record<string, boolean>),
                hendylinks_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc, [n]: dbHendylinksNetworks[n] === true
                }), {} as Record<string, boolean>),
                atishare_console_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc, [n]: dbAtishareConsoleNetworks[n] === true
                }), {} as Record<string, boolean>),
                spfastit_networks: NETWORKS.reduce((acc, n) => ({
                    ...acc, [n]: dbSpfastitNetworks[n] === true
                }), {} as Record<string, boolean>),
                mtn_codecraft_fallback: (map.mtn_codecraft_fallback === 'datakazina' || map.mtn_codecraft_fallback === 'xpress' || map.mtn_codecraft_fallback === 'ghdata' || map.mtn_codecraft_fallback === 'agentportal' || map.mtn_codecraft_fallback === 'bundleportal' || map.mtn_codecraft_fallback === 'hendylinks')
                    ? map.mtn_codecraft_fallback
                    : 'none',
                mtn_agentportal_fallback: (map.mtn_agentportal_fallback === 'datakazina' || map.mtn_agentportal_fallback === 'codecraft' || map.mtn_agentportal_fallback === 'xpress' || map.mtn_agentportal_fallback === 'ghdata' || map.mtn_agentportal_fallback === 'bundleportal' || map.mtn_agentportal_fallback === 'hendylinks')
                    ? map.mtn_agentportal_fallback
                    : 'none',
                mtn_bundleportal_fallback: (map.mtn_bundleportal_fallback === 'datakazina' || map.mtn_bundleportal_fallback === 'codecraft' || map.mtn_bundleportal_fallback === 'xpress' || map.mtn_bundleportal_fallback === 'ghdata' || map.mtn_bundleportal_fallback === 'agentportal' || map.mtn_bundleportal_fallback === 'hendylinks')
                    ? map.mtn_bundleportal_fallback
                    : 'none',
                mtn_hendylinks_fallback: (map.mtn_hendylinks_fallback === 'datakazina' || map.mtn_hendylinks_fallback === 'codecraft' || map.mtn_hendylinks_fallback === 'xpress' || map.mtn_hendylinks_fallback === 'ghdata' || map.mtn_hendylinks_fallback === 'agentportal' || map.mtn_hendylinks_fallback === 'bundleportal')
                    ? map.mtn_hendylinks_fallback
                    : 'none',
            })

            // Cron settings
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

            // MTN Express — absent row defaults to OFF (normal delivery)
            setMtnExpressEnabled(map.mtn_express_delivery_enabled === 'true' || map.mtn_express_delivery_enabled === true)
        } catch (error) {
            console.error('Failed to fetch settings:', error)
        }
    }

    const saveSettings = async (newSettings: FulfillmentSettings) => {
        setIsSavingSettings(true)
        try {
            const updates = [
                { key: 'auto_fulfillment_enabled', value: String(newSettings.is_global_enabled) },
                {
                    key: 'fulfillment_settings',
                    // Registry-driven: the written keys are the registry's keys by construction,
                    // so this can never drift from SUPPLIER_NETWORK_SETTING_KEYS (see lib/order-supplier.ts).
                    // A hand-listed key set here previously; if it ever fell out of sync with the
                    // registry, that supplier's per-network map would silently stop being persisted.
                    value: JSON.stringify(
                        Object.fromEntries(
                            Object.values(SUPPLIER_NETWORK_SETTING_KEYS)
                                .map(k => [k, (newSettings as any)[k] || {}])
                        )
                    ),
                },
                { key: 'mtn_codecraft_fallback', value: newSettings.mtn_codecraft_fallback },
                { key: 'mtn_agentportal_fallback', value: newSettings.mtn_agentportal_fallback },
                { key: 'mtn_bundleportal_fallback', value: newSettings.mtn_bundleportal_fallback },
                { key: 'mtn_hendylinks_fallback', value: newSettings.mtn_hendylinks_fallback },
            ]

            const { error } = await (supabase
                .from('admin_settings') as any)
                .upsert(updates)

            if (error) throw error
            setSettings(newSettings)
            toast.success('Fulfillment settings updated')
        } catch (error: any) {
            toast.error('Failed to save settings: ' + error.message)
        } finally {
            setIsSavingSettings(false)
        }
    }

    // Flip MTN Express via the audited admin toggle route (admin-only + allowlisted
    // server-side). Optimistic update, reconcile from the server's canonical value,
    // revert on error — same contract as the dashboard System Control Center.
    const toggleMtnExpress = async (next: boolean) => {
        setIsSavingExpress(true)
        const prev = mtnExpressEnabled
        setMtnExpressEnabled(next) // optimistic
        try {
            const res = await fetch('/api/admin/settings/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'mtn_express_delivery_enabled', value: next }),
            })
            const body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || 'Failed to update')
            if (body?.value === 'true' || body?.value === 'false') {
                setMtnExpressEnabled(body.value === 'true')
            }
            toast.success(`MTN Express Delivery ${next ? 'enabled' : 'disabled'}`)
        } catch (e: any) {
            setMtnExpressEnabled(prev) // revert
            toast.error(e.message || 'Failed to update setting')
        } finally {
            setIsSavingExpress(false)
        }
    }

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


    // Enabling a supplier for a network disables every other supplier for that same
    // network — one active supplier per network is the system-wide invariant, and the
    // dispatch-layer conflict guard halts orders if it is ever violated.
    //
    // Routed through the toggle_fulfillment_supplier_network RPC (see the 20260822
    // migration) rather than a client-side read-modify-write of the whole settings
    // blob — this page is no longer the only page with a Connect/Disconnect control
    // (app/admin/ishare has one too), so the mutation has to be atomic server-side or
    // two open tabs/pages can silently clobber each other's change. Local state is
    // updated from the RPC's own returned (canonical) settings, not from an optimistic
    // local mutation, so this page can never drift from what was actually persisted.
    const toggleNetwork = async (network: string, provider: SupplierKey) => {
        const providerKey = SUPPLIER_NETWORK_SETTING_KEYS[provider]
        const turningOn = !(settings as any)[providerKey]?.[network]

        setIsSavingSettings(true)
        const result = await toggleSupplierNetwork(provider, network, turningOn)
        setIsSavingSettings(false)

        if (!result.success) {
            toast.error('Failed to update supplier settings: ' + result.error)
            return
        }

        setSettings(prev => ({ ...prev, ...result.settings }))
        toast.success('Fulfillment settings updated')
    }

    // Writes ONLY auto_fulfillment_enabled via the audited, allowlisted quick-toggle
    // route (same one toggleMtnExpress uses) — deliberately NOT saveSettings, which
    // would also rewrite the whole fulfillment_settings blob from this page's local
    // snapshot and could clobber a concurrent toggleNetwork/RPC write on another page.
    const toggleGlobal = async () => {
        const next = !settings.is_global_enabled
        const prev = settings.is_global_enabled
        setIsSavingSettings(true)
        setSettings(s => ({ ...s, is_global_enabled: next })) // optimistic
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
            setSettings(s => ({ ...s, is_global_enabled: prev })) // revert
            toast.error(e.message || 'Failed to update setting')
        } finally {
            setIsSavingSettings(false)
        }
    }

    const handleSyncCodecraft = async () => {
        if (isSyncing || syncCooldown) return
        setIsSyncing(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-codecraft', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} checked, ${result.updated} updated, ${result.failed} failed`)
                await fetchOrders()
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncing(false)
            setSyncCooldown(true)
            setTimeout(() => setSyncCooldown(false), 30000)
        }
    }

    const handleSyncDakazina = async () => {
        if (isSyncingDakazina || dakazinaSyncCooldown) return
        setIsSyncingDakazina(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-dakazina', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} checked, ${result.updated} updated, ${result.failed} failed`)
                await fetchOrders(true)
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncingDakazina(false)
            setDakazinaSyncCooldown(true)
            setTimeout(() => setDakazinaSyncCooldown(false), 30000)
        }
    }

    const handleSyncXpress = async () => {
        if (isSyncingXpress || xpressSyncCooldown) return
        setIsSyncingXpress(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-xpress', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} checked, ${result.updated} updated, ${result.failed} failed`)
                await fetchOrders(true)
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncingXpress(false)
            setXpressSyncCooldown(true)
            setTimeout(() => setXpressSyncCooldown(false), 30000)
        }
    }

    const handleSyncGhData = async () => {
        if (isSyncingGhData || ghdataSyncCooldown) return
        setIsSyncingGhData(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-ghdata', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} checked, ${result.updated} updated, ${result.failed} failed`)
                await fetchOrders(true)
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncingGhData(false)
            setGhdataSyncCooldown(true)
            setTimeout(() => setGhdataSyncCooldown(false), 30000)
        }
    }

    const handleSyncAgentPortal = async () => {
        if (isSyncingAgentPortal || agentportalSyncCooldown) return
        setIsSyncingAgentPortal(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-agentportal', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} deliveries checked, ${result.updated} resent, ${result.failed} still stuck (admin alerted)`)
                await fetchOrders(true)
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncingAgentPortal(false)
            setAgentportalSyncCooldown(true)
            setTimeout(() => setAgentportalSyncCooldown(false), 30000)
        }
    }

    const handleSyncHendyLinks = async () => {
        if (isSyncingHendyLinks || hendylinksSyncCooldown) return
        setIsSyncingHendyLinks(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-hendylinks', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} checked, ${result.updated} updated, ${result.failed} failed`)
                await fetchOrders()
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncingHendyLinks(false)
            setHendylinksSyncCooldown(true)
            setTimeout(() => setHendylinksSyncCooldown(false), 30000)
        }
    }

    const handleSyncSpfastit = async () => {
        if (isSyncingSpfastit || spfastitSyncCooldown) return
        setIsSyncingSpfastit(true)
        try {
            const response = await fetch('/api/admin/fulfillment/sync-spfastit', {
                method: 'POST',
            })
            const result = await response.json()
            if (!response.ok) {
                toast.error('Sync failed: ' + (result.error || 'Unknown error'))
            } else {
                toast.success(`${result.checked} checked, ${result.updated} updated, ${result.failed} failed`)
                await fetchOrders()
            }
        } catch (err: any) {
            toast.error('Sync error: ' + err.message)
        } finally {
            setIsSyncingSpfastit(false)
            setSpfastitSyncCooldown(true)
            setTimeout(() => setSpfastitSyncCooldown(false), 30000)
        }
    }

    const fetchOrders = async (isNewFilter = false, silent = false) => {
        if (!silent) setIsLoadingOrders(true)
        try {
            const { start, end } = getDateRange()

            let url = `/api/admin/fulfillment?network=${networkFilter}&status=${statusFilter}&channel=${channelFilter}&limit=1000`
            if (start) url += `&startDate=${start.toISOString()}`
            if (end) url += `&endDate=${end.toISOString()}`
            if (searchQuery) url += `&search=${encodeURIComponent(searchQuery)}`

            const response = await fetch(url)
            if (!response.ok) {
                const errorData = await response.json()
                throw new Error(errorData.error || 'Failed to fetch orders')
            }

            const data = await response.json()
            const fetchedOrders = data.orders || []
            setOrders(fetchedOrders)
            setOrdersCount(fetchedOrders.length)
        } catch (error: any) {
            console.error('Fetch orders error:', error)
            if (!silent) toast.error('Failed to fetch orders: ' + error.message)
        } finally {
            if (!silent) setIsLoadingOrders(false)
        }
    }

    const fetchBalance = async () => {
        setIsLoadingBalance(true)
        try {
            const response = await fetch('/api/admin/fulfillment/balance')
            if (!response.ok) {
                const error = await response.json()
                throw new Error(error.error || 'Failed to fetch balance')
            }

            const data = await response.json()
            setBalance({ amount: data.balance, currency: data.currency })
            if (data.codecraft_currency !== undefined) {
                setCodecraftBalance({ amount: data.codecraft_balance, currency: data.codecraft_currency })
            }
            if (data.xpress_currency !== undefined) {
                setXpressBalance({ amount: data.xpress_balance, currency: data.xpress_currency })
            }
            if (data.ghdata_currency !== undefined) {
                setGhdataBalance({ amount: data.ghdata_balance, currency: data.ghdata_currency })
            }
            if (data.agentportal_currency !== undefined) {
                setAgentportalBalance({ amount: data.agentportal_balance, currency: data.agentportal_currency })
            }
            // Bundle Portal and HendyLinks were added after this handler was written, and each
            // shipped with its own card + manual refresh button but no branch here — so both
            // showed "GHS —" on page load until the admin clicked refresh, while the other five
            // populated automatically. The all-suppliers API response has always included these
            // two fields (see app/api/admin/fulfillment/balance/route.ts); only the wiring was
            // missing. Any eighth supplier needs a branch here too.
            if (data.bundleportal_currency !== undefined) {
                setBundleportalBalance({ amount: data.bundleportal_balance, currency: data.bundleportal_currency })
            }
            if (data.hendylinks_currency !== undefined) {
                setHendylinksBalance({ amount: data.hendylinks_balance, currency: data.hendylinks_currency })
            }
            if (data.spfastit_currency !== undefined) {
                setSpfastitBalance({ amount: data.spfastit_balance, currency: data.spfastit_currency })
            }
        } catch (error: any) {
            console.error('Balance fetch error:', error)
            toast.error('Failed to fetch supplier balance')
        } finally {
            setIsLoadingBalance(false)
        }
    }

    // Individual balance fetches — each refreshes only its own supplier
    const fetchDKBalance = async () => {
        setIsLoadingDKBalance(true)
        try {
            const res = await fetch('/api/admin/fulfillment/balance?supplier=datakazina')
            const data = await res.json()
            if (res.ok) setBalance({ amount: data.balance, currency: data.currency })
            else toast.error('DataKazina balance error: ' + (data.error || 'Unknown'))
        } catch (err: any) { toast.error('Balance error: ' + err.message) }
        finally { setIsLoadingDKBalance(false) }
    }
    const fetchCCBalance = async () => {
        setIsLoadingCCBalance(true)
        try {
            const res = await fetch('/api/admin/fulfillment/balance?supplier=codecraft')
            const data = await res.json()
            if (res.ok) setCodecraftBalance({ amount: data.codecraft_balance, currency: data.codecraft_currency })
            else toast.error('CodeCraft balance error: ' + (data.error || 'Unknown'))
        } catch (err: any) { toast.error('Balance error: ' + err.message) }
        finally { setIsLoadingCCBalance(false) }
    }
    const fetchXPBalance = async () => {
        setIsLoadingXPBalance(true)
        try {
            const res = await fetch('/api/admin/fulfillment/balance?supplier=xpress')
            const data = await res.json()
            if (res.ok) setXpressBalance({ amount: data.xpress_balance, currency: data.xpress_currency })
            else toast.error('Xpress balance error: ' + (data.error || 'Unknown'))
        } catch (err: any) { toast.error('Balance error: ' + err.message) }
        finally { setIsLoadingXPBalance(false) }
    }
    const fetchGHBalance = async () => {
        setIsLoadingGHBalance(true)
        try {
            const res = await fetch('/api/admin/fulfillment/balance?supplier=ghdata')
            const data = await res.json()
            if (res.ok) setGhdataBalance({ amount: data.ghdata_balance, currency: data.ghdata_currency })
            else toast.error('GhData balance error: ' + (data.error || 'Unknown'))
        } catch (err: any) { toast.error('Balance error: ' + err.message) }
        finally { setIsLoadingGHBalance(false) }
    }
    const fetchAPBalance = async () => {
        setIsLoadingAPBalance(true)
        try {
            const res = await fetch('/api/admin/fulfillment/balance?supplier=agentportal')
            const data = await res.json()
            if (res.ok) setAgentportalBalance({ amount: data.agentportal_balance, currency: data.agentportal_currency })
            else toast.error('AgentPortal balance error: ' + (data.error || 'Unknown'))
        } catch (err: any) { toast.error('Balance error: ' + err.message) }
        finally { setIsLoadingAPBalance(false) }
    }
    const fetchBundlePortalBalance = async () => {
        setIsLoadingBPBalance(true)
        try {
            const res = await fetch('/api/admin/fulfillment/balance?supplier=bundleportal')
            const data = await res.json()
            if (res.ok) setBundleportalBalance({ amount: data.bundleportal_balance, currency: data.bundleportal_currency })
            else toast.error('Bundle Portal balance error: ' + (data.error || 'Unknown'))
        } catch (err: any) { toast.error('Balance error: ' + err.message) }
        finally { setIsLoadingBPBalance(false) }
    }
    const fetchSFBalance = async () => {
        setIsLoadingSFBalance(true)
        try {
            const res = await fetch('/api/admin/fulfillment/balance?supplier=spfastit')
            const data = await res.json()
            if (res.ok) setSpfastitBalance({ amount: data.spfastit_balance, currency: data.spfastit_currency })
            else toast.error('SPFastIT balance error: ' + (data.error || 'Unknown'))
        } catch (err: any) { toast.error('Balance error: ' + err.message) }
        finally { setIsLoadingSFBalance(false) }
    }
    const fetchHendyLinksBalance = async () => {
        setIsLoadingHLBalance(true)
        try {
            const res = await fetch('/api/admin/fulfillment/balance?supplier=hendylinks')
            const data = await res.json()
            if (res.ok) setHendylinksBalance({ amount: data.hendylinks_balance, currency: data.hendylinks_currency })
            else toast.error('HendyLinks balance error: ' + (data.error || 'Unknown'))
        } catch (err: any) { toast.error('Balance error: ' + err.message) }
        finally { setIsLoadingHLBalance(false) }
    }

    // Always-fresh ref so the realtime handler sees latest filters without re-subscribing
    const fetchOrdersRef = useRef<typeof fetchOrders>(fetchOrders)
    useEffect(() => { fetchOrdersRef.current = fetchOrders })

    // Debounce ref — collapses burst DB events into one fetch
    const liveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Realtime subscription — auto-updates orders and status without manual refresh
    useEffect(() => {
        const triggerLiveFetch = () => {
            if (liveDebounceRef.current) clearTimeout(liveDebounceRef.current)
            liveDebounceRef.current = setTimeout(() => {
                fetchOrdersRef.current(false, true)
            }, 1000)
        }

        const channel = supabase
            .channel('fulfillment-live')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, triggerLiveFetch)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mtn_fulfillment_tracking' }, triggerLiveFetch)
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'mtn_fulfillment_tracking' }, triggerLiveFetch)
            .subscribe((status) => { setIsLive(status === 'SUBSCRIBED') })

        return () => { supabase.removeChannel(channel) }
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    // Refresh when tab becomes visible or window regains focus
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === 'visible') fetchOrdersRef.current(false, true)
        }
        const onFocus = () => fetchOrdersRef.current(false, true)
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', onFocus)
        return () => {
            document.removeEventListener('visibilitychange', onVisible)
            window.removeEventListener('focus', onFocus)
        }
    }, [])


    // Bulk refund — capped at MAX_BULK_REFUND for safety, processed server-side sequentially
    // (idempotent per order). Controlled dialog (no native confirm — iOS-PWA safe).
    const [showBulkRefund, setShowBulkRefund] = useState(false)
    const [bulkRefundBusy, setBulkRefundBusy] = useState(false)

    const bulkRefund = async () => {
        const ids = Array.from(selectedOrders)
        if (ids.length === 0) { toast.error('No orders selected'); return }
        if (ids.length > MAX_BULK_REFUND) {
            toast.error(`Select at most ${MAX_BULK_REFUND} orders to refund at once`)
            return
        }
        setBulkRefundBusy(true)
        try {
            const response = await fetch('/api/admin/orders/bulk-refund', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // mechanism applies only to shop orders in the batch; data orders ignore it.
                body: JSON.stringify({ orderIds: ids, mechanism: 'owner_wallet', confirmProcessing: true }),
            })
            const data = await response.json()
            if (!response.ok || !data.success) throw new Error(data.error || 'Bulk refund failed')
            const s = data.data?.summary ?? { ok: 0, skipped: 0, failed: 0 }
            toast.success(`Refunded ${s.ok} · skipped ${s.skipped} · failed ${s.failed}`)
            setSelectedOrders(new Set())
            setShowBulkRefund(false)
            await fetchOrders(true)
        } catch (error: any) {
            toast.error(error.message || 'Bulk refund failed')
        } finally {
            setBulkRefundBusy(false)
        }
    }

    const bulkUpdateStatus = async (newStatus: 'completed' | 'failed' | 'processing' | 'pending') => {
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

            // Re-fetch current view
            await fetchOrders(true)
        } catch (error: any) {
            toast.error('Update failed: ' + error.message)
        } finally {
            setIsUpdating(false)
        }
    }

    const refulfillPending = async (useSelection = false) => {
        setIsRefulfilling(true)
        try {
            const payload = useSelection && selectedOrders.size > 0
                ? { orderIds: Array.from(selectedOrders) }
                : {}

            const response = await fetch('/api/admin/fulfillment/refulfill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })

            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Refulfillment failed')

            toast.success(`Refulfillment complete: ${data.fulfilled} processing, ${data.skipped} skipped, ${data.failed} failed/reverted`)
            if (useSelection) setSelectedOrders(new Set())

            // Re-fetch current view
            await fetchOrders(true)
        } catch (error: any) {
            toast.error('Refulfillment failed: ' + error.message)
        } finally {
            setIsRefulfilling(false)
        }
    }

    // Retry — single-order and bulk. Both are issued via controlled dialogs (no native
    // confirm() — iOS-PWA safe), mirroring the refund/refulfill dialog patterns above.
    // Gated on order.status alone (failed/refunded) — never on order.user_id, since admins
    // may retry any order and shop orders' rightful retrier often isn't orders.user_id.
    const [retryTarget, setRetryTarget] = useState<Order | null>(null)
    const [retryBusy, setRetryBusy] = useState(false)
    const [showBulkRetry, setShowBulkRetry] = useState(false)
    const [bulkRetryBusy, setBulkRetryBusy] = useState(false)

    // MoMo details modal state — shown only for failed/refunded shop orders (shop_order_id set).
    const [momoOrderId, setMomoOrderId] = useState<string | null>(null)
    const [momoModalOpen, setMomoModalOpen] = useState(false)

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

    const handleRetry = (order: Order) => setRetryTarget(order)

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

    // Selection filtered to retry-eligible orders only — used to gate the "Retry Selected"
    // button and to build the confirm dialog's failed/refunded breakdown.
    const retryEligibleSelected = orders.filter(o => selectedOrders.has(o.id) && isRetryEligible(o))
    const retryEligibleFailedCount = retryEligibleSelected.filter(o => o.status === 'failed').length
    const retryEligibleRefundedCount = retryEligibleSelected.filter(o => o.status === 'refunded').length

    // Sync is only meaningful against ONE supplier's lookup endpoint at a time — mirrors the
    // same-supplier constraint app/api/admin/orders/sync-selection enforces server-side; this
    // is just the UI's earlier, friendlier rejection (with a reason for the disabled tooltip).
    const selectedOrdersList = orders.filter(o => selectedOrders.has(o.id))
    const selectedSuppliers = new Set(selectedOrdersList.map(o => o.supplier).filter(Boolean))
    const singleSelectedSupplier = selectedSuppliers.size === 1 ? (Array.from(selectedSuppliers)[0] as SupplierTag) : null
    const canSyncSelection = selectedOrdersList.length > 0 && singleSelectedSupplier !== null && SYNC_SUPPORTED_SUPPLIERS.has(singleSelectedSupplier)
    const syncSelectionDisabledReason =
        selectedOrdersList.length === 0 ? '' :
        selectedSuppliers.size > 1 ? 'Select orders from a single supplier to sync' :
        singleSelectedSupplier === null ? 'Selected orders have no supplier recorded' :
        !SYNC_SUPPORTED_SUPPLIERS.has(singleSelectedSupplier) ? `Sync isn't supported yet for ${singleSelectedSupplier}` : ''

    // Re-checks the selected orders directly against their supplier — a targeted lookup, not
    // the account-wide "Sync" buttons on the AgentPortal/HendyLinks cards above, which sweep a
    // bounded recent window and can miss an older order an admin is specifically re-opening.
    const syncSelection = async () => {
        const ids = Array.from(selectedOrders)
        if (ids.length === 0) { toast.error('No orders selected'); return }
        setIsSyncingSelection(true)
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
            setSelectedOrders(new Set())
            await fetchOrders(true)
        } catch (error: any) {
            toast.error('Sync failed: ' + error.message)
        } finally {
            setIsSyncingSelection(false)
        }
    }

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

    // Channel filtering happens server-side (see fetchOrders' `channel` param). Supplier
    // is a derived/joined tag, so it stays a client-side filter over the fetched orders.
    const visibleOrders = supplierFilter === 'all'
        ? orders
        : orders.filter(o => (o.supplier ?? 'na') === supplierFilter)

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
            {/* Header Section */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2.5">
                        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Fulfillment Center</h1>
                        <span className={`flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full transition-all ${isLive ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-500 animate-pulse' : 'bg-gray-400'}`} />
                            {isLive ? 'Live' : 'Offline'}
                        </span>
                    </div>
                    <p className="text-xs md:text-sm text-muted-foreground">Manage multi-network automated and manual order processing</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <Button
                        onClick={() => refulfillPending(false)}
                        disabled={isRefulfilling || orders.filter(o => o.status === 'pending').length === 0}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold h-9 md:h-10 text-xs md:text-sm px-3 md:px-4"
                    >
                        {isRefulfilling ? (
                            <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                            <RotateCcw className="w-4 h-4 mr-2" />
                        )}
                        Refulfill All Pending
                    </Button>
                    <Button onClick={() => fetchOrders(true)} disabled={isLoadingOrders} variant="outline" size="sm" className="h-9 md:h-10 text-xs md:text-sm">
                        <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingOrders ? 'animate-spin' : ''}`} />
                        Refresh
                    </Button>
                    <div className="flex items-center gap-2 bg-background border px-3 h-9 md:h-10 rounded-full shadow-sm">
                        <span className="text-[10px] md:text-xs font-semibold">Auto-Fulfillment</span>
                        <Switch checked={settings.is_global_enabled} onCheckedChange={toggleGlobal} disabled={isSavingSettings} className="scale-75 md:scale-90" />
                    </div>
                </div>
            </div>

            {/* Supplier Cards — 2-col on mobile, 4-col on tablet, 7-col on wide desktop (one row
                per supplier count). There are SEVEN suppliers now; at md:grid-cols-6 the seventh
                card wrapped onto a row by itself. Keep the widest column count in step with the
                number of cards below whenever a supplier is added or removed. */}
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2 md:gap-4">
                {/* GhData */}
                <Card className="bg-gradient-to-br from-yellow-400 to-yellow-600 text-white border-none shadow-lg">
                    <CardContent className="p-3 md:p-5">
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-1.5 md:gap-2">
                                <div className="bg-white/20 p-1.5 md:p-2.5 rounded-lg shrink-0">
                                    <Server className="w-3.5 h-3.5 md:w-5 md:h-5" />
                                </div>
                                <p className="text-[9px] md:text-xs font-bold uppercase tracking-wider opacity-95 leading-tight">GH-DATA</p>
                            </div>
                            <p className="text-base md:text-xl font-semibold leading-none">
                                {ghdataBalance ? `${ghdataBalance.currency} ${ghdataBalance.amount.toFixed(2)}` : (isLoadingGHBalance ? '...' : 'GHS —')}
                            </p>
                            <div className="flex gap-1.5">
                                <Button onClick={fetchGHBalance} disabled={isLoadingGHBalance} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    <RefreshCw className={`w-3 h-3 mr-1 shrink-0 ${isLoadingGHBalance ? 'animate-spin' : ''}`} />
                                    <span>Bal</span>
                                </Button>
                                <Button onClick={handleSyncGhData} disabled={isSyncingGhData || ghdataSyncCooldown} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    {isSyncingGhData ? <Loader2 className="w-3 h-3 mr-1 shrink-0 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1 shrink-0" />}
                                    <span>{ghdataSyncCooldown ? 'Wait' : 'Sync'}</span>
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* CodeCraft */}
                <Card className="bg-gradient-to-br from-blue-600 to-blue-800 text-white border-none shadow-lg">
                    <CardContent className="p-3 md:p-5">
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-1.5 md:gap-2">
                                <div className="bg-white/20 p-1.5 md:p-2.5 rounded-lg shrink-0">
                                    <Server className="w-3.5 h-3.5 md:w-5 md:h-5" />
                                </div>
                                <p className="text-[9px] md:text-xs font-bold uppercase tracking-wider opacity-95 leading-tight">CodeCraft</p>
                            </div>
                            <p className="text-base md:text-xl font-semibold leading-none">
                                {codecraftBalance ? `${codecraftBalance.currency} ${codecraftBalance.amount.toFixed(2)}` : (isLoadingCCBalance ? '...' : 'GHS —')}
                            </p>
                            <div className="flex gap-1.5">
                                <Button onClick={fetchCCBalance} disabled={isLoadingCCBalance} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    <RefreshCw className={`w-3 h-3 mr-1 shrink-0 ${isLoadingCCBalance ? 'animate-spin' : ''}`} />
                                    <span>Bal</span>
                                </Button>
                                <Button onClick={handleSyncCodecraft} disabled={isSyncing || syncCooldown} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    {isSyncing ? <Loader2 className="w-3 h-3 mr-1 shrink-0 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1 shrink-0" />}
                                    <span>{syncCooldown ? 'Wait' : 'Sync'}</span>
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* DataKazina */}
                <Card className="bg-gradient-to-br from-emerald-600 to-emerald-800 text-white border-none shadow-lg">
                    <CardContent className="p-3 md:p-5">
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-1.5 md:gap-2">
                                <div className="bg-white/20 p-1.5 md:p-2.5 rounded-lg shrink-0">
                                    <Server className="w-3.5 h-3.5 md:w-5 md:h-5" />
                                </div>
                                <p className="text-[9px] md:text-xs font-bold uppercase tracking-wider opacity-95 leading-tight">DaKazina</p>
                            </div>
                            <p className="text-base md:text-xl font-semibold leading-none">
                                {balance ? `${balance.currency} ${balance.amount.toFixed(2)}` : (isLoadingDKBalance ? '...' : 'GHS —')}
                            </p>
                            <div className="flex gap-1.5">
                                <Button onClick={fetchDKBalance} disabled={isLoadingDKBalance} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    <RefreshCw className={`w-3 h-3 mr-1 shrink-0 ${isLoadingDKBalance ? 'animate-spin' : ''}`} />
                                    <span>Bal</span>
                                </Button>
                                <Button onClick={handleSyncDakazina} disabled={isSyncingDakazina || dakazinaSyncCooldown} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    {isSyncingDakazina ? <Loader2 className="w-3 h-3 mr-1 shrink-0 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1 shrink-0" />}
                                    <span>{dakazinaSyncCooldown ? 'Wait' : 'Sync'}</span>
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Xpress */}
                <Card className="bg-gradient-to-br from-violet-600 to-purple-800 text-white border-none shadow-lg">
                    <CardContent className="p-3 md:p-5">
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-1.5 md:gap-2">
                                <div className="bg-white/20 p-1.5 md:p-2.5 rounded-lg shrink-0">
                                    <Server className="w-3.5 h-3.5 md:w-5 md:h-5" />
                                </div>
                                <p className="text-[9px] md:text-xs font-bold uppercase tracking-wider opacity-95 leading-tight">Xpress</p>
                            </div>
                            <p className="text-base md:text-xl font-semibold leading-none">
                                {xpressBalance ? `${xpressBalance.currency} ${xpressBalance.amount.toFixed(2)}` : (isLoadingXPBalance ? '...' : 'GHS —')}
                            </p>
                            <div className="flex gap-1.5">
                                <Button onClick={fetchXPBalance} disabled={isLoadingXPBalance} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    <RefreshCw className={`w-3 h-3 mr-1 shrink-0 ${isLoadingXPBalance ? 'animate-spin' : ''}`} />
                                    <span>Bal</span>
                                </Button>
                                <Button onClick={handleSyncXpress} disabled={isSyncingXpress || xpressSyncCooldown} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    {isSyncingXpress ? <Loader2 className="w-3 h-3 mr-1 shrink-0 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1 shrink-0" />}
                                    <span>{xpressSyncCooldown ? 'Wait' : 'Sync'}</span>
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* AgentPortal */}
                <Card className="bg-gradient-to-br from-rose-600 to-rose-800 text-white border-none shadow-lg">
                    <CardContent className="p-3 md:p-5">
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-1.5 md:gap-2">
                                <div className="bg-white/20 p-1.5 md:p-2.5 rounded-lg shrink-0">
                                    <Server className="w-3.5 h-3.5 md:w-5 md:h-5" />
                                </div>
                                <p className="text-[9px] md:text-xs font-bold uppercase tracking-wider opacity-95 leading-tight">AgentPortal</p>
                            </div>
                            <p className="text-base md:text-xl font-semibold leading-none">
                                {agentportalBalance ? `${agentportalBalance.currency} ${agentportalBalance.amount.toFixed(2)}` : (isLoadingAPBalance ? '...' : 'GHS —')}
                            </p>
                            <div className="flex gap-1.5">
                                <Button onClick={fetchAPBalance} disabled={isLoadingAPBalance} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    <RefreshCw className={`w-3 h-3 mr-1 shrink-0 ${isLoadingAPBalance ? 'animate-spin' : ''}`} />
                                    <span>Bal</span>
                                </Button>
                                <Button onClick={handleSyncAgentPortal} disabled={isSyncingAgentPortal || agentportalSyncCooldown} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    {isSyncingAgentPortal ? <Loader2 className="w-3 h-3 mr-1 shrink-0 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1 shrink-0" />}
                                    <span>{agentportalSyncCooldown ? 'Wait' : 'Sync'}</span>
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Bundle Portal */}
                <Card className="bg-gradient-to-br from-fuchsia-600 to-fuchsia-800 text-white border-none shadow-lg">
                    <CardContent className="p-3 md:p-5">
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-1.5 md:gap-2">
                                <div className="bg-white/20 p-1.5 md:p-2.5 rounded-lg shrink-0">
                                    <Server className="w-3.5 h-3.5 md:w-5 md:h-5" />
                                </div>
                                <p className="text-[9px] md:text-xs font-bold uppercase tracking-wider opacity-95 leading-tight">Bundle Portal</p>
                            </div>
                            <p className="text-base md:text-xl font-semibold leading-none">
                                {bundleportalBalance ? `${bundleportalBalance.currency} ${bundleportalBalance.amount.toFixed(2)}` : (isLoadingBPBalance ? '...' : 'GHS —')}
                            </p>
                            <div className="flex gap-1.5">
                                <Button onClick={fetchBundlePortalBalance} disabled={isLoadingBPBalance} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    <RefreshCw className={`w-3 h-3 mr-1 shrink-0 ${isLoadingBPBalance ? 'animate-spin' : ''}`} />
                                    <span>Bal</span>
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* HendyLinks */}
                <Card className="bg-gradient-to-br from-teal-600 to-teal-800 text-white border-none shadow-lg">
                    <CardContent className="p-3 md:p-5">
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-1.5 md:gap-2">
                                <div className="bg-white/20 p-1.5 md:p-2.5 rounded-lg shrink-0">
                                    <Server className="w-3.5 h-3.5 md:w-5 md:h-5" />
                                </div>
                                <p className="text-[9px] md:text-xs font-bold uppercase tracking-wider opacity-95 leading-tight">HendyLinks</p>
                            </div>
                            <p className="text-base md:text-xl font-semibold leading-none">
                                {hendylinksBalance ? `${hendylinksBalance.currency} ${hendylinksBalance.amount.toFixed(2)}` : (isLoadingHLBalance ? '...' : 'GHS —')}
                            </p>
                            <div className="flex gap-1.5">
                                <Button onClick={fetchHendyLinksBalance} disabled={isLoadingHLBalance} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    <RefreshCw className={`w-3 h-3 mr-1 shrink-0 ${isLoadingHLBalance ? 'animate-spin' : ''}`} />
                                    <span>Bal</span>
                                </Button>
                                <Button onClick={handleSyncHendyLinks} disabled={isSyncingHendyLinks || hendylinksSyncCooldown} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    {isSyncingHendyLinks ? <Loader2 className="w-3 h-3 mr-1 shrink-0 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1 shrink-0" />}
                                    <span>{hendylinksSyncCooldown ? 'Wait' : 'Sync'}</span>
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* SPFastIT — admin-triggered sync mirrors the sync-spfastit-status cron route
                    exactly (per-order lookup by spfastit_reference, same double-filtered
                    UPDATE), since this supplier has no bulk account-wide sweep endpoint of its
                    own the way AgentPortal/HendyLinks do — see app/api/admin/fulfillment/sync-spfastit. */}
                <Card className="bg-gradient-to-br from-orange-600 to-orange-800 text-white border-none shadow-lg">
                    <CardContent className="p-3 md:p-5">
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-1.5 md:gap-2">
                                <div className="bg-white/20 p-1.5 md:p-2.5 rounded-lg shrink-0">
                                    <Server className="w-3.5 h-3.5 md:w-5 md:h-5" />
                                </div>
                                <p className="text-[9px] md:text-xs font-bold uppercase tracking-wider opacity-95 leading-tight">SPFastIT</p>
                            </div>
                            <p className="text-base md:text-xl font-semibold leading-none">
                                {spfastitBalance ? `${spfastitBalance.currency} ${spfastitBalance.amount.toFixed(2)}` : (isLoadingSFBalance ? '...' : 'GHS —')}
                            </p>
                            <div className="flex gap-1.5">
                                <Button onClick={fetchSFBalance} disabled={isLoadingSFBalance} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    <RefreshCw className={`w-3 h-3 mr-1 shrink-0 ${isLoadingSFBalance ? 'animate-spin' : ''}`} />
                                    <span>Bal</span>
                                </Button>
                                <Button onClick={handleSyncSpfastit} disabled={isSyncingSpfastit || spfastitSyncCooldown} variant="secondary" size="sm"
                                    className="flex-1 bg-white/20 hover:bg-white/30 text-white border-white/30 disabled:opacity-50 h-6 md:h-7 text-[9px] md:text-xs px-1.5">
                                    {isSyncingSpfastit ? <Loader2 className="w-3 h-3 mr-1 shrink-0 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1 shrink-0" />}
                                    <span>Sync</span>
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Cron Jobs */}
            <div className="grid grid-cols-2 gap-3 md:gap-4">
                {/* Auto-Complete Data Cron Card */}
                <Card className="border-l-4 border-l-violet-500 shadow-md">
                    <CardContent className="p-3 md:p-5">
                        <div className="flex flex-col gap-3">
                            <div className="flex items-start justify-between gap-2">
                                <div className="flex items-start gap-2">
                                    <div className="bg-violet-100 dark:bg-violet-900/30 p-2 rounded-lg mt-0.5 shrink-0">
                                        <Clock className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                                    </div>
                                    <div>
                                        <p className="text-xs md:text-sm font-semibold text-foreground leading-tight">Auto-Complete</p>
                                        <p className="text-[10px] text-muted-foreground hidden md:block mt-0.5">Marks processing orders older than threshold as completed.</p>
                                    </div>
                                </div>
                                <div className={`shrink-0 text-[10px] font-semibold px-2 py-1 rounded-full ${cronEnabled ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400' : 'bg-muted text-muted-foreground'}`}>
                                    {cronEnabled ? `On·${cronThreshold}m` : 'Off'}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                                <Switch
                                    id="cron-enabled"
                                    checked={cronEnabled}
                                    onCheckedChange={(val) => saveCronSettings(val, cronThreshold)}
                                    disabled={isSavingCron}
                                    className="scale-90"
                                />
                                <Input
                                    id="cron-threshold"
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

                {/* Auto-Refulfill Pending Cron Card */}
                <Card className="border-l-4 border-l-orange-500 shadow-md">
                    <CardContent className="p-3 md:p-5">
                        <div className="flex flex-col gap-3">
                            <div className="flex items-start justify-between gap-2">
                                <div className="flex items-start gap-2">
                                    <div className="bg-orange-100 dark:bg-orange-900/30 p-2 rounded-lg mt-0.5 shrink-0">
                                        <RotateCcw className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                                    </div>
                                    <div>
                                        <p className="text-xs md:text-sm font-semibold text-foreground leading-tight">Auto-Refulfill</p>
                                        <p className="text-[10px] text-muted-foreground hidden md:block mt-0.5">Retries pending orders, skips within cooldown.</p>
                                    </div>
                                </div>
                                <div className={`shrink-0 text-[10px] font-semibold px-2 py-1 rounded-full ${autoRefulfillEnabled ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' : 'bg-muted text-muted-foreground'}`}>
                                    {autoRefulfillEnabled ? `On·${autoRefulfillThreshold}m` : 'Off'}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                                <Switch
                                    id="auto-refulfill-enabled"
                                    checked={autoRefulfillEnabled}
                                    onCheckedChange={(val) => saveAutoRefulfillSettings(val, autoRefulfillThreshold)}
                                    disabled={isSavingAutoRefulfill}
                                    className="scale-90"
                                />
                                <Input
                                    id="auto-refulfill-threshold"
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

            {/* Network Connections — Mutex Toggle System (collapsible) */}
            <div className="border rounded-xl overflow-hidden shadow-sm">
                <button
                    onClick={() => setNetworkConfigOpen(o => !o)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-muted/50 hover:bg-muted transition-colors"
                >
                    <div className="flex items-center gap-2">
                        <Server className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm font-bold">Supplier Network Configuration</span>
                        <span className="text-[10px] text-muted-foreground hidden sm:inline">(click to {networkConfigOpen ? 'hide' : 'show'})</span>
                    </div>
                    <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${networkConfigOpen ? 'rotate-180' : ''}`} />
                </button>

                {networkConfigOpen && (
                <div className="p-4 space-y-3">
                {/* DataKazina Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-emerald-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">DataKazina Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`datakazina-${net}`} className={`border-l-4 transition-colors ${settings.networks[net] ? 'border-l-emerald-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.networks[net] ? 'text-emerald-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`dk-toggle-${net}`}
                                            variant={settings.networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.networks[net] ? 'border-emerald-500 text-emerald-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'datakazina')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.networks[net] ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-emerald-600 dark:text-emerald-400">DataKazina</span>
                                        {settings.networks[net] && <span className="text-emerald-500 font-semibold">· Active</span>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>

                    {/* MTN Express Delivery — DataKazina + MTN only */}
                    <Card className={`mt-1 border-l-4 transition-colors ${mtnExpressEnabled ? 'border-l-amber-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                        <CardContent className="p-3 md:p-4 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <Activity className={`w-3.5 h-3.5 shrink-0 ${mtnExpressEnabled ? 'text-amber-500' : 'text-gray-400'}`} />
                                    <span className="font-semibold text-xs md:text-sm">MTN Express Delivery</span>
                                    <span className="text-[9px] md:text-[10px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">DataKazina · MTN only</span>
                                </div>
                                <p className="text-[10px] text-muted-foreground mt-1">
                                    Routes DataKazina MTN data orders via the express product line (network_id 6). Volumes not on the express lane stay pending. Other networks &amp; suppliers are unaffected.
                                </p>
                            </div>
                            <Switch
                                checked={mtnExpressEnabled}
                                onCheckedChange={toggleMtnExpress}
                                disabled={isSavingExpress}
                                className="shrink-0"
                            />
                        </CardContent>
                    </Card>
                </div>

                {/* CodeCraft Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-blue-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-blue-700 dark:text-blue-400">CodeCraft Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`codecraft-${net}`} className={`border-l-4 transition-colors ${settings.codecraft_networks[net] ? 'border-l-blue-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.codecraft_networks[net] ? 'text-blue-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`cc-toggle-${net}`}
                                            variant={settings.codecraft_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.codecraft_networks[net] ? 'border-blue-500 text-blue-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'codecraft')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.codecraft_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.codecraft_networks[net] ? 'bg-blue-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-blue-600 dark:text-blue-400">CodeCraft</span>
                                        {settings.codecraft_networks[net] && <span className="text-blue-500 font-semibold">· Active</span>}
                                    </div>
                                    {net === 'MTN' && settings.codecraft_networks['MTN'] && (
                                        <div className="mt-2 pt-2 border-t border-dashed">
                                            <p className="text-[10px] text-muted-foreground mb-1">
                                                Fallback when CodeCraft rejects a number as unverified:
                                            </p>
                                            <Select
                                                value={settings.mtn_codecraft_fallback}
                                                onValueChange={(value) => {
                                                    const next = { ...settings, mtn_codecraft_fallback: value as FulfillmentSettings['mtn_codecraft_fallback'] }
                                                    saveSettings(next)
                                                }}
                                            >
                                                <SelectTrigger className="h-7 text-[11px]" disabled={isSavingSettings}>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="none">None</SelectItem>
                                                    <SelectItem value="datakazina">DataKazina</SelectItem>
                                                    <SelectItem value="xpress">Xpress</SelectItem>
                                                    <SelectItem value="ghdata">GhData</SelectItem>
                                                    <SelectItem value="agentportal">AgentPortal</SelectItem>
                                                    <SelectItem value="bundleportal">Bundle Portal</SelectItem>
                                                    <SelectItem value="hendylinks">HendyLinks</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>

                {/* Xpress Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-violet-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-400">Xpress Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`xpress-${net}`} className={`border-l-4 transition-colors ${settings.xpress_networks[net] ? 'border-l-violet-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.xpress_networks[net] ? 'text-violet-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`xp-toggle-${net}`}
                                            variant={settings.xpress_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.xpress_networks[net] ? 'border-violet-500 text-violet-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'xpress')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.xpress_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.xpress_networks[net] ? 'bg-violet-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-violet-600 dark:text-violet-400">Xpress</span>
                                        {settings.xpress_networks[net] && <span className="text-violet-500 font-semibold">· Active</span>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>

                {/* GhData Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-amber-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">GhData Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`ghdata-${net}`} className={`border-l-4 transition-colors ${settings.ghdata_networks[net] ? 'border-l-amber-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.ghdata_networks[net] ? 'text-amber-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`gh-toggle-${net}`}
                                            variant={settings.ghdata_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.ghdata_networks[net] ? 'border-amber-500 text-amber-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'ghdata')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.ghdata_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.ghdata_networks[net] ? 'bg-amber-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-amber-600 dark:text-amber-400">GhData</span>
                                        {settings.ghdata_networks[net] && <span className="text-amber-500 font-semibold">· Active</span>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>

                {/* AgentPortal Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-rose-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-rose-700 dark:text-rose-400">AgentPortal Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`agentportal-${net}`} className={`border-l-4 transition-colors ${settings.agentportal_networks[net] ? 'border-l-rose-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.agentportal_networks[net] ? 'text-rose-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`ap-toggle-${net}`}
                                            variant={settings.agentportal_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.agentportal_networks[net] ? 'border-rose-500 text-rose-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'agentportal')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.agentportal_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.agentportal_networks[net] ? 'bg-rose-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-rose-600 dark:text-rose-400">AgentPortal</span>
                                        {settings.agentportal_networks[net] && <span className="text-rose-500 font-semibold">· Active</span>}
                                    </div>
                                    {net === 'MTN' && settings.agentportal_networks['MTN'] && (
                                        <div className="mt-2 pt-2 border-t border-dashed">
                                            <p className="text-[10px] text-muted-foreground mb-1">
                                                Fallback when a number isn&apos;t whitelisted yet:
                                            </p>
                                            <Select
                                                value={settings.mtn_agentportal_fallback}
                                                onValueChange={(value) => {
                                                    const next = { ...settings, mtn_agentportal_fallback: value as FulfillmentSettings['mtn_agentportal_fallback'] }
                                                    saveSettings(next)
                                                }}
                                            >
                                                <SelectTrigger className="h-7 text-[11px]" disabled={isSavingSettings}>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="none">None</SelectItem>
                                                    <SelectItem value="datakazina">DataKazina</SelectItem>
                                                    <SelectItem value="codecraft">CodeCraft</SelectItem>
                                                    <SelectItem value="xpress">Xpress</SelectItem>
                                                    <SelectItem value="ghdata">GhData</SelectItem>
                                                    <SelectItem value="bundleportal">Bundle Portal</SelectItem>
                                                    <SelectItem value="hendylinks">HendyLinks</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>

                {/* Bundle Portal Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-fuchsia-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-fuchsia-700 dark:text-fuchsia-400">Bundle Portal Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => {
                            const bpSupported = BUNDLEPORTAL_SUPPORTED_NETWORKS.includes(net)
                            const bpEnabled = settings.bundleportal_networks[net]
                            return (
                            <Card key={`bundleportal-${net}`} className={`border-l-4 transition-colors ${
                                !bpSupported
                                    ? (bpEnabled ? 'border-l-red-500' : 'border-l-gray-200 dark:border-l-gray-700 opacity-60')
                                    : (bpEnabled ? 'border-l-fuchsia-500' : 'border-l-gray-300 dark:border-l-gray-600')
                            }`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${!bpSupported ? 'text-gray-400' : (bpEnabled ? 'text-fuchsia-500' : 'text-gray-400')}`} />
                                            <span className={`font-semibold text-xs md:text-sm ${!bpSupported ? 'text-muted-foreground' : ''}`}>{net}</span>
                                        </div>
                                        <Button
                                            id={`bp-toggle-${net}`}
                                            variant={bpEnabled ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${bpEnabled ? 'border-fuchsia-500 text-fuchsia-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'bundleportal')}
                                            disabled={isSavingSettings || !bpSupported}
                                        >
                                            {bpEnabled ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${!bpSupported ? (bpEnabled ? 'bg-red-500' : 'bg-gray-300') : (bpEnabled ? 'bg-fuchsia-500' : 'bg-gray-300')}`} />
                                        <span className="font-bold text-fuchsia-600 dark:text-fuchsia-400">Bundle Portal</span>
                                        {bpSupported && bpEnabled && <span className="text-fuchsia-500 font-semibold">· Active</span>}
                                    </div>
                                    {!bpSupported && (
                                        <p className={`text-[10px] mt-1 ${bpEnabled ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-muted-foreground'}`}>
                                            {bpEnabled
                                                ? 'Not supported by Bundle Portal — stored as active. Switch this network to another supplier to clear it.'
                                                : 'Not supported by Bundle Portal'}
                                        </p>
                                    )}
                                    {net === 'MTN' && settings.bundleportal_networks['MTN'] && (
                                        <div className="mt-2 pt-2 border-t border-dashed">
                                            <p className="text-[10px] text-muted-foreground mb-1">
                                                Fallback when Bundle Portal rejects a number:
                                            </p>
                                            <Select
                                                value={settings.mtn_bundleportal_fallback}
                                                onValueChange={(value) => {
                                                    const next = { ...settings, mtn_bundleportal_fallback: value as FulfillmentSettings['mtn_bundleportal_fallback'] }
                                                    saveSettings(next)
                                                }}
                                            >
                                                <SelectTrigger className="h-7 text-[11px]" disabled={isSavingSettings}>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="none">None</SelectItem>
                                                    <SelectItem value="datakazina">DataKazina</SelectItem>
                                                    <SelectItem value="codecraft">CodeCraft</SelectItem>
                                                    <SelectItem value="xpress">Xpress</SelectItem>
                                                    <SelectItem value="ghdata">GhData</SelectItem>
                                                    <SelectItem value="agentportal">AgentPortal</SelectItem>
                                                    <SelectItem value="hendylinks">HendyLinks</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                            )
                        })}
                    </div>
                </div>

                {/* HendyLinks Row */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-teal-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-teal-700 dark:text-teal-400">HendyLinks Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {NETWORKS.map(net => (
                            <Card key={`hendylinks-${net}`} className={`border-l-4 transition-colors ${settings.hendylinks_networks[net] ? 'border-l-teal-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.hendylinks_networks[net] ? 'text-teal-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`hl-toggle-${net}`}
                                            variant={settings.hendylinks_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.hendylinks_networks[net] ? 'border-teal-500 text-teal-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'hendylinks')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.hendylinks_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.hendylinks_networks[net] ? 'bg-teal-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-teal-600 dark:text-teal-400">HendyLinks</span>
                                        {settings.hendylinks_networks[net] && <span className="text-teal-500 font-semibold">· Active</span>}
                                    </div>
                                    {net === 'MTN' && settings.hendylinks_networks['MTN'] && (
                                        <div className="mt-2 pt-2 border-t border-dashed">
                                            <p className="text-[10px] text-muted-foreground mb-1">
                                                Fallback when HendyLinks returns &quot;plan not found&quot; (404):
                                            </p>
                                            <Select
                                                value={settings.mtn_hendylinks_fallback}
                                                onValueChange={(value) => {
                                                    const next = { ...settings, mtn_hendylinks_fallback: value as FulfillmentSettings['mtn_hendylinks_fallback'] }
                                                    saveSettings(next)
                                                }}
                                            >
                                                <SelectTrigger className="h-7 text-[11px]" disabled={isSavingSettings}>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="none">None</SelectItem>
                                                    <SelectItem value="datakazina">DataKazina</SelectItem>
                                                    <SelectItem value="codecraft">CodeCraft</SelectItem>
                                                    <SelectItem value="xpress">Xpress</SelectItem>
                                                    <SelectItem value="ghdata">GhData</SelectItem>
                                                    <SelectItem value="agentportal">AgentPortal</SelectItem>
                                                    <SelectItem value="bundleportal">Bundle Portal</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>

                {/* AT-iShare Console Row — AT-iShare only, see ATISHARE_CONSOLE_SUPPORTED_NETWORKS */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Server className="w-3.5 h-3.5 text-indigo-500" />
                        <span className="text-xs font-bold uppercase tracking-wide text-indigo-700 dark:text-indigo-400">AT-iShare Console Networks</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {ATISHARE_CONSOLE_SUPPORTED_NETWORKS.map(net => (
                            <Card key={`atishare-console-${net}`} className={`border-l-4 transition-colors ${settings.atishare_console_networks[net] ? 'border-l-indigo-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.atishare_console_networks[net] ? 'text-indigo-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`ac-toggle-${net}`}
                                            variant={settings.atishare_console_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.atishare_console_networks[net] ? 'border-indigo-500 text-indigo-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'atishare_console')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.atishare_console_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.atishare_console_networks[net] ? 'bg-indigo-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-indigo-600 dark:text-indigo-400">AT-iShare Console</span>
                                        {settings.atishare_console_networks[net] && <span className="text-indigo-500 font-semibold">· Active</span>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>

                {/* SPFastIT Row — Telecel only, see SPFASTIT_SUPPORTED_NETWORKS */}
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-semibold text-muted-foreground">SPFastIT (Telecel)</span>
                        <span className="text-[10px] text-muted-foreground">(enabling a network here auto-disables others for same network)</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {SPFASTIT_SUPPORTED_NETWORKS.map(net => (
                            <Card key={`spfastit-${net}`} className={`border-l-4 transition-colors ${settings.spfastit_networks[net] ? 'border-l-orange-500' : 'border-l-gray-300 dark:border-l-gray-600'}`}>
                                <CardContent className="p-3 md:p-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <Activity className={`w-3.5 h-3.5 ${settings.spfastit_networks[net] ? 'text-orange-500' : 'text-gray-400'}`} />
                                            <span className="font-semibold text-xs md:text-sm">{net}</span>
                                        </div>
                                        <Button
                                            id={`sf-toggle-${net}`}
                                            variant={settings.spfastit_networks[net] ? 'outline' : 'default'}
                                            size="sm"
                                            className={`h-6 text-[10px] md:text-xs px-2 ${settings.spfastit_networks[net] ? 'border-orange-500 text-orange-600' : ''}`}
                                            onClick={() => toggleNetwork(net, 'spfastit')}
                                            disabled={isSavingSettings}
                                        >
                                            {settings.spfastit_networks[net] ? 'Disconnect' : 'Connect'}
                                        </Button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${settings.spfastit_networks[net] ? 'bg-orange-500' : 'bg-gray-300'}`} />
                                        <span className="font-bold text-orange-600 dark:text-orange-400">SPFastIT</span>
                                        {settings.spfastit_networks[net] && <span className="text-orange-500 font-semibold">· Active</span>}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>
                </div>
                )}
            </div>

            {/* Main Content Area */}
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                {/* Left Column: Stats & Filters */}
                <div className="lg:col-span-1 space-y-4">
                    <Card>
                        <CardHeader className="pb-2 pt-4 px-4">
                            <CardTitle className="text-sm font-bold flex items-center gap-2">
                                <Filter className="w-4 h-4" /> Filters & Search
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="px-4 pb-4 space-y-4">
                            {/* Search */}
                            <div className="relative">
                                <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                                <Input
                                    placeholder="Search Beneficiary..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="pl-8 text-xs h-8"
                                />
                            </div>

                            {/* Date Filter */}
                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase font-bold text-muted-foreground">Date Range</label>
                                <div className="grid grid-cols-2 md:grid-cols-1 gap-2">
                                    {DATE_FILTER_PRESETS.map(range => (
                                        <Button
                                            key={range.id}
                                            variant={dateFilter === range.id ? "default" : "outline"}
                                            size="sm"
                                            className="h-8 text-[11px] font-bold justify-start px-3"
                                            onClick={() => setDateFilter(range.id)}
                                        >
                                            <CalendarIcon className="w-3.5 h-3.5 mr-2 opacity-60" />
                                            {range.label}
                                        </Button>
                                    ))}
                                </div>
                                {dateFilter === 'custom' && (
                                    <div className="mt-2">
                                        <div className="relative">
                                            <CalendarIcon className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
                                            <Input
                                                type="date"
                                                className="pl-8 h-8 text-xs w-full block"
                                                value={customDate}
                                                onChange={(e) => setCustomDate(e.target.value)}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Status Filter */}
                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase font-bold text-muted-foreground">Status</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {['All', 'Pending', 'Queued', 'Processing', 'Completed', 'Failed', 'Refunded'].map(s => (
                                        <Button
                                            key={s}
                                            variant={statusFilter === (s === 'All' ? 'All' : s.toLowerCase()) ? "default" : "outline"}
                                            size="sm"
                                            className="h-7 text-[10px] px-2.5"
                                            onClick={() => setStatusFilter(s === 'All' ? 'All' : s.toLowerCase())}
                                        >
                                            {s}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            {/* Channel (origin) Filter — client-side */}
                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase font-bold text-muted-foreground">Channel</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {CHANNELS.map(c => (
                                        <Button
                                            key={c.key}
                                            variant={channelFilter === c.key ? "default" : "outline"}
                                            size="sm"
                                            className="h-7 text-[10px] px-2.5"
                                            onClick={() => setChannelFilter(c.key)}
                                        >
                                            {c.label}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            {/* Supplier Filter — client-side, derived from mtn_fulfillment_tracking / download_batch_id */}
                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase font-bold text-muted-foreground">Supplier</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {SUPPLIER_FILTERS.map(s => (
                                        <Button
                                            key={s.key}
                                            variant={supplierFilter === s.key ? "default" : "outline"}
                                            size="sm"
                                            className="h-7 text-[10px] px-2.5"
                                            onClick={() => setSupplierFilter(s.key)}
                                        >
                                            {s.label}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            {/* Network Filter */}
                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase font-bold text-muted-foreground">Network</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {['All', ...NETWORKS].map(n => (
                                        <Button
                                            key={n}
                                            variant={networkFilter === n ? "default" : "outline"}
                                            size="sm"
                                            className="h-7 text-[10px] px-2.5"
                                            onClick={() => setNetworkFilter(n)}
                                        >
                                            {n}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            <div className="pt-4 border-t">
                                <div className="grid grid-cols-2 gap-2">

                                    <div className="p-2 md:p-2.5 bg-amber-50 dark:bg-amber-900/10 rounded-lg border border-amber-100 dark:border-amber-900/20 italic">
                                        <p className="text-[9px] md:text-[10px] text-amber-700 dark:text-amber-400 font-bold uppercase">Pending</p>
                                        <p className="text-lg md:text-xl font-bold text-amber-600 dark:text-amber-500">{visibleOrders.filter(o => o.status === 'pending').length}</p>
                                    </div>
                                    <div className="p-2 md:p-2.5 bg-indigo-50 dark:bg-indigo-900/10 rounded-lg border border-indigo-100 dark:border-indigo-900/20 italic">
                                        <p className="text-[9px] md:text-[10px] text-indigo-700 dark:text-indigo-400 font-bold uppercase">Queued</p>
                                        <p className="text-lg md:text-xl font-bold text-indigo-600 dark:text-indigo-500">{visibleOrders.filter(o => o.status === 'queued').length}</p>
                                    </div>
                                    <div className="p-2 md:p-2.5 bg-yellow-50 dark:bg-yellow-900/10 rounded-lg border border-yellow-100 dark:border-yellow-900/20 italic">
                                        <p className="text-[9px] md:text-[10px] text-yellow-700 dark:text-yellow-400 font-bold uppercase">Processing</p>
                                        <p className="text-lg md:text-xl font-bold text-yellow-600 dark:text-yellow-500">{visibleOrders.filter(o => o.status === 'processing').length}</p>
                                    </div>
                                    <div className="p-2 md:p-2.5 bg-green-50 dark:bg-green-900/10 rounded-lg border border-green-100 dark:border-green-900/20">
                                        <p className="text-[9px] md:text-[10px] text-green-700 dark:text-green-400 font-bold uppercase">Completed</p>
                                        <p className="text-lg md:text-xl font-bold text-green-600 dark:text-green-500">{visibleOrders.filter(o => o.status === 'completed').length}</p>
                                    </div>
                                    <div className="p-2 md:p-2.5 bg-red-50 dark:bg-red-900/10 rounded-lg border border-red-100 dark:border-red-900/20">
                                        <p className="text-[9px] md:text-[10px] text-red-700 dark:text-red-400 font-bold uppercase">Failed</p>
                                        <p className="text-lg md:text-xl font-bold text-red-600 dark:text-red-500">{visibleOrders.filter(o => o.status === 'failed').length}</p>
                                    </div>
                                    <div className="p-2 md:p-2.5 bg-purple-50 dark:bg-purple-900/10 rounded-lg border border-purple-100 dark:border-purple-900/20">
                                        <p className="text-[9px] md:text-[10px] text-purple-700 dark:text-purple-400 font-bold uppercase">Refunded</p>
                                        <p className="text-lg md:text-xl font-bold text-purple-600 dark:text-purple-500">{visibleOrders.filter(o => o.status === 'refunded').length}</p>
                                    </div>
                                    <div className="p-2 md:p-2.5 bg-blue-50 dark:bg-blue-900/10 rounded-lg border border-blue-100 dark:border-blue-900/20">
                                        <p className="text-[9px] md:text-[10px] text-blue-700 dark:text-blue-400 font-bold uppercase">Selected</p>
                                        <p className="text-lg md:text-xl font-bold text-blue-600 dark:text-blue-500">{selectedOrders.size}</p>
                                    </div>
                                    <div className="p-2 md:p-2.5 bg-emerald-50 dark:bg-emerald-900/10 rounded-lg border border-emerald-100 dark:border-emerald-900/20">
                                        <p className="text-[9px] md:text-[10px] text-emerald-700 dark:text-emerald-400 font-bold uppercase">Total Cost</p>
                                        <p className="text-sm md:text-base font-bold text-emerald-600 dark:text-emerald-500 truncate">
                                            GHS {visibleOrders.reduce((acc, curr) => acc + (curr.price || 0), 0).toFixed(2)}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-gradient-to-br from-indigo-600 to-indigo-800 text-white border-none shadow-lg">
                        <CardHeader className="pb-2 pt-4 px-4">
                            <CardTitle className="text-sm font-bold flex items-center gap-2">
                                <Server className="w-4 h-4" /> Tip
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="px-4 pb-4 text-[10px] leading-relaxed opacity-90">
                            Check supplier portal manually. Mark orders appropriately to maintain accurate records.
                        </CardContent>
                    </Card>
                </div>

                {/* Right Column: Order List */}
                <div className="lg:col-span-3 space-y-4">
                    {/* Bulk Actions Bar */}
                    {selectedOrders.size > 0 && (
                        <div className="sticky top-20 z-30 flex items-center justify-between bg-primary/10 dark:bg-primary/20 backdrop-blur-md border border-primary/20 p-2 md:p-3 rounded-xl shadow-lg animate-in fade-in slide-in-from-top-4 flex-wrap gap-2 mx-2">
                            <div className="flex items-center gap-2">
                                <Badge variant="default" className="rounded-full px-2 text-[10px]">{selectedOrders.size}</Badge>
                                <span className="text-[10px] md:text-xs font-bold uppercase">Selected</span>
                            </div>
                            <div className="flex gap-2 md:gap-3 flex-wrap justify-end">
                                <Button
                                    size="sm"
                                    onClick={() => refulfillPending(true)}
                                    className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-sm"
                                    disabled={isRefulfilling || isUpdating}
                                >
                                    {isRefulfilling ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 mr-1.5" />}
                                    {isRefulfilling ? 'Refulfilling...' : 'Refulfill Pending'}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => bulkUpdateStatus('pending')}
                                    className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 bg-amber-500 hover:bg-amber-600 text-black font-bold shadow-sm disabled:opacity-50"
                                    disabled={isUpdating || isRefulfilling || orders.some(o => selectedOrders.has(o.id) && o.status === 'processing')}
                                    title={orders.some(o => selectedOrders.has(o.id) && o.status === 'processing') ? "Cannot revert processing orders to pending" : ""}
                                >
                                    <Clock className="w-3.5 h-3.5 mr-1.5" /> Pending
                                </Button>
                                <Button size="sm" onClick={() => bulkUpdateStatus('processing')} className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 bg-yellow-500 hover:bg-yellow-600 text-black font-bold shadow-sm" disabled={isUpdating || isRefulfilling}>
                                    <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Reprocess
                                </Button>
                                <Button size="sm" onClick={() => bulkUpdateStatus('completed')} className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 bg-green-600 hover:bg-green-700 font-bold shadow-sm" disabled={isUpdating || isRefulfilling}>
                                    <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Complete
                                </Button>
                                <Button size="sm" onClick={() => bulkUpdateStatus('failed')} variant="destructive" className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 font-bold shadow-sm" disabled={isUpdating || isRefulfilling}>
                                    <XCircle className="w-3.5 h-3.5 mr-1.5" /> Fail
                                </Button>
                                <Button size="sm" onClick={() => setShowBulkRefund(true)} className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 bg-amber-600 hover:bg-amber-700 text-white font-bold shadow-sm" disabled={isUpdating || isRefulfilling}>
                                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refund
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => setShowBulkRetry(true)}
                                    className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 bg-blue-600 hover:bg-blue-700 text-white font-bold shadow-sm"
                                    disabled={isUpdating || isRefulfilling || retryEligibleSelected.length === 0}
                                    title={retryEligibleSelected.length === 0 ? 'Select at least one failed/refunded order' : ''}
                                >
                                    <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Retry Selected
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={syncSelection}
                                    className="h-9 md:h-10 text-xs md:text-sm px-3 md:px-4 bg-cyan-600 hover:bg-cyan-700 text-white font-bold shadow-sm disabled:opacity-50"
                                    disabled={isUpdating || isRefulfilling || isSyncingSelection || !canSyncSelection}
                                    title={syncSelectionDisabledReason}
                                >
                                    {isSyncingSelection ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RadioTower className="w-3.5 h-3.5 mr-1.5" />}
                                    Sync
                                </Button>
                            </div>
                        </div>
                    )}

                    <Card className="shadow-md">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
                            <CardTitle className="text-lg font-bold">Order History</CardTitle>
                            <div className="flex gap-2">
                                <Button variant="ghost" size="sm" className="h-7 text-[10px]" onClick={() => setSelectedOrders(new Set())} disabled={selectedOrders.size === 0}>
                                    Clear
                                </Button>
                                <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => setSelectedOrders(new Set(visibleOrders.map(o => o.id)))} disabled={visibleOrders.length === 0}>
                                    Select Page
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="px-1 md:px-6">
                            {visibleOrders.length === 0 && !isLoadingOrders ? (
                                <div className="text-center py-20 border-2 border-dashed rounded-xl m-2">
                                    <Package className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
                                    <h3 className="text-sm font-bold">No Records Found</h3>
                                    <p className="text-muted-foreground text-xs">Try adjusting your filters.</p>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {visibleOrders.map(order => (
                                        <div
                                            key={order.id}
                                            onClick={() => {
                                                // If the user was dragging to select/copy text (phone number, etc.),
                                                // don't also toggle bulk-select on the resulting click.
                                                if (window.getSelection()?.toString()) return
                                                const next = new Set(selectedOrders)
                                                next.has(order.id) ? next.delete(order.id) : next.add(order.id)
                                                setSelectedOrders(next)
                                            }}
                                            className={cn(
                                                // flex-wrap is load-bearing on mobile: the View MoMo wrapper below is
                                                // `w-full` (100% of this row) and only renders for failed/refunded
                                                // orders. Without wrapping it claimed the whole row and crushed the
                                                // flex-1 grid beside it to near-zero, collapsing the labels and
                                                // wrapping text one character per line. On md+ the button is w-auto
                                                // and nowrap restores the original single-line layout.
                                                "group relative flex flex-wrap md:flex-nowrap items-center gap-3 p-3 border-2 rounded-xl transition-all duration-200 cursor-pointer",
                                                selectedOrders.has(order.id)
                                                    ? "bg-primary/10 border-primary shadow-md scale-[1.01]"
                                                    : "bg-card border-transparent hover:border-primary/20 hover:bg-accent/50"
                                            )}
                                        >
                                            <Checkbox
                                                checked={selectedOrders.has(order.id)}
                                                className="scale-110 pointer-events-none"
                                            />

                                            {/* min-w-0 lets this shrink below its content's intrinsic width, so a long
                                                purchaser/shop name truncates instead of forcing the row to overflow. */}
                                            <div className="flex-1 min-w-0 grid grid-cols-2 md:grid-cols-6 items-center gap-x-2 gap-y-3 md:gap-4 p-1">
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] md:text-[11px] uppercase font-medium text-muted-foreground">Beneficiary</p>
                                                    <p className="text-[13px] md:text-sm font-medium text-primary">{order.phone_number}</p>
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] md:text-[11px] uppercase font-medium text-muted-foreground">Bundle</p>
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        <Badge variant="outline" className="text-[10px] px-1.5 font-black leading-none py-1 bg-secondary/50">{order.network}</Badge>
                                                        <span className="text-[13px] md:text-xs font-medium">{order.size}</span>
                                                    </div>
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] md:text-[11px] uppercase font-medium text-muted-foreground">Purchaser</p>
                                                    <div className="text-[11px] md:text-xs">
                                                        <div className="flex items-center gap-1.5 flex-wrap">
                                                            {/* Shop-attributed orders with no buyer account (USSD shop
                                                                guests) show the SHOP as the purchaser — 'N/A' hid who
                                                                the sale belonged to. */}
                                                            <p className="font-bold truncate max-w-[100px] md:max-w-full" title={order.users?.first_name ? `${order.users?.first_name} ${order.users?.last_name ?? ''}` : (order.shop_name ?? undefined)}>
                                                                {order.users?.first_name
                                                                    ? <>{order.users.first_name} {order.users.last_name || ''}</>
                                                                    : (order.shop_name || 'N/A')}
                                                            </p>
                                                            {order.source === 'api' && (
                                                                <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-violet-100 text-violet-700 hover:bg-violet-100 border-violet-200">
                                                                    API
                                                                </Badge>
                                                            )}
                                                            {(order.source === 'ussd' || order.source === 'ussd_shop') && (
                                                                <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-blue-100 text-blue-700 hover:bg-blue-100 border-blue-200">
                                                                    USSD
                                                                </Badge>
                                                            )}
                                                            {/* The Shop pill stays only when the name line is a real
                                                                user (website shop rows attribute users = the owner) —
                                                                otherwise it would duplicate the purchaser line. */}
                                                            {order.shop_name && order.users?.first_name && (
                                                                <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-blue-100 text-blue-700 hover:bg-blue-100 border-blue-200">
                                                                    Shop: {order.shop_name}
                                                                </Badge>
                                                            )}
                                                        </div>
                                                        <p className="text-muted-foreground opacity-70 text-[10px] font-bold uppercase">
                                                            {order.users?.role || (order.shop_name ? 'Shop' : order.source?.startsWith('ussd') ? 'Guest' : 'User')}
                                                        </p>
                                                    </div>
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] md:text-[11px] uppercase font-medium text-muted-foreground">Status</p>
                                                    <div>
                                                        {(() => {
                                                            // "Background Queue Fulfillment Success" is a Hubtel processing sub-state
                                                            // (distinct from the new 'queued' registration status) — keep its yellow chip.
                                                            const isBgQueue = order.status === 'processing'
                                                                && order.mtn_fulfillment_tracking?.some((t: any) => t.api_response?.note === 'Background Queue Fulfillment Success')
                                                            const retryTag = getRetryTag(order)
                                                            const selfCompletedTag = getSelfCompletedTag(order)
                                                            return (
                                                                <div className="flex items-center gap-1 flex-wrap">
                                                                    <span className={cn(
                                                                        "inline-flex items-center rounded-md text-[10px] md:text-[11px] font-medium uppercase tracking-wider h-5 px-2",
                                                                        isBgQueue
                                                                            ? "border border-yellow-500 text-yellow-600 bg-yellow-50 dark:bg-yellow-900/20"
                                                                            : getStatusBadgeClass(order.status)
                                                                    )}>
                                                                        {isBgQueue ? 'Queued Processing' : order.status}
                                                                    </span>
                                                                    <span className={cn(
                                                                        "inline-flex items-center rounded-md border text-[10px] font-medium tracking-wide h-5 px-2",
                                                                        (SUPPLIER_META[order.supplier ?? 'na'] ?? SUPPLIER_META.na).badgeClass
                                                                    )}>
                                                                        {(SUPPLIER_META[order.supplier ?? 'na'] ?? SUPPLIER_META.na).label}
                                                                    </span>
                                                                    {shouldShowRefundOverlay(order) && (
                                                                        <span className={cn(
                                                                            "inline-flex items-center rounded-md text-[10px] md:text-[11px] font-medium uppercase tracking-wider h-5 px-2",
                                                                            REFUND_OVERLAY_BADGE_CLASS
                                                                        )}>
                                                                            Refunded
                                                                        </span>
                                                                    )}
                                                                    {selfCompletedTag ? (
                                                                        <span className={cn(
                                                                            "inline-flex items-center rounded-md text-[10px] font-medium tracking-wide h-5 px-2",
                                                                            selfCompletedTag.badge
                                                                        )}>
                                                                            {selfCompletedTag.label}
                                                                        </span>
                                                                    ) : retryTag && (
                                                                        <span className={cn(
                                                                            "inline-flex items-center rounded-md text-[10px] font-medium tracking-wide h-5 px-2",
                                                                            retryTag.badge
                                                                        )}>
                                                                            {retryTag.label}
                                                                        </span>
                                                                    )}
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
                                                                </div>
                                                            )
                                                        })()}
                                                    </div>
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-[10px] md:text-[11px] uppercase font-medium text-muted-foreground">Time</p>
                                                    <p className="text-[11px] md:text-[12px] font-bold opacity-80">
                                                        {new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {new Date(order.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                                    </p>
                                                </div>
                                                <div className="hidden md:block space-y-0.5 text-right">
                                                    <p className="text-[11px] uppercase font-medium text-muted-foreground">Cost</p>
                                                    <p className="text-sm font-semibold text-primary">{formatCurrency(order.price)}</p>
                                                </div>
                                            </div>
                                            {order.shop_order_id && isMomoLookupEligible({ status: order.status }) && (
                                                <div className="w-full md:w-auto md:ml-2">
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        className="h-7 px-2.5 text-[11px] text-purple-600 hover:text-purple-700 hover:bg-purple-50 border-purple-200 dark:border-purple-900"
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            setMomoOrderId(order.id)
                                                            setMomoModalOpen(true)
                                                        }}
                                                    >
                                                        <Smartphone className="w-3 h-3 mr-1" />
                                                        View MoMo
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    ))}

                                    {/* Footer Info */}
                                    {orders.length > 0 && (
                                        <div className="pt-4 flex items-center justify-center">
                                            <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">
                                                Showing {visibleOrders.length} orders in this period
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

            {/* Bulk refund confirmation — controlled, capped, iOS-PWA safe */}
            <Dialog open={showBulkRefund} onOpenChange={(o) => { if (!o && !bulkRefundBusy) setShowBulkRefund(false) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Refund {selectedOrders.size} order(s)?</DialogTitle>
                        <DialogDescription>
                            Eligible orders (pending / processing / failed) are refunded; completed and already-refunded orders are skipped automatically.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1.5 text-sm text-muted-foreground">
                        <p>• Data orders → the buyer&apos;s wallet is credited.</p>
                        <p>• Shop orders → the cost is credited to the shop owner&apos;s wallet.</p>
                        <p className="text-amber-600 dark:text-amber-400">• Some selected orders may be processing and already delivered — proceed only if you accept that risk.</p>
                        {selectedOrders.size > MAX_BULK_REFUND && (
                            <p className="text-red-600 font-medium">You can refund at most {MAX_BULK_REFUND} orders at once. Deselect some first.</p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setShowBulkRefund(false)} disabled={bulkRefundBusy}>Cancel</Button>
                        <Button
                            variant="destructive"
                            onClick={bulkRefund}
                            disabled={bulkRefundBusy || selectedOrders.size === 0 || selectedOrders.size > MAX_BULK_REFUND}
                        >
                            {bulkRefundBusy ? 'Processing…' : `Refund ${Math.min(selectedOrders.size, MAX_BULK_REFUND)} order(s)`}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Single-order retry — controlled, iOS-PWA safe (no native confirm) */}
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

            <MomoDetailsModal
                open={momoModalOpen}
                onOpenChange={setMomoModalOpen}
                fetchUrl={momoOrderId ? `/api/admin/orders/${momoOrderId}/momo-details` : null}
            />
        </div>
    )
}
