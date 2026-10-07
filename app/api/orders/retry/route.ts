import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { retryOrder, RetryOutcome } from '@/lib/retry-service'
import { isUuid } from '@/lib/refunds'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

/**
 * POST /api/orders/retry
 * Any authenticated user may retry their OWN refunded order (never a failed one —
 * failed-order retry is admin-only, enforced by retryOrder/claim_order_retry).
 *
 * "Own" includes shop owners retrying their storefront / USSD-shop orders: ownership
 * is decided inside retryOrder/claim_order_retry as (orders.user_id = actor) OR
 * (actor owns the shop behind orders.shop_order_id). Do NOT add a
 * `.eq('user_id', userId)` pre-filter here — source='ussd_shop' orders carry the USSD
 * caller in orders.user_id, not the owner, so a pre-filter would lock owners out of
 * their own orders. Pass orderId through and let the service/RPC decide.
 * Body: { orderId: uuid }
 */

// Deliberate, exhaustive mapping — every non-ok RetryOutcome maps to a specific HTTP
// status. No fallthrough: unmapped outcomes are treated as 500 (server-side/internal).
function statusForOutcome(outcome: RetryOutcome): number {
  switch (outcome) {
    case 'order_not_found':
      return 404
    case 'duplicate_attempt':
    case 'retry_too_soon':
    case 'retry_locked':
    case 'retry_already_in_progress':
      return 409
    case 'admin_only':
    case 'not_owner':
      return 403
    case 'not_retryable':
    case 'paystack_refund_no_wallet':
    case 'insufficient_balance':
    case 'invalid_charge_amount':
    case 'owner_not_found':
    case 'no_wallet_user':
    case 'not_whitelisted':
      return 400
    case 'invalid_actor_role':
    case 'error':
    default:
      return 500
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabaseUserClient = await createRouteClient()
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const rl = consumeRateLimit(`order-retry:${authUser.id}`, 10, 60_000)
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Too many retry requests, slow down.' }, { status: 429 })
    }

    const body = await request.json().catch(() => ({}))
    const orderId = body?.orderId
    if (!isUuid(orderId)) {
      return NextResponse.json({ success: false, error: 'A valid orderId is required' }, { status: 400 })
    }

    const admin = createServerClient()
    const result = await retryOrder(admin, { orderId, actorId: authUser.id, actorRole: 'user' })

    if (result.ok) {
      return NextResponse.json({
        success: true,
        data: {
          outcome: result.outcome,
          targetOrderId: result.targetOrderId,
          chargedAmount: result.chargedAmount,
          referenceCode: result.referenceCode,
          message: result.message,
        },
      })
    }

    return NextResponse.json(
      {
        success: false,
        error: result.message,
        outcome: result.outcome,
        ...(result.required !== undefined && { required: result.required }),
        ...(result.available !== undefined && { available: result.available }),
        ...(result.until !== undefined && { until: result.until }),
        ...(result.retryAfter !== undefined && { retryAfter: result.retryAfter }),
        ...(result.currentStatus !== undefined && { currentStatus: result.currentStatus }),
      },
      { status: statusForOutcome(result.outcome) }
    )
  } catch (e: any) {
    console.error('[OrderRetry] error:', e?.message || e)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
