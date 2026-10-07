'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { toast } from '@/lib/toast'
import { formatCurrency } from '@/lib/utils'
import {
    Smartphone, Settings2, RefreshCw, Save, Loader2,
    CheckCircle2, AlertCircle, Clock, ToggleLeft, Users, Activity, Banknote, Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

// ─── Types ────────────────────────────────────────────────────────────────────

interface USSDOrder {
    id: string
    session_id: string
    mobile: string
    service_type: 'data' | 'results_checker' | 'afa'
    price: number
    status: 'pending' | 'fulfilled' | 'failed' | 'expired'
    hubtel_order_id: string | null
    user_id: string | null
    created_at: string
    fulfilled_at: string | null
    expires_at: string
    order_payload: Record<string, unknown>
}

interface USSDSession {
    id: string
    session_id: string
    mobile: string
    operator: string | null
    platform: string
    steps: number
    service_used: string | null
    completed: boolean
    interrupted_at: string | null
    created_at: string
    updated_at: string
}

interface USSDCustomer {
    id: string
    mobile: string
    operator: string | null
    first_seen: string
    last_seen: string
    total_orders: number
    total_spent: number
    last_service: string | null
}

interface USSDSale {
    id: string
    service: 'data' | 'results_checker' | 'afa'
    created_at: string
    customer_phone: string
    description: string
    amount: number
    payment_method: 'momo' | 'wallet'
    status: string
    source: string
    reference_code: string | null
    shop_name: string | null
    registered: boolean
}

interface USSDSalesSummary {
    count: number
    totalAmount: number
    walletAmount: number
    momoAmount: number
}

type Tab = 'settings' | 'orders' | 'sales' | 'sessions' | 'customers'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusBadge(status: string) {
    const map: Record<string, { label: string; cls: string }> = {
        fulfilled: { label: 'Fulfilled', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' },
        pending:   { label: 'Pending',   cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
        failed:    { label: 'Failed',    cls: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' },
        expired:   { label: 'Expired',   cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
    }
    const s = map[status] ?? { label: status, cls: 'bg-slate-100 text-slate-600' }
    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${s.cls}`}>
            {s.label}
        </span>
    )
}

function serviceLabel(type: string) {
    const map: Record<string, string> = {
        data: 'Data Bundle',
        results_checker: 'Results Checker',
        afa: 'AFA Reg',
    }
    return map[type] ?? type
}

function paymentBadge(method: string) {
    const isWallet = method === 'wallet'
    const cls = isWallet
        ? 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300'
        : 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300'
    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${cls}`}>
            {isWallet ? 'Wallet' : 'MoMo'}
        </span>
    )
}

function fmt(iso: string | null) {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('en-GH', { dateStyle: 'short', timeStyle: 'short' })
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminUSSDPage() {
    const { user, isLoading: authLoading } = useAuth()
    const router = useRouter()

    const [tab, setTab] = useState<Tab>('settings')
    const [loading, setLoading] = useState(false)

    const [settings, setSettings] = useState<Record<string, string>>({})
    const [savingSettings, setSavingSettings] = useState(false)

    const [orders, setOrders] = useState<USSDOrder[]>([])
    const [sessions, setSessions] = useState<USSDSession[]>([])
    const [customers, setCustomers] = useState<USSDCustomer[]>([])
    const [orderFilter, setOrderFilter] = useState<string>('all')

    const [sales, setSales] = useState<USSDSale[]>([])
    const [salesSummary, setSalesSummary] = useState<USSDSalesSummary | null>(null)
    const [salesPayment, setSalesPayment] = useState<'all' | 'wallet' | 'momo'>('all')
    const [salesService, setSalesService] = useState<'all' | 'data' | 'results_checker' | 'afa'>('all')

    useEffect(() => {
        if (!authLoading && !user) router.replace('/auth/login')
    }, [authLoading, user, router])

    const fetchSettings = useCallback(async () => {
        const res = await fetch('/api/admin/ussd/settings')
        if (res.ok) {
            const { settings: s } = await res.json()
            setSettings(s)
        }
    }, [])

    const fetchOrders = useCallback(async (status?: string) => {
        const qs = status && status !== 'all' ? `?status=${status}` : ''
        const res = await fetch(`/api/admin/ussd/orders${qs}`)
        if (res.ok) {
            const { orders: o } = await res.json()
            setOrders(o)
        }
    }, [])

    const fetchSales = useCallback(async (payment: string, service: string) => {
        const params = new URLSearchParams()
        if (payment && payment !== 'all') params.set('payment', payment)
        if (service && service !== 'all') params.set('service', service)
        const qs = params.toString()
        const res = await fetch(`/api/admin/ussd/sales${qs ? `?${qs}` : ''}`)
        if (res.ok) {
            const { sales: s, summary } = await res.json()
            setSales(s)
            setSalesSummary(summary ?? null)
        }
    }, [])

    const fetchSessions = useCallback(async () => {
        const res = await fetch('/api/admin/ussd/sessions')
        if (res.ok) {
            const { sessions: s } = await res.json()
            setSessions(s)
        }
    }, [])

    const fetchCustomers = useCallback(async () => {
        const res = await fetch('/api/admin/ussd/customers')
        if (res.ok) {
            const { customers: c } = await res.json()
            setCustomers(c)
        }
    }, [])

    useEffect(() => {
        if (!user) return
        setLoading(true)
        const loads: Promise<unknown>[] = [fetchSettings()]
        if (tab === 'orders') loads.push(fetchOrders(orderFilter))
        if (tab === 'sales') loads.push(fetchSales(salesPayment, salesService))
        if (tab === 'sessions') loads.push(fetchSessions())
        if (tab === 'customers') loads.push(fetchCustomers())
        Promise.all(loads).finally(() => setLoading(false))
    }, [tab, user]) // eslint-disable-line react-hooks/exhaustive-deps

    const handleSaveSettings = async () => {
        setSavingSettings(true)
        const res = await fetch('/api/admin/ussd/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
        })
        setSavingSettings(false)
        if (res.ok) toast.success('USSD settings saved')
        else toast.error('Failed to save settings')
    }

    const setSetting = (key: string, value: string) =>
        setSettings(prev => ({ ...prev, [key]: value }))

    const toggleSetting = (key: string) =>
        setSetting(key, settings[key] === 'true' ? 'false' : 'true')

    const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
        { id: 'settings',  label: 'Settings',  icon: <Settings2 className="w-4 h-4" /> },
        { id: 'sales',     label: 'Sales',     icon: <Banknote className="w-4 h-4" /> },
        { id: 'orders',    label: 'Payments',  icon: <Activity className="w-4 h-4" /> },
        { id: 'sessions',  label: 'Sessions',  icon: <Clock className="w-4 h-4" /> },
        { id: 'customers', label: 'Customers', icon: <Users className="w-4 h-4" /> },
    ]

    if (authLoading) return null

    return (
        <div className="space-y-5">
            {/* Header */}
            <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center flex-shrink-0">
                    <Smartphone className="w-5 h-5 text-violet-600 dark:text-violet-400" />
                </div>
                <div>
                    <h1 className="text-lg font-bold text-slate-900 dark:text-white">USSD Management</h1>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Hubtel USSD settings, orders, session logs and guest customers</p>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl overflow-x-auto">
                {tabs.map(t => (
                    <button
                        key={t.id}
                        onClick={() => setTab(t.id)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors flex-1 justify-center
                            ${tab === t.id
                                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}
                    >
                        {t.icon}
                        <span className="hidden sm:inline">{t.label}</span>
                    </button>
                ))}
            </div>

            {loading && (
                <div className="flex justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                </div>
            )}

            {/* ── Settings ── */}
            {!loading && tab === 'settings' && (
                <div className="space-y-4">
                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                            <ToggleLeft className="w-4 h-4 text-slate-500" />
                            <div>
                                <p className="text-sm font-bold text-slate-900 dark:text-white">Service Toggles</p>
                                <p className="text-[11px] text-slate-500">Master kill-switch and per-service enablement</p>
                            </div>
                        </div>
                        <div className="p-5 space-y-4">
                            {([
                                ['ussd_enabled',         'USSD Master Switch', 'Disable to take down the entire USSD service'],
                                ['ussd_data_enabled',    'Data Bundles',       'Show data bundle option in USSD menu'],
                                ['ussd_rc_enabled',      'Results Checker',    'Show results checker option in USSD menu'],
                                ['ussd_afa_enabled',     'AFA Registration',   'Show AFA registration option in USSD menu'],
                                ['ussd_airtime_enabled', 'Buy Airtime',        'Show airtime on the main USSD menu AND all shop menus (auto-fulfilled via Hubtel Commission)'],
                                ['ussd_mashup_enabled',  'Buy Mashup',         'Show MTN Mashup on the main USSD menu AND all shop menus (MANUAL fulfillment only — never sent to Hubtel)'],
                            ] as [string, string, string][]).map(([key, label, hint]) => (
                                <div key={key} className="flex items-center justify-between gap-4">
                                    <div>
                                        <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{label}</p>
                                        <p className="text-[11px] text-slate-500">{hint}</p>
                                    </div>
                                    <Switch
                                        checked={settings[key] === 'true'}
                                        onCheckedChange={() => toggleSetting(key)}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                            <Settings2 className="w-4 h-4 text-slate-500" />
                            <div>
                                <p className="text-sm font-bold text-slate-900 dark:text-white">Pricing & Limits</p>
                                <p className="text-[11px] text-slate-500">AFA price, service fee, max PIN quantity, and session resume window</p>
                            </div>
                        </div>
                        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-5">
                            {([
                                ['afa_price_ussd',              'AFA Price (GH₵)',      'Price charged to USSD users for AFA registration'],
                                ['ussd_fee_percent',            'Service Fee (%)',       'Percentage added to all USSD MoMo payments (0 = no fee)'],
                                ['ussd_max_rc_quantity',        'Max RC PINs / Order',   'Maximum results checker PINs per single USSD order'],
                                ['ussd_session_resume_minutes', 'Session Resume (min)',  'Minutes before an interrupted USSD session cannot be resumed'],
                            ] as [string, string, string][]).map(([key, label, hint]) => (
                                <div key={key} className="space-y-1.5">
                                    <Label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">{label}</Label>
                                    <Input
                                        type="number"
                                        value={settings[key] ?? ''}
                                        onChange={e => setSetting(key, e.target.value)}
                                        className="h-9 text-sm"
                                    />
                                    <p className="text-[11px] text-slate-400">{hint}</p>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                            <Smartphone className="w-4 h-4 text-slate-500" />
                            <div>
                                <p className="text-sm font-bold text-slate-900 dark:text-white">USSD Menu Header</p>
                                <p className="text-[11px] text-slate-500">Shown at the top of every USSD screen — "Help Line: [number]"</p>
                            </div>
                        </div>
                        <div className="p-5 max-w-sm space-y-1.5">
                            <Label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Help Line Number</Label>
                            <Input
                                type="tel"
                                placeholder="e.g. 0551617309"
                                value={settings['ussd_helpline'] ?? ''}
                                onChange={e => setSetting('ussd_helpline', e.target.value)}
                                className="h-9 text-sm"
                            />
                            <p className="text-[11px] text-slate-400">Displayed as "Help Line: [number]" at the top of the USSD menu. Leave blank to omit the line.</p>
                        </div>
                    </div>

                    {/* ── Shop USSD Storefront ──────────────────────────────────────── */}
                    <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-5 space-y-4">
                        <div className="flex items-center gap-2 mb-1">
                            <Smartphone className="w-4 h-4 text-violet-500" />
                            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                                Shop USSD Storefront
                            </h3>
                        </div>

                        {/* Storefront mode toggle */}
                        <div className="flex items-center justify-between">
                            <div>
                                <Label className="text-sm font-medium">Storefront Mode</Label>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                    When ON, unregistered guests must enter a shop access code.
                                    Admin ussd_price is bypassed for guests.
                                </p>
                            </div>
                            <Switch
                                checked={settings['ussd_storefront_mode'] === 'true'}
                                onCheckedChange={() => toggleSetting('ussd_storefront_mode')}
                            />
                        </div>

                        {/* One-time activation fee */}
                        <div className="space-y-1">
                            <Label htmlFor="ussd_activation_fee" className="text-sm font-medium">
                                One-Time Activation Fee (GHS)
                            </Label>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                Deducted from shop owner&apos;s wallet when they activate their USSD code.
                            </p>
                            <Input
                                id="ussd_activation_fee"
                                type="number"
                                min="0"
                                step="0.01"
                                value={settings['ussd_shop_activation_fee'] ?? '50.00'}
                                onChange={e => setSetting('ussd_shop_activation_fee', e.target.value)}
                                className="w-40"
                            />
                        </div>

                        {/* Dedicated shop service fee (platform-retained, not credited to shop) */}
                        <div className="space-y-1">
                            <Label htmlFor="ussd_shop_fee_percent" className="text-sm font-medium">
                                Shop Service Fee (%)
                            </Label>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                Added to the guest&apos;s price on shop USSD orders and kept by the platform
                                (like the shop Paystack fee). It is never credited to the shop owner. 0 = no fee.
                            </p>
                            <Input
                                id="ussd_shop_fee_percent"
                                type="number"
                                min="0"
                                step="0.01"
                                value={settings['ussd_shop_fee_percent'] ?? '0'}
                                onChange={e => setSetting('ussd_shop_fee_percent', e.target.value)}
                                className="w-40"
                            />
                        </div>
                    </div>

                    <div className="flex justify-end">
                        <Button onClick={handleSaveSettings} disabled={savingSettings} className="gap-2">
                            {savingSettings ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            Save Settings
                        </Button>
                    </div>
                </div>
            )}

            {/* ── Sales (actual orders, incl. wallet-paid) ── */}
            {!loading && tab === 'sales' && (
                <div className="space-y-4">
                    {/* Summary cards */}
                    {salesSummary && (
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
                                <p className="text-[11px] font-medium text-slate-500">Orders</p>
                                <p className="text-lg font-bold text-slate-900 dark:text-white tabular-nums">{salesSummary.count}</p>
                            </div>
                            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
                                <p className="text-[11px] font-medium text-slate-500">Total</p>
                                <p className="text-lg font-bold text-slate-900 dark:text-white tabular-nums">{formatCurrency(salesSummary.totalAmount)}</p>
                            </div>
                            <div className="rounded-xl border border-violet-200 dark:border-violet-800 bg-violet-50/50 dark:bg-violet-900/10 p-3.5">
                                <p className="text-[11px] font-medium text-violet-600 dark:text-violet-400 flex items-center gap-1"><Wallet className="w-3 h-3" /> Wallet</p>
                                <p className="text-lg font-bold text-violet-700 dark:text-violet-300 tabular-nums">{formatCurrency(salesSummary.walletAmount)}</p>
                            </div>
                            <div className="rounded-xl border border-sky-200 dark:border-sky-800 bg-sky-50/50 dark:bg-sky-900/10 p-3.5">
                                <p className="text-[11px] font-medium text-sky-600 dark:text-sky-400">MoMo</p>
                                <p className="text-lg font-bold text-sky-700 dark:text-sky-300 tabular-nums">{formatCurrency(salesSummary.momoAmount)}</p>
                            </div>
                        </div>
                    )}

                    {/* Filters */}
                    <div className="flex flex-wrap items-center gap-2">
                        {(['all', 'wallet', 'momo'] as const).map(p => (
                            <button
                                key={p}
                                onClick={async () => { setSalesPayment(p); setLoading(true); await fetchSales(p, salesService); setLoading(false) }}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors capitalize
                                    ${salesPayment === p
                                        ? 'bg-violet-600 text-white'
                                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}`}
                            >
                                {p === 'all' ? 'All Payments' : p}
                            </button>
                        ))}
                        <span className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700" />
                        {([['all', 'All'], ['data', 'Data'], ['results_checker', 'RC'], ['afa', 'AFA']] as const).map(([val, label]) => (
                            <button
                                key={val}
                                onClick={async () => { setSalesService(val); setLoading(true); await fetchSales(salesPayment, val); setLoading(false) }}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors
                                    ${salesService === val
                                        ? 'bg-slate-900 dark:bg-slate-200 text-white dark:text-slate-900'
                                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}`}
                            >
                                {label}
                            </button>
                        ))}
                        <button
                            onClick={async () => { setLoading(true); await fetchSales(salesPayment, salesService); setLoading(false) }}
                            className="ml-auto p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                            <RefreshCw className="w-4 h-4 text-slate-400" />
                        </button>
                    </div>

                    {/* Desktop table */}
                    <div className="hidden md:block rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                                        {['Phone', 'Service', 'Description', 'Amount', 'Payment', 'Status', 'Shop', 'Created'].map(h => (
                                            <th key={h} className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-widest whitespace-nowrap">{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                    {sales.length === 0 && (
                                        <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-400">No sales found</td></tr>
                                    )}
                                    {sales.map(s => (
                                        <tr key={`${s.service}-${s.id}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                                            <td className="px-4 py-3 font-mono text-xs text-slate-700 dark:text-slate-300">{s.customer_phone}</td>
                                            <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">{serviceLabel(s.service)}</td>
                                            <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-300">{s.description}</td>
                                            <td className="px-4 py-3 text-xs font-medium text-slate-900 dark:text-white whitespace-nowrap">{formatCurrency(s.amount)}</td>
                                            <td className="px-4 py-3 whitespace-nowrap">{paymentBadge(s.payment_method)}</td>
                                            <td className="px-4 py-3 whitespace-nowrap">{statusBadge(s.status)}</td>
                                            <td className="px-4 py-3 text-xs text-slate-500">{s.source === 'ussd_shop' ? (s.shop_name ?? 'Shop') : '—'}</td>
                                            <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{fmt(s.created_at)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Mobile cards */}
                    <div className="md:hidden space-y-3">
                        {sales.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No sales found</p>}
                        {sales.map(s => (
                            <div key={`${s.service}-${s.id}`} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="font-mono text-sm text-slate-700 dark:text-slate-300">{s.customer_phone}</span>
                                    <div className="flex items-center gap-1.5">{paymentBadge(s.payment_method)}{statusBadge(s.status)}</div>
                                </div>
                                <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
                                    <span>{serviceLabel(s.service)}</span>
                                    <span>•</span>
                                    <span className="text-slate-700 dark:text-slate-300">{s.description}</span>
                                    <span>•</span>
                                    <span className="font-semibold text-slate-700 dark:text-slate-300">{formatCurrency(s.amount)}</span>
                                </div>
                                <p className="text-[11px] text-slate-400">
                                    {s.source === 'ussd_shop' ? `${s.shop_name ?? 'Shop'} • ` : ''}{fmt(s.created_at)}
                                </p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Payments (USSD MoMo payment attempts incl. failed/expired) ── */}
            {!loading && tab === 'orders' && (
                <div className="space-y-4">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                        MoMo payment attempts and their lifecycle (pending, fulfilled, failed, expired). Wallet-paid orders appear under the Sales tab.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                        {(['all', 'pending', 'fulfilled', 'failed', 'expired'] as const).map(s => (
                            <button
                                key={s}
                                onClick={async () => {
                                    setOrderFilter(s)
                                    setLoading(true)
                                    await fetchOrders(s)
                                    setLoading(false)
                                }}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors capitalize
                                    ${orderFilter === s
                                        ? 'bg-violet-600 text-white'
                                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}`}
                            >
                                {s === 'all' ? 'All' : s}
                            </button>
                        ))}
                        <button
                            onClick={async () => { setLoading(true); await fetchOrders(orderFilter); setLoading(false) }}
                            className="ml-auto p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                            <RefreshCw className="w-4 h-4 text-slate-400" />
                        </button>
                    </div>

                    {/* Desktop table */}
                    <div className="hidden md:block rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                                        {['Phone', 'Service', 'Amount', 'Status', 'Source', 'Created', 'Fulfilled'].map(h => (
                                            <th key={h} className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-widest whitespace-nowrap">{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                    {orders.length === 0 && (
                                        <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">No orders found</td></tr>
                                    )}
                                    {orders.map(o => (
                                        <tr key={o.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                                            <td className="px-4 py-3 font-mono text-xs text-slate-700 dark:text-slate-300">{o.mobile}</td>
                                            <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">{serviceLabel(o.service_type)}</td>
                                            <td className="px-4 py-3 text-xs font-medium text-slate-900 dark:text-white whitespace-nowrap">{formatCurrency(o.price)}</td>
                                            <td className="px-4 py-3 whitespace-nowrap">{statusBadge(o.status)}</td>
                                            <td className="px-4 py-3 text-xs text-slate-500">{o.user_id ? 'Account' : 'Guest'}</td>
                                            <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{fmt(o.created_at)}</td>
                                            <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{fmt(o.fulfilled_at)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Mobile cards */}
                    <div className="md:hidden space-y-3">
                        {orders.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No orders found</p>}
                        {orders.map(o => (
                            <div key={o.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="font-mono text-sm text-slate-700 dark:text-slate-300">{o.mobile}</span>
                                    {statusBadge(o.status)}
                                </div>
                                <div className="flex items-center gap-2 text-xs text-slate-500">
                                    <span>{serviceLabel(o.service_type)}</span>
                                    <span>•</span>
                                    <span className="font-semibold text-slate-700 dark:text-slate-300">{formatCurrency(o.price)}</span>
                                    <span>•</span>
                                    <span>{o.user_id ? 'Account' : 'Guest'}</span>
                                </div>
                                <p className="text-[11px] text-slate-400">{fmt(o.created_at)}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Sessions ── */}
            {!loading && tab === 'sessions' && (
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <p className="text-xs text-slate-500 dark:text-slate-400">Last 100 sessions — newest first</p>
                        <button
                            onClick={async () => { setLoading(true); await fetchSessions(); setLoading(false) }}
                            className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                            <RefreshCw className="w-4 h-4 text-slate-400" />
                        </button>
                    </div>

                    {/* Desktop */}
                    <div className="hidden md:block rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                                        {['Phone', 'Operator', 'Service', 'Steps', 'Status', 'Interrupted At', 'Started'].map(h => (
                                            <th key={h} className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-widest whitespace-nowrap">{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                    {sessions.length === 0 && (
                                        <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">No sessions found</td></tr>
                                    )}
                                    {sessions.map(s => (
                                        <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                            <td className="px-4 py-3 font-mono text-xs">{s.mobile}</td>
                                            <td className="px-4 py-3 text-xs text-slate-500">{s.operator ?? '—'}</td>
                                            <td className="px-4 py-3 text-xs">{s.service_used ? serviceLabel(s.service_used) : '—'}</td>
                                            <td className="px-4 py-3 text-xs text-slate-500">{s.steps}</td>
                                            <td className="px-4 py-3 whitespace-nowrap">
                                                {s.completed
                                                    ? <span className="flex items-center gap-1 text-emerald-600 text-xs"><CheckCircle2 className="w-3.5 h-3.5" />Done</span>
                                                    : s.interrupted_at
                                                        ? <span className="flex items-center gap-1 text-amber-600 text-xs"><AlertCircle className="w-3.5 h-3.5" />Interrupted</span>
                                                        : <span className="flex items-center gap-1 text-slate-400 text-xs"><Clock className="w-3.5 h-3.5" />In Progress</span>
                                                }
                                            </td>
                                            <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{fmt(s.interrupted_at)}</td>
                                            <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{fmt(s.created_at)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Mobile */}
                    <div className="md:hidden space-y-3">
                        {sessions.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No sessions found</p>}
                        {sessions.map(s => (
                            <div key={s.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="font-mono text-sm">{s.mobile}</span>
                                    {s.completed
                                        ? <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 rounded-full">Completed</span>
                                        : s.interrupted_at
                                            ? <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 rounded-full">Interrupted</span>
                                            : <span className="text-[10px] font-semibold text-slate-500 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">In Progress</span>
                                    }
                                </div>
                                <p className="text-xs text-slate-500">{s.service_used ? serviceLabel(s.service_used) : 'No service'} • {s.steps} steps • {s.operator ?? 'Unknown'}</p>
                                <p className="text-[11px] text-slate-400">{fmt(s.created_at)}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Customers ── */}
            {!loading && tab === 'customers' && (
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <p className="text-xs text-slate-500 dark:text-slate-400">Guest USSD users tracked after first successful order</p>
                        <button
                            onClick={async () => { setLoading(true); await fetchCustomers(); setLoading(false) }}
                            className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                            <RefreshCw className="w-4 h-4 text-slate-400" />
                        </button>
                    </div>

                    {/* Desktop */}
                    <div className="hidden md:block rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                                        {['Phone', 'Operator', 'Orders', 'Total Spent', 'Last Service', 'First Seen', 'Last Seen'].map(h => (
                                            <th key={h} className="px-4 py-3 text-left text-[11px] font-bold text-slate-500 uppercase tracking-widest whitespace-nowrap">{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                    {customers.length === 0 && (
                                        <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">No guest customers yet</td></tr>
                                    )}
                                    {customers.map(c => (
                                        <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                            <td className="px-4 py-3 font-mono text-xs">{c.mobile}</td>
                                            <td className="px-4 py-3 text-xs text-slate-500">{c.operator ?? '—'}</td>
                                            <td className="px-4 py-3 text-xs font-semibold text-slate-700 dark:text-slate-300">{c.total_orders}</td>
                                            <td className="px-4 py-3 text-xs font-semibold text-emerald-600">{formatCurrency(c.total_spent)}</td>
                                            <td className="px-4 py-3 text-xs text-slate-500">{c.last_service ? serviceLabel(c.last_service) : '—'}</td>
                                            <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{fmt(c.first_seen)}</td>
                                            <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{fmt(c.last_seen)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Mobile */}
                    <div className="md:hidden space-y-3">
                        {customers.length === 0 && <p className="text-center text-sm text-slate-400 py-8">No guest customers yet</p>}
                        {customers.map(c => (
                            <div key={c.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="font-mono text-sm">{c.mobile}</span>
                                    <span className="text-sm font-bold text-emerald-600">{formatCurrency(c.total_spent)}</span>
                                </div>
                                <p className="text-xs text-slate-500">{c.total_orders} orders • {c.last_service ? serviceLabel(c.last_service) : 'No service'} • {c.operator ?? 'Unknown'}</p>
                                <p className="text-[11px] text-slate-400">Last seen {fmt(c.last_seen)}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}
