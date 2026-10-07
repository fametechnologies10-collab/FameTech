import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { isRefundable, isUuid } from '@/lib/refunds'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

/**
 * POST /api/user/orders/refund
 * Self-service refund for a REGISTERED user's OWN order.
 * Strict gates: caller owns the order; status === 'pending'; NOT a shop order (shop_order_id IS NULL).
 * Credits the caller's wallet via the idempotent refund_order_wallet RPC. Guests cannot reach this
 * (no session). Processing/failed/completed are NOT self-refundable (admin-only for those).
 *
 * Body: { orderId: string }
 */
export async function POST(request: NextRequest) {
  try {
    const supabaseUserClient = await createRouteClient()
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const rl = consumeRateLimit(`user-refund:${authUser.id}`, 5, 60_000)
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests, please wait a moment.' }, { status: 429 })
    }

    const body = await request.json().catch(() => ({}))
    const orderId = body?.orderId
    if (!isUuid(orderId)) {
      return NextResponse.json({ success: false, error: 'A valid orderId is required' }, { status: 400 })
    }

    // Fetch via the RLS-aware client scoped to the caller — ownership is enforced structurally
    // (RLS + explicit user_id filter), not by a procedural app-level check.
    const { data: order, error: fetchErr } = await supabaseUserClient
      .from('orders')
      .select('id, user_id, status, payment_status, shop_order_id')
      .eq('id', orderId)
      .eq('user_id', authUser.id)
      .maybeSingle()

    if (fetchErr || !order) {
      return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 })
    }
    // Self-service is retail-only: shop orders are admin-refunded.
    if ((order as any).shop_order_id) {
      return NextResponse.json({ success: false, error: 'This order cannot be self-refunded.' }, { status: 400 })
    }
    // Pending/queued-only for users; blocks completed/processing/failed and already-refunded.
    const elig = isRefundable(order as any, 'user')
    if (!elig.ok) {
      const msg = elig.reason === 'already_refunded'
        ? 'This order has already been refunded.'
        : 'Only pending or queued orders can be refunded.'
      return NextResponse.json({ success: false, error: msg }, { status: 400 })
    }

    // Service-role client ONLY to invoke the service_role-locked refund RPC (money movement).
    const admin = createServerClient()
    const { data, error } = await (admin as any).rpc('refund_order_wallet', {
      p_order_id: orderId, p_actor_id: authUser.id, p_reason: 'user self-service refund (pending)',
    })
    if (error) {
      console.error('[UserRefund] RPC error:', error)
      return NextResponse.json({ success: false, error: 'Refund failed, please try again.' }, { status: 500 })
    }
    if ((data as any)?.already_refunded) {
      return NextResponse.json({ success: true, data: { outcome: 'already_refunded' } })
    }
    if ((data as any)?.ok) {
      return NextResponse.json({ success: true, data: { outcome: 'refunded', amount: (data as any)?.amount } })
    }
    return NextResponse.json({ success: false, error: (data as any)?.error || 'Refund could not be completed.' }, { status: 400 })
  } catch (error: any) {
    console.error('[UserRefund] Error:', error)
    return NextResponse.json({ success: false, error: error?.message || 'Internal server error' }, { status: 500 })
  }
}
