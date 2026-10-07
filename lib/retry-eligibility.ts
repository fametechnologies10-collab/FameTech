// Pure retry-eligibility logic — no I/O. Mirrors the checks re-enforced
// server-side inside the claim_order_retry RPC; exists so routes can return
// fast, specific errors and so this logic is unit-testable without a DB.
// See docs/superpowers/specs/2026-07-26-order-retry-design.md.

export type RetryActorRole = 'admin' | 'user'

export interface RetryEligibilityResult {
  ok: boolean
  reason?: 'admin_only' | 'not_owner' | 'not_retryable'
}

/**
 * Whether `actorRole` may retry an order currently in `order.status`.
 *
 * The free in-place path (no charge) is gated on `refunded_at IS NULL`, not on
 * `status === 'failed'` alone — a row can drift to status='failed' after
 * already being refunded (see shouldShowRefundOverlay in lib/order-status.ts,
 * which detects exactly that: refunded_at set but status !== 'refunded'). Such
 * a row must take the paid path below and never the free one, or the customer
 * keeps their refund AND gets a free re-delivery. This mirrors the
 * claim_order_retry RPC's branch selection (refunded_at, not status).
 */
export function isRetryEligible(
  order: { status: string; refunded_at?: string | null },
  actorRole: RetryActorRole,
  isOwner: boolean
): RetryEligibilityResult {
  const wasRefunded = !!order.refunded_at

  if (order.status === 'failed' && !wasRefunded) {
    return actorRole === 'admin' ? { ok: true } : { ok: false, reason: 'admin_only' }
  }
  if (order.status === 'refunded' || (order.status === 'failed' && wasRefunded)) {
    if (actorRole === 'admin') return { ok: true }
    return isOwner ? { ok: true } : { ok: false, reason: 'not_owner' }
  }
  return { ok: false, reason: 'not_retryable' }
}

export interface CooldownResult {
  ok: boolean
  reason?: 'retry_too_soon' | 'retry_locked'
  retryAfter?: Date
}

const MIN_GAP_MS = 60 * 1000
const LOCKOUT_MS = 24 * 60 * 60 * 1000
const MAX_ATTEMPTS = 3

/** 60s gap between any two attempts; after MAX_ATTEMPTS, a 24h hard lockout, then reset. */
export function checkRetryCooldown(
  order: { retry_count: number; last_retry_at: string | null },
  now: Date = new Date()
): CooldownResult {
  if (order.last_retry_at) {
    const last = new Date(order.last_retry_at)
    const gapEnd = new Date(last.getTime() + MIN_GAP_MS)
    if (gapEnd > now) {
      return { ok: false, reason: 'retry_too_soon', retryAfter: gapEnd }
    }
    if (order.retry_count >= MAX_ATTEMPTS) {
      const lockoutEnd = new Date(last.getTime() + LOCKOUT_MS)
      if (lockoutEnd > now) {
        return { ok: false, reason: 'retry_locked', retryAfter: lockoutEnd }
      }
    }
  }
  return { ok: true }
}

export type FundingWalletResult =
  | { ok: true; userId: string }
  | { ok: false; error: 'paystack_refund_no_wallet' | 'owner_not_found' | 'no_wallet_user' }

/**
 * Mirrors the refund destination: retail/USSD orders fund from the buyer's own
 * wallet; shop orders refunded to the owner fund from the owner's wallet at
 * cost; shop orders refunded via Paystack have no wallet to charge.
 */
export function resolveRetryFundingWallet(
  order: { shop_order_id: string | null; user_id: string | null },
  shopOrder?: { refund_method: string | null; owner_id: string | null } | null
): FundingWalletResult {
  if (order.shop_order_id) {
    if (shopOrder?.refund_method === 'paystack') {
      return { ok: false, error: 'paystack_refund_no_wallet' }
    }
    if (!shopOrder?.owner_id) {
      return { ok: false, error: 'owner_not_found' }
    }
    return { ok: true, userId: shopOrder.owner_id }
  }
  if (!order.user_id) {
    return { ok: false, error: 'no_wallet_user' }
  }
  return { ok: true, userId: order.user_id }
}
