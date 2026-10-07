import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createServerClient } from '@/lib/supabase'
import { processRefulfillment } from '@/lib/refulfillment-service'
import { logAdminPaymentAction } from '@/lib/payment-reconciliation'

export async function POST(request: NextRequest) {
  const access = await validateAdminAccess(false)
  if (access.error || !access.user) return NextResponse.json({ success: false, error: access.error }, { status: access.status })

  let body: any = {}
  try { body = await request.json() } catch { /* noop */ }
  const source = body?.source as string | undefined
  const shopOrderId = body?.orderId as string | undefined
  const reference = body?.reference as string | undefined

  if (source !== 'shop') {
    return NextResponse.json({ success: false, error: 'Retry is only available for shop data orders. Use Verify for other sources.' }, { status: 400 })
  }

  const db = createServerClient() as any

  let internalOrder: { id: string; status: string } | undefined
  if (shopOrderId) {
    const { data } = await db.from('orders').select('id, status').eq('shop_order_id', shopOrderId).maybeSingle()
    internalOrder = data || undefined
  } else if (reference) {
    const refCode = `SHOP-${reference.slice(-10)}`
    const { data } = await db.from('orders').select('id, status').eq('reference_code', refCode).maybeSingle()
    internalOrder = data || undefined
  }

  if (!internalOrder?.id) {
    return NextResponse.json({ success: false, error: 'No internal data order found to retry (order may be airtime, or already delivered).' }, { status: 404 })
  }
  if (internalOrder.status !== 'pending') {
    return NextResponse.json({ success: false, error: `Order is not pending (status: ${internalOrder.status}); nothing to retry.` }, { status: 409 })
  }
  const internalOrderId = internalOrder.id

  const result = await processRefulfillment(false, [internalOrderId])
  const ok = !!result?.success && (result.fulfilled || 0) > 0
  await logAdminPaymentAction(access.user.id, 'retry_fulfillment',
    { reference, source: 'shop', outcome: ok ? 'processed' : 'failed', detail: { fulfilled: result?.fulfilled, failed: result?.failed, skipped: result?.skipped } })

  return NextResponse.json({
    success: !!result?.success,
    data: result,
    message: ok ? 'Re-fulfillment dispatched' : 'No order was fulfilled (check supplier config / order eligibility)',
  })
}
