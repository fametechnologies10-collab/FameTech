'use client'

import { useState, useEffect, useCallback } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// usePushNotifications Hook
// ─────────────────────────────────────────────────────────────────────────────
// Manages the full lifecycle of Web Push subscription on the frontend:
//   1. Checks if push is supported in the current browser
//   2. Reads the current notification permission state
//   3. Subscribes the browser using the VAPID public key
//   4. Sends the subscription to /api/push/subscribe for persistence
//   5. Exposes a `requestPermission` function for the UI to call on user action
// ─────────────────────────────────────────────────────────────────────────────

type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported'

interface UsePushNotificationsReturn {
    /** Current browser notification permission state */
    permission: PermissionState
    /** True if the browser supports push notifications */
    isSupported: boolean
    /** True while the subscription request is in progress */
    isSubscribing: boolean
    /** True while an unsubscribe request is in progress */
    isUnsubscribing: boolean
    /** Call this in response to a user click to request permission & subscribe */
    requestPermission: () => Promise<void>
    /** Unsubscribe this browser and delete the saved subscription */
    unsubscribe: () => Promise<void>
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = window.atob(base64)
    // Explicitly allocate an ArrayBuffer so TypeScript infers Uint8Array<ArrayBuffer>
    // instead of Uint8Array<ArrayBufferLike>, which is required by PushManager.subscribe
    const buffer = new ArrayBuffer(rawData.length)
    const outputArray = new Uint8Array(buffer)
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i)
    }
    return outputArray
}

export function usePushNotifications(): UsePushNotificationsReturn {
    const [permission, setPermission] = useState<PermissionState>('default')
    const [isSupported, setIsSupported] = useState(false)
    const [isSubscribing, setIsSubscribing] = useState(false)
    const [isUnsubscribing, setIsUnsubscribing] = useState(false)

    useEffect(() => {
        // Check for browser support
        const supported =
            typeof window !== 'undefined' &&
            'serviceWorker' in navigator &&
            'PushManager' in window &&
            'Notification' in window

        setIsSupported(supported)

        if (supported) {
            const currentPermission = Notification.permission as PermissionState
            setPermission(currentPermission)

            // Auto-sync subscription if permission is already granted
            if (currentPermission === 'granted') {
                const syncSubscription = async () => {
                    try {
                        const registration = await navigator.serviceWorker.ready
                        const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
                        if (!vapidPublicKey) return

                        let subscription = await registration.pushManager.getSubscription()

                        if (subscription) {
                            try {
                                subscription = await registration.pushManager.subscribe({
                                    userVisibleOnly: true,
                                    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
                                })
                            } catch (err) {
                                console.warn('[usePushNotifications] Auto-sync re-subscribe failed, recreating:', err)
                                try {
                                    await subscription.unsubscribe()
                                } catch (unsubErr) {
                                    console.warn('[usePushNotifications] Unsubscribe error:', unsubErr)
                                }
                                subscription = await registration.pushManager.subscribe({
                                    userVisibleOnly: true,
                                    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
                                })
                            }
                        } else {
                            subscription = await registration.pushManager.subscribe({
                                userVisibleOnly: true,
                                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
                            })
                        }

                        if (subscription) {
                            await fetch('/api/push/subscribe', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(subscription.toJSON()),
                            })
                        }
                    } catch (err) {
                        console.error('[usePushNotifications] Auto-sync subscription error:', err)
                    }
                }
                syncSubscription()
            }
        }
    }, [])

    const requestPermission = useCallback(async () => {
        if (!isSupported || isSubscribing) return

        setIsSubscribing(true)
        try {
            // Request OS-level notification permission
            const result = await Notification.requestPermission()
            setPermission(result as PermissionState)

            if (result !== 'granted') return

            // Get the active service worker registration
            const registration = await navigator.serviceWorker.ready

            const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
            if (!vapidPublicKey) {
                console.error('[usePushNotifications] NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set.')
                return
            }

            // Subscribe to push notifications using the VAPID public key
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
            })

            // Send subscription details to our backend to persist in Supabase
            const res = await fetch('/api/push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(subscription.toJSON()),
            })

            if (!res.ok) {
                const data = await res.json()
                console.error('[usePushNotifications] Failed to save subscription:', data.error)
            }
        } catch (err) {
            console.error('[usePushNotifications] Subscription error:', err)
        } finally {
            setIsSubscribing(false)
        }
    }, [isSupported, isSubscribing])

    const unsubscribe = useCallback(async () => {
        if (!isSupported || isUnsubscribing) return
        setIsUnsubscribing(true)
        try {
            const registration = await navigator.serviceWorker.ready
            const subscription = await registration.pushManager.getSubscription()
            if (subscription) {
                const endpoint = subscription.endpoint
                try {
                    await subscription.unsubscribe()
                } catch (e) {
                    console.warn('[usePushNotifications] unsubscribe() failed:', e)
                }
                await fetch('/api/push/subscribe', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint }),
                }).catch(e => console.error('[usePushNotifications] delete subscription failed:', e))
            }
            // Permission stays 'granted' at the OS level; the user re-enables via requestPermission().
        } finally {
            setIsUnsubscribing(false)
        }
    }, [isSupported, isUnsubscribing])

    return { permission, isSupported, isSubscribing, isUnsubscribing, requestPermission, unsubscribe }
}
