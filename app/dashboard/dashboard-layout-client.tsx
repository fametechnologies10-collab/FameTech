'use client'

import { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { useNotificationModal } from '@/hooks/useNotificationModal'
import { Bell, X } from 'lucide-react'
import { useRouter, usePathname } from 'next/navigation'
import { SystemAnnouncementModal } from '@/components/system-announcement-modal'
import { SessionExpiryModal } from '@/components/session-expiry-modal'
import { AgentExpiryModal } from '@/components/agent-expiry-modal'
import { SignupPromoModal } from '@/components/signup-promo-modal'
import { TermsGate } from '@/components/terms/terms-gate'
import { NotificationModal } from '@/components/dashboard/NotificationModal'
import { BrandLoader } from '@/components/ui/brand-loader'
import { useAuth } from '@/contexts/auth-context'
import { UIProvider } from '@/contexts/ui-context'
import { ModalQueueProvider, useModalQueue, useModalQueueContext } from '@/contexts/modal-queue-context'
import { DashboardSidebar } from '@/components/dashboard/sidebar'
import { DashboardHeader } from '@/components/dashboard/header'
import { PageAccessGuard } from '@/components/dashboard/page-access-guard'
import { cn } from '@/lib/utils'
import { useUI } from '@/contexts/ui-context'
import { SuspendedAccount } from '@/components/dashboard/SuspendedAccount'
import { CopyrightFooter } from '@/components/CopyrightFooter'
import { FloatingRefreshButton } from '@/components/dashboard/floating-refresh-button'
import { BottomNav } from '@/components/dashboard/bottom-nav'
import { Button } from '@/components/ui/button'
import { supabase } from '@/lib/supabase'


export default function DashboardLayoutClient({
    children,
    adminSettings = {},
    communityLink,
    signupPromoRole = null,
}: {
    children: React.ReactNode
    adminSettings?: Record<string, string>
    communityLink?: string
    signupPromoRole?: 'dealer' | 'agent' | null
}) {
    const { user, dbUser, isLoading } = useAuth()
    const { isCollapsed, isAnnouncementBellOpen } = useUI()
    const router = useRouter()
    const pathname = usePathname()
    const { permission, isSupported, isSubscribing, requestPermission } = usePushNotifications()
    const [bannerDismissed, setBannerDismissed] = useState(false)

    // ── Notification modal state (root-level) ─────────────────────────────────
    const { isOpen: notifOpen, setIsOpen: setNotifOpen, highlightedId, clearHighlight } = useNotificationModal()
    const [unreadCount, setUnreadCount] = useState(0)

    const handleOpenNotifications = useCallback(() => setNotifOpen(true), [setNotifOpen])
    const handleCloseNotifications = useCallback(() => setNotifOpen(false), [setNotifOpen])

    // ── Always-on background subscription for live unread count ──────────────
    // Runs independently of modal open/close so the badge stays accurate
    // even while the modal is closed.
    useEffect(() => {
        if (!dbUser) return

        // Initial count fetch
        ;(supabase.from('notifications') as any)
            .select('*', { count: 'exact', head: true })
            .eq('user_id', dbUser.id)
            .eq('is_read', false)
            .then(({ count }: { count: number | null }) => {
                setUnreadCount(count ?? 0)
            })

        // Live channel — listens for INSERT and UPDATE on this user's notifications
        const channel = supabase
            .channel(`layout-notif-count:${dbUser.id}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'notifications',
                filter: `user_id=eq.${dbUser.id}`,
            }, () => {
                // New notification arrived — bump the badge
                setUnreadCount(prev => prev + 1)
            })
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'notifications',
                filter: `user_id=eq.${dbUser.id}`,
            }, () => {
                // A notification was marked read — re-fetch the count accurately
                ;(supabase.from('notifications') as any)
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', dbUser.id)
                    .eq('is_read', false)
                    .then(({ count }: { count: number | null }) => {
                        setUnreadCount(count ?? 0)
                    })
            })
            .on('postgres_changes', {
                event: 'DELETE',
                schema: 'public',
                table: 'notifications',
                filter: `user_id=eq.${dbUser.id}`,
            }, () => {
                // A notification was deleted — re-fetch count to stay accurate
                ;(supabase.from('notifications') as any)
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', dbUser.id)
                    .eq('is_read', false)
                    .then(({ count }: { count: number | null }) => {
                        setUnreadCount(count ?? 0)
                    })
            })
            .subscribe()

        return () => { supabase.removeChannel(channel) }
    }, [dbUser])

    // ── Profile-completeness guard (Layer 2) ─────────────────────────────────
    // Derived before any early returns so hooks are always called unconditionally.
    // updateUser({ password }) for OAuth users does NOT add an email identity —
    // we rely on user_metadata.has_password written by complete-profile instead.
    const isGoogleUser   = user?.identities?.some((id: any) => id.provider === 'google') ?? false
    const hasPassword    = (user?.user_metadata?.has_password === true)
        || (user?.identities?.some((id: any) => id.provider === 'email') ?? false)
    const profileComplete = !isLoading && !!user && !!dbUser
        && (!!dbUser.phone_number && (!isGoogleUser || hasPassword))

    useEffect(() => {
        if (!isLoading && user && dbUser && !profileComplete) {
            router.replace('/auth/complete-profile')
        }
    }, [isLoading, user, dbUser, profileComplete, router])

    // Show loader while auth is resolving, profile is incomplete, or redirect is pending.
    if (isLoading || !user || !dbUser || !profileComplete) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <BrandLoader fullScreen={false} />
            </div>
        )
    }

    // A timed suspension lapses on its own the moment suspended_until passes (the
    // cron flips the DB status back to active shortly after; this makes the UI honor
    // it immediately). Staff (admin/sub-admin) are never gated here.
    const _suspUntil = (dbUser as any)?.suspended_until ? new Date((dbUser as any).suspended_until).getTime() : null
    const _stillSuspended = dbUser?.status === 'suspended' && (_suspUntil === null || _suspUntil > Date.now())
    const isSuspended = _stillSuspended && dbUser?.role !== 'admin' && dbUser?.role !== 'sub-admin'

    // Suspended users keep access to Support & Complaints so they can appeal —
    // purchases/top-ups stay blocked server-side regardless of this UI gate.
    const suspensionExempt = pathname?.startsWith('/dashboard/complaints')

    if (isSuspended && !suspensionExempt) {
        return (
            <div className="min-h-screen bg-background relative">
                <DashboardSidebar communityLink={communityLink} />
                <div className={cn(
                    "relative transition-all duration-300 ease-in-out min-h-screen flex flex-col w-full max-w-[100vw] overflow-x-clip",
                    isCollapsed ? "lg:pl-20" : "lg:pl-80"
                )}>
                    <DashboardHeader
                        onOpenNotifications={handleOpenNotifications}
                        unreadCount={unreadCount}
                    />
                    <div className="h-16 flex-shrink-0" />
                    <main className="p-4 lg:p-6 flex-1">
                        <SuspendedAccount />
                    </main>
                    <CopyrightFooter adminSettings={adminSettings} className="bg-transparent" />
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

    return (
        <ModalQueueProvider>
        <div className="min-h-screen bg-background relative">
            <TermsGate minVersion={adminSettings['terms_min_acceptable_version'] || ''} effectiveDate={adminSettings['terms_effective_date']} />
            <SignupPromoModal promoRole={signupPromoRole} />
            <SystemAnnouncementModal />

            {/* ── Web Push Permission Toast (queue-aware, 8 s delay) ─────── */}
            <PushPermissionToast
                isSupported={isSupported}
                permission={permission}
                bannerDismissed={bannerDismissed}
                isAnnouncementBellOpen={isAnnouncementBellOpen}
                isSubscribing={isSubscribing}
                onEnable={async () => { await requestPermission(); setBannerDismissed(true) }}
                onDismiss={() => setBannerDismissed(true)}
            />

            <AgentExpiryModal />
            <SessionExpiryModal />
            <DashboardSidebar communityLink={communityLink} />
            <div className={cn(
                "relative transition-all duration-300 ease-in-out min-h-screen flex flex-col w-full max-w-[100vw] overflow-x-clip",
                isCollapsed ? "lg:pl-20" : "lg:pl-80"
            )}>
                <DashboardHeader
                    onOpenNotifications={handleOpenNotifications}
                    unreadCount={unreadCount}
                />
                <div className="h-16 flex-shrink-0" />
                <main className="p-4 lg:p-6 flex-1 max-lg:pb-[calc(80px+env(safe-area-inset-bottom,0px))]">
                    <PageAccessGuard>
                        {children}
                    </PageAccessGuard>
                </main>
                <CopyrightFooter adminSettings={adminSettings} className="hidden md:block bg-transparent" />
            </div>

            {/* ── Notification Modal (root-level, portals to document.body) ── */}
            <NotificationModal
                isOpen={notifOpen}
                onClose={handleCloseNotifications}
                highlightedId={highlightedId}
                onClearHighlight={clearHighlight}
                onUnreadCountChange={setUnreadCount}
            />

            <FloatingRefreshButton />
            <BottomNav />
        </div>
        </ModalQueueProvider>
    )
}

// ── Push permission toast — isolated so it can read the modal queue context ──
function PushPermissionToast({
    isSupported, permission, bannerDismissed, isAnnouncementBellOpen,
    isSubscribing, onEnable, onDismiss,
}: {
    isSupported: boolean
    permission: NotificationPermission | 'unsupported'
    bannerDismissed: boolean
    isAnnouncementBellOpen: boolean
    isSubscribing: boolean
    onEnable: () => Promise<void>
    onDismiss: () => void
}) {
    const { hasActiveModal } = useModalQueueContext()
    const [ready, setReady] = useState(false)

    // Delay showing the push toast so it never competes with opening modals
    useEffect(() => {
        const t = setTimeout(() => setReady(true), 8000)
        return () => clearTimeout(t)
    }, [])

    const show = isSupported && permission === 'default' && !bannerDismissed
        && !isAnnouncementBellOpen && !hasActiveModal && ready

    return (
        <AnimatePresence>
            {show && (
                <motion.div
                    className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+88px)] md:bottom-6 right-4 md:right-6 z-[9999] w-[calc(100vw-2rem)] max-w-sm"
                    initial={{ y: 40, opacity: 0, scale: 0.95 }}
                    animate={{ y: 0, opacity: 1, scale: 1 }}
                    exit={{ y: 40, opacity: 0, scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                >
                    <div className="ft-card flex items-start gap-3 p-4 rounded-2xl">
                        <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center mt-0.5">
                            <Bell className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-foreground text-xs font-bold mb-0.5">Stay in the loop</p>
                            <p className="text-muted-foreground text-[11px] leading-relaxed">Get alerts for orders, payouts and important updates.</p>
                            <div className="flex items-center gap-2 mt-2.5">
                                <Button
                                    type="button"
                                    size="sm"
                                    onClick={onEnable}
                                    disabled={isSubscribing}
                                    className="text-[11px] font-bold"
                                >
                                    {isSubscribing ? 'Turning on…' : 'Turn on notifications'}
                                </Button>
                                <Button type="button" variant="ghost" size="sm" onClick={onDismiss}
                                    className="text-[11px] font-medium focus-visible:ring-2 focus-visible:ring-ring">
                                    Not now
                                </Button>
                            </div>
                        </div>
                        <button type="button" onClick={onDismiss} aria-label="Dismiss"
                            className="flex-shrink-0 w-10 h-10 -mt-2 -mr-2 inline-flex items-center justify-center rounded-xl text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
