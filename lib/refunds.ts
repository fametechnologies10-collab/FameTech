/**
 * Refund eligibility + routing — pure logic (no I/O), shared by every refund entry point.
 *
 * Rules (see docs/superpowers/plans/2026-07-02-refund-system.md Global Constraints):
 * - `completed` orders are NEVER refundable.
 * - Admin may refund pending | queued | processing | failed.
 * - Registered users may self-refund only `pending` or `queued` orders (and only their own,
 *   non-shop — the ownership/shop gate is enforced in the route, not here).
 * - `queued` = paid but held for MTN number registration; refundable exactly like pending.
 * - Refund routing by order shape: shop_order_id present → shop path; airtime/mashup → airtime
 *   wallet path; otherwise retail wallet path.
 */

export type RefundActor = 'admin' | 'user'
export type RefundKind = 'retail_wallet' | 'airtime_wallet' | 'shop' | 'ineligible'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Strict UUID guard for order ids arriving from request bodies. */
export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s)
}

export const REFUND_ELIGIBLE_STATUSES = ['pending', 'queued', 'processing', 'failed'] as const
export const USER_ELIGIBLE_STATUSES = ['pending', 'queued'] as const
/** Hard cap on how many orders a single bulk-refund request may process (safety). */
export const MAX_BULK_REFUND = 50
/**
 * Hard cap on how many orders a single bulk-RETRY request may process (safety).
 * Lower than MAX_BULK_REFUND: each retry does ~6 sequential Supabase round-trips PLUS a
 * live supplier HTTP call (CodeCraft alone retries up to 3x internally), so 50 sequential
 * retries at 2-4s/order can blow past the Vercel function timeout with no summary returned
 * and no way for the admin to tell which orders were already charged.
 */
export const MAX_BULK_RETRY = 10

export interface RefundEligibilityInput {
  status: string
  payment_status?: string | null
}

export interface RefundEligibilityResult {
  ok: boolean
  reason?: string
}

/** Whether a given actor may refund an order in its current status. Never mutates. */
export function isRefundable(order: RefundEligibilityInput, actor: RefundActor): RefundEligibilityResult {
  if (order.status === 'refunded' || order.payment_status === 'refunded') {
    return { ok: false, reason: 'already_refunded' }
  }
  if (order.status === 'completed') {
    return { ok: false, reason: 'completed_not_refundable' }
  }
  const allowed: readonly string[] = actor === 'admin' ? REFUND_ELIGIBLE_STATUSES : USER_ELIGIBLE_STATUSES
  if (!allowed.includes(order.status)) {
    return { ok: false, reason: 'status_not_eligible' }
  }
  return { ok: true }
}

export interface RefundKindInput {
  category?: string | null
  shop_order_id?: string | null
  type?: string | null
  shop_id?: string | null
}

/** Decide which refund pathway an order needs. Shop link wins; then airtime/mashup; else retail. */
export function refundKindForOrder(o: RefundKindInput): RefundKind {
  if (o.shop_order_id) return 'shop'
  if (o.type === 'airtime' || o.type === 'mashup') return 'airtime_wallet'
  return 'retail_wallet'
}

/** True when a `processing` refund needs the explicit "may already be delivered" confirmation. */
export function requiresProcessingConfirmation(order: RefundEligibilityInput): boolean {
  return order.status === 'processing'
}
