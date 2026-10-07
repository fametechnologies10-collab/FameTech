/**
 * Refund orchestration — server-only. Wraps the idempotent DB RPCs and the Paystack Refund API.
 * Shared by the admin single-refund route and the admin bulk-refund route (DRY).
 *
 * Money never moves via direct table writes here — only via the SECURITY DEFINER RPCs:
 *   refund_order_wallet | settle_shop_refund_to_owner | mark_shop_order_refunded
 *
 * Shop-owner profit is never reversed by any refund/fail path — a refund only returns the
 * guest's payment (cost via settle_shop_refund_to_owner, or the full charge via Paystack); the
 * owner keeps their margin either way, same as a 'failed' order.
 */
import { isRefundable } from '@/lib/refunds'

export type RefundOutcome = 'refunded' | 'refund_initiated' | 'already_refunded' | 'skipped' | 'needs_confirmation' | 'needs_mechanism' | 'error'
export type ShopRefundMechanism = 'owner_wallet' | 'paystack'

export interface AdminRefundParams {
  orderId: string
  actorId: string
  mechanism?: ShopRefundMechanism
  confirmProcessing?: boolean
  reason?: string | null
}

export interface RefundResult {
  ok: boolean
  outcome: RefundOutcome
  message: string
  orderId: string
  amount?: number
}

/** Issue a Paystack refund for a previously-captured transaction. External call — not a DB op. */
export async function paystackRefund(
  transactionRef: string,
  amountPesewas?: number
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const key = process.env.PAYSTACK_SECRET_KEY
  if (!key) return { ok: false, error: 'paystack_secret_missing' }
  try {
    const body: Record<string, unknown> = { transaction: transactionRef }
    if (amountPesewas && amountPesewas > 0) body.amount = amountPesewas
    const res = await fetch('https://api.paystack.co/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json?.status !== true) {
      console.error('[refund] Paystack refund failed:', res.status, json?.message)
      return { ok: false, error: json?.message || `paystack_http_${res.status}` }
    }
    return { ok: true, status: json?.data?.status }
  } catch (e: unknown) {
    console.error('[refund] Paystack refund error:', e)
    return { ok: false, error: 'paystack_request_failed' }
  }
}

interface OrderRow {
  id: string
  user_id: string | null
  price: number
  status: string
  payment_status: string | null
  category: string | null
  shop_order_id: string | null
  reference_code: string | null
  phone_number: string | null
  network: string | null
  size: string | null
}

/**
 * True when two Ghanaian numbers are the same line written differently
 * (`0241234567` vs `233241234567` vs `+233 24 123 4567`). Compares the final 9
 * significant digits, which is the subscriber part in every local format.
 * Empty/absent inputs are never "the same" — there is nothing to compare.
 */
export function sameGhanaNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const norm = (s: string) => s.replace(/\D/g, '').slice(-9)
  const na = norm(a)
  const nb = norm(b)
  if (na.length < 9 || nb.length < 9) return false
  return na === nb
}

/**
 * Chooses who gets the refund alert. Pure and exported so the rule is directly
 * testable — the surrounding notify function does I/O and can't be unit tested
 * in this repo (no mocking framework).
 *
 * The beneficiary is always first and always included. The payer is appended
 * only when it is known AND is a genuinely different line — on ~31% of USSD
 * orders the payer is someone other than the beneficiary, and that person is
 * the one actually owed the money.
 */
export function selectRefundSmsRecipients(
  beneficiaryPhone: string,
  payerPhone: string | null | undefined
): string[] {
  if (!payerPhone) return [beneficiaryPhone]
  if (sameGhanaNumber(payerPhone, beneficiaryPhone)) return [beneficiaryPhone]
  return [beneficiaryPhone, payerPhone]
}

/**
 * Best-effort SMS to the GUEST beneficiary of a shop order — a shop refund settles to the
 * OWNER's wallet, so without this the guest has no way to know their order was refunded.
 * Also texts the PAYER (via resolveMomoPayerDetails) when known and different from the
 * beneficiary, since they are the one actually owed the money back.
 *
 * The beneficiary's SMS is sent FIRST and fully awaited before the payer is even looked
 * up. resolveMomoPayerDetails does unbounded external I/O (a Paystack verify call and/or
 * a name-resolution provider call) — on Vercel this function can be frozen the instant
 * the HTTP response returns, so queuing the beneficiary's send behind that lookup risked
 * it never happening at all on a slow provider, even though nothing here throws. The two
 * sends are independent failure domains: a failing/slow payer lookup must never affect
 * the beneficiary's alert, and vice versa.
 *
 * Never throws / never blocks the refund that already committed.
 */
async function notifyShopGuestRefund(admin: any, order: OrderRow) {
  if (!order.phone_number || !order.network || !order.size) return

  let so: any = null
  let ownerPhone: string | null = null
  try {
    const { data: soRow } = await admin
      .from('shop_orders')
      .select('id, shop_id, source, guest_phone, network, selling_price, paystack_reference, status, payer_momo_number, payer_momo_name, payer_momo_network, payer_momo_resolved_at')
      .eq('id', order.shop_order_id)
      .maybeSingle()
    so = soRow
    if (!so?.shop_id) return
    const { data: shop } = await admin.from('shop_profiles').select('owner_phone').eq('id', so.shop_id).maybeSingle()
    if (!shop?.owner_phone) return
    ownerPhone = shop.owner_phone
  } catch (e) {
    console.error('[refund] Guest refund SMS setup failed (non-fatal):', e)
    return
  }

  const { sendShopGuestRefundSMS } = await import('@/lib/sms-service')
  const details = { network: order.network, size: order.size, ownerPhone: ownerPhone as string }

  // 1. Beneficiary — sent first, fully awaited, before any payer I/O starts.
  try {
    const beneficiaryResult = await sendShopGuestRefundSMS(order.phone_number, details)
    if (beneficiaryResult && beneficiaryResult.success === false) {
      // sendSMS/sendShopGuestRefundSMS resolves with { success: false, error }
      // rather than throwing — checking only a caught exception would miss this.
      console.error('[refund] refund SMS to beneficiary not delivered (non-fatal):', beneficiaryResult.error)
    }
  } catch (e) {
    console.error('[refund] refund SMS to beneficiary failed (non-fatal):', e)
  }

  // 2. Payer — resolved and sent only after the beneficiary's send above has
  //    already completed. The payer is who is actually owed the money, and on
  //    roughly a third of USSD orders that is a different person from the
  //    beneficiary. `selectRefundSmsRecipients` remains the single source of
  //    truth for the dedup/inclusion rule; now that the beneficiary is always
  //    sent separately above, it's used here only to decide whether a second
  //    (payer) send is warranted, rather than duplicating the same-number
  //    comparison inline.
  try {
    const { resolveMomoPayerDetails } = await import('@/lib/momo-payer-resolver')
    const payer = await resolveMomoPayerDetails(so as any)
    const payerPhone = payer.ok && payer.data.number ? payer.data.number : null
    const recipients = selectRefundSmsRecipients(order.phone_number, payerPhone)
    if (recipients.length > 1) {
      const payerResult = await sendShopGuestRefundSMS(recipients[1], details)
      if (payerResult && payerResult.success === false) {
        console.error('[refund] refund SMS to payer not delivered (non-fatal):', payerResult.error)
      }
    }
  } catch (e) {
    // Never let a payer lookup/send failure affect the beneficiary's alert,
    // which already went out above.
    console.error('[refund] refund SMS to payer failed (non-fatal):', e)
  }
}

/** Best-effort in-app notification (never throws / never blocks the refund). */
async function notifyRefund(admin: any, userId: string | null, refCode: string | null, amount: number) {
  if (!userId) return
  try {
    await admin.from('notifications').insert({
      user_id: userId,
      title: 'Order Refunded',
      message: `Your order ${refCode ?? ''} has been refunded. GHS ${amount.toFixed(2)} has been credited to your wallet.`,
      type: 'balance_updated',
      action_url: '/dashboard/wallet',
    })
  } catch (e) {
    console.error('[refund] notification insert failed (non-fatal):', e)
  }
}

/**
 * Admin refund of a single `orders`-table order (retail data, or a shop order via its shop_order_id).
 * Idempotent (the RPCs enforce refund-once); safe to call twice → returns already_refunded.
 * Airtime retail orders are handled by the dedicated airtime route, not here.
 */
export async function adminRefundOrder(admin: any, params: AdminRefundParams): Promise<RefundResult> {
  const { orderId, actorId, mechanism, confirmProcessing, reason } = params

  const { data: order, error: fetchErr } = await admin
    .from('orders')
    .select('id, user_id, price, status, payment_status, category, shop_order_id, reference_code, phone_number, network, size')
    .eq('id', orderId)
    .maybeSingle()

  if (fetchErr || !order) {
    return { ok: false, outcome: 'error', message: 'Order not found', orderId }
  }
  const o = order as OrderRow

  const elig = isRefundable(o, 'admin')
  if (!elig.ok) {
    // Business-rule refusals are "skipped" (not hard errors) so bulk triage stays honest.
    const outcome: RefundOutcome = elig.reason === 'already_refunded' ? 'already_refunded' : 'skipped'
    return { ok: outcome === 'already_refunded', outcome, message: elig.reason || 'not_refundable', orderId }
  }

  if (o.status === 'processing' && !confirmProcessing) {
    return { ok: false, outcome: 'needs_confirmation', message: 'Processing order may already be delivered — confirmation required', orderId }
  }

  // ── Shop order path ─────────────────────────────────────────────────────
  if (o.shop_order_id) {
    if (mechanism !== 'owner_wallet' && mechanism !== 'paystack') {
      return { ok: false, outcome: 'needs_mechanism', message: 'Shop refund requires a mechanism (owner_wallet | paystack)', orderId }
    }
    if (mechanism === 'owner_wallet') {
      const { data, error } = await admin.rpc('settle_shop_refund_to_owner', {
        p_shop_order_id: o.shop_order_id, p_actor_id: actorId, p_reason: reason ?? null,
      })
      if (error) return { ok: false, outcome: 'error', message: error.message, orderId }
      if (data?.already_refunded) return { ok: true, outcome: 'already_refunded', message: 'Already refunded', orderId }
      if (data?.ok) {
        notifyShopGuestRefund(admin, o).catch(e => console.error('[refund] notifyShopGuestRefund threw:', e))
        return { ok: true, outcome: 'refunded', message: 'Refunded to shop owner wallet (cost)', orderId, amount: data?.amount }
      }
      return { ok: false, outcome: 'error', message: data?.error || 'settle_failed', orderId }
    }
    // paystack: refunds are ASYNC (Paystack: pending → processing → processed | failed | needs-attention).
    // We only INITIATE here. The order is NOT marked refunded until the `refund.processed` webhook
    // confirms it (see app/api/webhooks/paystack) — that avoids any rollback if the refund later fails
    // or needs the customer's bank details. Profit is never reversed on this path (see file header).
    const { data: so } = await admin.from('shop_orders')
      .select('paystack_reference, refund_method, status').eq('id', o.shop_order_id).maybeSingle()
    const soRow = so as any
    const ref = soRow?.paystack_reference
    if (!ref) return { ok: false, outcome: 'error', message: 'No paystack_reference on shop order', orderId }
    // Idempotency: never re-issue an external refund already in-progress/done for this order.
    // 'paystack_failed' is NOT blocked — a failed refund may be legitimately re-attempted.
    if (soRow.status === 'refunded') {
      return { ok: true, outcome: 'already_refunded', message: 'Already refunded', orderId }
    }
    if (soRow.refund_method === 'paystack' || soRow.refund_method === 'paystack_attention') {
      return { ok: true, outcome: 'already_refunded', message: 'Paystack refund already in progress', orderId }
    }
    const pr = await paystackRefund(ref)
    if (!pr.ok) return { ok: false, outcome: 'error', message: `Paystack refund failed: ${pr.error}`, orderId }
    // Mark in-progress: blocks re-issue + fulfillment. Status/profit finalized by the refund webhook.
    await admin.from('shop_orders')
      .update({ refund_method: 'paystack', refunded_by: actorId, refund_reason: reason ?? null })
      .eq('id', o.shop_order_id).in('status', ['pending', 'processing', 'failed'])
    return { ok: true, outcome: 'refund_initiated', message: 'Paystack refund initiated — completes when Paystack processes it', orderId }
  }

  // ── Retail wallet path (data / mashup-data) ─────────────────────────────
  const { data, error } = await admin.rpc('refund_order_wallet', {
    p_order_id: o.id, p_actor_id: actorId, p_reason: reason ?? null,
  })
  if (error) return { ok: false, outcome: 'error', message: error.message, orderId }
  if (data?.already_refunded) return { ok: true, outcome: 'already_refunded', message: 'Already refunded', orderId }
  if (data?.ok) {
    await notifyRefund(admin, o.user_id, o.reference_code, Number(data?.amount ?? o.price))
    // Web push, same treatment as the completed/failed order-status pushes. Fire-and-forget —
    // a push failure must never affect the refund result already committed above.
    import('@/lib/push-service').then(({ sendOrderRefundedPushNotification }) =>
      sendOrderRefundedPushNotification(orderId).catch(e => console.error('[refund] Push error:', e))
    ).catch(e => console.error('[refund] Failed to import push service:', e))
    return { ok: true, outcome: 'refunded', message: 'Refunded to wallet', orderId, amount: data?.amount }
  }
  return { ok: false, outcome: 'error', message: data?.error || 'refund_failed', orderId }
}
