// Single source of truth: notification `type` -> user-facing category.
// Pure (no React / no DB) so it is safe to import from server push code and
// client components alike.

export type NotificationCategory = 'orders' | 'payments' | 'support' | 'announcements' | 'system'

export const CATEGORY_ORDER: NotificationCategory[] = [
    'orders',
    'payments',
    'support',
    'announcements',
    'system',
]

export const CATEGORY_LABEL: Record<NotificationCategory, string> = {
    orders: 'Orders',
    payments: 'Payments',
    support: 'Support',
    announcements: 'Announcements',
    system: 'System',
}

export const CATEGORY_DESCRIPTION: Record<NotificationCategory, string> = {
    orders: 'Order status & fulfilment updates',
    payments: 'Wallet credits, debits & payment receipts',
    support: 'Replies to your complaints & support chats',
    announcements: 'Platform-wide alerts from KiNG FLEXY',
    system: 'Account, role & general notices',
}

// type -> category. Any unknown type falls into 'system'.
export const TYPES_BY_CATEGORY: Record<NotificationCategory, string[]> = {
    orders: ['order_update'],
    payments: ['payment_success', 'balance_updated'],
    support: ['support_reply', 'complaint_resolved'],
    announcements: ['announcement'],
    system: ['system', 'role_upgrade', 'welcome'],
}

export function categoryForType(type: string): NotificationCategory {
    for (const cat of CATEGORY_ORDER) {
        if (TYPES_BY_CATEGORY[cat].includes(type)) return cat
    }
    return 'system'
}

export interface NotificationPrefs {
    muted?: Partial<Record<NotificationCategory, boolean>>
}

export function isCategoryMuted(
    prefs: NotificationPrefs | null | undefined,
    category: NotificationCategory,
): boolean {
    return prefs?.muted?.[category] === true
}
