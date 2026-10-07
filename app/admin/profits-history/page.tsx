'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatCurrency } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
    TrendingUp,
    TrendingDown,
    Calendar,
    AlertCircle,
    Wallet,
    Users,
    Store,
    HandCoins,
    Handshake,
    Tags,
    Radio,
    ChevronDown,
} from 'lucide-react'
import {
    AreaChart,
    Area,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    PieChart,
    Pie,
    Cell,
} from 'recharts'

type TimeRange = 'today' | 'yesterday' | 'week' | 'month' | 'all' | 'custom'
type NetworkFilter = 'all' | 'MTN' | 'Telecel' | 'AirtelTigo'

const PRODUCT_LABELS: Record<string, string> = {
    data: 'Data',
    airtime: 'Airtime & Mashup',
    utility: 'Utility Bills',
    afa: 'AFA',
    results_checker: 'Results Checker',
    subscriptions: 'Subscriptions',
    sms: 'SMS',
    ussd_activation: 'USSD Activation',
}
const PRODUCT_KEYS = Object.keys(PRODUCT_LABELS)

const NETWORK_OPTIONS: { value: NetworkFilter; label: string }[] = [
    { value: 'all', label: 'All networks' },
    { value: 'MTN', label: 'MTN' },
    { value: 'Telecel', label: 'Telecel' },
    { value: 'AirtelTigo', label: 'AirtelTigo' },
]

interface ProductStat {
    revenue: number
    cost: number
    profit: number
    orders: number
    excluded: number
    recruiter_payout: number
    partner_payout: number
}

interface AnalyticsResponse {
    summary: {
        total_revenue: number
        total_cost: number
        total_profit: number
        profit_margin: number
        total_orders: number
        excluded_orders: number
        growth_percent: number
        recruiter_payouts: number
        partner_commission_payouts: number
    }
    by_product: Record<string, ProductStat>
    charts_data: { daily: { date: string; revenue: number; cost: number; profit: number }[] }
    shop_owner_stats: {
        owner_id: string
        owner_name: string
        shop_name: string
        total_sales_count: number
        platform_profit: number
        owner_profit: number
    }[]
    wallet_stats: {
        total_user_balance: number
        user_count: number
        total_shop_owner_balance: number
        shop_owner_count: number
        total_commission_balance: number
        commission_count: number
    }
}

export default function AdminProfitsPage() {
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [range, setRange] = useState<TimeRange>('today')
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [selectedProducts, setSelectedProducts] = useState<string[]>(PRODUCT_KEYS)
    const [network, setNetwork] = useState<NetworkFilter>('all')

    const [data, setData] = useState<AnalyticsResponse | null>(null)
    const abortRef = useRef<AbortController | null>(null)

    useEffect(() => {
        fetchAnalytics()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [range, customStart, customEnd, selectedProducts, network])

    const fetchAnalytics = async () => {
        // I4: cancel any in-flight fetch before starting a new one — without this,
        // a slower earlier response (e.g. "All time") can land after a faster
        // later one (e.g. "Today") and silently overwrite it with stale numbers.
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        setLoading(true)
        setError(null)
        try {
            const now = new Date()
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
            const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)

            let startDate: Date
            let endDate: Date

            if (range === 'today') {
                startDate = todayStart
                endDate = todayEnd
            } else if (range === 'yesterday') {
                startDate = new Date(todayStart)
                startDate.setDate(startDate.getDate() - 1)
                endDate = new Date(todayEnd)
                endDate.setDate(endDate.getDate() - 1)
            } else if (range === 'week') {
                const dayOfWeek = now.getDay() || 7
                startDate = new Date(todayStart)
                startDate.setDate(startDate.getDate() - dayOfWeek + 1)
                endDate = todayEnd
            } else if (range === 'month') {
                startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
                endDate = todayEnd
            } else if (range === 'all') {
                startDate = new Date(2023, 0, 1)
                endDate = todayEnd
            } else {
                startDate = customStart ? new Date(customStart) : todayStart
                endDate = customEnd ? new Date(customEnd) : todayEnd
                if (endDate < startDate) endDate = new Date(startDate)
                endDate.setHours(23, 59, 59, 999)
            }

            const params = new URLSearchParams({
                startDate: startDate.toISOString(),
                endDate: endDate.toISOString(),
            })
            if (selectedProducts.length > 0 && selectedProducts.length < PRODUCT_KEYS.length) {
                params.set('productTypes', selectedProducts.join(','))
            }
            if (network !== 'all') {
                params.set('network', network)
            }

            const res = await fetch(`/api/admin/profit-analytics-v2?${params.toString()}`, { signal: controller.signal })
            const json = await res.json()

            if (!res.ok) throw new Error(json.error || 'Failed to load analytics')
            setData(json)
        } catch (err: any) {
            if (err?.name === 'AbortError') return
            setError(err.message)
        } finally {
            if (abortRef.current === controller) setLoading(false)
        }
    }

    const toggleProduct = (key: string) => {
        setSelectedProducts((prev) => {
            const next = prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]
            return next.length === 0 ? PRODUCT_KEYS : next
        })
    }

    const productFilterLabel = useMemo(() => {
        if (selectedProducts.length === PRODUCT_KEYS.length) return 'All product types'
        if (selectedProducts.length === 1) return PRODUCT_LABELS[selectedProducts[0]]
        return `${selectedProducts.length} product types`
    }, [selectedProducts])

    const revenueCostSplit = useMemo(() => {
        if (!data) return []
        const cost = Math.max(data.summary.total_cost, 0)
        const profit = Math.max(data.summary.total_profit, 0)
        if (cost === 0 && profit === 0) return []
        return [
            { name: 'Cost', value: cost },
            { name: 'Profit', value: profit },
        ]
    }, [data])

    if (loading && !data) {
        return (
            <div className="p-4 md:p-8 space-y-6 max-w-[1400px] mx-auto">
                <Skeleton className="h-10 w-64" />
                <Skeleton className="h-[140px] w-full rounded-2xl" />
                <Skeleton className="h-[380px] w-full rounded-2xl" />
            </div>
        )
    }

    if (error) {
        return (
            <div className="p-4 md:p-8">
                <Card className="border-rose-300 dark:border-rose-900 max-w-lg mx-auto mt-20">
                    <CardContent className="pt-6 flex flex-col items-center text-center space-y-4">
                        <AlertCircle className="w-12 h-12 text-rose-500" />
                        <h2 className="text-xl font-semibold">Couldn&rsquo;t load the ledger</h2>
                        <p className="text-muted-foreground">{error}</p>
                        <Button onClick={fetchAnalytics}>Try again</Button>
                    </CardContent>
                </Card>
            </div>
        )
    }

    const summary = data?.summary
    const growth = summary?.growth_percent ?? 0
    const SPLIT_COLORS = ['#e11d48', '#059669']

    return (
        <div className="min-h-screen bg-background pb-24">
            <div className="max-w-[1400px] mx-auto p-4 md:p-8 space-y-8">

                {/* ── Masthead ─────────────────────────────────────────── */}
                <div className="flex flex-col gap-1 border-b border-border pb-6">
                    <h1 className="text-[28px] md:text-3xl font-semibold tracking-tight text-foreground">
                        Profit ledger
                    </h1>
                    <p className="text-muted-foreground text-sm md:text-base">
                        What the platform earned, what it paid out, and what it still owes — for the period below.
                    </p>
                </div>

                {/* ── Filter bar ───────────────────────────────────────── */}
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                        {(['today', 'yesterday', 'week', 'month', 'all'] as TimeRange[]).map((r) => (
                            <button
                                key={r}
                                onClick={() => setRange(r)}
                                className={`px-3.5 py-1.5 rounded-full text-sm font-medium border transition-colors ${range === r
                                        ? 'bg-foreground text-background border-foreground'
                                        : 'bg-card text-muted-foreground border-border hover:text-foreground hover:border-foreground/30'
                                    }`}
                            >
                                {r === 'all' ? 'All time' : r.charAt(0).toUpperCase() + r.slice(1)}
                            </button>
                        ))}
                        <button
                            onClick={() => setRange('custom')}
                            className={`px-3.5 py-1.5 rounded-full text-sm font-medium border flex items-center gap-1.5 transition-colors ${range === 'custom'
                                    ? 'bg-foreground text-background border-foreground'
                                    : 'bg-card text-muted-foreground border-border hover:text-foreground hover:border-foreground/30'
                                }`}
                        >
                            <Calendar className="w-3.5 h-3.5" /> Custom
                        </button>

                        <div className="h-6 w-px bg-border mx-1 hidden sm:block" />

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button className="px-3.5 py-1.5 rounded-full text-sm font-medium border border-border bg-card text-muted-foreground hover:text-foreground hover:border-foreground/30 flex items-center gap-1.5">
                                    <Tags className="w-3.5 h-3.5" /> {productFilterLabel}
                                    <ChevronDown className="w-3.5 h-3.5 opacity-60" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-56">
                                <DropdownMenuLabel>Product types</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {PRODUCT_KEYS.map((key) => (
                                    <DropdownMenuCheckboxItem
                                        key={key}
                                        checked={selectedProducts.includes(key)}
                                        onSelect={(e) => e.preventDefault()}
                                        onCheckedChange={() => toggleProduct(key)}
                                    >
                                        {PRODUCT_LABELS[key]}
                                    </DropdownMenuCheckboxItem>
                                ))}
                                <DropdownMenuSeparator />
                                <button
                                    onClick={() => setSelectedProducts(PRODUCT_KEYS)}
                                    className="w-full text-left px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                                >
                                    Select all
                                </button>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <Select value={network} onValueChange={(v) => setNetwork(v as NetworkFilter)}>
                            <SelectTrigger className="w-auto h-auto rounded-full border-border bg-card text-muted-foreground px-3.5 py-1.5 text-sm font-medium gap-1.5 [&>svg]:opacity-60">
                                <Radio className="w-3.5 h-3.5" />
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {NETWORK_OPTIONS.map((opt) => (
                                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {range === 'custom' && (
                        <div className="flex flex-wrap items-end gap-4 bg-card border border-dashed border-border rounded-xl p-4">
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">Start date</label>
                                <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="w-[160px]" />
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">End date</label>
                                <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="w-[160px]" />
                            </div>
                        </div>
                    )}

                    {network !== 'all' && (
                        <p className="text-xs text-muted-foreground">
                            Network filter narrows data and airtime figures only — every other product type is network-agnostic and stays unfiltered.
                        </p>
                    )}
                </div>

                {/* ── Transparency notice ──────────────────────────────── */}
                {(summary?.excluded_orders ?? 0) > 0 && (
                    <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-amber-900 dark:text-amber-300 p-4 rounded-xl flex items-start gap-3">
                        <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-amber-500" />
                        <div>
                            <p className="font-semibold text-sm">Some transactions were left out</p>
                            <p className="text-sm">
                                {summary!.excluded_orders} {summary!.excluded_orders === 1 ? 'transaction was' : 'transactions were'} excluded from this period&rsquo;s figures because accurate historical cost data wasn&rsquo;t available at the time of purchase. The breakdown below shows exactly which category each one belongs to.
                            </p>
                        </div>
                    </div>
                )}

                {/* ── Statement band ───────────────────────────────────── */}
                <Card className="overflow-hidden">
                    <div className="grid grid-cols-2 md:grid-cols-4">
                        <div className="p-6 border-r border-b md:border-b-0 border-border">
                            <p className="text-sm text-muted-foreground mb-1.5">Total revenue</p>
                            <p className="text-2xl md:text-[28px] font-semibold tabular-nums text-foreground">
                                {formatCurrency(summary?.total_revenue || 0)}
                            </p>
                        </div>
                        <div className="p-6 border-b md:border-b-0 md:border-r border-border">
                            <p className="text-sm text-muted-foreground mb-1.5">Supplier cost</p>
                            <p className="text-2xl md:text-[28px] font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                                {formatCurrency(summary?.total_cost || 0)}
                            </p>
                        </div>
                        <div className="p-6 border-r md:border-r border-border">
                            <div className="flex items-center gap-2 mb-1.5">
                                <p className="text-sm text-muted-foreground">Net platform profit</p>
                                <Badge
                                    variant="outline"
                                    className={`h-5 px-1.5 gap-0.5 border-0 ${growth >= 0
                                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                                            : 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400'
                                        }`}
                                >
                                    {growth >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                                    {growth >= 0 ? '+' : ''}{growth.toFixed(1)}%
                                </Badge>
                            </div>
                            <p className="text-2xl md:text-[28px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                                {formatCurrency(summary?.total_profit || 0)}
                            </p>
                        </div>
                        <div className="p-6">
                            <p className="text-sm text-muted-foreground mb-1.5">Completed orders</p>
                            <p className="text-2xl md:text-[28px] font-semibold tabular-nums text-foreground">
                                {(summary?.total_orders || 0).toLocaleString()}
                            </p>
                        </div>
                    </div>
                </Card>

                {/* ── Payouts (kept separate from net profit) ──────────── */}
                <div>
                    <p className="text-sm text-muted-foreground mb-3">
                        Paid out to others — already excluded from net profit above, shown here for full transparency
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Card className="border-amber-200 dark:border-amber-500/20 bg-amber-50/60 dark:bg-amber-500/5">
                            <CardContent className="p-5 flex items-start gap-4">
                                <div className="bg-amber-100 dark:bg-amber-500/15 p-2.5 rounded-lg shrink-0">
                                    <HandCoins className="w-5 h-5 text-amber-700 dark:text-amber-400" />
                                </div>
                                <div>
                                    <p className="font-medium text-sm text-foreground">Recruiter payouts</p>
                                    <p className="text-xs text-muted-foreground mb-1.5">Margin owed to sub-agent recruiters on their referred orders</p>
                                    <p className="text-xl font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                                        {formatCurrency(summary?.recruiter_payouts || 0)}
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="border-amber-200 dark:border-amber-500/20 bg-amber-50/60 dark:bg-amber-500/5">
                            <CardContent className="p-5 flex items-start gap-4">
                                <div className="bg-amber-100 dark:bg-amber-500/15 p-2.5 rounded-lg shrink-0">
                                    <Handshake className="w-5 h-5 text-amber-700 dark:text-amber-400" />
                                </div>
                                <div>
                                    <p className="font-medium text-sm text-foreground">Partner commission payouts</p>
                                    <p className="text-xs text-muted-foreground mb-1.5">Share of airtime/utility commission owed to API partners</p>
                                    <p className="text-xl font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                                        {formatCurrency(summary?.partner_commission_payouts || 0)}
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </div>

                {/* ── Trend chart + revenue split ──────────────────────── */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <Card className="lg:col-span-2">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-base font-medium text-foreground">Daily trend</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="h-[300px] w-full">
                                <ResponsiveContainer width="100%" height="100%">
                                    <AreaChart data={data?.charts_data?.daily || []} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                                        <defs>
                                            <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#059669" stopOpacity={0.28} />
                                                <stop offset="95%" stopColor="#059669" stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <XAxis
                                            dataKey="date"
                                            axisLine={false}
                                            tickLine={false}
                                            tick={{ fontSize: 12, fill: '#888' }}
                                            dy={10}
                                            tickFormatter={(val) => {
                                                const d = new Date(val)
                                                return `${d.getDate()}/${d.getMonth() + 1}`
                                            }}
                                        />
                                        <YAxis
                                            axisLine={false}
                                            tickLine={false}
                                            tick={{ fontSize: 12, fill: '#888' }}
                                            dx={-10}
                                            tickFormatter={(val) => `₵${val}`}
                                        />
                                        <CartesianGrid vertical={false} stroke="currentColor" className="text-muted/20" />
                                        <Tooltip
                                            formatter={(value: any, name: any) => [`GHS ${Number(value).toFixed(2)}`, name]}
                                            labelFormatter={(val) => new Date(val).toDateString()}
                                            contentStyle={{ borderRadius: '10px', border: '1px solid hsl(var(--border))', backgroundColor: 'hsl(var(--card))', color: 'hsl(var(--foreground))', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                                            itemStyle={{ color: 'hsl(var(--foreground))' }}
                                        />
                                        <Area type="monotone" name="Profit" dataKey="profit" stroke="#059669" fillOpacity={1} fill="url(#colorProfit)" strokeWidth={2} />
                                        <Line type="monotone" name="Revenue" dataKey="revenue" stroke="#94a3b8" strokeDasharray="4 4" strokeWidth={1.5} dot={false} />
                                        <Line type="monotone" name="Cost" dataKey="cost" stroke="#e11d48" strokeDasharray="4 4" strokeWidth={1.5} dot={false} />
                                    </AreaChart>
                                </ResponsiveContainer>
                            </div>
                            <div className="flex justify-center gap-5 mt-3 text-xs text-muted-foreground">
                                <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-emerald-600" /> Profit</div>
                                <div className="flex items-center gap-1.5"><div className="w-2.5 h-0.5 bg-slate-400" /> Revenue</div>
                                <div className="flex items-center gap-1.5"><div className="w-2.5 h-0.5 bg-rose-500" /> Cost</div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-base font-medium text-foreground">Where revenue goes</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="h-[180px] w-full relative">
                                {revenueCostSplit.length > 0 ? (
                                    <>
                                        <ResponsiveContainer width="100%" height="100%">
                                            <PieChart>
                                                <Pie
                                                    data={revenueCostSplit}
                                                    cx="50%"
                                                    cy="50%"
                                                    innerRadius={55}
                                                    outerRadius={75}
                                                    paddingAngle={4}
                                                    dataKey="value"
                                                >
                                                    {revenueCostSplit.map((_, index) => (
                                                        <Cell key={`cell-${index}`} fill={SPLIT_COLORS[index]} />
                                                    ))}
                                                </Pie>
                                                <Tooltip formatter={(value: any) => `GHS ${Number(value).toFixed(2)}`} />
                                            </PieChart>
                                        </ResponsiveContainer>
                                        <div className="absolute inset-0 flex items-center justify-center flex-col pointer-events-none">
                                            <span className="text-xs text-muted-foreground">Margin</span>
                                            <span className="text-2xl font-semibold tabular-nums">{summary?.profit_margin ?? 0}%</span>
                                        </div>
                                    </>
                                ) : (
                                    <div className="h-full flex items-center justify-center text-sm text-muted-foreground">No revenue in this period</div>
                                )}
                            </div>
                            <div className="flex justify-center gap-5 mt-2 text-xs text-muted-foreground">
                                <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-rose-600" /> Cost</div>
                                <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-emerald-600" /> Profit</div>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* ── Per-product breakdown ────────────────────────────── */}
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base font-medium text-foreground">By product type</CardTitle>
                    </CardHeader>
                    <CardContent className="pt-2">
                        <div className="overflow-x-auto -mx-2">
                            <table className="w-full text-sm min-w-[560px]">
                                <thead>
                                    <tr className="text-left text-muted-foreground border-b border-border">
                                        <th className="py-2.5 px-2 font-medium">Product</th>
                                        <th className="py-2.5 px-2 font-medium text-right">Revenue</th>
                                        <th className="py-2.5 px-2 font-medium text-right">Cost</th>
                                        <th className="py-2.5 px-2 font-medium text-right">Profit</th>
                                        <th className="py-2.5 px-2 font-medium text-right">Orders</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {PRODUCT_KEYS.map((key) => {
                                        const row = data?.by_product?.[key]
                                        if (!row) return null
                                        return (
                                            <tr key={key} className="border-b border-border last:border-0">
                                                <td className="py-3 px-2">
                                                    <p className="font-medium text-foreground">{PRODUCT_LABELS[key]}</p>
                                                    {row.excluded > 0 && (
                                                        <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5 flex items-center gap-1">
                                                            <AlertCircle className="w-3 h-3" />
                                                            {row.excluded} excluded — cost data unavailable
                                                        </p>
                                                    )}
                                                </td>
                                                <td className="py-3 px-2 text-right tabular-nums">{formatCurrency(row.revenue)}</td>
                                                <td className="py-3 px-2 text-right tabular-nums text-rose-600 dark:text-rose-400">{formatCurrency(row.cost)}</td>
                                                <td className="py-3 px-2 text-right tabular-nums font-medium text-emerald-600 dark:text-emerald-400">{formatCurrency(row.profit)}</td>
                                                <td className="py-3 px-2 text-right tabular-nums text-muted-foreground">{row.orders.toLocaleString()}</td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </CardContent>
                </Card>

                {/* ── Wallet liability + leaderboard ───────────────────── */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-base font-medium text-foreground flex items-center gap-2">
                                <Wallet className="w-4 h-4 text-muted-foreground" /> Money the platform owes
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <div className="p-4 rounded-xl border border-border flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="bg-muted p-2 rounded-lg"><Users className="w-5 h-5 text-muted-foreground" /></div>
                                    <div>
                                        <p className="font-medium text-sm text-foreground">Main platform users</p>
                                        <p className="text-xs text-muted-foreground">{data?.wallet_stats?.user_count || 0} active wallets</p>
                                    </div>
                                </div>
                                <p className="text-lg font-semibold tabular-nums text-foreground">{formatCurrency(data?.wallet_stats?.total_user_balance || 0)}</p>
                            </div>

                            <div className="p-4 rounded-xl border border-border flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="bg-muted p-2 rounded-lg"><Store className="w-5 h-5 text-muted-foreground" /></div>
                                    <div>
                                        <p className="font-medium text-sm text-foreground">Shop owners</p>
                                        <p className="text-xs text-muted-foreground">{data?.wallet_stats?.shop_owner_count || 0} active wallets</p>
                                    </div>
                                </div>
                                <p className="text-lg font-semibold tabular-nums text-foreground">{formatCurrency(data?.wallet_stats?.total_shop_owner_balance || 0)}</p>
                            </div>

                            <div className="p-4 rounded-xl border border-border flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="bg-muted p-2 rounded-lg"><HandCoins className="w-5 h-5 text-muted-foreground" /></div>
                                    <div>
                                        <p className="font-medium text-sm text-foreground">Commission balances</p>
                                        <p className="text-xs text-muted-foreground">{data?.wallet_stats?.commission_count || 0} recruiter/partner balances</p>
                                    </div>
                                </div>
                                <p className="text-lg font-semibold tabular-nums text-foreground">{formatCurrency(data?.wallet_stats?.total_commission_balance || 0)}</p>
                            </div>

                            <p className="text-xs text-muted-foreground text-center pt-1">
                                These are balances the platform holds for other people — entirely separate from the profit figures above.
                            </p>
                        </CardContent>
                    </Card>

                    <Card className="flex flex-col">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-base font-medium text-foreground flex items-center gap-2">
                                <Store className="w-4 h-4 text-muted-foreground" /> All-Time Leaderboard (legacy calculation)
                            </CardTitle>
                            <p className="text-xs text-muted-foreground">
                                Always all-time — ignores the filters above, and does not reflect the recruiter-margin correction applied to the figures above. Kept for reference only.
                            </p>
                        </CardHeader>
                        <CardContent className="flex-1 overflow-auto max-h-[320px] pt-0">
                            {data?.shop_owner_stats && data.shop_owner_stats.length > 0 ? (
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-border text-left text-muted-foreground">
                                            <th className="py-2.5 font-medium">Owner / shop</th>
                                            <th className="py-2.5 font-medium text-right">Your cut</th>
                                            <th className="py-2.5 font-medium text-right">Their cut</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.shop_owner_stats.map((shop) => (
                                            <tr key={shop.owner_id} className="border-b border-border last:border-0">
                                                <td className="py-3">
                                                    <p className="font-medium text-foreground">{shop.owner_name}</p>
                                                    <p className="text-xs text-muted-foreground">{shop.shop_name} • {shop.total_sales_count} sales</p>
                                                </td>
                                                <td className="py-3 text-right font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                                                    +{formatCurrency(shop.platform_profit)}
                                                </td>
                                                <td className="py-3 text-right tabular-nums text-muted-foreground">
                                                    {formatCurrency(shop.owner_profit)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            ) : (
                                <div className="h-full flex items-center justify-center flex-col text-muted-foreground py-10">
                                    <Store className="w-10 h-10 mb-3 opacity-20" />
                                    <p>No shop analytics available yet.</p>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>

            </div>
        </div>
    )
}
