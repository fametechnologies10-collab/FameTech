import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { adminRefundOrder, type ShopRefundMechanism } from '@/lib/refund-service'
import { isUuid } from '@/lib/refunds'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

/**
 * POST /api/admin/orders/refund
 * Admin-only (NOT sub-admin). Refunds a single `orders`-table order.
 *  - Retail data order → credits the buyer's wallet (idempotent RPC).
 *  - Shop order (shop_order_id set) → admin picks mechanism:
 *      'owner_wallet' → credit cost_price to owner's personal wallet (profit KEPT)
 *      'paystack'     → refund the guest via Paystack + reverse owner profit
 * Completed orders can never be refunded. Processing orders require confirmProcessing=true.
 * Idempotent: a repeat returns success with outcome 'already_refunded' (never double-credits).
 *
 * Body: { orderId: uuid, mechanism?: 'owner_wallet'|'paystack', confirmProcessing?: boolean, reason?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const supabaseUserClient = await createRouteClient()
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    // Role check via the SERVICE-ROLE client — immune to any users-table RLS misconfiguration
    // (the project has previously had role-escalation holes; do not trust an RLS-read role here).
    const admin = createServerClient()
    const { data: userData } = await admin.from('users').select('role').eq('id', authUser.id).single()
    if ((userData as any)?.role !== 'admin') {
      return NextResponse.json({ success: false, error: 'Forbidden — admin only' }, { status: 403 })
    }

    const rl = consumeRateLimit(`admin-refund:${authUser.id}`, 20, 60_000)
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Too many refund requests, slow down.' }, { status: 429 })
    }

    const body = await request.json().catch(() => ({}))
    const orderId = body?.orderId
    if (!isUuid(orderId)) {
      return NextResponse.json({ success: false, error: 'A valid orderId is required' }, { status: 400 })
    }
    const mechanism: ShopRefundMechanism | undefined =
      body?.mechanism === 'owner_wallet' || body?.mechanism === 'paystack' ? body.mechanism : undefined
    const confirmProcessing = body?.confirmProcessing === true
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : null

    const result = await adminRefundOrder(admin, {
      orderId, actorId: authUser.id, mechanism, confirmProcessing, reason,
    })

    if (result.ok) {
      return NextResponse.json({ success: true, data: { outcome: result.outcome, amount: result.amount, message: result.message } })
    }

    const code = result.outcome
    const status = code === 'needs_confirmation' || code === 'needs_mechanism' || code === 'skipped' ? 400 : 500
    return NextResponse.json({ success: false, error: result.message, code }, { status })
  } catch (error: any) {
    console.error('[RefundOrder] Error:', error)
    return NextResponse.json({ success: false, error: error?.message || 'Internal server error' }, { status: 500 })
  }
}
