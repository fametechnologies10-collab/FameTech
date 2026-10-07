'use client'

import { useState, useEffect, useCallback } from 'react'

interface NotificationModalState {
    isOpen: boolean
    setIsOpen: (open: boolean) => void
    highlightedId: string | null
    clearHighlight: () => void
}

/**
 * Manages the notification modal open/close state and the ID of a notification
 * that should be scrolled to and highlighted when the modal opens.
 *
 * Two trigger paths:
 *  1. URL params  — ?openNotifications=true&highlight=<id>
 *     Used when a web push notification is clicked and no app window is open:
 *     the service worker opens a new window with this URL.
 *  2. SW postMessage — { type: 'OPEN_NOTIFICATIONS', highlightId?: string }
 *     Used when the app is already open: the service worker focuses the existing
 *     window and sends this message instead of navigating.
 *
 * NOTE: Uses window.location directly (not useSearchParams) so it is safe to
 * use inside layouts without a Suspense boundary.
 */
export function useNotificationModal(): NotificationModalState {
    const [isOpen, setIsOpenRaw] = useState(false)
    const [highlightedId, setHighlightedId] = useState<string | null>(null)

    // ── 1. URL param trigger (runs once on mount) ─────────────────────────────
    useEffect(() => {
        if (typeof window === 'undefined') return

        const params = new URLSearchParams(window.location.search)
        const shouldOpen = params.get('openNotifications') === 'true'
        const highlight = params.get('highlight') ?? null

        if (shouldOpen) {
            setHighlightedId(highlight)
            setIsOpenRaw(true)

            // Remove the params from the URL without re-rendering
            const url = new URL(window.location.href)
            url.searchParams.delete('openNotifications')
            url.searchParams.delete('highlight')
            window.history.replaceState(null, '', url.toString())
        }
    }, [])

    // ── 2. Service Worker postMessage trigger ─────────────────────────────────
    useEffect(() => {
        if (typeof window === 'undefined' || !navigator.serviceWorker) return

        const handleMessage = (event: MessageEvent) => {
            if (event.data?.type !== 'OPEN_NOTIFICATIONS') return
            const highlight: string | undefined = event.data.highlightId
            setHighlightedId(highlight ?? null)
            setIsOpenRaw(true)
        }

        navigator.serviceWorker.addEventListener('message', handleMessage)
        return () => {
            navigator.serviceWorker.removeEventListener('message', handleMessage)
        }
    }, [])

    const setIsOpen = useCallback((open: boolean) => {
        setIsOpenRaw(open)
        if (!open) setHighlightedId(null)
    }, [])

    const clearHighlight = useCallback(() => {
        setHighlightedId(null)
    }, [])

    return { isOpen, setIsOpen, highlightedId, clearHighlight }
}
