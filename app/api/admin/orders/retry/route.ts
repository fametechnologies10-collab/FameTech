import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { retryOrder, RetryOutcome } from '@/lib/retry-service'
import { MAX_BULK_RETRY, isUuid } from '@/lib/refunds'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

/**
 * POST /api/admin/orders/retry
 * Admin-only. Retries a single order (`orderId`) or up to MAX_BULK_RETRY orders
 * (`orderIds`). Processed sequentially — each order goes through the same
 * claim_order_retry-backed path as the single route, so a repeat never double-charges.
 * Body: { orderId: uuid } | { orderIds: uuid[] }
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

async function verifyAdmin(supabaseUserClient: any): Promise<string | null> {
  const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
  if (error || !authUser) return null
  const admin = createServerClient()
  const { data: user } = await admin.from('users').select('role').eq('id', authUser.id).single()
  return (user as any)?.role === 'admin' ? authUser.id : null
}

export async function POST(request: NextRequest) {
  try {
    const supabaseUserClient = await createRouteClient()
    const actorId = await verifyAdmin(supabaseUserClient)
    if (!actorId) return NextResponse.json({ success: false, error: 'Forbidden — admin only' }, { status: 403 })

    const rl = consumeRateLimit(`admin-order-retry:${actorId}`, 20, 60_000)
    if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many retry requests, slow down.' }, { status: 429 })

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 }) }

    const admin = createServerClient()

    if (Array.isArray(body?.orderIds)) {
      const rawIds = body.orderIds
      if (rawIds.length === 0 || !rawIds.every((id: any) => isUuid(id))) {
        return NextResponse.json({ success: false, error: 'orderIds must be a non-empty array of UUIDs' }, { status: 400 })
      }
      const orderIds = Array.from(new Set(rawIds as string[]))
      if (orderIds.length > MAX_BULK_RETRY) {
        return NextResponse.json({ success: false, error: `Select at most ${MAX_BULK_RETRY} orders` }, { status: 400 })
      }

      const results: any[] = []
      for (const id of orderIds) {
        try {
          const r = await retryOrder(admin, { orderId: id, actorId, actorRole: 'admin' })
          results.push({
            orderId: id,
            ok: r.ok,
            outcome: r.outcome,
            message: r.message,
            chargedAmount: r.chargedAmount,
            targetOrderId: r.targetOrderId,
            ...(r.required !== undefined && { required: r.required }),
            ...(r.available !== undefined && { available: r.available }),
            ...(r.until !== undefined && { until: r.until }),
            ...(r.retryAfter !== undefined && { retryAfter: r.retryAfter }),
            ...(r.currentStatus !== undefined && { currentStatus: r.currentStatus }),
          })
        } catch (e: any) {
          results.push({ orderId: id, ok: false, outcome: 'error', message: String(e?.message || e) })
        }
      }

      const summary = { ok: 0, skipped: 0, failed: 0, total: results.length }
      for (const r of results) {
        if (r.ok) summary.ok++
        else if (r.outcome === 'retry_locked' || r.outcome === 'retry_too_soon' || r.outcome === 'not_retryable' || r.outcome === 'paystack_refund_no_wallet' || r.outcome === 'retry_already_in_progress' || r.outcome === 'not_whitelisted') summary.skipped++
        else summary.failed++
      }

      return NextResponse.json({ success: true, data: { summary, results } })
    }

    const orderId = body?.orderId
    if (!isUuid(orderId)) {
      return NextResponse.json({ success: false, error: 'A valid orderId or orderIds is required' }, { status: 400 })
    }

    const result = await retryOrder(admin, { orderId, actorId, actorRole: 'admin' })
    if (result.ok) {
      return NextResponse.json({ success: true, data: { outcome: result.outcome, targetOrderId: result.targetOrderId, chargedAmount: result.chargedAmount, referenceCode: result.referenceCode, message: result.message } })
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
    console.error('[AdminOrderRetry] error:', e?.message || e)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
