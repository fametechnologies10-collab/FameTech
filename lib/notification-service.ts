import { createServerClient } from '@/lib/supabase'

export type NotificationType =
    | 'order_update'
    | 'complaint_resolved'
    | 'payment_success'
    | 'balance_updated'
    | 'system'
    | 'role_upgrade'
    | 'welcome'
    | 'announcement'

interface NotificationData {
    userId: string
    title: string
    message: string
    type: NotificationType
    actionUrl?: string
}

/**
 * Creates a notification row and returns the new notification ID.
 * The ID is used by callers to build a deep-link URL for web push payloads.
 */
export async function createNotification(data: NotificationData): Promise<{ success: boolean; id?: string; error?: unknown }> {
    const supabase = createServerClient()

    try {
        const { data: row, error } = await (supabase.from('notifications') as any).insert({
            user_id: data.userId,
            title: data.title,
            message: data.message,
            type: data.type,
            action_url: data.actionUrl,
            is_read: false,
        }).select('id').single()

        if (error) {
            console.error('Failed to create notification:', error)
            return { success: false, error }
        }

        return { success: true, id: row?.id }
    } catch (error) {
        console.error('Notification error:', error)
        return { success: false, error }
    }
}

export async function markAsRead(notificationId: string, userId: string) {
    const supabase = createServerClient()

    const { error } = await (supabase
        .from('notifications') as any)
        .update({ is_read: true })
        .eq('id', notificationId)
        .eq('user_id', userId)

    return { success: !error, error }
}

export async function markAllAsRead(userId: string) {
    const supabase = createServerClient()

    const { error } = await (supabase
        .from('notifications') as any)
        .update({ is_read: true })
        .eq('user_id', userId)
        .eq('is_read', false)

    return { success: !error, error }
}

export async function deleteNotification(notificationId: string, userId: string) {
    const supabase = createServerClient()

    const { error } = await (supabase
        .from('notifications') as any)
        .delete()
        .eq('id', notificationId)
        .eq('user_id', userId)

    return { success: !error, error }
}

export async function cleanupOldNotifications() {
    const supabase = createServerClient()

    // Delete read notifications older than 72 hours
    const cutoffDate = new Date()
    cutoffDate.setHours(cutoffDate.getHours() - 72)

    const { error } = await (supabase
        .from('notifications') as any)
        .delete()
        .eq('is_read', true)
        .lt('created_at', cutoffDate.toISOString())

    return { success: !error, error }
}

// ── Notification Templates ────────────────────────────────────────────────────

export function orderUpdateNotification(orderRef: string, status: string): Omit<NotificationData, 'userId'> {
    const statusMessages: Record<string, string> = {
        processing: `Your order ${orderRef} is being processed.`,
        completed: `Your order ${orderRef} has been completed successfully!`,
        failed: `Your order ${orderRef} has failed. Please file a complaint for a refund.`,
    }

    return {
        title: `Order ${status.charAt(0).toUpperCase() + status.slice(1)}`,
        message: statusMessages[status] || `Order ${orderRef} status updated to ${status}`,
        type: 'order_update',
        actionUrl: '/dashboard/my-orders',
    }
}

export function paymentSuccessNotification(amount: number): Omit<NotificationData, 'userId'> {
    return {
        title: 'Payment Successful',
        message: `Your wallet has been credited with GHS ${amount.toFixed(2)}`,
        type: 'payment_success',
        actionUrl: '/dashboard/wallet',
    }
}

export function complaintResolvedNotification(complaintId: string, resolution: string): Omit<NotificationData, 'userId'> {
    return {
        title: 'Complaint Resolved',
        message: `Your complaint has been resolved: ${resolution}`,
        type: 'complaint_resolved',
        actionUrl: '/dashboard/complaints',
    }
}

export function balanceUpdatedNotification(amount: number, type: 'credit' | 'debit'): Omit<NotificationData, 'userId'> {
    const action = type === 'credit' ? 'credited' : 'debited'
    return {
        title: `Balance ${action.charAt(0).toUpperCase() + action.slice(1)}`,
        message: `Your wallet has been ${action} with GHS ${amount.toFixed(2)}`,
        type: 'balance_updated',
        actionUrl: '/dashboard/wallet',
    }
}

export function welcomeNotification(): Omit<NotificationData, 'userId'> {
    return {
        title: 'Welcome to KiNG FLEXY GH! 🎉',
        message: 'Your account is ready. Start buying data, airtime, and more at the best rates!',
        type: 'welcome',
        actionUrl: '/dashboard',
    }
}

export function roleRenewalReminderNotification(role: 'agent' | 'dealer'): Omit<NotificationData, 'userId'> {
    return {
        title: `${role === 'agent' ? 'Agent' : 'Dealer'} Role Expiring Soon`,
        message: `Your ${role === 'agent' ? 'Agent' : 'Dealer'} Role plan is expiring in less than 48 hours. Enable Auto-Upgrade or renew manually to keep your benefits.`,
        type: 'system',
        actionUrl: '/dashboard/upgrade',
    }
}
