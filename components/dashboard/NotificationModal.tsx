'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/lib/toast'
import { Notification } from '@/types/supabase'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import {
    Bell,
    BellOff,
    X,
    Check,
    Trash2,
    Trash,
    Loader2,
    CheckCircle2,
    Download,
    Settings,
    ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createPortal } from 'react-dom'
import { NotifIcon, iconBg } from '@/components/dashboard/notification-visuals'
import { NotificationMessage } from '@/components/dashboard/notification-message'

// ── Types ─────────────────────────────────────────────────────────────────────
interface NotificationModalProps {
    isOpen: boolean
    onClose: () => void
    highlightedId: string | null
    onClearHighlight: () => void
    onUnreadCountChange?: (count: number) => void
}

// Notification icon + background are shared with the full notifications page
// via components/dashboard/notification-visuals (single source of truth).

// EGRESS: this query used to be unbounded. `notifications` grows without limit
// per account, so a long-lived user re-downloaded their ENTIRE history on every
// open. The list is newest-first and the footer links to the full page, so 50
// rows is more than the modal ever shows.
const NOTIFICATION_FETCH_LIMIT = 50

// EGRESS: re-opens within this window reuse the rows already in state instead of
// re-querying. The realtime INSERT subscription below keeps the list current
// while mounted, so a re-open has nothing new to fetch. This also makes the
// fetch effect idempotent if `fetchNotifications` changes identity on a
// re-render (it depends on `dbUser`), which previously caused a full re-query.
const REFETCH_STALE_MS = 60_000

// ── Main component ────────────────────────────────────────────────────────────
export function NotificationModal({
    isOpen,
    onClose,
    highlightedId,
    onClearHighlight,
    onUnreadCountChange,
}: NotificationModalProps) {
    const { dbUser } = useAuth()
    const router = useRouter()
    const { permission, isSupported, isSubscribing, requestPermission } = usePushNotifications()

    const [notifications, setNotifications] = useState<Notification[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [filter, setFilter] = useState<'all' | 'unread'>('all')
    const [markingAllRead, setMarkingAllRead] = useState(false)
    const [deletingAll, setDeletingAll] = useState(false)
    const [mounted, setMounted] = useState(false)

    // PWA install prompt
    const [installPrompt, setInstallPrompt] = useState<any>(null)
    const [isInstalled, setIsInstalled] = useState(false)
    const [isInstalling, setIsInstalling] = useState(false)

    const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const hasFetchedRef = useRef(false)
    const lastFetchedAtRef = useRef(0)

    // ── Swipe-down-to-close (mobile bottom sheet) ─────────────────────────────
    // Direct DOM manipulation avoids per-frame React re-renders during the gesture
    const panelRef = useRef<HTMLDivElement>(null)
    const dragStartY = useRef(0)
    const dragDelta = useRef(0)
    const [isDragging, setIsDragging] = useState(false)

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        dragStartY.current = e.touches[0].clientY
        dragDelta.current = 0
        setIsDragging(true)
    }, [])

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
        const delta = e.touches[0].clientY - dragStartY.current
        if (delta > 0 && panelRef.current) {
            dragDelta.current = delta
            panelRef.current.style.transform = `translateY(${delta}px)`
            panelRef.current.style.opacity = String(Math.max(0, 1 - delta / 300))
        }
    }, [])

    const handleTouchEnd = useCallback(() => {
        const delta = dragDelta.current
        if (panelRef.current) {
            panelRef.current.style.transform = ''
            panelRef.current.style.opacity = ''
        }
        dragDelta.current = 0
        setIsDragging(false)
        if (delta > 90) onClose()
    }, [onClose])

    useEffect(() => { setMounted(true) }, [])

    // Detect PWA install state
    useEffect(() => {
        if (typeof window === 'undefined') return
        const standalone =
            window.matchMedia('(display-mode: standalone)').matches ||
            (window.navigator as any).standalone === true
        setIsInstalled(standalone)

        const handler = (e: Event) => {
            e.preventDefault()
            setInstallPrompt(e)
        }
        window.addEventListener('beforeinstallprompt', handler)
        window.addEventListener('appinstalled', () => setIsInstalled(true))
        return () => {
            window.removeEventListener('beforeinstallprompt', handler)
        }
    }, [])

    // Lock body scroll while modal is open (avoid touching html — it breaks position:fixed)
    useEffect(() => {
        if (!isOpen) return
        const scrollY = window.scrollY
        document.body.style.position = 'fixed'
        document.body.style.top = `-${scrollY}px`
        document.body.style.width = '100%'
        return () => {
            document.body.style.position = ''
            document.body.style.top = ''
            document.body.style.width = ''
            window.scrollTo(0, scrollY)
        }
    }, [isOpen])

    // ── Fetch ─────────────────────────────────────────────────────────────────
    const fetchNotifications = useCallback(async (showLoading = true) => {
        if (!dbUser) return
        if (showLoading) setIsLoading(true)
        try {
            const { data, error } = await (supabase
                .from('notifications') as any)
                .select('*')
                .eq('user_id', dbUser.id)
                .order('created_at', { ascending: false })
                .limit(NOTIFICATION_FETCH_LIMIT)

            if (error) throw error
            const rows: Notification[] = data || []
            lastFetchedAtRef.current = Date.now()
            setNotifications(rows)
            onUnreadCountChange?.(rows.filter(n => !n.is_read).length)
        } catch {
            toast.error('Failed to load notifications')
        } finally {
            setIsLoading(false)
        }
    }, [dbUser, onUnreadCountChange])

    // First open: show skeleton. Re-opens: show cached rows instantly, and only
    // hit the network again if they have actually gone stale (see REFETCH_STALE_MS).
    useEffect(() => {
        if (!isOpen || !dbUser) return

        if (!hasFetchedRef.current) {
            hasFetchedRef.current = true
            fetchNotifications(true)
            return
        }

        if (Date.now() - lastFetchedAtRef.current >= REFETCH_STALE_MS) {
            fetchNotifications(false)
        }
    }, [isOpen, dbUser, fetchNotifications])

    // ── Realtime subscription ────────────────────────────────────────────────
    useEffect(() => {
        if (!dbUser || !isOpen) return

        const channel = supabase
            .channel(`notifications:${dbUser.id}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'notifications',
                filter: `user_id=eq.${dbUser.id}`,
            }, (payload) => {
                setNotifications(prev => [payload.new as Notification, ...prev])
            })
            .subscribe()

        return () => { supabase.removeChannel(channel) }
    }, [dbUser, isOpen])

    useEffect(() => {
        onUnreadCountChange?.(notifications.filter(n => !n.is_read).length)
    }, [notifications, onUnreadCountChange])

    // ── Highlight scroll ─────────────────────────────────────────────────────
    useEffect(() => {
        if (!highlightedId || isLoading) return

        const tryScroll = () => {
            const el = document.getElementById(`notif-${highlightedId}`)
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
                highlightTimerRef.current = setTimeout(() => onClearHighlight(), 3000)
            }
        }

        const t = setTimeout(tryScroll, 150)
        return () => {
            clearTimeout(t)
            if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
        }
    }, [highlightedId, isLoading, onClearHighlight])

    // ── Actions ───────────────────────────────────────────────────────────────
    const markAsRead = async (id: string) => {
        await (supabase.from('notifications') as any).update({ is_read: true }).eq('id', id)
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n))
    }

    const handleNotifClick = async (notif: Notification) => {
        if (!notif.is_read) await markAsRead(notif.id)
        if (notif.action_url) {
            onClose()
            router.push(notif.action_url)
        }
    }

    const markAllAsRead = async () => {
        setMarkingAllRead(true)
        try {
            await (supabase.from('notifications') as any)
                .update({ is_read: true })
                .eq('user_id', dbUser?.id)
                .eq('is_read', false)
            setNotifications(prev => prev.map(n => ({ ...n, is_read: true })))
            toast.success('All notifications marked as read')
        } catch {
            toast.error('Failed to mark all as read')
        } finally {
            setMarkingAllRead(false)
        }
    }

    const deleteNotif = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation()
        await (supabase.from('notifications') as any).delete().eq('id', id)
        setNotifications(prev => prev.filter(n => n.id !== id))
        toast.success('Notification deleted')
    }

    const deleteAll = async () => {
        setDeletingAll(true)
        try {
            await (supabase.from('notifications') as any).delete().eq('user_id', dbUser?.id)
            setNotifications([])
            toast.success('All notifications cleared')
        } catch {
            toast.error('Failed to clear notifications')
        } finally {
            setDeletingAll(false)
        }
    }

    const handleInstall = async () => {
        if (!installPrompt) return
        setIsInstalling(true)
        try {
            await installPrompt.prompt()
            const { outcome } = await installPrompt.userChoice
            if (outcome === 'accepted') {
                setIsInstalled(true)
                setInstallPrompt(null)
            }
        } catch {
            // user dismissed
        } finally {
            setIsInstalling(false)
        }
    }

    // ── Derived ───────────────────────────────────────────────────────────────
    const unreadCount = notifications.filter(n => !n.is_read).length
    const filtered = filter === 'unread' ? notifications.filter(n => !n.is_read) : notifications

    const showPushPrompt = isSupported && permission === 'default'
    const showInstallPrompt = !isInstalled && !!installPrompt

    if (!mounted) return null

    const modal = (
        <>
            {/* Backdrop — subtle dim, transparent enough to see page */}
            <div
                className={cn(
                    'fixed inset-0 z-50 bg-black/20 transition-opacity duration-200',
                    isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
                )}
                onClick={onClose}
                aria-hidden="true"
            />

            {/* Panel — semi-transparent, no blur */}
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label="Notifications"
                className={cn(
                    'fixed z-[51]',
                    isDragging ? '' : 'transition-[transform,opacity] duration-200 ease-out',
                    // Mobile: full-width bottom sheet
                    'bottom-0 left-0 right-0 rounded-t-2xl',
                    // Desktop: top-right drawer
                    'sm:bottom-auto sm:top-4 sm:right-4 sm:left-auto sm:w-[420px] sm:rounded-2xl',
                    isOpen
                        ? 'translate-y-0 opacity-100 sm:translate-y-0 pointer-events-auto'
                        : 'translate-y-full opacity-0 pointer-events-none sm:translate-y-[-12px]',
                    'bg-white/95 dark:bg-gray-900/95 border border-gray-200/70 dark:border-gray-700/70',
                    'shadow-xl',
                    'max-h-[85dvh] sm:max-h-[80vh] flex flex-col',
                )}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            >
                {/* Drag handle — mobile bottom sheet only */}
                <div className="sm:hidden flex justify-center pt-2.5 pb-1 flex-shrink-0">
                    <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
                </div>

                {/* ── Header ───────────────────────────────────────────────── */}
                <div className="flex items-center justify-between px-4 py-3 sm:px-5 sm:py-4 border-b border-gray-200/60 dark:border-gray-700/60 flex-shrink-0">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                            <Bell className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                        </div>
                        <div>
                            <h2 className="text-sm font-semibold text-gray-900 dark:text-white leading-tight">Notifications</h2>
                            <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-tight">
                                {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up!'}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                        {unreadCount > 0 && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={markAllAsRead}
                                disabled={markingAllRead}
                                className="h-8 px-2.5 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-xs gap-1"
                            >
                                {markingAllRead ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                <span>Mark all read</span>
                            </Button>
                        )}
                        {notifications.length > 0 && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={deleteAll}
                                disabled={deletingAll}
                                className="h-8 px-2.5 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 text-xs gap-1"
                            >
                                {deletingAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash className="w-3 h-3" />}
                                <span>Clear all</span>
                            </Button>
                        )}
                        <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => { onClose(); router.push('/dashboard/notifications?tab=settings') }}
                            title="Notification settings"
                            className="w-8 h-8 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white flex-shrink-0"
                        >
                            <Settings className="w-4 h-4" />
                        </Button>
                        <Button
                            size="icon"
                            variant="ghost"
                            onClick={onClose}
                            className="w-8 h-8 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white flex-shrink-0"
                        >
                            <X className="w-4 h-4" />
                        </Button>
                    </div>
                </div>

                {/* ── Filter tabs ──────────────────────────────────────────── */}
                <div className="flex gap-1.5 px-4 sm:px-5 py-2.5 border-b border-gray-200/60 dark:border-gray-700/60 flex-shrink-0">
                    {(['all', 'unread'] as const).map(tab => (
                        <button
                            type="button"
                            key={tab}
                            onClick={() => setFilter(tab)}
                            className={cn(
                                'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                                filter === tab
                                    ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900'
                                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800'
                            )}
                        >
                            {tab === 'all' ? `All (${notifications.length})` : `Unread (${unreadCount})`}
                        </button>
                    ))}
                </div>

                {/* ── Action prompts (push + install) — only when needed ────── */}
                {(showPushPrompt || showInstallPrompt) && (
                    <div className="flex flex-col gap-2 px-3 sm:px-4 pt-2.5 pb-1 flex-shrink-0">
                        {showPushPrompt && (
                            <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900/50">
                                <div className="flex items-center gap-2.5 min-w-0">
                                    <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center flex-shrink-0">
                                        <Bell className="w-3.5 h-3.5 text-blue-500" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-xs font-semibold text-blue-900 dark:text-blue-200 leading-tight truncate">Enable Notifications</p>
                                        <p className="text-[10px] text-blue-600 dark:text-blue-400 leading-tight">Get real-time order updates</p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={async () => { await requestPermission() }}
                                    disabled={isSubscribing}
                                    className="flex-shrink-0 px-3 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-[11px] font-semibold transition-colors disabled:opacity-60"
                                >
                                    {isSubscribing ? 'Enabling...' : 'Enable'}
                                </button>
                            </div>
                        )}

                        {showInstallPrompt && (
                            <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900/50">
                                <div className="flex items-center gap-2.5 min-w-0">
                                    <div className="w-7 h-7 rounded-full bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center flex-shrink-0">
                                        <Download className="w-3.5 h-3.5 text-emerald-500" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200 leading-tight truncate">Install the App</p>
                                        <p className="text-[10px] text-emerald-600 dark:text-emerald-400 leading-tight">Faster push notifications & offline access</p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={handleInstall}
                                    disabled={isInstalling}
                                    className="flex-shrink-0 px-3 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-semibold transition-colors disabled:opacity-60"
                                >
                                    {isInstalling ? 'Installing...' : 'Install'}
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* ── List ─────────────────────────────────────────────────── */}
                <div className="flex-1 overflow-y-auto overscroll-contain scroll-smooth px-3 sm:px-4 py-2 space-y-2 notif-list-scroll">
                    {isLoading ? (
                        <div className="space-y-2 py-1">
                            {[...Array(4)].map((_, i) => (
                                <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-800">
                                    <Skeleton className="w-9 h-9 rounded-full flex-shrink-0" />
                                    <div className="flex-1 space-y-1.5">
                                        <Skeleton className="h-3 w-3/4 rounded" />
                                        <Skeleton className="h-3 w-full rounded" />
                                        <Skeleton className="h-2.5 w-1/3 rounded" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-14 gap-3 text-center">
                            <div className="w-14 h-14 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                                <Bell className="w-6 h-6 text-gray-400" />
                            </div>
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                                {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
                            </p>
                        </div>
                    ) : (
                        filtered.map(notif => {
                            const isHighlighted = notif.id === highlightedId
                            return (
                                <div
                                    key={notif.id}
                                    id={`notif-${notif.id}`}
                                    onClick={() => handleNotifClick(notif)}
                                    className={cn(
                                        'group relative flex items-start gap-3 p-3 rounded-xl cursor-pointer',
                                        'bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700',
                                        'transition-colors duration-150',
                                        'hover:bg-gray-50 dark:hover:bg-gray-700',
                                        !notif.is_read && 'border-l-[3px] border-l-blue-500',
                                        isHighlighted && 'bg-blue-50 dark:bg-blue-950/40 border-l-[3px] border-l-blue-500'
                                    )}
                                >
                                    {/* Icon bubble */}
                                    <div className={cn(
                                        'w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5',
                                        iconBg(notif.type)
                                    )}>
                                        <NotifIcon type={notif.type} />
                                    </div>

                                    {/* Content */}
                                    <div className="flex-1 min-w-0 pr-6">
                                        <p className={cn(
                                            'text-sm font-semibold leading-snug truncate',
                                            notif.is_read ? 'text-gray-600 dark:text-gray-300' : 'text-gray-900 dark:text-white'
                                        )}>
                                            {notif.title}
                                        </p>
                                        <NotificationMessage
                                            message={notif.message}
                                            className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 leading-relaxed"
                                        />
                                        <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1.5">
                                            {formatDate(notif.created_at ?? '')}
                                        </p>
                                    </div>

                                    {/* Unread dot */}
                                    {!notif.is_read && (
                                        <span className="absolute top-3.5 right-3 w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                                    )}

                                    {/* Actions — revealed on hover */}
                                    <div className="absolute right-2 top-2 hidden group-hover:flex items-center gap-1 bg-white dark:bg-gray-700 rounded-lg p-0.5 shadow-sm border border-gray-100 dark:border-gray-600">
                                        {!notif.is_read && (
                                            <button
                                                type="button"
                                                onClick={async (e) => { e.stopPropagation(); await markAsRead(notif.id) }}
                                                title="Mark as read"
                                                className="w-6 h-6 flex items-center justify-center rounded-md text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                                            >
                                                <CheckCircle2 className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={(e) => deleteNotif(e, notif.id)}
                                            title="Delete"
                                            className="w-6 h-6 flex items-center justify-center rounded-md text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                            )
                        })
                    )}
                </div>

                {/* ── Footer: see-all link + mobile drag handle ─────────────── */}
                <div className="flex-shrink-0 border-t border-gray-200/60 dark:border-gray-700/60">
                    <button
                        type="button"
                        onClick={() => { onClose(); router.push('/dashboard/notifications') }}
                        className="w-full flex items-center justify-center gap-1 py-3 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors"
                    >
                        See all notifications <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                    <div className="flex justify-center pb-2.5 sm:hidden">
                        <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
                    </div>
                </div>
            </div>
        </>
    )

    return createPortal(modal, document.body)
}
