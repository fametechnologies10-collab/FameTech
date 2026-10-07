'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import type { Notification } from '@/types/supabase'

export const PAGE_SIZE = 20

export function useNotificationsList(userId?: string) {
    const [notifications, setNotifications] = useState<Notification[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isLoadingMore, setIsLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const offsetRef = useRef(0)

    const fetchPage = useCallback(async (reset: boolean) => {
        if (!userId) return
        if (reset) { setIsLoading(true); offsetRef.current = 0 } else { setIsLoadingMore(true) }
        const from = offsetRef.current
        const to = from + PAGE_SIZE - 1
        const { data, error } = await (supabase.from('notifications') as any)
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(from, to)
        if (!error) {
            const rows: Notification[] = data || []
            setHasMore(rows.length === PAGE_SIZE)
            offsetRef.current = from + rows.length
            setNotifications(prev => reset ? rows : [...prev, ...rows])
        }
        setIsLoading(false)
        setIsLoadingMore(false)
    }, [userId])

    useEffect(() => { if (userId) fetchPage(true) }, [userId, fetchPage])

    // Realtime INSERT — prepend new rows (dedupe by id).
    useEffect(() => {
        if (!userId) return
        const channel = supabase
            .channel(`notif-list:${userId}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
                (payload) => {
                    const incoming = payload.new as Notification
                    setNotifications(prev => prev.some(n => n.id === incoming.id) ? prev : [incoming, ...prev])
                    offsetRef.current += 1
                })
            .subscribe()
        return () => { supabase.removeChannel(channel) }
    }, [userId])

    const markAsRead = useCallback(async (id: string) => {
        await (supabase.from('notifications') as any).update({ is_read: true }).eq('id', id)
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n))
    }, [])

    const markAllAsRead = useCallback(async () => {
        if (!userId) return
        await (supabase.from('notifications') as any).update({ is_read: true }).eq('user_id', userId).eq('is_read', false)
        setNotifications(prev => prev.map(n => ({ ...n, is_read: true })))
    }, [userId])

    const deleteNotif = useCallback(async (id: string) => {
        await (supabase.from('notifications') as any).delete().eq('id', id)
        setNotifications(prev => prev.filter(n => n.id !== id))
    }, [])

    const deleteAll = useCallback(async () => {
        if (!userId) return
        await (supabase.from('notifications') as any).delete().eq('user_id', userId)
        setNotifications([])
        offsetRef.current = 0
        setHasMore(false)
    }, [userId])

    const unreadCount = notifications.filter(n => !n.is_read).length

    return {
        notifications, isLoading, isLoadingMore, hasMore,
        loadMore: () => fetchPage(false),
        markAsRead, markAllAsRead, deleteNotif, deleteAll,
        refresh: () => fetchPage(true),
        unreadCount,
    }
}
