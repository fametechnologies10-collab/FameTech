'use client'

import { useState, useEffect, type CSSProperties } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { useUI } from '@/contexts/ui-context'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { PWAInstallButton } from '@/components/pwa-install-prompt'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { roleConfig, roleTheme } from '@/lib/roles'
import { supabase } from '@/lib/supabase'
import { Bell, User, Settings, LogOut, Headphones, Mail, MessageCircle, Key, Code2, Loader2 } from 'lucide-react'
import { cn, normalizeWhatsAppNumber } from '@/lib/utils'
import { getSupportContacts } from '@/app/actions/support'
import { HybridHeaderTitle } from '@/components/dashboard/HybridHeaderTitle'

interface DashboardHeaderProps {
    /** Called when the bell icon is clicked — opens the notification modal in the parent layout */
    onOpenNotifications: () => void
    /** Live unread count driven by the parent layout's realtime state */
    unreadCount: number
}

export function DashboardHeader({ onOpenNotifications, unreadCount }: DashboardHeaderProps) {
    const { dbUser, signOut, isSigningOut, isAdmin, isSubAdmin } = useAuth()
    const { isCollapsed } = useUI()
    const [supportContacts, setSupportContacts] = useState({ whatsapp: '', email: '' })

    useEffect(() => {
        if (dbUser) {
            getSupportContacts().then(setSupportContacts)
        }
    }, [dbUser])

    const getInitials = () => {
        if (!dbUser) return 'U'
        return `${dbUser.first_name?.[0] || ''}${dbUser.last_name?.[0] || ''}`.toUpperCase()
    }

    const userRole = isAdmin ? 'admin' : isSubAdmin ? 'sub-admin' : (dbUser?.role || 'customer') as keyof typeof roleConfig
    const currentRole = roleConfig[userRole] || roleConfig['customer']
    const RoleIcon = currentRole.icon
    // Sentence case for the visible badge only; lib/roles.ts labels stay as-is for admin pages
    const roleLabel = currentRole.label === 'Sub-Admin' ? 'Sub-admin' : currentRole.label === 'Sub-Agent' ? 'Sub-agent' : currentRole.label
    const theme = roleTheme[userRole] ?? roleTheme['customer']
    // Same technique as the sidebar: chip/ring colours come only from roleTheme, exposed as CSS variables
    const roleVars = {
        '--chip-bg': theme.chipLight.bg,
        '--chip-fg': theme.chipLight.text,
        '--chip-bg-d': theme.chipDark.bg,
        '--chip-fg-d': theme.chipDark.text,
        '--tw-ring-color': theme.ring
    } as CSSProperties
    const chipClass = "bg-[color:var(--chip-bg)] text-[color:var(--chip-fg)] dark:bg-[color:var(--chip-bg-d)] dark:text-[color:var(--chip-fg-d)]"

    return (
        <header className={cn(
            "fixed top-0 left-0 z-40 h-16 ft-card transition-all duration-300 ease-in-out",
            "w-full lg:left-80 lg:w-[calc(100%-20rem)]",
            isCollapsed && "lg:left-20 lg:w-[calc(100%-5rem)]"
        )}>
            <div className="h-full px-4 lg:px-6 flex items-center justify-between">
                <HybridHeaderTitle role={dbUser?.role ?? undefined} />

                {/* Right Side Actions */}
                <div className="flex items-center gap-2">
                    <div className="hidden sm:block">
                        <PWAInstallButton />
                    </div>
                    <ThemeToggle />

                    {/* Role Badge */}
                    <Badge
                        className={cn("hidden sm:flex text-xs", chipClass)}
                        style={roleVars}
                    >
                        {roleLabel}
                    </Badge>

                    {/* Notifications bell — opens modal, no page navigation */}
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onOpenNotifications}
                        aria-label="Open notifications"
                        className="relative text-foreground"
                    >
                        <Bell className="w-5 h-5 text-muted-foreground" />
                        {unreadCount > 0 && (
                            <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 text-xs rounded-full flex items-center justify-center font-semibold bg-[#D00000] text-white">
                                {unreadCount > 9 ? '9+' : unreadCount}
                            </span>
                        )}
                    </Button>

                    {/* Customer Support */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Customer support"
                                className="relative text-foreground"
                            >
                                <Headphones className="w-5 h-5 text-muted-foreground" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="w-56" align="end" forceMount>
                            <DropdownMenuLabel className="font-normal">
                                <div className="flex flex-col space-y-1">
                                    <p className="text-sm font-semibold leading-none">Customer support</p>
                                    <p className="text-xs leading-none text-muted-foreground mt-1">Get help from our team</p>
                                </div>
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild>
                                <Link href="/dashboard/complaints" className="cursor-pointer flex items-center">
                                    <Headphones className="mr-2 h-4 w-4" />
                                    <span>Help center</span>
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <a href={supportContacts.email ? `mailto:${supportContacts.email}` : '#'} className="cursor-pointer flex items-center">
                                    <Mail className="mr-2 h-4 w-4" />
                                    <span>Email support</span>
                                </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <a
                                    href={supportContacts.whatsapp ? `https://wa.me/${normalizeWhatsAppNumber(supportContacts.whatsapp)}` : '#'}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="cursor-pointer flex items-center"
                                >
                                    <MessageCircle className="mr-2 h-4 w-4" />
                                    <span>WhatsApp chat</span>
                                </a>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* User Menu */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="relative h-10 w-10 rounded-full">
                                <Avatar className="h-10 w-10 ring-[3px] transition-transform hover:scale-105 active:scale-95" style={roleVars}>
                                    <AvatarFallback className={cn("font-semibold flex items-center justify-center delay-0 duration-0", chipClass)}>
                                        <RoleIcon className="w-5 h-5" />
                                    </AvatarFallback>
                                </Avatar>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="w-56" align="end" forceMount>
                            <DropdownMenuLabel className="font-normal">
                                <div className="flex flex-col space-y-1">
                                    <p className="text-sm font-medium leading-none">
                                        {dbUser?.first_name} {dbUser?.last_name}
                                    </p>
                                    <p className="text-xs leading-none text-muted-foreground">
                                        {dbUser?.email}
                                    </p>
                                    <Badge
                                        className={cn("w-fit mt-1 text-[10px] px-1.5 py-0", chipClass)}
                                        style={roleVars}
                                    >
                                        {isAdmin ? 'Admin' : isSubAdmin ? 'Sub-admin' : dbUser?.role === 'agent' ? 'Agent' : dbUser?.role === 'dealer' ? 'Dealer' : dbUser?.role === 'subagent' ? 'Sub-agent' : 'Customer'}
                                    </Badge>
                                </div>
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <Link href="/dashboard/profile">
                                <DropdownMenuItem>
                                    <User className="mr-2 h-4 w-4" />
                                    <span>Profile</span>
                                </DropdownMenuItem>
                            </Link>
                            {(isAdmin || dbUser?.role === 'agent' || dbUser?.role === 'dealer') && (
                                <Link href="/dashboard/api">
                                    <DropdownMenuItem>
                                        <Key className="mr-2 h-4 w-4" />
                                        <span>Developer API</span>
                                    </DropdownMenuItem>
                                </Link>
                            )}
                            <Link href="/developers">
                                <DropdownMenuItem>
                                    <Code2 className="mr-2 h-4 w-4" />
                                    <span>API documentation</span>
                                </DropdownMenuItem>
                            </Link>
                            {isAdmin && (
                                <>
                                    <Link href="/admin/settings">
                                        <DropdownMenuItem>
                                            <Settings className="mr-2 h-4 w-4" />
                                            <span>Admin settings</span>
                                        </DropdownMenuItem>
                                    </Link>
                                    <Link href="/admin/api-keys">
                                        <DropdownMenuItem>
                                            <Key className="mr-2 h-4 w-4" />
                                            <span>API keys approval</span>
                                        </DropdownMenuItem>
                                    </Link>
                                </>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                onClick={isSigningOut ? undefined : signOut}
                                disabled={isSigningOut}
                                className="text-red-600"
                            >
                                {isSigningOut
                                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    : <LogOut className="mr-2 h-4 w-4" />
                                }
                                <span>{isSigningOut ? 'Signing out…' : 'Log out'}</span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        </header>
    )
}
