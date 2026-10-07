'use client'

import { useMemo, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { useNotificationsList } from '@/hooks/useNotificationsList'
import { NotifIcon, iconBg } from '@/components/dashboard/notification-visuals'
import { NotificationMessage } from '@/components/dashboard/notification-message'
import { categoryForType, CATEGORY_ORDER, CATEGORY_LABEL, type NotificationCategory } from '@/lib/notification-categories'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDate } from '@/lib/utils'
import { Bell, Check, Trash2, Search, Loader2, CheckCircle2 } from 'lucide-react'
import type { Notification } from '@/types/supabase'

type CatFilter = 'all' | NotificationCategory

function groupLabel(iso: string): 'Today' | 'Yesterday' | 'Earlier' {
    const d = new Date(iso); const now = new Date()
    const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
    if (sameDay(d, now)) return 'Today'
    const y = new Date(now); y.setDate(now.getDate() - 1)
    if (sameDay(d, y)) return 'Yesterday'
    return 'Earlier'
}

export default function NotificationsInbox({ highlightId }: { highlightId?: string | null }) {
    const { dbUser } = useAuth()
    const router = useRouter()
    const {
        notifications, isLoading, isLoadingMore, hasMore, loadMore,
        markAsRead, markAllAsRead, deleteNotif, deleteAll, unreadCount,
    } = useNotificationsList(dbUser?.id)

    const [cat, setCat] = useState<CatFilter>('all')
    const [onlyUnread, setOnlyUnread] = useState(false)
    const [query, setQuery] = useState('')

    const filtered = useMemo(() => {
        return notifications.filter(n => {
            if (cat !== 'all' && categoryForType(n.type) !== cat) return false
            if (onlyUnread && n.is_read) return false
            if (query.trim()) {
                const q = query.toLowerCase()
                if (!n.title.toLowerCase().includes(q) && !n.message.toLowerCase().includes(q)) return false
            }
            return true
        })
    }, [notifications, cat, onlyUnread, query])

    const groups = useMemo(() => {
        const g: Record<string, Notification[]> = { Today: [], Yesterday: [], Earlier: [] }
        for (const n of filtered) g[groupLabel(n.created_at ?? new Date().toISOString())].push(n)
        return g
    }, [filtered])

    useEffect(() => {
        if (!highlightId || isLoading) return
        const t = setTimeout(() => {
            document.getElementById(`notif-row-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 200)
        return () => clearTimeout(t)
    }, [highlightId, isLoading])

    const handleClick = async (n: Notification) => {
        if (!n.is_read) await markAsRead(n.id)
        if (n.action_url) router.push(n.action_url)
    }

    return (
        <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex flex-col gap-3">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                        value={query} onChange={e => setQuery(e.target.value)}
                        placeholder="Search notifications"
                        className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                </div>
                <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                    {(['all', ...CATEGORY_ORDER] as CatFilter[]).map(c => (
                        <button key={c} type="button" onClick={() => setCat(c)}
                            className={cn('px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors',
                                cat === c ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900'
                                    : 'text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700')}>
                            {c === 'all' ? 'All' : CATEGORY_LABEL[c]}
                        </button>
                    ))}
                    <span className="w-px h-5 bg-gray-200 dark:bg-gray-700 mx-1 flex-shrink-0" />
                    <button type="button" onClick={() => setOnlyUnread(v => !v)}
                        className={cn('px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors',
                            onlyUnread ? 'bg-blue-600 text-white' : 'text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700')}>
                        Unread ({unreadCount})
                    </button>
                </div>
                <div className="flex items-center gap-2">
                    {unreadCount > 0 && (
                        <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={markAllAsRead}>
                            <Check className="w-3.5 h-3.5" /> Mark all read
                        </Button>
                    )}
                    {notifications.length > 0 && (
                        <Button size="sm" variant="outline" className="gap-1.5 text-xs text-red-500 hover:text-red-600" onClick={() => { if (confirm('Clear all notifications?')) deleteAll() }}>
                            <Trash2 className="w-3.5 h-3.5" /> Clear all
                        </Button>
                    )}
                </div>
            </div>

            {/* List */}
            {isLoading ? (
                <div className="space-y-2">
                    {[...Array(6)].map((_, i) => (
                        <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800">
                            <Skeleton className="w-9 h-9 rounded-full" />
                            <div className="flex-1 space-y-1.5"><Skeleton className="h-3 w-1/2" /><Skeleton className="h-3 w-full" /></div>
                        </div>
                    ))}
                </div>
            ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                    <div className="w-14 h-14 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center"><Bell className="w-6 h-6 text-gray-400" /></div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{query || cat !== 'all' || onlyUnread ? 'Nothing matches this filter' : 'No notifications yet'}</p>
                </div>
            ) : (
                <div className="space-y-5">
                    {(['Today', 'Yesterday', 'Earlier'] as const).map(label => groups[label].length > 0 && (
                        <div key={label} className="space-y-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 px-1">{label}</p>
                            {groups[label].map(n => (
                                <div key={n.id} id={`notif-row-${n.id}`}
                                    onClick={() => handleClick(n)}
                                    className={cn('group relative flex items-start gap-3 p-3 rounded-xl cursor-pointer bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors',
                                        !n.is_read && 'border-l-[3px] border-l-blue-500',
                                        n.id === highlightId && 'ring-2 ring-blue-400')}>
                                    <div className={cn('w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5', iconBg(n.type))}>
                                        <NotifIcon type={n.type} />
                                    </div>
                                    <div className="flex-1 min-w-0 pr-6">
                                        <p className={cn('text-sm font-semibold leading-snug', n.is_read ? 'text-gray-600 dark:text-gray-300' : 'text-gray-900 dark:text-white')}>{n.title}</p>
                                        <NotificationMessage
                                            message={n.message}
                                            className="text-xs text-gray-600 dark:text-gray-400 mt-0.5"
                                        />
                                        <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1.5">{formatDate(n.created_at ?? '')}</p>
                                    </div>
                                    {!n.is_read && <span className="absolute top-3.5 right-3 w-2 h-2 rounded-full bg-blue-500" />}
                                    <div className="absolute right-2 top-2 hidden group-hover:flex items-center gap-1 bg-white dark:bg-gray-800 rounded-lg p-0.5 shadow-sm border border-gray-100 dark:border-gray-700">
                                        {!n.is_read && (
                                            <button type="button" title="Mark as read" onClick={e => { e.stopPropagation(); markAsRead(n.id) }}
                                                className="w-6 h-6 flex items-center justify-center rounded-md text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/30"><CheckCircle2 className="w-3.5 h-3.5" /></button>
                                        )}
                                        <button type="button" title="Delete" onClick={e => { e.stopPropagation(); deleteNotif(n.id) }}
                                            className="w-6 h-6 flex items-center justify-center rounded-md text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"><Trash2 className="w-3.5 h-3.5" /></button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ))}
                    {hasMore && !query && cat === 'all' && !onlyUnread && (
                        <div className="flex justify-center pt-2">
                            <Button variant="outline" size="sm" onClick={loadMore} disabled={isLoadingMore} className="gap-1.5">
                                {isLoadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Load more
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
