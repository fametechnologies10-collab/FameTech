'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion'
import {
    type LucideIcon,
    Activity, BadgeCheck, Banknote, Bell, ClipboardList, Code2,
    Crown, FileText, Headphones, Key, LayoutDashboard, LayoutGrid, Lightbulb,
    Menu, MessageSquare, Package, Phone, Send, Settings, Shield, ShoppingCart,
    Store, Tag, TrendingUp, User, Users, Wallet, Wifi,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { useUI } from '@/contexts/ui-context'
import { useModalQueueContextSafe } from '@/contexts/modal-queue-context'

// ── Dynamic 6th-tab route registries ────────────────────────────────────────
// Keys sorted longest-first so prefix matching picks the most specific route.
const USER_REGISTRY: Record<string, { label: string; icon: LucideIcon }> = {
    '/dashboard/shop/orders':     { label: 'Sh.Orders', icon: ShoppingCart },
    '/dashboard/shop/pricing':    { label: 'Pricing',   icon: Tag },
    '/dashboard/shop/setup':      { label: 'Sh.Setup',  icon: Settings },
    '/dashboard/shop/withdraw':   { label: 'Withdraw',  icon: Banknote },
    '/dashboard/results-checker': { label: 'Results',   icon: FileText },
    '/dashboard/transactions':    { label: 'Activity',  icon: Activity },
    '/dashboard/notifications':   { label: 'Alerts',    icon: Bell },
    '/dashboard/utilities':       { label: 'Utilities', icon: Lightbulb },
    '/dashboard/complaints':      { label: 'Support',   icon: Headphones },
    '/dashboard/afa-orders':      { label: 'AFA',       icon: BadgeCheck },
    '/dashboard/developers':      { label: 'Dev',       icon: Code2 },
    '/dashboard/sms':             { label: 'SMS',       icon: Send },
    '/dashboard/airtime':         { label: 'Airtime',   icon: Phone },
    '/dashboard/profile':         { label: 'Profile',   icon: User },
    '/dashboard/upgrade':         { label: 'Upgrade',   icon: Crown },
    '/dashboard/api':             { label: 'API',       icon: Code2 },
}

const ADMIN_REGISTRY: Record<string, { label: string; icon: LucideIcon }> = {
    '/admin/ishare':              { label: 'iShare',      icon: Wifi },
    '/admin/utilities':           { label: 'Utilities',   icon: Lightbulb },
    '/admin/shops/withdrawals':   { label: 'Withdrawals', icon: Banknote },
    '/admin/shops/settings':      { label: 'Sh.Settings', icon: Settings },
    '/admin/profits-history':     { label: 'Profits',     icon: TrendingUp },
    '/admin/afa-management':      { label: 'AFA',         icon: BadgeCheck },
    '/admin/sms-broadcast':       { label: 'SMS',         icon: MessageSquare },
    '/admin/sms-platform':        { label: 'SMS Plat.',   icon: Send },
    '/admin/momo-claims':         { label: 'MoMo',        icon: Wallet },
    '/admin/results-checker':     { label: 'Results',     icon: FileText },
    '/admin/profit-logs':         { label: 'Profit Logs', icon: TrendingUp },
    '/admin/transactions':        { label: 'Txns',        icon: Activity },
    '/admin/mtn-logs':            { label: 'MTN Logs',    icon: Activity },
    '/admin/dealerships':         { label: 'Dealers',     icon: Store },
    '/admin/memberships':         { label: 'Members',     icon: Users },
    '/admin/complaints':          { label: 'Complaints',  icon: MessageSquare },
    '/admin/announcements':       { label: 'Announce',    icon: Bell },
    '/admin/api-keys':            { label: 'API Keys',    icon: Key },
    '/admin/packages':            { label: 'Packages',    icon: Package },
    '/admin/settings':            { label: 'Settings',    icon: Settings },
    '/admin/finance':             { label: 'Finance',     icon: Banknote },
    '/admin/datagod':             { label: 'DataGod',     icon: Activity },
    '/admin/shops':               { label: 'Shops',       icon: Store },
    '/admin/roles':               { label: 'Roles',       icon: Users },
    '/admin/users':               { label: 'Users',       icon: Users },
    '/admin':                     { label: 'Dashboard',   icon: Shield },
}

// ── Role-based colors — bar background mirrors the sidebar ───────────────────
const ROLE_COLORS = {
    admin: {
        barBg:      'bg-[#E5E7EB] dark:bg-[#000000]',
        barBorder:  'border-gray-300 dark:border-gray-800',
        barShadow:  'shadow-[0_-2px_20px_rgba(0,0,0,0.08)] dark:shadow-[0_-2px_20px_rgba(0,0,0,0.5)]',
        activeBg:   'bg-red-600',
        activeText: 'text-white dark:text-black',
        inactiveIcon: 'text-gray-500 dark:text-gray-400',
    },
    'sub-admin': {
        barBg:      'bg-[#E5E7EB] dark:bg-[#000000]',
        barBorder:  'border-gray-300 dark:border-gray-800',
        barShadow:  'shadow-[0_-2px_20px_rgba(0,0,0,0.08)] dark:shadow-[0_-2px_20px_rgba(0,0,0,0.5)]',
        activeBg:   'bg-yellow-400',
        activeText: 'text-black',
        inactiveIcon: 'text-gray-500 dark:text-gray-400',
    },
    dealer: {
        barBg:      'bg-gradient-to-b from-violet-600 to-violet-800',
        barBorder:  'border-violet-900/30',
        barShadow:  'shadow-[0_-2px_20px_rgba(124,58,237,0.35)]',
        activeBg:   'bg-white',
        activeText: 'text-violet-800',  // 7.1:1 contrast on white
        inactiveIcon: 'text-white/80',  // boosted for legibility on violet
    },
    agent: {
        barBg:      'bg-[#E5E7EB] dark:bg-[#000000]',
        barBorder:  'border-gray-300 dark:border-gray-800',
        barShadow:  'shadow-[0_-2px_20px_rgba(0,0,0,0.08)] dark:shadow-[0_-2px_20px_rgba(0,0,0,0.5)]',
        activeBg:   'bg-yellow-400',
        activeText: 'text-black',
        inactiveIcon: 'text-gray-500 dark:text-gray-400',
    },
    customer: {
        barBg:      'bg-[#E5E7EB] dark:bg-[#000000]',
        barBorder:  'border-gray-300 dark:border-gray-800',
        barShadow:  'shadow-[0_-2px_20px_rgba(0,0,0,0.08)] dark:shadow-[0_-2px_20px_rgba(0,0,0,0.5)]',
        activeBg:   'bg-blue-600',
        activeText: 'text-white',
        inactiveIcon: 'text-gray-500 dark:text-gray-400',
    },
    subagent: {
        barBg:      'bg-[#E5E7EB] dark:bg-[#000000]',
        barBorder:  'border-gray-300 dark:border-gray-800',
        barShadow:  'shadow-[0_-2px_20px_rgba(0,0,0,0.08)] dark:shadow-[0_-2px_20px_rgba(0,0,0,0.5)]',
        activeBg:   'bg-[#0D9488]',
        activeText: 'text-white',
        inactiveIcon: 'text-gray-500 dark:text-gray-400',
    },
} as const

type RoleKey = keyof typeof ROLE_COLORS

type NavItem = {
    label: string
    href: string
    icon: LucideIcon
    isActive: boolean
}

export function BottomNav() {
    const pathname = usePathname()
    const { dbUser, isAdmin, isSubAdmin } = useAuth()
    const { isInternalSidebarOpen, toggleSidebar } = useUI()
    const { hasActiveModal } = useModalQueueContextSafe()

    // Hint is permanently dismissed only when the user clicks "Got it".
    // Until then it reappears on every dashboard load.
    const [hintSeen, setHintSeen] = useState(() =>
        typeof window !== 'undefined' && !!localStorage.getItem('kfg_nav_tip_ack')
    )
    const [hintReady, setHintReady] = useState(false)
    const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Portal to document.body so no transformed / overflow-clipped ancestor can
    // turn this fixed bar into a scroll-following element (iOS Safari containing-block bug).
    const [mounted, setMounted] = useState(false)
    useEffect(() => setMounted(true), [])

    // ── Auto-hide on scroll (premium fintech pattern) ─────────────────────────
    // Hide when scrolling DOWN (reading), reveal when scrolling UP or near the top.
    // rAF-throttled window listener; 6px threshold kills jitter from momentum scroll.
    const [scrollHidden, setScrollHidden] = useState(false)
    const lastYRef = useRef(0)
    const tickingRef = useRef(false)
    useEffect(() => {
        const update = () => {
            const y = window.scrollY
            const last = lastYRef.current
            if (y < 48) setScrollHidden(false)              // always show near the top
            else if (y > last + 6) setScrollHidden(true)    // scrolling down → hide
            else if (y < last - 6) setScrollHidden(false)   // scrolling up → reveal
            lastYRef.current = y
            tickingRef.current = false
        }
        const onScroll = () => {
            if (!tickingRef.current) {
                tickingRef.current = true
                requestAnimationFrame(update)
            }
        }
        window.addEventListener('scroll', onScroll, { passive: true })
        return () => window.removeEventListener('scroll', onScroll)
    }, [])

    // While the sidebar is open the bar is already hidden; keep scrollHidden reset
    // so closing the sidebar always brings the bar straight back (no stuck-hidden state).
    useEffect(() => {
        if (isInternalSidebarOpen) setScrollHidden(false)
    }, [isInternalSidebarOpen])

    // Wait for modal queue to clear, then delay 2.5 s before showing.
    // Resets the timer whenever the queue becomes active again.
    useEffect(() => {
        if (hintSeen) return
        if (hasActiveModal) {
            if (hintTimerRef.current) { clearTimeout(hintTimerRef.current); hintTimerRef.current = null }
            setHintReady(false)
            return
        }
        hintTimerRef.current = setTimeout(() => setHintReady(true), 2500)
        return () => {
            if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
        }
    }, [hintSeen, hasActiveModal])

    const showHint = !hintSeen && hintReady && !isInternalSidebarOpen && !scrollHidden

    const handleHintGotIt = useCallback(() => {
        setHintSeen(true)
        setHintReady(false)
        localStorage.setItem('kfg_nav_tip_ack', '1')
    }, [])

    const role: RoleKey = isAdmin
        ? 'admin'
        : isSubAdmin
            ? 'sub-admin'
            : ((dbUser?.role as RoleKey) ?? 'customer')

    const colors = ROLE_COLORS[role] ?? ROLE_COLORS.customer
    const isAdminArea = isAdmin || isSubAdmin

    const handleSidebarToggle = useCallback(() => {
        toggleSidebar()
    }, [toggleSidebar])

    // ── Default nav items ────────────────────────────────────────────────────
    const adminBase: NavItem[] = [
        { label: 'Top Up',   href: '/admin/top-up',       icon: Wallet,       isActive: pathname === '/admin/top-up' },
        { label: 'Orders',   href: '/admin/orders',        icon: ShoppingCart, isActive: pathname === '/admin/orders' },
        { label: 'Fulfill',  href: '/admin/fulfillment',   icon: Activity,     isActive: pathname === '/admin/fulfillment' },
        { label: 'Announce', href: '/admin/announcements', icon: Bell,         isActive: pathname === '/admin/announcements' },
        { label: 'Airtime',  href: '/admin/airtime',       icon: Phone,        isActive: pathname === '/admin/airtime' },
    ]

    const userBase: NavItem[] = [
        { label: 'Home',   href: '/dashboard',               icon: LayoutDashboard, isActive: pathname === '/dashboard' },
        { label: 'Wallet', href: '/dashboard/wallet',        icon: Wallet,          isActive: pathname === '/dashboard/wallet' },
        { label: 'Data',   href: '/dashboard/data-packages', icon: Package,         isActive: pathname === '/dashboard/data-packages' },
        { label: 'Orders', href: '/dashboard/my-orders',     icon: ClipboardList,   isActive: pathname === '/dashboard/my-orders' },
        { label: 'Shop',   href: '/dashboard/shop',          icon: Store,           isActive: pathname.startsWith('/dashboard/shop') },
    ]

    const baseItems = isAdminArea ? adminBase : userBase

    // ── Dynamic 6th tab for off-nav pages ────────────────────────────────────
    const navItems: NavItem[] = (() => {
        if (baseItems.some(i => i.isActive)) return baseItems
        const registry = isAdminArea ? ADMIN_REGISTRY : USER_REGISTRY
        const sortedEntries = Object.entries(registry).sort((a, b) => b[0].length - a[0].length)
        const found = registry[pathname]
            ?? sortedEntries.find(([key]) => pathname.startsWith(key + '/'))?.[1]
        return [
            ...baseItems,
            { label: found?.label ?? 'More', href: pathname, icon: found?.icon ?? LayoutGrid, isActive: true },
        ]
    })()

    if (!mounted) return null

    return createPortal(
        <>
            {/* Nav hint — shows every login until user taps "Got it" */}
            <AnimatePresence>
                {showHint && (
                    <motion.div
                        className="lg:hidden fixed z-[52] left-4 right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+80px)] flex justify-center"
                        initial={{ opacity: 0, y: 8, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.96 }}
                        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                    >
                        <div className="relative bg-slate-900 dark:bg-slate-100 rounded-2xl px-4 py-3 shadow-2xl max-w-xs w-full">
                            {/* Arrow pointer */}
                            <div className="absolute -bottom-[6px] left-1/2 -translate-x-1/2 w-3 h-3 bg-slate-900 dark:bg-slate-100 rotate-45 rounded-[3px]" />

                            <p className="text-white dark:text-slate-900 text-[12px] font-semibold text-center mb-2.5 leading-snug">
                                Tap the active tab again to open the side menu
                            </p>
                            <button
                                type="button"
                                onClick={handleHintGotIt}
                                className="w-full py-1.5 rounded-xl bg-white/20 dark:bg-slate-900/20 hover:bg-white/30 dark:hover:bg-slate-900/30 active:scale-95 transition-all text-white dark:text-slate-900 text-[11px] font-bold tracking-wide"
                            >
                                Got it!
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Nav bar — slides away when the sidebar opens OR when scrolling down */}
            <AnimatePresence>
                {!isInternalSidebarOpen && !scrollHidden && (
                    <motion.div
                        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 px-2 xs:px-3 sm:px-4 pb-[calc(env(safe-area-inset-bottom,0px)+8px)]"
                        initial={{ y: 100, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: 100, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 380, damping: 36 }}
                    >
                        <div className="flex items-stretch gap-2">
                            {/* Dedicated sidebar opener — always-visible, obvious entry to the side menu */}
                            <button
                                type="button"
                                onClick={handleSidebarToggle}
                                aria-label="Open side menu"
                                className={cn(
                                    'flex-shrink-0 w-14 rounded-full flex items-center justify-center border active:scale-90 transition-transform',
                                    colors.barBg,
                                    colors.barBorder,
                                    colors.barShadow,
                                    colors.inactiveIcon
                                )}
                            >
                                <Menu className="w-6 h-6 stroke-[2.2]" />
                            </button>
                            <LayoutGroup id="kfg-bottom-nav">
                            <div className={cn(
                                'flex-1 min-w-0 rounded-full flex items-center p-2.5 border',
                                colors.barBg,
                                colors.barBorder,
                                colors.barShadow
                            )}>
                                {navItems.map((item) => {
                                    const Icon = item.icon
                                    return (
                                        <motion.div
                                            key={item.label}
                                            layout
                                            className={cn('relative min-w-0', item.isActive ? 'flex-[2]' : 'flex-1')}
                                            transition={{ type: 'spring', stiffness: 500, damping: 42 }}
                                        >
                                            <Link
                                                href={item.href}
                                                onClick={(e) => {
                                                    if (item.isActive) {
                                                        e.preventDefault()
                                                        handleSidebarToggle()
                                                    }
                                                }}
                                                className="relative flex items-center justify-center h-12 w-full rounded-full overflow-hidden active:opacity-75 transition-opacity"
                                            >
                                                {item.isActive && (
                                                    <motion.div
                                                        layoutId="kfg-active-pill"
                                                        className={cn('absolute inset-0 rounded-full', colors.activeBg)}
                                                        transition={{ type: 'spring', stiffness: 500, damping: 42 }}
                                                    />
                                                )}
                                                {item.isActive ? (
                                                    /* Active pill: icon + label + always-visible sidebar toggle hint */
                                                    <div className={cn('relative z-10 flex items-center gap-1.5 px-3', colors.activeText)}>
                                                        <Icon className="w-[18px] h-[18px] stroke-[2.2] flex-shrink-0" />
                                                        <span className="text-[11px] font-bold whitespace-nowrap truncate">
                                                            {item.label}
                                                        </span>
                                                        <Menu className="w-2.5 h-2.5 opacity-40 flex-shrink-0" />
                                                    </div>
                                                ) : (
                                                    /* Inactive: icon stacked above tiny label */
                                                    <div className={cn('relative z-10 flex flex-col items-center justify-center gap-0.5 w-full', colors.inactiveIcon)}>
                                                        <Icon className="w-[18px] h-[18px] stroke-[2] flex-shrink-0" />
                                                        <span className="text-[9px] font-semibold leading-none tracking-tight truncate max-w-full px-1">
                                                            {item.label}
                                                        </span>
                                                    </div>
                                                )}
                                            </Link>
                                        </motion.div>
                                    )
                                })}
                            </div>
                            </LayoutGroup>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>,
        document.body
    )
}
