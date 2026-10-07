'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUI } from '@/contexts/ui-context'
import { useNotificationModal } from '@/hooks/useNotificationModal'
import { DashboardSidebar } from '@/components/dashboard/sidebar'
import { DashboardHeader } from '@/components/dashboard/header'
import { NotificationModal } from '@/components/dashboard/NotificationModal'
import { BrandLoader } from '@/components/ui/brand-loader'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CopyrightFooter } from '@/components/CopyrightFooter'
import { FloatingRefreshButton } from '@/components/dashboard/floating-refresh-button'
import { BottomNav } from '@/components/dashboard/bottom-nav'
import { TermsGate } from '@/components/terms/terms-gate'
import { supabase } from '@/lib/supabase'

export default function AdminLayoutClient({
    children,
    adminSettings = {},
}: {
    children: React.ReactNode
    adminSettings?: Record<string, string>
}) {
    const { user, dbUser, isLoading, isAdmin, isSubAdmin } = useAuth()
    const { isCollapsed } = useUI()
    const router = useRouter()
    const pathname = usePathname()

    const { isOpen: notifOpen, setIsOpen: setNotifOpen, highlightedId, clearHighlight } = useNotificationModal()
    const [unreadCount, setUnreadCount] = useState(0)

    const handleOpenNotifications = useCallback(() => setNotifOpen(true), [setNotifOpen])
    const handleCloseNotifications = useCallback(() => setNotifOpen(false), [setNotifOpen])

    // ── Always-on background subscription for live unread count ──────────────
    useEffect(() => {
        if (!dbUser) return

        ;(supabase.from('notifications') as any)
            .select('*', { count: 'exact', head: true })
            .eq('user_id', dbUser.id)
            .eq('is_read', false)
            .then(({ count }: { count: number | null }) => setUnreadCount(count ?? 0))

        const channel = supabase
            .channel(`admin-notif-count:${dbUser.id}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${dbUser.id}` },
                () => setUnreadCount(prev => prev + 1))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `user_id=eq.${dbUser.id}` },
                () => {
                    ;(supabase.from('notifications') as any)
                        .select('*', { count: 'exact', head: true })
                        .eq('user_id', dbUser.id).eq('is_read', false)
                        .then(({ count }: { count: number | null }) => setUnreadCount(count ?? 0))
                })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'notifications', filter: `user_id=eq.${dbUser.id}` },
                () => {
                    ;(supabase.from('notifications') as any)
                        .select('*', { count: 'exact', head: true })
                        .eq('user_id', dbUser.id).eq('is_read', false)
                        .then(({ count }: { count: number | null }) => setUnreadCount(count ?? 0))
                })
            .subscribe()

        return () => { supabase.removeChannel(channel) }
    }, [dbUser])

    // Auth check — no pathname dependency so this doesn't re-run on every navigation.
    // Do NOT client-redirect on a momentary null user (a transient session-state
    // blip): middleware already gates /admin and redirects unauthenticated access
    // to /auth. Client-redirect only a CONFIRMED wrong-role user. (Mirrors the
    // dashboard layout, which renders a loader rather than bouncing.)
    useEffect(() => {
        if (isLoading || !user) return
        if (!isAdmin && !isSubAdmin) {
            router.push('/dashboard')
        }
    }, [user, isAdmin, isSubAdmin, isLoading, router])

    // Sub-admin scope lock — only triggers when pathname changes, guarded by confirmed role
    useEffect(() => {
        if (isLoading || !isSubAdmin) return
        if (pathname && !pathname.startsWith('/admin/orders')) {
            router.push('/admin/orders')
        }
    }, [isSubAdmin, pathname, isLoading, router])

    // Loader while auth resolves OR the user is momentarily null — avoids a flash/
    // bounce on a transient session blip; middleware owns the real unauth redirect.
    if (isLoading || !user) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <BrandLoader fullScreen={false} />
            </div>
        )
    }

    if (!isAdmin && !isSubAdmin) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center p-4">
                <Alert variant="destructive" className="max-w-md">
                    <ShieldAlert className="h-4 w-4" />
                    <AlertTitle>Access Denied</AlertTitle>
                    <AlertDescription>
                        You do not have permission to access the admin panel. Please contact an administrator if you believe this is an error.
                    </AlertDescription>
                </Alert>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-[#E5E7EB] dark:bg-[#000000]">
            <TermsGate minVersion={adminSettings['terms_min_acceptable_version'] || ''} effectiveDate={adminSettings['terms_effective_date']} />
            <DashboardSidebar />
            <div className={cn(
                "relative transition-[padding-left] duration-200 min-h-screen flex flex-col w-full max-w-[100vw] overflow-x-clip",
                isCollapsed ? "lg:pl-20" : "lg:pl-80"
            )}>
                <DashboardHeader
                    onOpenNotifications={handleOpenNotifications}
                    unreadCount={unreadCount}
                />
                <div className="h-16 flex-shrink-0" />
                <main className="p-4 lg:p-6 flex-1 max-lg:pb-[calc(80px+env(safe-area-inset-bottom,0px))]">
                    {children}
                </main>
                <CopyrightFooter adminSettings={adminSettings} className="hidden md:block bg-[#E5E7EB]/50 dark:bg-[#000000]/50" />
                <FloatingRefreshButton />
                <BottomNav />
            </div>
            <NotificationModal
                isOpen={notifOpen}
                onClose={handleCloseNotifications}
                highlightedId={highlightedId}
                onClearHighlight={clearHighlight}
                onUnreadCountChange={setUnreadCount}
            />
        </div>
    )
}
