/// <reference lib="webworker" />
// The triple-slash directive above tells TypeScript to use the `webworker` lib
// for this file, giving us ServiceWorkerGlobalScope, PushEvent, NotificationEvent, etc.
// `export type {}` below makes this a module (not a global script) which prevents
// the "Cannot redeclare block-scoped variable 'self'" conflict with the dom lib.
export type {}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Service Worker Extension — Web Push Notifications
// This file is merged into the final sw.js by @ducanh2912/next-pwa via the
// `customWorkerDir: 'worker'` option in next.config.ts.
// ─────────────────────────────────────────────────────────────────────────────

declare const self: ServiceWorkerGlobalScope

// ── Push Event ───────────────────────────────────────────────────────────────
self.addEventListener('push', (event: PushEvent) => {
    if (!event.data) return

    let data: { title?: string; body?: string; url?: string; icon?: string } = {}
    try {
        data = event.data.json()
    } catch {
        data = { title: 'KiNG FLEXY GH', body: event.data.text() }
    }

    const title = data.title || 'KiNG FLEXY GH'
    const options: NotificationOptions = {
        body: data.body || 'You have a new notification.',
        icon: data.icon || '/icons/icon-192x192.png',
        badge: '/icons/icon-192x192.png',
        // Store the target URL so the click handler can open the right page
        data: { url: data.url || '/dashboard?openNotifications=true' },
        requireInteraction: false,
    }

    event.waitUntil(self.registration.showNotification(title, options))
})

// ── Notification Click ────────────────────────────────────────────────────────
// Fired when the user taps/clicks a displayed notification.
// If the app is already open in any window, we focus it and send a postMessage
// so the notification modal opens and highlights the specific notification.
// Otherwise we open a new window at the target URL (which the app picks up via
// URL params on mount through useNotificationModal).
self.addEventListener('notificationclick', (event: NotificationEvent) => {
    event.notification.close()

    const targetUrl: string = event.notification.data?.url || '/dashboard?openNotifications=true'

    // Extract highlight ID and openNotifications flag from the URL for postMessage
    let highlightId: string | null = null
    let shouldOpen = false
    try {
        const parsedUrl = new URL(targetUrl, self.location.origin)
        highlightId = parsedUrl.searchParams.get('highlight')
        shouldOpen = parsedUrl.searchParams.get('openNotifications') === 'true'
    } catch {
        // fallback — URL is relative or malformed
        if (targetUrl.includes('openNotifications=true')) shouldOpen = true
        const match = targetUrl.match(/highlight=([^&]+)/)
        if (match) highlightId = match[1]
    }

    event.waitUntil(
        self.clients
            .matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList: readonly WindowClient[]) => {
                // Try to find an existing window on the same origin
                for (const client of clientList) {
                    if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
                        client.focus()
                        // Tell the app to open the notification modal and optionally highlight
                        if (shouldOpen || highlightId) {
                            client.postMessage({
                                type: 'OPEN_NOTIFICATIONS',
                                highlightId: highlightId ?? undefined,
                            })
                        }
                        return
                    }
                }
                // No existing window — open a new one; the app reads URL params on mount
                if (self.clients.openWindow) {
                    return self.clients.openWindow(targetUrl)
                }
            })
    )
})
