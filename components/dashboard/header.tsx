'use client'

import { useState, useEffect } from 'react'
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
import { roleConfig } from '@/lib/roles'
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

    return (
        <header className={cn(
            "fixed top-0 left-0 z-40 h-16 backdrop-blur-xl border-b transition-all duration-300 ease-in-out",
            "w-full lg:left-80 lg:w-[calc(100%-20rem)]",
            isCollapsed && "lg:left-20 lg:w-[calc(100%-5rem)]",
            dbUser?.role === 'agent'
                ? "bg-gradient-to-b from-yellow-400 via-amber-500 to-amber-600 border-amber-600/20 shadow-sm"
                : dbUser?.role === 'dealer'
                    ? "bg-gradient-to-b from-violet-600 via-purple-700 to-violet-800 border-violet-800/20 shadow-sm"
                    : dbUser?.role === 'subagent'
                        ? "bg-gradient-to-b from-teal-500 via-teal-600 to-teal-700 border-teal-700/20 shadow-sm"
                        : "bg-white/80 dark:bg-gray-900/80 border-gray-200 dark:border-gray-800"
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
                        className="hidden sm:flex text-xs"
                        style={{
                            backgroundColor: currentRole.color,
                            color: isSubAdmin ? 'black' : 'white'
                        }}
                    >
                        {currentRole.label}
                    </Badge>

                    {/* Notifications bell — opens modal, no page navigation */}
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onOpenNotifications}
                        aria-label="Open notifications"
                        className={cn(
                            "relative",
                            dbUser?.role === 'agent' ? "text-black hover:bg-black/10" : dbUser?.role === 'dealer' || dbUser?.role === 'subagent' ? "text-white hover:bg-white/10" : ""
                        )}
                    >
                        <Bell className={cn(
                            "w-5 h-5",
                            dbUser?.role === 'agent' ? "text-black" : dbUser?.role === 'dealer' || dbUser?.role === 'subagent' ? "text-white" : "text-gray-500 dark:text-gray-400"
                        )} />
                        {unreadCount > 0 && (
                            <span className={cn(
                                "absolute -top-1 -right-1 w-5 h-5 text-xs rounded-full flex items-center justify-center font-semibold",
                                dbUser?.role === 'agent' ? "bg-black text-[#FFCE00]" : dbUser?.role === 'dealer' || dbUser?.role === 'subagent' ? "bg-white text-violet-700" : "bg-red-500 text-white"
                            )}>
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
                                className={cn("relative", dbUser?.role === 'agent' ? "text-black hover:bg-black/10" : dbUser?.role === 'dealer' || dbUser?.role === 'subagent' ? "text-white hover:bg-white/10" : "")}
                            >
                                <Headphones className={cn("w-5 h-5", dbUser?.role === 'agent' ? "text-black" : dbUser?.role === 'dealer' || dbUser?.role === 'subagent' ? "text-white" : "text-gray-500 dark:text-gray-400")} />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="w-56" align="end" forceMount>
                            <DropdownMenuLabel className="font-normal">
                                <div className="flex flex-col space-y-1">
                                    <p className="text-sm font-semibold leading-none">Customer Support</p>
                                    <p className="text-xs leading-none text-muted-foreground mt-1">Get help from our team</p>
                                </div>
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild>
                                <Link href="/dashboard/complaints" className="cursor-pointer flex items-center">
                                    <Headphones className="mr-2 h-4 w-4" />
                                    <span>Support Center</span>
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <a href={supportContacts.email ? `mailto:${supportContacts.email}` : '#'} className="cursor-pointer flex items-center">
                                    <Mail className="mr-2 h-4 w-4" />
                                    <span>Email Support</span>
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
                                    <span>WhatsApp Chat</span>
                                </a>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* User Menu */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="relative h-10 w-10 rounded-full">
                                <Avatar className="h-10 w-10 ring-2 ring-primary/20 transition-transform hover:scale-105 active:scale-95">
                                    <AvatarFallback className="text-white font-semibold flex items-center justify-center delay-0 duration-0" style={{ backgroundColor: currentRole.color }}>
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
                                        className="w-fit mt-1 text-[10px] px-1.5 py-0"
                                        style={{
                                            backgroundColor: isAdmin ? '#E60000' : isSubAdmin ? '#FACC15' : dbUser?.role === 'agent' ? '#25D366' : dbUser?.role === 'dealer' ? '#7C3AED' : dbUser?.role === 'subagent' ? '#0D9488' : '#0056B3',
                                            color: isSubAdmin ? 'black' : 'white'
                                        }}
                                    >
                                        {isAdmin ? 'Admin' : isSubAdmin ? 'Sub-Admin' : dbUser?.role === 'agent' ? 'Agent' : dbUser?.role === 'dealer' ? 'Dealer' : dbUser?.role === 'subagent' ? 'Sub-Agent' : 'Customer'}
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
                                    <span>API Documentation</span>
                                </DropdownMenuItem>
                            </Link>
                            {isAdmin && (
                                <>
                                    <Link href="/admin/settings">
                                        <DropdownMenuItem>
                                            <Settings className="mr-2 h-4 w-4" />
                                            <span>Admin Settings</span>
                                        </DropdownMenuItem>
                                    </Link>
                                    <Link href="/admin/api-keys">
                                        <DropdownMenuItem>
                                            <Key className="mr-2 h-4 w-4" />
                                            <span>API Keys Approval</span>
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
