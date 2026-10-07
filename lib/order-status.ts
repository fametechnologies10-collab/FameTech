// lib/order-status.ts
// -----------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for data-bundle order status presentation.
// Replaces the ad-hoc inline status→color maps that had drifted apart across
// admin/user/shop/guest surfaces (refunded was purple / gray / slate / unstyled).
//
// Every surface that renders an order status should import STATUS_CONFIG or one
// of the helpers below. Adding a new status = one edit here.
// -----------------------------------------------------------------------------
import {
    Clock,
    Hourglass,
    Loader2,
    CheckCircle2,
    XCircle,
    RefreshCw,
    type LucideIcon,
} from 'lucide-react'

export type OrderStatus =
    | 'pending'
    | 'queued'
    | 'processing'
    | 'completed'
    | 'failed'
    | 'refunded'

export interface StatusConfig {
    /** Human label shown on badges/cards. */
    label: string
    /** Pill/badge Tailwind classes (light + dark). */
    badge: string
    /** Stat-card icon container background (light + dark). */
    cardBg: string
    /** Stat-card icon color (light + dark). */
    iconColor: string
    /** lucide icon component. */
    Icon: LucideIcon
    /** Short sub-label for stat cards. */
    sub: string
    /** Customer-friendly one-liner (guest tracker / tooltips). */
    description: string
}

export const STATUS_CONFIG: Record<OrderStatus, StatusConfig> = {
    pending: {
        label: 'Pending',
        badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
        cardBg: 'bg-amber-50 dark:bg-amber-900/20',
        iconColor: 'text-amber-600 dark:text-amber-400',
        Icon: Clock,
        sub: 'Awaiting fulfillment',
        description: 'Your order is received and waiting to be sent to the network.',
    },
    queued: {
        label: 'Queued',
        badge: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
        cardBg: 'bg-indigo-50 dark:bg-indigo-900/20',
        iconColor: 'text-indigo-600 dark:text-indigo-400',
        Icon: Hourglass,
        sub: 'Registering number',
        description:
            'Your number is being registered with the network provider. Your bundle will be delivered automatically once registration is confirmed.',
    },
    processing: {
        label: 'Processing',
        badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
        cardBg: 'bg-blue-50 dark:bg-blue-900/20',
        iconColor: 'text-blue-600 dark:text-blue-400',
        Icon: Loader2,
        sub: 'In progress',
        description: 'Your order has been sent to the network and is being delivered.',
    },
    completed: {
        label: 'Completed',
        badge: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
        cardBg: 'bg-green-50 dark:bg-green-900/20',
        iconColor: 'text-green-600 dark:text-green-400',
        Icon: CheckCircle2,
        sub: 'Fulfilled',
        description: 'Your bundle has been delivered.',
    },
    failed: {
        label: 'Failed',
        badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
        cardBg: 'bg-red-50 dark:bg-red-900/20',
        iconColor: 'text-red-600 dark:text-red-400',
        Icon: XCircle,
        sub: 'Needs review',
        description: 'This order could not be delivered. You may request a refund.',
    },
    refunded: {
        label: 'Refunded',
        badge: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
        cardBg: 'bg-purple-50 dark:bg-purple-900/20',
        iconColor: 'text-purple-600 dark:text-purple-400',
        Icon: RefreshCw,
        sub: 'Back to wallet',
        description: 'This order was refunded to your wallet.',
    },
}

/** Ordered list of statuses (useful for filters + fully-partitioned stat cards). */
export const ORDER_STATUSES: OrderStatus[] = [
    'pending',
    'queued',
    'processing',
    'completed',
    'failed',
    'refunded',
]

function resolve(status: string | null | undefined): StatusConfig {
    const key = (status || '').toLowerCase() as OrderStatus
    return STATUS_CONFIG[key] ?? STATUS_CONFIG.pending
}

/** Badge (pill) classes for a status. Falls back to pending styling. */
export function getStatusBadgeClass(status: string | null | undefined): string {
    return resolve(status).badge
}

/** Human label for a status. */
export function getStatusLabel(status: string | null | undefined): string {
    return resolve(status).label
}

/** Full config for a status (badge/card/icon/copy). */
export function getStatusConfig(status: string | null | undefined): StatusConfig {
    return resolve(status)
}

/**
 * Whether the small "Refunded" overlay pill should render next to the main status badge.
 * Only true when the order was refunded (refunded_at set) but its current `status` has since
 * drifted away from 'refunded' — the normal status badge already says "Refunded" when
 * status === 'refunded', so the overlay would be redundant there. This is what lets a
 * refunded order that later got marked completed/failed show BOTH for transparency, without
 * losing the original terminal status the way `status='refunded'` alone does.
 */
export function shouldShowRefundOverlay(order: { status?: string | null; refunded_at?: string | null }): boolean {
    return !!order.refunded_at && order.status !== 'refunded'
}

/** Shared Tailwind classes for the "Refunded" overlay pill (matches STATUS_CONFIG.refunded.badge). */
export const REFUND_OVERLAY_BADGE_CLASS = STATUS_CONFIG.refunded.badge

/** Shared Tailwind classes for the retry tag pill. */
export const RETRY_TAG_BADGE_CLASS = 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'

/**
 * Orders eligible for retry — terminal failed/refunded states only (mirrors the
 * server's claim_order_retry() eligibility check; this is a client-side filter so
 * ineligible rows are silently omitted rather than sent and rejected). Shared by
 * app/admin/fulfillment and app/admin/ishare so both pages agree on eligibility.
 */
export function isRetryEligible(order: { status: string }): boolean {
    return order.status === 'failed' || order.status === 'refunded'
}

/**
 * Retry tag for an order row. Two distinct cases:
 *  - A source row that has been retried at least once (`retry_count > 0`) shows
 *    who retried it and how many times.
 *  - A fresh row created by a refunded-order retry (`retry_of_order_id` set) shows
 *    what it was retried from — always 'refunded' for a fresh row, since only the
 *    refunded path creates a new row (the failed path mutates in place instead).
 * Mirrors shouldShowRefundOverlay's "one shared source of truth" pattern above.
 */
export function getRetryTag(order: {
    retry_count?: number | null
    retry_from_status?: string | null
    retry_of_order_id?: string | null
    retried_by_role?: string | null
}): { label: string; badge: string } | null {
    if (order.retry_of_order_id) {
        // retried_by_role is copied onto the fresh row too, so the "who retried it"
        // info is available here even though this row's own retry_count starts at 0.
        const by = order.retried_by_role === 'admin' ? 'Admin' : order.retried_by_role === 'subagent' ? 'Sub-Agent' : 'Customer'
        return { label: `Retry of refunded order · by ${by}`, badge: RETRY_TAG_BADGE_CLASS }
    }
    if (order.retry_count && order.retry_count > 0) {
        const by = order.retried_by_role === 'admin' ? 'Admin' : order.retried_by_role === 'subagent' ? 'Sub-Agent' : 'Customer'
        const from = order.retry_from_status === 'refunded' ? 'Refunded' : 'Failed'
        return { label: `Retried ×${order.retry_count} (was ${from}) · by ${by}`, badge: RETRY_TAG_BADGE_CLASS }
    }
    return null
}

/** Shared Tailwind classes for the "Completed by ..." self-service tag pill. */
export const SELF_COMPLETE_TAG_BADGE_CLASS = 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'

/**
 * Frontend gate for showing the "Confirm Received" button. This MIRRORS the
 * backend RPC's own status check (claim_self_order_complete requires status
 * = 'processing' exactly) — it is defense in depth for UX only, never the
 * source of truth. A button rendered here that the backend then rejects is
 * a bug in this function, not evidence the backend check can be skipped.
 */
export function isConfirmReceivedEligible(order: { status: string }): boolean {
    return order.status === 'processing'
}

/** "Completed by Customer" / "Completed by Shop Owner" tag for a self-completed order. */
export function getSelfCompletedTag(order: {
    self_completed_at?: string | null
    self_completed_by_role?: string | null
}): { label: string; badge: string } | null {
    if (!order.self_completed_at) return null
    const by = order.self_completed_by_role === 'shop_owner' ? 'Shop Owner' : order.self_completed_by_role === 'subagent' ? 'Sub-Agent' : 'Customer'
    return { label: `Completed by ${by}`, badge: SELF_COMPLETE_TAG_BADGE_CLASS }
}
