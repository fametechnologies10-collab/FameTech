'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
    Clock,
    Star,
    Settings,
    ShoppingCart,
    Zap,
    ZapOff,
    Sun,
    CloudSun,
    Sunset,
    Moon,
} from 'lucide-react'
import AutoUpgradeQuickModal from '@/components/upgrade/AutoUpgradeQuickModal'

interface RoleGreetingBoxProps {
    stats?: {
        totalOrders: number
    }
}

function getGreeting(): string {
    const h = new Date().getHours()
    if (h >= 5 && h < 12) return 'Good Morning'
    if (h >= 12 && h < 17) return 'Good Afternoon'
    if (h >= 17 && h < 21) return 'Good Evening'
    return 'Good Night'
}

type TimeConfig = {
    Icon: React.ComponentType<{ className?: string }>
    iconColor: string
    iconBg: string
}

function getTimeConfig(): TimeConfig {
    const h = new Date().getHours()
    if (h >= 5 && h < 12)  return { Icon: Sun,      iconColor: 'text-amber-500',  iconBg: 'bg-amber-50 dark:bg-amber-900/30'   }
    if (h >= 12 && h < 17) return { Icon: CloudSun,  iconColor: 'text-sky-500',    iconBg: 'bg-sky-50 dark:bg-sky-900/30'       }
    if (h >= 17 && h < 21) return { Icon: Sunset,    iconColor: 'text-orange-500', iconBg: 'bg-orange-50 dark:bg-orange-900/30' }
    return                          { Icon: Moon,     iconColor: 'text-indigo-400', iconBg: 'bg-indigo-50 dark:bg-indigo-900/30' }
}

function getStaticDateTime(): { dateStr: string; timeStr: string } {
    const now = new Date()
    const dateStr = now.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    })
    const timeStr = now.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
    })
    return { dateStr, timeStr }
}

function getTimeSinceJoined(createdAt?: string): string {
    if (!createdAt) return 'Recently'
    const diffDays = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000)
    if (diffDays < 30) return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`
    if (diffDays < 365) {
        const months = Math.floor(diffDays / 30)
        return `${months} ${months === 1 ? 'month' : 'months'} ago`
    }
    const years = Math.floor(diffDays / 365)
    return `${years} ${years === 1 ? 'year' : 'years'} ago`
}

const ROLE_PILL: Record<string, { label: string; dot: string; pill: string }> = {
    admin:     { label: 'System Administrator', dot: 'bg-red-500',    pill: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800' },
    sub_admin: { label: 'Sub-Administrator',    dot: 'bg-indigo-500', pill: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-800' },
    dealer:    { label: 'Authorized Dealer',    dot: 'bg-violet-500', pill: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800' },
    agent:     { label: 'Authorized Agent',     dot: 'bg-amber-500',  pill: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800' },
    subagent:  { label: 'Sub-Agent',            dot: 'bg-teal-500',   pill: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-800' },
    customer:  { label: 'Valued Customer',      dot: 'bg-blue-500',   pill: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800' },
}

export function RoleGreetingBox({ stats }: RoleGreetingBoxProps) {
    const { dbUser, isAdmin, isSubAdmin, refreshUser } = useAuth()
    const [autoUpgradeModal, setAutoUpgradeModal] = useState<'enable' | 'manage' | null>(null)

    if (!dbUser) return null

    const { dateStr, timeStr } = getStaticDateTime()
    const { Icon: TimeIcon, iconColor, iconBg } = getTimeConfig()

    const roleKey = isAdmin ? 'admin' : isSubAdmin ? 'sub_admin' : (dbUser.role ?? 'customer')
    const roleCfg = ROLE_PILL[roleKey] ?? ROLE_PILL.customer

    const daysRemaining = (() => {
        if (dbUser.role === 'agent' && dbUser.agent_expires_at) {
            const d = Math.ceil((new Date(dbUser.agent_expires_at).getTime() - Date.now()) / 86400000)
            return d > 0 ? d : 0
        }
        if (dbUser.role === 'dealer' && (dbUser as any).dealer_expires_at) {
            const d = Math.ceil((new Date((dbUser as any).dealer_expires_at).getTime() - Date.now()) / 86400000)
            return d > 0 ? d : 0
        }
        return null
    })()

    const autoUpgradeEnabled: boolean = (dbUser as any)?.auto_upgrade_enabled ?? false
    const autoUpgradePlan: string | null = (dbUser as any)?.auto_upgrade_plan ?? null
    const roleExpiresAt: string | null = dbUser.role === 'dealer'
        ? (dbUser as any)?.dealer_expires_at ?? null
        : dbUser.agent_expires_at ?? null

    const isExpiring = daysRemaining !== null && daysRemaining <= 7
    const isDealerExpiring = dbUser.role === 'dealer' && daysRemaining !== null && daysRemaining <= 14

    return (
        <>
            {autoUpgradeModal && (dbUser.role === 'agent' || dbUser.role === 'dealer') && (
                <AutoUpgradeQuickModal
                    mode={autoUpgradeModal}
                    userRole={dbUser.role as 'agent' | 'dealer'}
                    expiresAt={roleExpiresAt}
                    currentPlan={autoUpgradePlan}
                    firstName={dbUser.first_name ?? ''}
                    onClose={() => setAutoUpgradeModal(null)}
                    onUpdated={async () => {
                        setAutoUpgradeModal(null)
                        await refreshUser()
                    }}
                />
            )}

            <div className="rounded-2xl border border-border bg-card text-card-foreground shadow-sm overflow-hidden">

                {/* Header */}
                <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                    <div className="flex flex-col gap-1">
                        <div className={cn(
                            'inline-flex items-center gap-1.5 w-fit px-2.5 py-1 rounded-full border text-[10px] font-semibold tracking-wide mb-1',
                            roleCfg.pill
                        )}>
                            <span className={cn('w-1.5 h-1.5 rounded-full', roleCfg.dot)} />
                            {roleCfg.label}
                        </div>
                        <h2 className="text-lg sm:text-xl font-bold text-foreground leading-tight flex items-center gap-2.5">
                            <span className={cn('inline-flex items-center justify-center w-8 h-8 rounded-xl flex-shrink-0', iconBg)}>
                                <TimeIcon className={cn('w-4 h-4', iconColor)} />
                            </span>
                            {getGreeting()}, {dbUser.first_name}
                        </h2>
                        <p className="text-xs text-muted-foreground pl-[2.625rem]">
                            Here's an overview of your transactions and recent activity.
                        </p>
                    </div>
                    <div className="flex flex-row sm:flex-col items-center sm:items-end gap-2 sm:gap-0.5 flex-shrink-0">
                        <p className="text-[11px] text-muted-foreground font-medium">{dateStr}</p>
                        <p className="text-sm font-semibold text-foreground">{timeStr}</p>
                    </div>
                </div>

                <div className="border-t border-border" />

                <div className="divide-y divide-border">

                    {/* Membership countdown — agent / dealer */}
                    {(dbUser.role === 'agent' || dbUser.role === 'dealer') && daysRemaining !== null && (
                        <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5">
                                <Clock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                <div>
                                    <p className="text-xs font-semibold text-foreground">Membership</p>
                                    <span className={cn(
                                        'text-[10px] font-bold px-1.5 py-0.5 rounded-full',
                                        daysRemaining > 7
                                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                            : daysRemaining > 3
                                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                                : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                    )}>
                                        {daysRemaining > 0 ? 'Active' : 'Expired'}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <p className={cn(
                                    'text-sm font-semibold tabular-nums',
                                    daysRemaining <= 3 ? 'text-red-600 dark:text-red-400'
                                        : daysRemaining <= 7 ? 'text-amber-600 dark:text-amber-400'
                                            : 'text-foreground'
                                )}>
                                    {daysRemaining > 0 ? `${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'} left` : 'Expired'}
                                </p>
                                {(isExpiring || isDealerExpiring) && (
                                    <Link href="/dashboard/upgrade">
                                        <Button size="sm" className="h-7 px-3 text-[11px] bg-green-600 hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-400 text-white border-0 shadow-none">
                                            Renew
                                        </Button>
                                    </Link>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Auto-upgrade — agent / dealer */}
                    {(dbUser.role === 'agent' || dbUser.role === 'dealer') && (
                        <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5">
                                {autoUpgradeEnabled
                                    ? <Zap className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" />
                                    : <ZapOff className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                }
                                <div>
                                    <p className="text-xs font-semibold text-foreground">Auto-Upgrade</p>
                                    {autoUpgradeEnabled && autoUpgradePlan && (
                                        <p className="text-[10px] text-muted-foreground capitalize">
                                            {autoUpgradePlan === '6m' ? '6 Months Dealer' : `${autoUpgradePlan} Agent`}
                                        </p>
                                    )}
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className={cn(
                                    'text-[10px] font-bold px-2 py-0.5 rounded border',
                                    autoUpgradeEnabled
                                        ? 'text-green-700 bg-green-50 border-green-200 dark:text-green-400 dark:bg-green-900/30 dark:border-green-800'
                                        : 'text-muted-foreground bg-muted border-border'
                                )}>
                                    {autoUpgradeEnabled ? 'ON' : 'OFF'}
                                </span>
                                <button
                                    onClick={() => setAutoUpgradeModal(autoUpgradeEnabled ? 'manage' : 'enable')}
                                    className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors font-medium"
                                >
                                    {autoUpgradeEnabled ? 'Manage' : 'Enable'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Admin panel shortcut */}
                    {(isAdmin || isSubAdmin) && (
                        <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5">
                                <Settings className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                <p className="text-xs font-semibold text-foreground">System Access</p>
                            </div>
                            <Link href="/admin">
                                <Button size="sm" variant="outline" className="h-7 px-3 text-[11px] font-semibold border-border">
                                    Admin Panel →
                                </Button>
                            </Link>
                        </div>
                    )}

                    {/* Customer: total orders */}
                    {dbUser.role === 'customer' && (
                        <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5">
                                <ShoppingCart className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                <p className="text-xs font-semibold text-foreground">Total Orders</p>
                            </div>
                            <p className="text-sm font-bold text-foreground tabular-nums">{stats?.totalOrders ?? 0}</p>
                        </div>
                    )}

                    {/* Member Since — all roles */}
                    <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5">
                            <Star className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                            <p className="text-xs font-semibold text-foreground">Member Since</p>
                        </div>
                        <p className="text-sm font-semibold text-foreground">
                            {getTimeSinceJoined(dbUser.created_at ?? undefined)}
                        </p>
                    </div>

                </div>
            </div>
        </>
    )
}
