'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
    Store, Wallet, TrendingUp, ShoppingCart, ArrowRight,
    Settings, Tag, Banknote, Clock, CheckCircle2, XCircle,
    AlertCircle, ExternalLink, Copy, Check, RefreshCcw, Crown,
    MessageCircle, Loader2, Gem, Users, FileText, MessageSquare, Smartphone, Receipt
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Switch } from '@/components/ui/switch'
import { ConfirmationStatusBanner } from '@/components/shop/confirmation-status-banner'
import { PromoCarousel } from '@/components/promo-carousel/PromoCarousel'
import { buildShopDashboardSlides } from '@/lib/promo-carousel/shop-dashboard-slides'

interface ShopProfile {
    id: string
    shop_name: string
    shop_slug: string
    description: string
    approval_status: 'pending' | 'approved' | 'rejected' | 'suspended'
    approval_note: string | null
    is_active: boolean
    owner_phone: string
    whatsapp_number: string | null
    logo_url: string | null
    brand_color: string
    pricing_status: 'not_submitted' | 'pending_review' | 'approved' | 'rejected'
}

interface ShopWallet {
    balance: number
    total_earned: number
    total_withdrawn: number
}

interface ShopStats {
    total_orders: number
    completed_orders: number
    pending_orders: number
    processing_orders: number
    failed_orders: number
    total_revenue: number
    total_profit: number
}

interface RecentOrder {
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
    is_rc?: boolean
    source?: string  // 'ussd' | 'ussd_shop' = sold via USSD
}

const statusConfig = {
    pending: { label: 'Pending Approval', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400', icon: Clock },
    approved: { label: 'Active', color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400', icon: CheckCircle2 },
    rejected: { label: 'Rejected', color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400', icon: XCircle },
    suspended: { label: 'Suspended', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400', icon: AlertCircle },
}

export default function ShopDashboardPage() {
    const { dbUser, isAdmin, isSubAdmin } = useAuth()
    const router = useRouter()
    const [shop, setShop] = useState<ShopProfile | null>(null)
    const [wallet, setWallet] = useState<ShopWallet | null>(null)
    const [stats, setStats] = useState<ShopStats | null>(null)
    const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([])
    const [filter, setFilter] = useState<'all' | 'today' | '7d' | '30d'>('all')
    const [loading, setLoading] = useState(true)
    const [isFiltering, setIsFiltering] = useState(false)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [copied, setCopied] = useState(false)

    // USSD state
    const [ussdCode, setUssdCode]           = useState<string | null>(null)
    const [ussdActive, setUssdActive]       = useState(false)
    const [activationFee, setActivationFee] = useState<number>(50)

    // Customer order-confirmation SMS toggle (per shop, defaults enabled)
    const [smsConfirmEnabled, setSmsConfirmEnabled] = useState(true)
    const [savingSmsToggle, setSavingSmsToggle]     = useState(false)

    // Utility bills storefront toggle (per shop, defaults OFF — opt-in)
    const [utilitiesEnabled, setUtilitiesEnabled]   = useState(false)
    const [savingUtilityToggle, setSavingUtilityToggle] = useState(false)

    // Utility-bill completion SMS toggle — separate from the general customer-order SMS
    // toggle above (defaults enabled, same convention).
    const [utilitySmsEnabled, setUtilitySmsEnabled] = useState(true)
    const [savingUtilitySmsToggle, setSavingUtilitySmsToggle] = useState(false)

    // Announcement state
    const [shopAnnouncement, setShopAnnouncement] = useState<{ id: string; message: string; is_active: boolean } | null>(null)
    const [annMsg, setAnnMsg] = useState('')
    const [isSavingAnn, setIsSavingAnn] = useState(false)
    const [adminAnnActive, setAdminAnnActive] = useState(false)

    const fetchShopData = async () => {
        if (!shop) {
            setLoading(true)
        } else {
            setIsFiltering(true)
        }

        // --- Stage 1: Fetch the shop profile in isolation ---
        let shopData: any = shop

        if (!shopData) {
            try {
                const { data, error } = await ((supabase as any)
                    .from('shop_profiles')
                    .select('*')
                    .eq('owner_id', dbUser!.id)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle())

                if (error) throw error
                shopData = data
            } catch (profileErr) {
                console.error('[ShopPage] Failed to fetch shop profile:', profileErr)
                setLoading(false)
                setIsFiltering(false)
                return
            }

            if (!shopData) {
                setLoading(false)
                setIsFiltering(false)
                return
            }

            setShop(shopData)
            setUssdCode(shopData?.ussd_code ?? null)
            setUssdActive(shopData?.ussd_active ?? false)
            setSmsConfirmEnabled(shopData?.sms_order_confirmation_enabled !== false)
            setUtilitiesEnabled(shopData?.utilities_enabled === true)
            setUtilitySmsEnabled(shopData?.utility_sms_confirmation_enabled !== false)

            // Fetch USSD activation fee
            try {
                const feeRes = await fetch('/api/shop/ussd-activate')
                if (feeRes.ok) {
                    const { fee } = await feeRes.json()
                    setActivationFee(fee)
                }
            } catch (_) {
                // non-critical — keep default fee
            }
        }

        // --- Stage 2: Fetch secondary data (wallet, orders) with allSettled ---
        // Failures here never hide the shop dashboard.
        // shop_orders_effective resolves each order's real current status through its
        // retry chain (effective_status) — plain shop_orders.status goes stale on retry
        // since the sync trigger only fires for the original mirror order, not retries.
        let query = (supabase as any)
            .from('shop_orders_effective')
            .select('*')
            .eq('shop_id', shopData.id)

        let rcQuery = (supabase as any)
            .from('results_checker_orders')
            .select('*')
            .eq('shop_id', shopData.id)
            .neq('payment_status', 'pending_payment')

        const now = new Date()
        if (filter === 'today') {
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
            query = query.gte('created_at', startOfDay)
            rcQuery = rcQuery.gte('created_at', startOfDay)
        } else if (filter === '7d') {
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
            query = query.gte('created_at', sevenDaysAgo)
            rcQuery = rcQuery.gte('created_at', sevenDaysAgo)
        } else if (filter === '30d') {
            const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
            query = query.gte('created_at', thirtyDaysAgo)
            rcQuery = rcQuery.gte('created_at', thirtyDaysAgo)
        }

        const [walletSettled, ordersSettled, rcOrdersSettled] = await Promise.allSettled([
            (supabase as any).from('shop_wallets').select('*').eq('owner_id', dbUser!.id).maybeSingle(),
            query.order('created_at', { ascending: false }),
            rcQuery.order('created_at', { ascending: false }),
        ])

        if (walletSettled.status === 'fulfilled' && walletSettled.value?.data) {
            setWallet(walletSettled.value.data)
        }

        const rawDataOrders = (ordersSettled.status === 'fulfilled' ? ordersSettled.value?.data : null) || []
        const rawRcOrders = (rcOrdersSettled.status === 'fulfilled' ? rcOrdersSettled.value?.data : null) || []

        // Use effective_status (resolves the retry chain) for stats/display, falling
        // back to the raw status for rows with no retry history.
        const dataOrders = rawDataOrders.map((o: any) => ({ ...o, status: o.effective_status || o.status }))

        const mappedRcOrders = rawRcOrders.map((o: any) => ({
            id: o.id,
            guest_phone: o.customer_phone,
            type_name: o.type_name,
            quantity: o.quantity,
            selling_price: o.unit_price * o.quantity,
            profit: o.shop_markup * o.quantity,
            status: o.status,
            created_at: o.created_at,
            is_rc: true,
            source: o.source
        }))

        const allOrders = [...dataOrders, ...mappedRcOrders].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        setRecentOrders(allOrders)

        // Calculate stats
        const pending = allOrders.filter((o: any) => o.status === 'pending')
        const completed = allOrders.filter((o: any) => o.status === 'completed')
        const processing = allOrders.filter((o: any) => o.status === 'processing')
        const failed = allOrders.filter((o: any) => o.status === 'failed')

        const earningStatuses = ['pending', 'processing', 'completed']
        const earningsOrders = allOrders.filter((o: any) => earningStatuses.includes(o.status))

        setStats({
            total_orders: allOrders.length,
            completed_orders: completed.length,
            pending_orders: pending.length,
            processing_orders: processing.length,
            failed_orders: failed.length,
            total_revenue: earningsOrders.reduce((sum: number, o: any) => sum + (o.selling_price || 0), 0),
            total_profit: earningsOrders.reduce((sum: number, o: any) => sum + (o.profit || 0), 0),
        })

        setLoading(false)
        setIsFiltering(false)
    }

    const fetchShopAnnouncement = async () => {
        try {
            const res = await fetch('/api/shop/announcements')
            const data = await res.json()
            if (data.announcement) {
                setShopAnnouncement(data.announcement)
                setAnnMsg(data.announcement.message)
            }

            // Also check if admin has one active to show "Locked" state
            const { data: adminAnn } = await supabase
                .from('system_announcements')
                .select('id')
                .eq('is_active', true)
                .in('visible_on', ['storefronts', 'both'])
                .limit(1)
                .maybeSingle()

            setAdminAnnActive(!!adminAnn)
        } catch (err) {
            console.error('Error fetching announcement:', err)
        }
    }

    const handleRefresh = async () => {
        setIsRefreshing(true)
        await fetchShopData()
        setIsRefreshing(false)
        toast.success('Dashboard updated')
    }

    useEffect(() => {
        // Shop feature is available to all authenticated users
        if (dbUser) {
            fetchShopData()
            fetchShopAnnouncement()
        }
    }, [dbUser, isAdmin, isSubAdmin, filter])

    const shopUrl = shop ? `https://shop.kingflexygh.com/${shop.shop_slug}` : ''

    const copyLink = async () => {
        await navigator.clipboard.writeText(shopUrl)
        setCopied(true)
        toast.success('Shop link copied!')
        setTimeout(() => setCopied(false), 2000)
    }

    const handleSaveAnnouncement = async () => {
        if (!annMsg.trim()) {
            toast.error('Message cannot be empty')
            return
        }
        setIsSavingAnn(true)
        try {
            const res = await fetch('/api/shop/announcements', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: annMsg })
            })
            const data = await res.json()
            if (res.ok) {
                setShopAnnouncement(data.announcement)
                toast.success('Storefront announcement updated!')
            } else {
                toast.error(data.message || 'Failed to update announcement')
            }
        } catch (err) {
            toast.error('Failed to update announcement')
        } finally {
            setIsSavingAnn(false)
        }
    }

    // Toggle whether customers get an SMS confirmation on each order. Optimistic
    // update; revert on failure so the switch never lies about the saved state.
    const handleToggleSmsConfirm = async (next: boolean) => {
        const prev = smsConfirmEnabled
        setSmsConfirmEnabled(next)
        setSavingSmsToggle(true)
        try {
            const res = await fetch('/api/shop/sms-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            })
            const data = await res.json()
            if (res.ok && data.success) {
                toast.success(next ? 'Customers will get order SMS' : 'Order SMS to customers turned off')
            } else {
                setSmsConfirmEnabled(prev)
                toast.error(data.error || 'Could not update SMS setting')
            }
        } catch {
            setSmsConfirmEnabled(prev)
            toast.error('Could not update SMS setting')
        } finally {
            setSavingSmsToggle(false)
        }
    }

    // Toggle whether a completion SMS is sent (from THIS shop's own sender, deducted from
    // its own SMS credits) when one of its utility-bill orders finishes. Separate from
    // handleToggleSmsConfirm — a shop owner may want one on and the other off. Optimistic
    // update; revert on failure — same shape as every other toggle on this page.
    const handleToggleUtilitySms = async (next: boolean) => {
        const prev = utilitySmsEnabled
        setUtilitySmsEnabled(next)
        setSavingUtilitySmsToggle(true)
        try {
            const res = await fetch('/api/shop/utility-sms-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            })
            const data = await res.json()
            if (res.ok && data.success) {
                toast.success(next
                    ? 'Utility bill completion SMS turned on'
                    : 'Utility bill completion SMS turned off')
            } else {
                setUtilitySmsEnabled(prev)
                toast.error(data.error || 'Could not update utility SMS setting')
            }
        } catch {
            setUtilitySmsEnabled(prev)
            toast.error('Could not update utility SMS setting')
        } finally {
            setSavingUtilitySmsToggle(false)
        }
    }

    // Toggle whether utility bill payments (ECG/Ghana Water/DSTV/GOtv/StarTimes) appear on
    // this shop's storefront. Optimistic update; revert on failure so the switch never lies
    // about the saved state — same shape as handleToggleSmsConfirm.
    const handleToggleUtilities = async (next: boolean) => {
        const prev = utilitiesEnabled
        setUtilitiesEnabled(next)
        setSavingUtilityToggle(true)
        try {
            const res = await fetch('/api/shop/utility-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            })
            const data = await res.json()
            if (res.ok && data.success) {
                toast.success(next
                    ? "Utility bills are now on your storefront — you'll earn commission on every sale, added to your shop profit."
                    : 'Utility bills removed from your storefront')
            } else {
                setUtilitiesEnabled(prev)
                if (res.status === 403 && data.error === 'upgrade_required') {
                    toast.error('Upgrade to Agent or Dealer to sell utility bills on your storefront.')
                } else {
                    toast.error(data.error || 'Could not update utility bills setting')
                }
            }
        } catch {
            setUtilitiesEnabled(prev)
            toast.error('Could not update utility bills setting')
        } finally {
            setSavingUtilityToggle(false)
        }
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    // No shop yet
    if (!shop) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6 px-4">
                <div className="w-20 h-20 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                    <Store className="w-10 h-10 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                    <h2 className="text-2xl font-bold mb-2">Set Up Your Shop</h2>
                    <p className="text-muted-foreground max-w-sm">
                        Create your reseller storefront and start earning profit on every data bundle sale.
                    </p>
                </div>
                <Link href="/dashboard/shop/setup">
                    <Button size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2">
                        <Store className="w-5 h-5" />
                        Create My Shop
                    </Button>
                </Link>
            </div>
        )
    }

    const daysLeft = dbUser?.agent_expires_at
        ? Math.ceil((new Date(dbUser.agent_expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : 0

    const isPermanentAgent = (dbUser?.role === 'agent' && dbUser?.agent_expires_at === null) || dbUser?.role === 'dealer'

    const cfg = statusConfig[shop.approval_status]
    const StatusIcon = cfg?.icon || Clock
    const isPending = shop.approval_status === 'pending'
    const shopIsLive = shop.approval_status === 'approved' && shop.pricing_status === 'approved'

    const ussdShortcode = process.env.NEXT_PUBLIC_USSD_SHORTCODE ?? '*713*9939#'

    // Quick links — every shop page reachable from the dashboard hub.
    const quickLinks: { href: string; label: string; icon: any; external?: boolean }[] = [
        { href: '/dashboard/shop/orders', label: 'Orders', icon: ShoppingCart },
        { href: '/dashboard/shop/pricing', label: 'Pricing', icon: Tag },
        { href: '/dashboard/shop/withdraw', label: 'Withdraw', icon: Banknote },
        { href: '/dashboard/shop/customers', label: 'Customers', icon: Users },
        { href: '/dashboard/shop/profit-logs', label: 'Profit Logs', icon: FileText },
        { href: '/dashboard/shop/sms', label: 'SMS', icon: MessageSquare },
        { href: '/dashboard/shop/ussd', label: 'USSD', icon: Smartphone },
        { href: '/dashboard/shop/setup', label: 'Settings', icon: Settings },
        ...(shopIsLive ? [{ href: shopUrl, label: 'Storefront', icon: ExternalLink, external: true }] : []),
    ]

    const statCards = [
        { label: 'Sales', value: formatCurrency(stats?.total_revenue || 0), accent: 'text-emerald-600 dark:text-emerald-400', icon: Banknote },
        { label: 'Profit', value: formatCurrency(stats?.total_profit || 0), accent: 'text-purple-600 dark:text-purple-400', icon: TrendingUp },
        { label: 'Completed', value: `${stats?.completed_orders || 0}`, accent: 'text-green-600 dark:text-green-400', icon: CheckCircle2 },
        { label: 'In Progress', value: `${(stats?.pending_orders || 0) + (stats?.processing_orders || 0)}`, accent: 'text-yellow-600 dark:text-yellow-400', icon: Clock },
    ]

    return (
        <div className="space-y-5 pb-20 md:pb-6">
            {/* ── Header ── */}
            <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-950 p-4 sm:p-5">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0 border border-emerald-100 dark:border-emerald-800/50">
                            <Store className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                        </div>
                        <div className="min-w-0">
                            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-gray-900 dark:text-white truncate">{shop.shop_name}</h1>
                            <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                                <span className={cn('inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full', statusConfig[shop.approval_status]?.color)}>
                                    <StatusIcon className="w-3 h-3" />
                                    {statusConfig[shop.approval_status]?.label}
                                </span>
                                {(dbUser?.role === 'agent' || dbUser?.role === 'dealer') && (
                                    dbUser?.role === 'dealer' ? (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 rounded-full text-[11px] font-semibold">
                                            <Gem className="w-3 h-3" /> Dealer
                                        </span>
                                    ) : isPermanentAgent ? (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 rounded-full text-[11px] font-semibold">
                                            <Crown className="w-3 h-3" /> Lifetime
                                        </span>
                                    ) : (
                                        <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold', daysLeft <= 3 ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300')}>
                                            <Clock className="w-3 h-3" /> {daysLeft <= 0 ? 'Expired' : `${daysLeft}d left`}
                                        </span>
                                    )
                                )}
                            </div>
                        </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing} className="gap-1.5 rounded-lg flex-shrink-0">
                        <RefreshCcw className={cn('w-3.5 h-3.5', isRefreshing && 'animate-spin')} />
                        <span className="hidden sm:inline">Refresh</span>
                    </Button>
                </div>

                {shopIsLive && (
                    <div className="mt-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-emerald-50/60 dark:bg-emerald-950/20 p-2 rounded-xl border border-emerald-100 dark:border-emerald-900/50">
                        <span className="text-xs font-mono text-emerald-800 dark:text-emerald-300 truncate flex-1 px-2 py-1.5">{shopUrl}</span>
                        <div className="flex items-center gap-2">
                            <Button onClick={copyLink} variant="secondary" size="sm" className="flex-1 sm:flex-none h-9 bg-white dark:bg-zinc-900 text-emerald-600 gap-1.5 rounded-lg font-semibold">
                                {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied!' : 'Copy'}
                            </Button>
                            <a href={shopUrl} target="_blank" rel="noopener noreferrer" title="Open Shop" aria-label="Open Shop">
                                <Button size="sm" className="h-9 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg"><ExternalLink className="w-3.5 h-3.5" /></Button>
                            </a>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Confirmation-status warning (only renders when something needs the owner's attention) ── */}
            <ConfirmationStatusBanner />

            {/* ── Promo Carousel ── */}
            <PromoCarousel
                slides={buildShopDashboardSlides({
                    shopIsLive,
                    ussdActive,
                    ussdCode,
                    ussdShortcode,
                    activationFee,
                    smsConfirmEnabled,
                    utilitiesEnabled,
                    ownerRole: dbUser?.role,
                    brandColor: /^#([A-Fa-f0-9]{3}){1,4}$/.test(shop.brand_color) ? shop.brand_color : '#2563eb',
                })}
            />

            {/* ── Quick Links (real buttons) ── */}
            <div className="grid grid-cols-4 sm:grid-cols-4 md:grid-cols-8 gap-2">
                {quickLinks.map(({ href, label, icon: Icon, external }) => {
                    const inner = (
                        <span className="flex flex-col items-center justify-center gap-1.5 w-full h-full py-3 px-1 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-950 shadow-sm transition-all duration-150 hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20 active:scale-95 active:shadow-inner">
                            <Icon className="w-4.5 h-4.5 w-[18px] h-[18px] text-emerald-600 dark:text-emerald-400" />
                            <span className="text-[11px] font-semibold text-gray-700 dark:text-gray-300 leading-none">{label}</span>
                        </span>
                    )
                    if (external) {
                        return <a key={label} href={href} target="_blank" rel="noopener noreferrer" className="block">{inner}</a>
                    }
                    return <Link key={label} href={href} className="block">{inner}</Link>
                })}
            </div>

            {/* ── Stats ── */}
            <div className={cn('space-y-2.5 transition-opacity duration-300', (isPending || isFiltering) && 'opacity-50 pointer-events-none')}>
                <div className="flex items-center justify-between px-1">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
                        <TrendingUp className="w-4 h-4 text-emerald-500" /> Performance
                    </h3>
                    <div className="flex bg-gray-100 dark:bg-zinc-900 rounded-lg p-0.5">
                        {(['all', 'today', '7d', '30d'] as const).map((f) => (
                            <button key={f} onClick={() => setFilter(f)} className={cn('px-2.5 py-1 text-[11px] font-semibold rounded-md transition-all', filter === f ? 'bg-white dark:bg-zinc-800 shadow-sm text-emerald-600' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300')}>
                                {f === 'all' ? 'All' : f === 'today' ? 'Today' : f.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
                    {statCards.map(({ label, value, accent, icon: Icon }) => (
                        <Card key={label} className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-gray-800 rounded-xl shadow-sm">
                            <CardContent className="p-3.5">
                                <div className="flex items-center gap-1.5 mb-1">
                                    <Icon className={cn('w-3.5 h-3.5', accent)} />
                                    <p className="text-[11px] font-medium text-gray-500 dark:text-gray-400">{label}</p>
                                </div>
                                <p className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">{value}</p>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </div>

            {/* ── Wallet + Notice + Activity ── */}
            <div className={cn('grid grid-cols-1 lg:grid-cols-12 gap-4', isPending && 'opacity-50 pointer-events-none')}>
                <div className="lg:col-span-4 space-y-4">
                    <div className="rounded-2xl bg-gradient-to-br from-emerald-700 to-emerald-900 p-5 text-white shadow-md">
                        <p className="text-emerald-200 text-xs font-medium mb-1">Available Profit</p>
                        <p className="text-3xl font-bold tabular-nums">{formatCurrency(wallet?.balance || 0)}</p>
                        <div className="flex gap-4 mt-2 text-[11px] text-emerald-200/90">
                            <span>Earned: {formatCurrency(wallet?.total_earned || 0)}</span>
                            <span>Withdrawn: {formatCurrency(wallet?.total_withdrawn || 0)}</span>
                        </div>
                        <Link href="/dashboard/shop/withdraw" className="block mt-4">
                            <Button size="sm" className="w-full bg-white text-emerald-700 hover:bg-emerald-50 font-semibold rounded-lg h-10">
                                Withdraw Earnings <ArrowRight className="w-4 h-4 ml-1.5" />
                            </Button>
                        </Link>
                    </div>

                    <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
                        <div className="flex items-center gap-2 font-semibold text-sm"><MessageCircle className="w-4 h-4 text-emerald-600" /> Storefront Notice</div>
                        {adminAnnActive && (
                            <div className="p-2.5 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-xs rounded-lg flex items-center gap-2">
                                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                                A system-wide admin announcement is active. Your notice is temporarily disabled.
                            </div>
                        )}
                        <textarea title="Storefront Notice" placeholder="Enter your storefront notice here..." className="w-full min-h-[90px] p-3 text-sm rounded-lg border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 focus:ring-1 focus:ring-emerald-500 focus:outline-none" value={annMsg} onChange={(e) => setAnnMsg(e.target.value)} disabled={adminAnnActive} />
                        <Button size="sm" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-9 font-semibold" onClick={handleSaveAnnouncement} disabled={adminAnnActive || isSavingAnn || !annMsg.trim()}>
                            {isSavingAnn ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save Notice'}
                        </Button>
                    </div>

                    {/* Customer SMS confirmation toggle */}
                    <div id="sms-confirm-toggle" className="scroll-mt-24 bg-white dark:bg-zinc-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-4">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 font-semibold text-sm">
                                    <MessageSquare className="w-4 h-4 text-emerald-600" /> Customer order SMS
                                </div>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                    Text customers a confirmation each time they order from your shop.
                                </p>
                            </div>
                            <Switch
                                checked={smsConfirmEnabled}
                                onCheckedChange={handleToggleSmsConfirm}
                                disabled={savingSmsToggle}
                                aria-label="Send order confirmation SMS to customers"
                            />
                        </div>
                    </div>

                    {/* Utility bills storefront toggle */}
                    <div id="bill-pay-toggle" className="scroll-mt-24 bg-white dark:bg-zinc-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-4">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 font-semibold text-sm">
                                    <Receipt className="w-4 h-4 text-emerald-600" /> Utility bills on my storefront
                                </div>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                    Let customers pay ECG, Ghana Water, DSTV, GOtv and StarTimes bills from your shop.
                                </p>
                            </div>
                            <Switch
                                checked={utilitiesEnabled}
                                onCheckedChange={handleToggleUtilities}
                                disabled={savingUtilityToggle}
                                aria-label="Sell utility bill payments on my storefront"
                            />
                        </div>
                        {utilitiesEnabled && (
                            <div className="flex items-start justify-between gap-3 mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 font-semibold text-sm">
                                        <MessageSquare className="w-4 h-4 text-emerald-600" /> Utility bill completion SMS
                                    </div>
                                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                        Text the customer when their bill payment completes, from your own sender — uses your SMS credits.
                                    </p>
                                </div>
                                <Switch
                                    checked={utilitySmsEnabled}
                                    onCheckedChange={handleToggleUtilitySms}
                                    disabled={savingUtilitySmsToggle}
                                    aria-label="Send utility bill completion SMS to customers"
                                />
                            </div>
                        )}
                    </div>
                </div>

                <div className="lg:col-span-8">
                    <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden flex flex-col">
                        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
                            <h3 className="font-semibold text-sm">Recent Activity</h3>
                            <Link href="/dashboard/shop/orders" className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 flex items-center gap-1">
                                View all <ArrowRight className="w-3 h-3" />
                            </Link>
                        </div>
                        <div className="flex-1 overflow-y-auto max-h-[440px] p-3">
                            {recentOrders.length === 0 ? (
                                <div className="h-[240px] flex flex-col items-center justify-center text-center">
                                    <Tag className="w-10 h-10 text-gray-200 dark:text-gray-700 mb-3" />
                                    <p className="text-gray-500 text-sm">No sales yet. Share your link to start earning!</p>
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    {recentOrders.slice(0, 30).map((order) => (
                                        <div key={order.id} className="px-3 py-2.5 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800/50 flex items-center justify-between gap-3">
                                            <div className="flex items-center gap-3 min-w-0">
                                                <div className={cn('w-9 h-9 rounded-full flex items-center justify-center font-semibold text-xs flex-shrink-0', order.is_rc ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400')}>
                                                    {order.is_rc ? 'RC' : order.network?.charAt(0) || 'D'}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="font-semibold text-sm text-gray-900 dark:text-white truncate flex items-center gap-1.5">
                                                        <span className="truncate">{order.is_rc ? `${order.quantity}x ${order.type_name}` : `${order.network} ${order.package_size}`}</span>
                                                        {(order.source === 'ussd' || order.source === 'ussd_shop') && (
                                                            <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400 flex-shrink-0">
                                                                <Smartphone className="w-2.5 h-2.5" /> USSD
                                                            </span>
                                                        )}
                                                    </p>
                                                    <p className="text-xs text-gray-500 dark:text-gray-400">{order.guest_phone}</p>
                                                </div>
                                            </div>
                                            <div className="text-right flex-shrink-0">
                                                <p className="font-semibold text-sm text-gray-900 dark:text-white tabular-nums">{formatCurrency(order.selling_price)}</p>
                                                <p className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 tabular-nums">+{formatCurrency(order.profit)}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
