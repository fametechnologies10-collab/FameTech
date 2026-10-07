'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useAuth } from '@/contexts/auth-context'
import { useUI } from '@/contexts/ui-context'
import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
    ShoppingCart,
    CheckCircle2,
    Clock,
    Hourglass,
    XCircle,
    Wallet,
    Package,
    AlertCircle,
    Plus,
    Star,
    Store,
    FileText,
    Phone,
    Loader2,
    RefreshCw,
    UserPlus,
} from 'lucide-react'
import { useCountUp } from '@/hooks/use-count-up'

import { PromoCarousel } from '@/components/promo-carousel/PromoCarousel'
import { buildDashboardSlides } from '@/lib/promo-carousel/dashboard-slides'
import { RoleGreetingBox } from '@/components/dashboard/RoleGreetingBox'
import { WebsiteRequestBanner } from '@/components/dashboard/WebsiteRequestBanner'
import { TodaysOrdersSummary } from '@/components/dashboard/TodaysOrdersSummary'

const MtnWhitelistChecker = dynamic(
    () => import('@/components/mtn-whitelist-checker').then(m => m.MtnWhitelistChecker),
    { ssr: false },
)

// NEXT_PUBLIC_ vars inline at build time — keep as a module const.
const USSD_SHORTCODE = process.env.NEXT_PUBLIC_USSD_SHORTCODE ?? '*713*9939#'

interface DashboardStats {
    totalOrders: number
    completedOrders: number
    pendingOrders: number
    queuedOrders: number
    processingOrders: number
    failedOrders: number
    refundedOrders: number
    walletBalance: number
}

interface ActiveWebsiteRequest {
    id: string
    status: 'new' | 'contacted' | 'closed'
    request_type: 'full_request' | 'call_request'
    created_at: string
}

const STAT_CARDS = [
    {
        key: 'totalOrders' as const,
        label: 'Total Orders',
        sub: 'All time',
        iconBg: 'bg-blue-50 dark:bg-blue-900/20',
        iconColor: 'text-blue-600 dark:text-blue-400',
        Icon: ShoppingCart,
    },
    {
        key: 'completedOrders' as const,
        label: 'Completed',
        sub: 'Fulfilled',
        iconBg: 'bg-green-50 dark:bg-green-900/20',
        iconColor: 'text-green-600 dark:text-green-400',
        Icon: CheckCircle2,
    },
    {
        key: 'pendingOrders' as const,
        label: 'Pending',
        sub: 'Awaiting fulfillment',
        iconBg: 'bg-amber-50 dark:bg-amber-900/20',
        iconColor: 'text-amber-600 dark:text-amber-400',
        Icon: Clock,
    },
    {
        key: 'queuedOrders' as const,
        label: 'Queued',
        sub: 'Registering number',
        iconBg: 'bg-indigo-50 dark:bg-indigo-900/20',
        iconColor: 'text-indigo-600 dark:text-indigo-400',
        Icon: Hourglass,
    },
    {
        key: 'processingOrders' as const,
        label: 'Processing',
        sub: 'In progress',
        iconBg: 'bg-blue-50 dark:bg-blue-900/20',
        iconColor: 'text-blue-600 dark:text-blue-400',
        Icon: Clock,
    },
    {
        key: 'failedOrders' as const,
        label: 'Failed',
        sub: 'Needs review',
        iconBg: 'bg-red-50 dark:bg-red-900/20',
        iconColor: 'text-red-600 dark:text-red-400',
        Icon: XCircle,
    },
    {
        key: 'refundedOrders' as const,
        label: 'Refunded',
        sub: 'Back to wallet',
        iconBg: 'bg-purple-50 dark:bg-purple-900/20',
        iconColor: 'text-purple-600 dark:text-purple-400',
        Icon: RefreshCw,
    },
]

const QUICK_LINKS = [
    { label: 'Buy Data',    href: '/dashboard/data-packages',  Icon: Package,      id: 'data-packages',    bg: 'bg-yellow-50 dark:bg-yellow-900/20',  icon: 'text-yellow-600 dark:text-yellow-400' },
    { label: 'Buy Airtime', href: '/dashboard/airtime',        Icon: Phone,        id: undefined,          bg: 'bg-orange-50 dark:bg-orange-900/20',  icon: 'text-orange-600 dark:text-orange-400' },
    { label: 'Orders',      href: '/dashboard/my-orders',      Icon: ShoppingCart, id: 'order-history',    bg: 'bg-blue-50 dark:bg-blue-900/20',      icon: 'text-blue-600 dark:text-blue-400' },
    { label: 'Top Up',      href: '/dashboard/wallet',         Icon: Wallet,       id: undefined,          bg: 'bg-green-50 dark:bg-green-900/20',    icon: 'text-green-600 dark:text-green-400' },
    { label: 'Support',     href: '/dashboard/complaints',     Icon: AlertCircle,  id: 'complaint-button', bg: 'bg-red-50 dark:bg-red-900/20',        icon: 'text-red-600 dark:text-red-400' },
    { label: 'AFA Orders',  href: '/dashboard/afa-orders',     Icon: Star,         id: undefined,          bg: 'bg-purple-50 dark:bg-purple-900/20',  icon: 'text-purple-600 dark:text-purple-400' },
    { label: 'Vouchers',    href: '/dashboard/results-checker',Icon: FileText,     id: undefined,          bg: 'bg-teal-50 dark:bg-teal-900/20',      icon: 'text-teal-600 dark:text-teal-400' },
    { label: 'My Shop',     href: '/dashboard/shop',           Icon: Store,        id: undefined,          bg: 'bg-indigo-50 dark:bg-indigo-900/20',  icon: 'text-indigo-600 dark:text-indigo-400' },
]

function StatValue({ value }: { value: number }) {
    const display = useCountUp(value, 700)
    return <span>{display}</span>
}

function WalletValue({ value }: { value: number }) {
    const display = useCountUp(value, 700, 2)
    return <span>{display}</span>
}

export default function DashboardPage() {
    const { dbUser, isAdmin } = useAuth()
    const { activeAnnouncement, reopenAnnouncement } = useUI()
    const [stats, setStats] = useState<DashboardStats | null>(null)
    const [websiteRequest, setWebsiteRequest] = useState<ActiveWebsiteRequest | null>(null)
    const [hasShop, setHasShop] = useState(false)
    // Mounted on first open only, so the checker's code isn't loaded until someone asks for it.
    const [whitelistMounted, setWhitelistMounted] = useState(false)
    const [whitelistOpen, setWhitelistOpen] = useState(false)
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        if (dbUser) {
            fetchDashboardData()
        }
    }, [dbUser])

    const fetchDashboardData = async () => {
        try {
            const [totalRes, completedRes, pendingRes, queuedRes, processingRes, failedRes, refundedRes, walletRes, websiteReqRes, shopRes] =
                await Promise.all([
                    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', dbUser?.id as any).is('shop_order_id', null),
                    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', dbUser?.id as any).eq('status', 'completed').is('shop_order_id', null),
                    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', dbUser?.id as any).eq('status', 'pending').is('shop_order_id', null),
                    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', dbUser?.id as any).eq('status', 'queued').is('shop_order_id', null),
                    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', dbUser?.id as any).eq('status', 'processing').is('shop_order_id', null),
                    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', dbUser?.id as any).eq('status', 'failed').is('shop_order_id', null),
                    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', dbUser?.id as any).eq('status', 'refunded').is('shop_order_id', null),
                    supabase.from('wallets').select('balance').eq('user_id', dbUser?.id as any).single(),
                    // Banner state rides along with the existing parallel fetch — RLS grants the
                    // owner SELECT on these columns, so no serverless round-trip is needed.
                    // An error here (e.g. migration not yet applied) degrades to "no active
                    // request" rather than taking the whole dashboard down with it.
                    (supabase as any).from('website_requests')
                        .select('id, status, request_type, created_at')
                        .eq('user_id', dbUser?.id)
                        .in('status', ['new', 'contacted'])
                        .order('created_at', { ascending: false })
                        .limit(1)
                        .maybeSingle(),
                    // Shop existence drives which promo slides the carousel shows. An error
                    // degrades to "no shop" rather than failing the dashboard.
                    supabase.from('shop_profiles').select('id').eq('owner_id', dbUser?.id as any).maybeSingle(),
                ])

            setWebsiteRequest(websiteReqRes?.error ? null : (websiteReqRes?.data ?? null))
            setHasShop(!shopRes?.error && !!shopRes?.data)

            setStats({
                totalOrders:      totalRes.count || 0,
                completedOrders:  completedRes.count || 0,
                pendingOrders:    pendingRes.count || 0,
                queuedOrders:     queuedRes.count || 0,
                processingOrders: processingRes.count || 0,
                failedOrders:     failedRes.count || 0,
                refundedOrders:   refundedRes.count || 0,
                walletBalance:    (walletRes.data as any)?.balance || 0,
            })
        } catch (error) {
            console.error('Error fetching dashboard data:', error)
        } finally {
            setIsLoading(false)
        }
    }

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    // Sub-Agents shortcut — agent/dealer/admin only, same gate as the sidebar's
    // Sub-Agents link (components/dashboard/sidebar.tsx): a sub-agent can never
    // recruit (spec C1), so dbUser?.role === 'subagent' is excluded by
    // construction since it isn't in the allow-list below.
    const quickLinks = [
        ...QUICK_LINKS,
        ...(isAdmin || dbUser?.role === 'agent' || dbUser?.role === 'dealer'
            ? [{ label: 'Sub-Agents', href: '/dashboard/recruit', Icon: UserPlus, id: undefined, bg: 'bg-fuchsia-50 dark:bg-fuchsia-900/20', icon: 'text-fuchsia-600 dark:text-fuchsia-400' }]
            : []),
    ]

    return (
        <div className="space-y-4">

            {/* Role Greeting */}
            <RoleGreetingBox stats={{ totalOrders: stats?.totalOrders ?? 0 }} />

            {/* Promo Carousel */}
            <PromoCarousel
                slides={buildDashboardSlides({
                    role: dbUser?.role,
                    hasShop,
                    ussdShortcode: USSD_SHORTCODE,
                    announcement: activeAnnouncement,
                    onOpenAnnouncement: reopenAnnouncement,
                    onOpenWhitelistCheck: () => {
                        setWhitelistMounted(true)
                        setWhitelistOpen(true)
                    },
                })}
            />
            {whitelistMounted && <MtnWhitelistChecker open={whitelistOpen} onOpenChange={setWhitelistOpen} />}

            {/* Website & App Request */}
            <WebsiteRequestBanner activeRequest={websiteRequest} />

            {/* Wallet Balance */}
            <div
                id="wallet-card"
                className="rounded-2xl bg-card shadow-sm border border-border p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
                <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Wallet Balance</p>
                    <p className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
                        GHS <WalletValue value={stats?.walletBalance ?? 0} />
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Available now</p>
                </div>
                <Link href="/dashboard/wallet" className="w-full sm:w-auto">
                    <Button
                        size="lg"
                        className="w-full sm:w-auto bg-green-600 hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-400 text-white border-0 shadow-none rounded-xl font-semibold h-11 px-6 gap-2"
                    >
                        <Plus className="w-4 h-4" />
                        Top Up Wallet
                    </Button>
                </Link>
            </div>

            {/* Stat Cards — Total headline + 6 status cards, 3 per row */}
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
                {STAT_CARDS.map(({ key, label, sub, iconBg, iconColor, Icon }) => {
                    // Total Orders spans the full width as a headline; the six status
                    // cards below it fill exactly two rows of three.
                    if (key === 'totalOrders') {
                        return (
                            <div
                                key={key}
                                className="col-span-3 rounded-2xl bg-card shadow-sm border border-border p-4 flex items-center justify-between gap-3"
                            >
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg}`}>
                                        <Icon className={`w-5 h-5 ${iconColor}`} />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-sm font-semibold text-foreground leading-tight truncate">{label}</p>
                                        <p className="text-[11px] text-muted-foreground truncate">{sub}</p>
                                    </div>
                                </div>
                                <p className="text-3xl font-bold text-foreground leading-none flex-shrink-0">
                                    <StatValue value={stats?.[key] ?? 0} />
                                </p>
                            </div>
                        )
                    }
                    return (
                        <div
                            key={key}
                            className="rounded-2xl bg-card shadow-sm border border-border p-3 hover:shadow-md transition-shadow duration-200"
                        >
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${iconBg}`}>
                                <Icon className={`w-4 h-4 ${iconColor}`} />
                            </div>
                            <p className="text-xl sm:text-2xl font-bold text-foreground leading-none">
                                <StatValue value={stats?.[key] ?? 0} />
                            </p>
                            <p className="text-[11px] font-medium text-muted-foreground mt-1 truncate">{label}</p>
                        </div>
                    )
                })}
            </div>

            {/* Today's Summary */}
            <TodaysOrdersSummary />

            {/* Quick Links */}
            <div className="rounded-2xl bg-card shadow-sm border border-border overflow-hidden">
                <div className="px-5 pt-4 pb-3 border-b border-border">
                    <p className="text-sm font-semibold text-foreground">Quick Links</p>
                </div>
                <div id="data-packages" className="grid grid-cols-4 sm:grid-cols-8 gap-0 divide-x divide-y divide-border">
                    {quickLinks.map(({ label, href, Icon, id, bg, icon }) => (
                        <Link key={href} href={href}>
                            <div
                                id={id}
                                className="flex flex-col items-center gap-2 p-3 sm:p-4 hover:bg-muted/60 transition-colors duration-150 cursor-pointer group"
                            >
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${bg} group-hover:scale-105 transition-transform duration-150`}>
                                    <Icon className={`w-5 h-5 ${icon}`} />
                                </div>
                                <p className="text-[10px] sm:text-xs font-medium text-muted-foreground text-center leading-tight group-hover:text-foreground transition-colors">
                                    {label}
                                </p>
                            </div>
                        </Link>
                    ))}
                </div>
            </div>

        </div>
    )
}
