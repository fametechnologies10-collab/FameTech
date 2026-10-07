import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { adminRefundOrder, type ShopRefundMechanism } from '@/lib/refund-service'
import { MAX_BULK_REFUND, isUuid } from '@/lib/refunds'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

/**
 * POST /api/admin/orders/bulk-refund
 * Admin-only (NOT sub-admin). Refunds up to MAX_BULK_REFUND (50) orders in one request.
 * Processed SEQUENTIALLY (not Promise.all) — each order goes through the same idempotent
 * adminRefundOrder path as the single route, so a repeat / double-submit never double-credits.
 *
 * Body: { orderIds: string[], mechanism?: 'owner_wallet'|'paystack', confirmProcessing?: boolean, reason?: string }
 * Response: { success, data: { summary: { ok, skipped, failed, total }, results: [...] } }
 */
async function verifyAdmin(supabaseUserClient: any): Promise<string | null> {
  const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
  if (error || !authUser) return null
  const admin = createServerClient()
  const { data: user } = await admin.from('users').select('role').eq('id', authUser.id).single()
  // Refunds are strictly admin-only (sub-admin excluded).
  return (user as any)?.role === 'admin' ? authUser.id : null
}

export async function POST(request: NextRequest) {
  try {
    const supabaseUserClient = await createRouteClient()
    const actorId = await verifyAdmin(supabaseUserClient)
    if (!actorId) return NextResponse.json({ success: false, error: 'Forbidden — admin only' }, { status: 403 })

    const rl = consumeRateLimit(`admin-bulk-refund:${actorId}`, 10, 60_000)
    if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many bulk-refund requests, slow down.' }, { status: 429 })

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 }) }

    const rawIds = body?.orderIds
    if (!Array.isArray(rawIds) || rawIds.length === 0 || !rawIds.every((id: any) => isUuid(id))) {
      return NextResponse.json({ success: false, error: 'orderIds must be a non-empty array of UUIDs' }, { status: 400 })
    }
    const orderIds = Array.from(new Set(rawIds as string[]))
    if (orderIds.length > MAX_BULK_REFUND) {
      return NextResponse.json({ success: false, error: `Select at most ${MAX_BULK_REFUND} orders` }, { status: 400 })
    }

    const mechanism: ShopRefundMechanism | undefined =
      body?.mechanism === 'owner_wallet' || body?.mechanism === 'paystack' ? body.mechanism : undefined
    const confirmProcessing = body?.confirmProcessing === true
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : null

    const admin = createServerClient()
    const results: any[] = []
    // Sequential — pace external Paystack calls and keep row-lock contention low.
    for (const id of orderIds) {
      try {
        const r = await adminRefundOrder(admin, { orderId: id, actorId, mechanism, confirmProcessing, reason })
        results.push({ orderId: id, ok: r.ok, outcome: r.outcome, message: r.message, amount: r.amount })
      } catch (e: any) {
        results.push({ orderId: id, ok: false, outcome: 'error', message: String(e?.message || e) })
      }
    }

    const summary = { ok: 0, skipped: 0, failed: 0, total: results.length }
    for (const r of results) {
      if (r.ok && (r.outcome === 'refunded' || r.outcome === 'refund_initiated')) summary.ok++
      else if (r.outcome === 'already_refunded' || r.outcome === 'skipped') summary.skipped++
      else summary.failed++
    }

    return NextResponse.json({ success: true, data: { summary, results } }, { status: 200 })
  } catch (e: any) {
    console.error('[BulkRefund] error:', e?.message || e)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
