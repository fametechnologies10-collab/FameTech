'use client'

import Link from 'next/link'
import Image from 'next/image'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { useUI } from '@/contexts/ui-context'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/utils'
import {
    LayoutDashboard,
    Package,
    ShoppingCart,
    Wallet,
    User,
    MessageSquare,
    Bell,
    Send,
    Users,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    LogOut,
    Loader2,
    Settings,
    Shield,
    Crown,
    Star,
    BadgeCheck,
    UserCircle,
    Plus,
    Activity,
    Banknote,
    Store,
    Tag,
    Phone,
    FileText,
    Code2,
    Key,
    Gem,
    Smartphone,
    CreditCard,
    Hourglass,
    Lightbulb,
    ListChecks,
    Wifi,
    Percent,
    UserPlus
} from 'lucide-react'
import { useState, useEffect, type CSSProperties } from 'react'
import { supabase } from '@/lib/supabase'
import { usePageAccess } from '@/hooks/use-page-access'
import { differenceInDays } from 'date-fns'
import { useAdminCounts } from '@/hooks/use-admin-counts'

// Short deliberately: worst case after creating a shop is the "My Shop" nav
// item lags up to this long (self-heals on the next reload), which is an
// acceptable tradeoff for cutting a redundant query on every sidebar mount.
const SHOP_EXISTENCE_CACHE_TTL_MS = 2 * 60 * 1000

export const userNavItems = [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/dashboard/upgrade', label: 'Upgrade', icon: Crown },
    { href: '/dashboard/data-packages', label: 'Data bundles', icon: Package },
    { href: '/dashboard/airtime', label: 'Airtime and mashup', icon: Phone },
    { href: '/dashboard/utilities', label: 'Bills', icon: Lightbulb },
    { href: '/dashboard/results-checker', label: 'Result checkers', icon: FileText },
    { href: '/dashboard/my-orders', label: 'Orders', icon: ShoppingCart },
    { href: '/dashboard/wallet', label: 'Wallet', icon: Wallet },
    { href: '/dashboard/transactions', label: 'Activity', icon: Activity },
    { href: '/dashboard/complaints', label: 'Help and complaints', icon: MessageSquare },
    { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
    { href: '/dashboard/profile', label: 'Profile', icon: User },
    { href: '/dashboard/afa-orders', label: 'AFA registration', icon: BadgeCheck },
    { href: '/dashboard/sms', label: 'Bulk SMS', icon: Send },
    { href: '/dashboard/api', label: 'Developer API', icon: Code2 },
    { href: '/dashboard/commission', label: 'Commission wallet', icon: Percent },
]

export const adminNavItems = [
    { href: '/admin', label: 'Admin dashboard', icon: Shield },
    { href: '/admin/top-up', label: 'Top-Up', icon: Wallet },
    { href: '/admin/orders', label: 'Orders', icon: ShoppingCart },
    { href: '/admin/orders/bulk-update', label: 'Bulk order update', icon: ListChecks },
    { href: '/admin/results-checker', label: 'Result checker management', icon: FileText },
    { href: '/admin/ussd', label: 'USSD management', icon: Smartphone },
    { href: '/admin/fulfillment', label: 'Fulfillment', icon: Activity },
    { href: '/admin/ishare', label: 'iShare center', icon: Wifi },
    { href: '/admin/number-registration', label: 'Number registration', icon: Hourglass },
    { href: '/admin/datagod', label: 'DataGod terminal', icon: Activity },
    { href: '/admin/airtime', label: 'Airtime and mashup', icon: Phone },
    { href: '/admin/utilities', label: 'Utilities', icon: Lightbulb },
    { href: '/admin/shops', label: 'Shops', icon: Store },
    { href: '/admin/shops/withdrawals', label: 'Shop withdrawals', icon: Banknote },
    { href: '/admin/shop-sms', label: 'Shop SMS', icon: MessageSquare },
    { href: '/admin/sms-platform', label: 'SMS platform', icon: Send },
    { href: '/admin/afa-management', label: 'AFA management', icon: BadgeCheck },
    { href: '/admin/roles', label: 'Role management', icon: Users },
    { href: '/admin/users', label: 'Users', icon: Users },
    { href: '/admin/packages', label: 'Packages', icon: Package },
    { href: '/admin/mtn-mashup', label: 'MTN mashup', icon: Package },
    { href: '/admin/complaints', label: 'Complaints', icon: MessageSquare },
    { href: '/admin/website-requests', label: 'Website requests', icon: Code2 },
    { href: '/admin/announcements', label: 'Announcements', icon: Bell },
    { href: '/admin/sms-broadcast', label: 'SMS broadcast', icon: MessageSquare },
    { href: '/admin/finance', label: 'Finance', icon: Banknote },
    { href: '/admin/payments', label: 'Payments center', icon: CreditCard },
    { href: '/admin/momo-claims', label: 'MoMo claims', icon: Wallet },
    { href: '/admin/ussd-refunds', label: 'USSD refunds', icon: Wallet },
    { href: '/admin/profits-history', label: 'Profits history', icon: Wallet },
    { href: '/admin/api-keys', label: 'API keys', icon: Key },
    { href: '/admin/terms', label: 'Terms and policies', icon: FileText },
    { href: '/admin/settings', label: 'Settings', icon: Settings },
]

export const shopNavItems = [
    { href: '/dashboard/shop', label: 'My store', icon: Store },
    { href: '/dashboard/shop/orders', label: 'Store orders', icon: ShoppingCart },
    { href: '/dashboard/shop/pricing', label: 'Store pricing', icon: Tag },
    { href: '/dashboard/shop/setup', label: 'Shop profile', icon: Settings },
    { href: '/dashboard/shop/withdraw', label: 'Withdraw', icon: Banknote },
    { href: '/dashboard/shop/setup', label: 'Create store', icon: Store },
]

import { roleConfig, roleTheme } from '@/lib/roles'

export function DashboardSidebar({ communityLink = 'https://chat.whatsapp.com/GY8X8nUkNgYATUiOY5gXAb' }: { communityLink?: string }) {
    const pathname = usePathname()
    const { dbUser, isAdmin, isSubAdmin, signOut, isSigningOut } = useAuth()
    const { isInternalSidebarOpen, closeSidebar, isCollapsed, toggleCollapse } = useUI()
    const { isPageAccessible, loading: pageAccessLoading } = usePageAccess()
    // Remove local state: const [isCollapsed, setIsCollapsed] = useState(false)
    const [walletBalance, setWalletBalance] = useState(0)
    const [isShopOpen, setIsShopOpen] = useState(false)
    const [hasShop, setHasShop] = useState<boolean | null>(null)
    const { counts: adminCounts } = useAdminCounts()

    // Calculate days remaining for agents
    const calculateDaysRemaining = () => {
        if (!dbUser?.agent_expires_at || dbUser?.role !== 'agent') return null
        const now = new Date()
        const expiresAt = new Date(dbUser.agent_expires_at)
        const daysRemaining = Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        return daysRemaining > 0 ? daysRemaining : 0
    }

    const calculateDealerDaysRemaining = () => {
        if (!(dbUser as any)?.dealer_expires_at || dbUser?.role !== 'dealer') return null
        const now = new Date()
        const expiresAt = new Date((dbUser as any).dealer_expires_at)
        const daysRemaining = Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        return daysRemaining > 0 ? daysRemaining : 0
    }

    const daysRemaining = calculateDaysRemaining()
    const dealerDaysRemaining = calculateDealerDaysRemaining()

    // Fetch wallet balance + subscribe to real-time updates
    useEffect(() => {
        if (!dbUser?.id) return

        // Initial fetch
        const fetchBalance = async () => {
            const { data } = await (supabase
                .from('wallets')
                .select('balance')
                .eq('user_id', dbUser.id)
                .single() as any)
            if (data) setWalletBalance(data.balance || 0)
        }
        fetchBalance()

        // Real-time subscription — fires instantly on any balance change
        const channel = supabase
            .channel(`sidebar-wallet-${dbUser.id}`)
            .on(
                'postgres_changes' as any,
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'wallets',
                    filter: `user_id=eq.${dbUser.id}`,
                },
                (payload: any) => {
                    if (payload.new?.balance !== undefined) {
                        setWalletBalance(payload.new.balance)
                    }
                }
            )
            .subscribe()

        return () => {
            supabase.removeChannel(channel)
        }
    }, [dbUser?.id])

    // Auto-open My Shop dropdown when on any /dashboard/shop/* page
    useEffect(() => {
        if (pathname?.startsWith('/dashboard/shop')) {
            setIsShopOpen(true)
        }
    }, [pathname])

    // Fetch shop existence
    // EGRESS: this is a pure existence boolean that only changes when the user
    // creates a shop — a rare, explicit action — yet was refetched uncached on
    // every sidebar mount (1,873 req/day measured 2026-09-24, the largest
    // shop_profiles query shape after real per-order checks). sessionStorage
    // (not an in-memory cache) survives a full page reload, which a module-scope
    // cache would not. Scoped per user id so a shared-device account switch can
    // never read a stale value for the wrong account.
    useEffect(() => {
        const checkShop = async () => {
            if (!dbUser?.id) return
            const cacheKey = `kfg_has_shop_${dbUser.id}`
            try {
                const cached = sessionStorage.getItem(cacheKey)
                if (cached) {
                    const { v, at } = JSON.parse(cached) as { v: boolean; at: number }
                    if (Date.now() - at < SHOP_EXISTENCE_CACHE_TTL_MS) {
                        setHasShop(v)
                        return
                    }
                }
            } catch {}
            const { data } = await supabase.from('shop_profiles').select('id').eq('owner_id', dbUser.id).maybeSingle()
            const exists = !!data
            setHasShop(exists)
            try { sessionStorage.setItem(cacheKey, JSON.stringify({ v: exists, at: Date.now() })) } catch {}
        }
        checkShop()
    }, [dbUser?.id])

    const isLinkActive = (href: string) => {
        if (href === '/dashboard' || href === '/admin') {
            return pathname === href
        }
        return pathname?.startsWith(href)
    }

    // Get role config
    const userRole = isAdmin ? 'admin' : isSubAdmin ? 'sub-admin' : (dbUser?.role || 'customer') as keyof typeof roleConfig
    const currentRole = roleConfig[userRole] || roleConfig['customer']
    const RoleIcon = currentRole.icon
    const theme = roleTheme[userRole] ?? roleTheme['customer']
    // Per-role chip/ring colours come only from roleTheme (contrast-checked pairs), exposed as CSS variables
    const roleVars = {
        '--chip-bg': theme.chipLight.bg,
        '--chip-fg': theme.chipLight.text,
        '--chip-bg-d': theme.chipDark.bg,
        '--chip-fg-d': theme.chipDark.text,
        '--tw-ring-color': theme.ring
    } as CSSProperties

    // One shared nav look for every role: flat row, active = inset tray + 3px FT blue marker + semibold
    const navLinkClass = "block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    const navRowClass = (active?: boolean) => cn(
        "relative flex items-center gap-2.5 px-3 py-2 min-h-10 rounded-xl text-sm transition-colors duration-200",
        active
            ? "ft-field font-semibold text-foreground before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-[var(--ft-blue)] dark:before:bg-[var(--ft-cyan)]"
            : "font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        isCollapsed && "justify-center px-2"
    )
    const navIconClass = (active?: boolean) => cn(
        "w-5 h-5 flex-shrink-0",
        active && "text-[var(--ft-blue)] dark:text-[var(--ft-cyan)]"
    )

    return (
        <>
            {/* Mobile overlay */}
            {isInternalSidebarOpen && (
                <div
                    className="fixed inset-0 z-40 bg-black/60 lg:hidden"
                    onClick={closeSidebar}
                />
            )}

            {/* Sidebar */}
            <aside
                className={cn(
                    "fixed left-0 top-0 z-50 h-full flex flex-col transition-all duration-300 ease-in-out ft-card rounded-r-2xl text-foreground",
                    isCollapsed ? "w-20" : "w-80",
                    "lg:transform-none",
                    isInternalSidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
                )}
            >

                {/* Logo Header */}
                <div className={cn(
                    "h-20 flex items-center justify-between border-b border-foreground/10",
                    isCollapsed ? "flex-col justify-center px-2" : "px-6"
                )}>
                    <Link href="/dashboard" className="flex items-center gap-3 group rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <div className="relative w-10 h-10 flex-shrink-0 transition-transform group-hover:scale-110">
                            <div className="w-full h-full rounded-full overflow-hidden flex items-center justify-center ft-soft">
                                <BrandLogo width={40} height={40} className="object-contain" />
                            </div>
                            {dbUser?.role === 'agent' && (
                                <Crown
                                    className="absolute -top-4 -left-3 w-6 h-6 -rotate-[25deg] drop-shadow-md z-10"
                                    style={{ color: roleTheme.agent.ring, fill: roleTheme.agent.ring }}
                                />
                            )}
                            {dbUser?.role === 'dealer' && (
                                <Gem
                                    className="absolute -top-4 -left-3 w-6 h-6 -rotate-[15deg] drop-shadow-md z-10"
                                    style={{ color: roleTheme.dealer.ring, fill: roleTheme.dealer.ring }}
                                />
                            )}
                        </div>
                        {!isCollapsed && (
                            <div className="flex flex-col transition-transform group-hover:scale-105">
                                <BrandTitle className="text-base font-bold tracking-tight text-foreground font-display" />
                                <span className="text-[11px] font-medium text-[#C40000] dark:text-[#FF8A8A] -mt-1 tracking-widest">TECHNOLOGIES</span>
                            </div>
                        )}
                    </Link>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggleCollapse}
                        aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                        className="hidden lg:flex text-muted-foreground hover:text-foreground hover:bg-foreground/5 w-10 h-10 rounded-full focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        {isCollapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={closeSidebar}
                        aria-label="Close menu"
                        className="lg:hidden text-muted-foreground hover:text-foreground hover:bg-foreground/5 w-10 h-10 rounded-full focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <ChevronLeft className="w-5 h-5" />
                    </Button>
                </div>

                {/* Role crest + profile widget */}
                {!isCollapsed && dbUser && (
                    <div className="mx-4 mt-6 p-4 rounded-2xl ft-soft">
                        {/* User Info Row */}
                        <div className="flex items-center gap-3.5 mb-4">
                            {/* Avatar with role ring and role icon */}
                            <div
                                className="relative w-12 h-12 rounded-full flex items-center justify-center ft-field ring-[3px] ring-offset-2 ring-offset-[var(--ft-raised-bg)] text-[var(--chip-fg)] dark:text-[var(--chip-fg-d)]"
                                style={roleVars}
                            >
                                <RoleIcon className="w-6 h-6" />
                                <div
                                    className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center border-2 border-[var(--ft-raised-bg)] bg-[var(--ft-raised-bg)]"
                                >
                                    <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                                </div>
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-foreground truncate flex items-center gap-1.5 flex-wrap">
                                    {dbUser?.role === 'agent' ? (
                                        <>
                                            {dbUser?.first_name} {dbUser?.last_name}
                                            {daysRemaining !== null && (
                                                <span className={cn(
                                                    "text-xs font-bold px-1.5 py-0.5 rounded-full ml-1",
                                                    daysRemaining <= 3
                                                        ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                                                        : "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
                                                )}>
                                                    {daysRemaining}d
                                                </span>
                                            )}
                                        </>
                                    ) : dbUser?.role === 'dealer' ? (
                                        <>
                                            {dbUser?.first_name} {dbUser?.last_name}
                                            {dealerDaysRemaining !== null && (
                                                <span className={cn(
                                                    "text-xs font-bold px-1.5 py-0.5 rounded-full ml-1",
                                                    dealerDaysRemaining <= 3
                                                        ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                                                        : "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
                                                )}>
                                                    {dealerDaysRemaining}d
                                                </span>
                                            )}
                                        </>
                                    ) : (
                                        <span>{dbUser?.first_name} {dbUser?.last_name}</span>
                                    )}
                                </p>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                    <span
                                        className="text-xs font-bold px-2 py-0.5 rounded-full bg-[var(--chip-bg)] text-[var(--chip-fg)] dark:bg-[var(--chip-bg-d)] dark:text-[var(--chip-fg-d)]"
                                        style={roleVars}
                                    >
                                        {currentRole.label}
                                    </span>
                                </div>
                            </div>
                        </div>

                        {/* Subscription Info for Dealers / Agents / Upgrade for Customers */}
                        {dbUser?.role === 'dealer' ? (
                            <div className="mt-3 space-y-2">
                                {dealerDaysRemaining !== null && (
                                    <div className="p-3 rounded-xl ft-field">
                                        <p className="text-xs text-muted-foreground font-semibold mb-1">
                                            Dealer Subscription
                                        </p>
                                        <div className="flex items-center gap-2">
                                            <span className={cn(
                                                "text-base font-semibold",
                                                dealerDaysRemaining <= 3 ? "text-red-700 dark:text-red-400" : "text-foreground"
                                            )}>
                                                {dealerDaysRemaining} {dealerDaysRemaining === 1 ? 'day' : 'days'}
                                            </span>
                                            <span className="text-xs text-muted-foreground">remaining</span>
                                        </div>
                                    </div>
                                )}
                                <Link href="/dashboard/upgrade" className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={closeSidebar}>
                                    <Button
                                        size="sm"
                                        className="w-full h-10 text-xs font-bold rounded-xl flex items-center justify-center gap-2"
                                    >
                                        <Gem className="w-4 h-4" />
                                        Renew Dealer Access
                                    </Button>
                                </Link>
                            </div>
                        ) : dbUser?.role === 'agent' ? (
                            <div className="mt-3 space-y-2">
                                {/* Days Remaining Display */}
                                {daysRemaining !== null && (
                                    <div className="p-3 rounded-xl ft-field">
                                        <p className="text-xs text-muted-foreground font-semibold mb-1">
                                            Subscription Status
                                        </p>
                                        <div className="flex items-center gap-2">
                                            <span className={cn(
                                                "text-base font-semibold",
                                                daysRemaining <= 3 ? "text-red-700 dark:text-red-400" : "text-green-800 dark:text-green-400"
                                            )}>
                                                {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'}
                                            </span>
                                            <span className="text-xs text-muted-foreground">remaining</span>
                                        </div>
                                    </div>
                                )}

                                {/* Extend Button */}
                                <Link href="/dashboard/upgrade" className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={closeSidebar}>
                                    <Button
                                        size="sm"
                                        className="w-full h-10 text-xs font-bold rounded-xl flex items-center justify-center gap-2"
                                    >
                                        <Crown className="w-4 h-4" />
                                        Extend Subscription
                                    </Button>
                                </Link>
                            </div>
                        ) : dbUser?.role === 'customer' && (
                            <Link href="/dashboard/upgrade" className="block mt-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={closeSidebar}>
                                <Button
                                    size="sm"
                                    className="w-full h-10 text-xs font-bold rounded-xl flex items-center justify-center gap-2"
                                >
                                    <Crown className="w-4 h-4" />
                                    Upgrade to Agent
                                </Button>
                            </Link>
                        )}

                        {/* Wallet Section */}
                        <div className="mt-3 flex items-center justify-between p-3 rounded-xl ft-field">
                            <div>
                                <p className="text-xs font-semibold text-muted-foreground mb-0.5">Balance</p>
                                <p className="text-lg font-bold tracking-tight text-foreground">{formatCurrency(walletBalance)}</p>
                            </div>
                            {!(process.env.NEXT_PUBLIC_PAYMENT_MAINTENANCE_MODE === 'true' && !isAdmin) && isPageAccessible('/dashboard/wallet') && (
                                <Link href="/dashboard/wallet" className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                    <Button
                                        size="sm"
                                        className="h-10 px-3 text-xs font-bold rounded-xl"
                                    >
                                        <Plus className="w-3.5 h-3.5 mr-1.5" />
                                        Top Up
                                    </Button>
                                </Link>
                            )}
                        </div>
                    </div>
                )
                }

                {/* Navigation */}
                <nav className={cn(
                    "px-3 py-3 space-y-1 overflow-y-auto flex-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-foreground/20 hover:scrollbar-thumb-foreground/30"
                )}>
                    {!isCollapsed && (
                        <p className="text-xs font-semibold text-muted-foreground mb-1.5 px-2">
                            Menu
                        </p>
                    )}


                    {(() => {
                        const visibleNavItems = userNavItems
                            .filter(item => isPageAccessible(item.href))
                            .filter(item => !(item.href === '/dashboard/upgrade' && dbUser?.role === 'subagent'))

                        const renderNavItem = (item: typeof userNavItems[number]) => {
                            const isActive = isLinkActive(item.href)
                            return (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className={navLinkClass}
                                    aria-current={isActive ? 'page' : undefined}
                                    aria-label={isCollapsed ? item.label : undefined}
                                    title={isCollapsed ? item.label : undefined}
                                    onClick={() => {
                                        if (window.innerWidth < 1024) closeSidebar()
                                    }}
                                >
                                    <div className={navRowClass(isActive)}>
                                        <item.icon className={navIconClass(isActive)} />
                                        {!isCollapsed && <span>{item.label}</span>}
                                    </div>
                                </Link>
                            )
                        }

                        // "Sub-Agents" (recruit) renders right after Data Bundles rather than as
                        // part of userNavItems itself — it needs its own role gate (agent/dealer/
                        // admin only; a sub-agent can never recruit, spec C1) that doesn't fit the
                        // plain per-item array the rest of the menu uses.
                        const splitIndex = visibleNavItems.findIndex(item => item.href === '/dashboard/data-packages')
                        const beforeRecruit = splitIndex === -1 ? visibleNavItems : visibleNavItems.slice(0, splitIndex + 1)
                        const afterRecruit = splitIndex === -1 ? [] : visibleNavItems.slice(splitIndex + 1)

                        return (
                            <>
                                {beforeRecruit.map(renderNavItem)}
                                {(isAdmin || dbUser?.role === 'agent' || dbUser?.role === 'dealer') && isPageAccessible('/dashboard/recruit') && (
                                    <Link
                                        href="/dashboard/recruit"
                                        className={navLinkClass}
                                        aria-current={isLinkActive('/dashboard/recruit') ? 'page' : undefined}
                                        aria-label={isCollapsed ? 'Sub-Agents' : undefined}
                                        title={isCollapsed ? 'Sub-Agents' : undefined}
                                        onClick={() => {
                                            if (window.innerWidth < 1024) closeSidebar()
                                        }}
                                    >
                                        <div className={navRowClass(isLinkActive('/dashboard/recruit'))}>
                                            <UserPlus className={navIconClass(isLinkActive('/dashboard/recruit'))} />
                                            {!isCollapsed && <span>Sub-Agents</span>}
                                        </div>
                                    </Link>
                                )}
                                {afterRecruit.map(renderNavItem)}
                            </>
                        )
                    })()}

                    {/* My Shop — conditionally a link or dropdown based on hasShop */}
                    {(isAdmin || isSubAdmin || dbUser?.role === 'agent' || dbUser?.role === 'dealer' || dbUser?.role === 'customer' || dbUser?.role === 'subagent') && (() => {
                        const isShopActive = pathname?.startsWith('/dashboard/shop')

                        if (hasShop === false) {
                            return (
                                <Link
                                    href="/dashboard/shop/setup"
                                    className={cn(navLinkClass, "mb-1")}
                                    aria-current={isShopActive ? 'page' : undefined}
                                    aria-label={isCollapsed ? 'My store' : undefined}
                                    title={isCollapsed ? 'My store' : undefined}
                                    onClick={() => {
                                        if (window.innerWidth < 1024) closeSidebar()
                                    }}
                                >
                                    <div className={navRowClass(isShopActive)}>
                                        <Store className={navIconClass(isShopActive)} />
                                        {!isCollapsed && <span>My store</span>}
                                    </div>
                                </Link>
                            )
                        }

                        return (
                            <div className="mb-1">
                                {/* Toggle button */}
                                <button
                                    onClick={() => setIsShopOpen(prev => !prev)}
                                    aria-expanded={isShopOpen}
                                    aria-label={isCollapsed ? 'My store' : undefined}
                                    title={isCollapsed ? 'My store' : undefined}
                                    className={cn(
                                        "w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        navRowClass(isShopActive)
                                    )}
                                >
                                    <Store className={navIconClass(isShopActive)} />
                                    {!isCollapsed && (
                                        <>
                                            <span className="flex-1 text-left">My store</span>
                                            <ChevronDown
                                                className={cn(
                                                    "w-4 h-4 flex-shrink-0 transition-transform duration-200",
                                                    isShopOpen && "rotate-180"
                                                )}
                                            />
                                        </>
                                    )}
                                </button>

                                {/* Sub-menu — shown when isShopOpen is true */}
                                {isShopOpen && (
                                    <div className={cn(
                                        "space-y-1",
                                        !isCollapsed && "ml-3 pl-2 border-l-2 mt-1 border-foreground/10"
                                    )}>
                                        {[
                                            { href: '/dashboard/shop', label: 'Overview', icon: LayoutDashboard },
                                            { href: '/dashboard/shop/orders', label: 'Orders', icon: ShoppingCart },
                                            { href: '/dashboard/shop/customers', label: 'Customers', icon: Users },
                                            { href: '/dashboard/shop/profit-logs', label: 'Profit Logs', icon: Activity },
                                            { href: '/dashboard/shop/pricing', label: 'Pricing', icon: Tag },
                                            { href: '/dashboard/shop/sms', label: 'SMS', icon: Send },
                                            { href: '/dashboard/shop/withdraw', label: 'Withdraw', icon: Banknote },
                                            { href: '/dashboard/shop/setup', label: 'Shop Profile', icon: Settings },
                                        ].map(item => {
                                            const isActive = pathname === item.href
                                            return (
                                                <Link
                                                    key={item.href}
                                                    href={item.href}
                                                    className={navLinkClass}
                                                    aria-current={isActive ? 'page' : undefined}
                                                    aria-label={isCollapsed ? item.label : undefined}
                                                    title={isCollapsed ? item.label : undefined}
                                                    onClick={() => {
                                                        if (window.innerWidth < 1024) closeSidebar()
                                                    }}
                                                >
                                                    <div className={navRowClass(isActive)}>
                                                        <item.icon className={navIconClass(isActive)} />
                                                        {!isCollapsed && <span>{item.label}</span>}
                                                    </div>
                                                </Link>
                                            )
                                        })}
                                    </div>
                                )}
                            </div>
                        )
                    })()}

                    {(isAdmin || isSubAdmin) && (
                        <>
                            {!isCollapsed && (
                                <p className="text-xs font-semibold text-muted-foreground mt-4 mb-1.5 px-2">
                                    Admin
                                </p>
                            )}
                            {adminNavItems.filter(item => {
                                if (isAdmin) return true
                                if (isSubAdmin) return item.href === '/admin/orders'
                                return false
                            }).map((item) => {
                                const isActive = isLinkActive(item.href)

                                // Get badge count for this item
                                let badgeCount = 0
                                if (item.href === '/admin/orders') badgeCount = adminCounts.pendingOrders
                                else if (item.href === '/admin/top-up') badgeCount = adminCounts.pendingDebts
                                else if (item.href === '/admin/fulfillment') badgeCount = adminCounts.pendingFulfillment
                                else if (item.href === '/admin/shops') badgeCount = adminCounts.pendingShops
                                else if (item.href === '/admin/shops/withdrawals') badgeCount = adminCounts.pendingWithdrawals
                                else if (item.href === '/admin/afa-management') badgeCount = adminCounts.pendingAfa
                                else if (item.href === '/admin/memberships') badgeCount = adminCounts.expiringAgents
                                else if (item.href === '/admin/complaints') badgeCount = adminCounts.pendingComplaints

                                return (
                                    <Link
                                        key={item.href}
                                        href={item.href}
                                        className={navLinkClass}
                                        aria-current={isActive ? 'page' : undefined}
                                        aria-label={isCollapsed ? item.label : undefined}
                                        title={isCollapsed ? item.label : undefined}
                                        onClick={() => {
                                            if (window.innerWidth < 1024) closeSidebar()
                                        }}
                                    >
                                        <div className={navRowClass(isActive)}>
                                            <div className="relative">
                                                <item.icon className={navIconClass(isActive)} />
                                                {isCollapsed && badgeCount > 0 && (
                                                    <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-[#D00000] rounded-full border-2 border-[var(--ft-raised-bg)]" />
                                                )}
                                            </div>
                                            {!isCollapsed && (
                                                <>
                                                    <span className="flex-1">{item.label}</span>
                                                    {badgeCount > 0 && (
                                                        <div className="flex items-center justify-center min-w-[20px] h-5 px-1.5 bg-[#D00000] rounded-full shadow-[inset_0_1px_2px_rgba(255,255,255,0.35),inset_0_-1px_2px_rgba(0,0,0,0.25)]">
                                                            <span className="text-[10px] font-bold text-white">
                                                                {badgeCount > 9 ? '9+' : badgeCount}
                                                            </span>
                                                        </div>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    </Link>
                                )
                            })}
                        </>
                    )}
                    {/* WhatsApp Community & Logout Section */}
                    <div className="mt-4 pt-3 border-t border-foreground/10 space-y-1 pb-24 md:pb-0">
                        {communityLink && (
                            <a
                                href={communityLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={isCollapsed ? 'Join community' : undefined}
                                title={isCollapsed ? 'Join community' : undefined}
                                onClick={() => {
                                    if (window.innerWidth < 1024) closeSidebar()
                                }}
                                className={cn(
                                    "flex items-center w-full justify-start text-foreground hover:bg-foreground/5 transition-colors duration-200 min-h-10 rounded-xl px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    isCollapsed && "justify-center px-2"
                                )}
                            >
                                <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current flex-shrink-0 text-[#128C7E] dark:text-[#25D366]" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.008-.57-.008-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.88 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                                </svg>
                                {!isCollapsed && <span className="ml-3 text-sm font-medium">Join Community</span>}
                            </a>
                        )}
                        <Button
                            variant="ghost"
                            onClick={isSigningOut ? undefined : signOut}
                            disabled={isSigningOut}
                            aria-label={isCollapsed ? 'Logout' : undefined}
                            title={isCollapsed ? 'Logout' : undefined}
                            className={cn(
                                "w-full justify-start min-h-10 h-10 px-3 rounded-xl text-muted-foreground hover:text-red-700 dark:hover:text-red-300 hover:bg-red-500/10 focus-visible:ring-2 focus-visible:ring-ring",
                                isCollapsed && "justify-center px-2"
                            )}
                        >
                            {isSigningOut
                                ? <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                                : <LogOut className="w-5 h-5 flex-shrink-0" />
                            }
                            {!isCollapsed && (
                                <span className="ml-3 text-sm font-medium">
                                    {isSigningOut ? 'Signing out…' : 'Logout'}
                                </span>
                            )}
                        </Button>
                    </div>
                </nav>
            </aside >
        </>
    )
}
