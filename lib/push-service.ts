import webPush from 'web-push'
import { createClient } from '@supabase/supabase-js'
import {
    isCategoryMuted,
    type NotificationCategory,
    type NotificationPrefs,
} from '@/lib/notification-categories'

// ─────────────────────────────────────────────────────────────────────────────
// Web Push Service — Server-Side Push Notification Delivery
// ─────────────────────────────────────────────────────────────────────────────
// This utility is called from any server-side context (API routes, webhooks,
// cron jobs) to deliver a real-time push notification to a specific user's
// registered devices.
//
// Prerequisites (add to .env.local / Vercel env vars):
//   NEXT_PUBLIC_VAPID_PUBLIC_KEY=<your generated public key>
//   VAPID_PRIVATE_KEY=<your generated private key>
//   VAPID_SUBJECT=mailto:support@kingflexygh.com
//
// Generate VAPID keys once by running in Node.js:
//   node -e "const wp = require('web-push'); console.log(wp.generateVAPIDKeys())"
// ─────────────────────────────────────────────────────────────────────────────

let isVapidSet = false
function ensureVapidDetails() {
    if (isVapidSet) return
    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    const privateKey = process.env.VAPID_PRIVATE_KEY
    const subject = process.env.VAPID_SUBJECT || 'mailto:support@kingflexygh.com'

    if (publicKey && privateKey) {
        try {
            webPush.setVapidDetails(subject, publicKey, privateKey)
            isVapidSet = true
        } catch (e) {
            console.error('[push-service] Failed to set VAPID details:', e)
        }
    } else {
        console.warn('[push-service] VAPID keys are missing. Push notifications will be disabled.')
    }
}

// ── Payload Interface ─────────────────────────────────────────────────────────
export interface PushPayload {
    title: string
    body: string
    /**
     * The in-app notification row ID. When provided, the push click will open
     * the dashboard and highlight this specific notification in the modal.
     */
    notificationId?: string
    /** Override the target URL entirely (ignores notificationId). */
    url?: string
    /** Override the notification icon. Defaults to /icons/icon-192x192.png */
    icon?: string
    /** When set, the push is suppressed for users who muted this category. */
    category?: NotificationCategory
}

// ── sendPushNotification ──────────────────────────────────────────────────────
/**
 * Sends a Web Push notification to ALL active subscriptions for a given user.
 * Stale/expired subscriptions (410 Gone) are automatically cleaned from the DB.
 *
 * @param userId  — The Supabase user ID of the notification recipient
 * @param payload — The notification title, body, and optional URL
 */
export async function sendPushNotification(
    userId: string,
    payload: PushPayload
): Promise<{ sent: number; failed: number }> {
    ensureVapidDetails()
    const adminDb = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Per-category mute gate (push only). Fail-open: on any read error we send.
    if (payload.category) {
        try {
            const { data: prefRow } = await (adminDb as any)
                .from('users')
                .select('notification_prefs')
                .eq('id', userId)
                .single()
            const prefs = (prefRow?.notification_prefs ?? null) as NotificationPrefs | null
            if (isCategoryMuted(prefs, payload.category)) {
                return { sent: 0, failed: 0 }
            }
        } catch {
            // ignore — fail open
        }
    }

    // Fetch all active subscriptions for this user
    const { data: subscriptions, error } = await (adminDb as any)
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth')
        .eq('user_id', userId)

    if (error) {
        console.error('[push-service] Failed to fetch subscriptions:', error)
        return { sent: 0, failed: 0 }
    }

    if (!subscriptions || subscriptions.length === 0) {
        return { sent: 0, failed: 0 }
    }

    // Build the deep-link URL: prefer explicit url, else build from notificationId
    const targetUrl = payload.url
        ?? (payload.notificationId
            ? `/dashboard?openNotifications=true&highlight=${payload.notificationId}`
            : '/dashboard?openNotifications=true')

    const payloadString = JSON.stringify({
        title: payload.title,
        body: payload.body,
        url: targetUrl,
        icon: payload.icon || '/icons/icon-192x192.png',
    })

    let sent = 0
    let failed = 0
    const staleIds: string[] = []

    await Promise.allSettled(
        subscriptions.map(async (sub: any) => {
            const pushSubscription = {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: sub.p256dh,
                    auth: sub.auth,
                },
            }

            try {
                await webPush.sendNotification(pushSubscription, payloadString)
                sent++
            } catch (err: any) {
                // HTTP 410 Gone / 404 Not Found / 400 Bad Request / 401 Unauthorized / 403 Forbidden = clean it up
                if (
                    err?.statusCode === 410 ||
                    err?.statusCode === 404 ||
                    err?.statusCode === 400 ||
                    err?.statusCode === 401 ||
                    err?.statusCode === 403
                ) {
                    staleIds.push(sub.id)
                } else {
                    console.error('[push-service] Push failed for endpoint:', sub.endpoint, err?.message)
                }
                failed++
            }
        })
    )

    // Remove stale subscriptions from the database
    if (staleIds.length > 0) {
        await (adminDb as any)
            .from('push_subscriptions')
            .delete()
            .in('id', staleIds)
    }

    return { sent, failed }
}

// ── sendAdminPushNotification ────────────────────────────────────────────────
/**
 * Sends a push notification to all users with role 'admin' or 'sub-admin'.
 * Also creates an in-app notification row for each admin so that tapping the
 * push opens the modal and highlights the specific notification.
 */
export async function sendAdminPushNotification(
    payload: PushPayload
): Promise<{ sent: number; failed: number }> {
    const adminDb = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch all admins
    const { data: admins, error } = await (adminDb as any)
        .from('users')
        .select('id')
        .in('role', ['admin', 'sub-admin'])

    if (error || !admins || admins.length === 0) {
        console.error('[push-service] Failed to fetch admins for push notification:', error)
        return { sent: 0, failed: 0 }
    }

    let totalSent = 0
    let totalFailed = 0

    // For each admin: insert a notification row first, then fire the device push
    // using the new row's ID so the push deep-links to that specific notification.
    await Promise.allSettled(
        admins.map(async (admin: any) => {
            // Create the in-app notification row
            let notificationId: string | undefined
            try {
                const { data: row } = await (adminDb as any)
                    .from('notifications')
                    .insert({
                        user_id: admin.id,
                        title: payload.title,
                        message: payload.body,
                        type: 'system',
                        action_url: payload.url ?? null,
                        is_read: false,
                    })
                    .select('id')
                    .single()
                notificationId = row?.id
            } catch (err) {
                console.error('[push-service] Failed to create admin notification row:', err)
            }

            // Send device push with deep-link to the notification row
            const { sent, failed } = await sendPushNotification(admin.id, {
                ...payload,
                notificationId,
            })
            totalSent += sent
            totalFailed += failed
        })
    )

    return { sent: totalSent, failed: totalFailed }
}

// ── sendAnnouncementPushNotification ─────────────────────────────────────────
/**
 * Sends a push notification + in-app notification to every user who has an
 * active push subscription. Called when an admin posts a new announcement so
 * all subscribed users are notified in real time.
 */
export async function sendAnnouncementPushNotification(payload: {
    title: string
    body: string
    /** When false, the in-app rows are still created but no device push fires. */
    sendPush?: boolean
    /** Deep-link URL embedded in the in-app row and the push payload. Defaults to '/dashboard'. */
    actionUrl?: string
}): Promise<{ sent: number; failed: number; recorded: number }> {
    const sendPush = payload.sendPush !== false
    const adminDb = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Recipients = all users who have at least one push subscription.
    const { data: subs, error } = await (adminDb as any)
        .from('push_subscriptions')
        .select('user_id')

    if (error || !subs || subs.length === 0) return { sent: 0, failed: 0, recorded: 0 }

    const userIds: string[] = [...new Set<string>(subs.map((s: any) => s.user_id as string))]

    // Batch-load mute prefs so we can skip push (not the in-app row) for muters.
    const mutedSet = new Set<string>()
    try {
        const { data: prefRows } = await (adminDb as any)
            .from('users')
            .select('id, notification_prefs')
            .in('id', userIds)
        for (const row of (prefRows ?? [])) {
            if (isCategoryMuted((row?.notification_prefs ?? null) as NotificationPrefs | null, 'announcements')) {
                mutedSet.add(row.id as string)
            }
        }
    } catch {
        // fail open — leave mutedSet empty so everyone is pushed
    }

    let totalSent = 0
    let totalFailed = 0
    let recorded = 0

    await Promise.allSettled(
        userIds.map(async (userId) => {
            // Always create the in-app row (fix: announcements were invisible before).
            let notificationId: string | undefined
            try {
                const { data: row } = await (adminDb as any)
                    .from('notifications')
                    .insert({
                        user_id: userId,
                        title: payload.title,
                        message: payload.body,
                        type: 'announcement',
                        // Only https: is navigable via the in-app router.push() click handler;
                        // tel:/mailto: CTAs still work as <a href> on the modal/bell, but as an
                        // in-app deep-link they would be a dead click, so fall back to /dashboard.
                        action_url: payload.actionUrl?.startsWith('https://') ? payload.actionUrl : '/dashboard',
                        is_read: false,
                    })
                    .select('id')
                    .single()
                notificationId = row?.id
                if (notificationId) recorded++
            } catch (err) {
                console.error('[push-service] Failed to create announcement notification row:', err)
            }

            // Device push only when enabled and not muted by this user.
            if (sendPush && !mutedSet.has(userId)) {
                const { sent, failed } = await sendPushNotification(userId, {
                    title: payload.title,
                    body: payload.body,
                    url: payload.actionUrl ?? undefined,
                    notificationId,
                })
                totalSent += sent
                totalFailed += failed
            }
        })
    )

    return { sent: totalSent, failed: totalFailed, recorded }
}

// ── sendOrderCompletedPushNotification ────────────────────────────────────────
/**
 * Fetches order details by orderId and triggers a push notification to the
 * authenticated customer. Also sends to guest subscribers when the order was
 * placed through a storefront (shop_order_id is set and guest_phone matches).
 */
// ── Shared order-status push (completed/failed/refunded) ─────────────────────
// All three notify the authenticated dashboard user; only completed/failed also notify a
// storefront guest subscriber (refunds land in the shop owner's wallet, not a guest's, so
// there's nothing for a guest to be pushed about).
async function sendOrderStatusPush(
    orderId: string,
    userNotification: { title: string; body: (order: any) => string },
    guestNotification?: { title: string; body: (order: any) => string }
): Promise<void> {
    try {
        const adminDb = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        )
        const { data: order } = await (adminDb as any)
            .from('orders')
            .select('user_id, network, size, phone_number, shop_order_id')
            .eq('id', orderId)
            .single()

        if (!order) return

        // Authenticated dashboard user
        if (order.user_id) {
            await sendPushNotification(order.user_id, {
                title: userNotification.title,
                body: userNotification.body(order),
                url: '/dashboard/my-orders',
                category: 'orders',
            })
        }

        // Storefront guest subscribers whose phone matches
        if (guestNotification && order.shop_order_id) {
            const { data: shopOrder } = await (adminDb as any)
                .from('shop_orders')
                .select('shop_id, guest_phone')
                .eq('id', order.shop_order_id)
                .single()

            if (shopOrder?.guest_phone && shopOrder?.shop_id) {
                const { data: shopProfile } = await (adminDb as any)
                    .from('shop_profiles')
                    .select('slug')
                    .eq('id', shopOrder.shop_id)
                    .single()

                await sendGuestOrderPush(shopOrder.shop_id, shopOrder.guest_phone, {
                    title: guestNotification.title,
                    body: guestNotification.body(order),
                    url: shopProfile?.slug ? `/shop/${shopProfile.slug}` : '/',
                })
            }
        }
    } catch (err) {
        console.error(`[push-service] Failed to send order status push for ${orderId}:`, err)
    }
}

export async function sendOrderCompletedPushNotification(orderId: string): Promise<void> {
    return sendOrderStatusPush(
        orderId,
        {
            title: 'Order Completed',
            body: (order) => `Your order of ${order.size} (${order.network}) for ${order.phone_number} is completed successfully!`,
        },
        {
            title: '✅ Order Delivered!',
            body: (order) => `Your ${order.size} (${order.network}) for ${order.phone_number} is ready.`,
        }
    )
}

export async function sendOrderFailedPushNotification(orderId: string): Promise<void> {
    return sendOrderStatusPush(
        orderId,
        {
            title: 'Order Failed',
            body: (order) => `Your order of ${order.size} (${order.network}) for ${order.phone_number} could not be completed.`,
        },
        {
            title: 'Order Failed',
            body: (order) => `Your ${order.size} (${order.network}) order for ${order.phone_number} could not be completed.`,
        }
    )
}

export async function sendOrderRefundedPushNotification(orderId: string): Promise<void> {
    return sendOrderStatusPush(orderId, {
        title: 'Order Refunded',
        body: (order) => `Your order of ${order.size} (${order.network}) for ${order.phone_number} was refunded to your wallet.`,
    })
}

export async function sendOrderRetryPushNotification(orderId: string, amount: number): Promise<void> {
    return sendOrderStatusPush(orderId, {
        title: 'Order Retry',
        body: (order) => `Your order of ${order.size} (${order.network}) for ${order.phone_number} is being retried. GHS ${amount.toFixed(2)} was debited from your wallet.`,
    })
}

// ── sendGuestAnnouncementPush ─────────────────────────────────────────────────
/**
 * Sends a push notification to ALL guest subscribers across every shop.
 * Called when admin posts a system announcement targeting storefronts.
 * Each notification deep-links to the subscriber's specific storefront URL.
 */
export async function sendGuestAnnouncementPush(payload: {
    title: string
    body: string
    /** Deep-link URL for the push. When provided, overrides the per-shop storefront URL. Defaults to the subscriber's shop URL. */
    actionUrl?: string
}): Promise<{ sent: number; failed: number }> {
    ensureVapidDetails()
    const adminDb = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: subs, error } = await (adminDb as any)
        .from('guest_push_subscriptions')
        .select('id, endpoint, p256dh, auth, shop_id')

    if (error || !subs || subs.length === 0) return { sent: 0, failed: 0 }

    // Resolve shop slugs so each notification links to the right storefront
    const shopIds: string[] = [...new Set<string>(subs.map((s: any) => s.shop_id as string))]
    const { data: shops } = await (adminDb as any)
        .from('shop_profiles')
        .select('id, slug')
        .in('id', shopIds)

    const slugMap: Record<string, string> = {}
    for (const s of (shops ?? [])) slugMap[s.id] = s.slug

    let sent = 0
    let failed = 0
    const staleIds: string[] = []

    await Promise.allSettled(
        subs.map(async (sub: any) => {
            const slug = slugMap[sub.shop_id]
            const payloadStr = JSON.stringify({
                title: payload.title,
                body: payload.body,
                url: payload.actionUrl ?? (slug ? `/shop/${slug}` : '/'),
                icon: '/icons/icon-192x192.png',
            })
            try {
                await webPush.sendNotification(
                    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                    payloadStr
                )
                sent++
            } catch (err: any) {
                if ([400, 401, 403, 404, 410].includes(err?.statusCode)) staleIds.push(sub.id)
                else console.error('[push-service] Guest announcement push failed:', sub.endpoint, err?.message)
                failed++
            }
        })
    )

    if (staleIds.length > 0) {
        await (adminDb as any).from('guest_push_subscriptions').delete().in('id', staleIds)
    }

    return { sent, failed }
}

// ── sendGuestOrderPush ────────────────────────────────────────────────────────
/**
 * Sends an order-completion push to guest subscribers whose stored phone number
 * matches the given guestPhone on the given shop.
 */
export async function sendGuestOrderPush(
    shopId: string,
    guestPhone: string,
    payload: { title: string; body: string; url?: string }
): Promise<void> {
    ensureVapidDetails()
    const adminDb = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: subs, error } = await (adminDb as any)
        .from('guest_push_subscriptions')
        .select('id, endpoint, p256dh, auth')
        .eq('shop_id', shopId)
        .eq('guest_phone', guestPhone)

    if (error || !subs || subs.length === 0) return

    const staleIds: string[] = []
    await Promise.allSettled(
        subs.map(async (sub: any) => {
            const payloadStr = JSON.stringify({
                title: payload.title,
                body: payload.body,
                url: payload.url ?? '/',
                icon: '/icons/icon-192x192.png',
            })
            try {
                await webPush.sendNotification(
                    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                    payloadStr
                )
            } catch (err: any) {
                if ([400, 401, 403, 404, 410].includes(err?.statusCode)) staleIds.push(sub.id)
            }
        })
    )

    if (staleIds.length > 0) {
        await (adminDb as any).from('guest_push_subscriptions').delete().in('id', staleIds)
    }
}
