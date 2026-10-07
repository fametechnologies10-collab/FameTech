import { createServerClient } from '@/lib/supabase'

export type PaymentSource = 'main' | 'shop' | 'results_checker'
export type ReconState =
  | 'reconciled' | 'paid_unsettled' | 'mismatch' | 'in_flight' | 'failed' | 'unknown'
export type DbState = 'processed' | 'pending' | 'missing' | 'failed'

type ProcessorResult = {
  success: boolean
  isDuplicate?: boolean
  alreadyProcessed?: boolean
  error?: string
  orderId?: string
}

const REFERENCE_SHAPE = /^[A-Za-z0-9_-]{6,90}$/

/** Pure: prefix → source. Mirrors the webhook + verify-pending cron. */
export function routeReference(reference: string): { source: PaymentSource } {
  if (reference.startsWith('RC-')) return { source: 'results_checker' }
  if (reference.startsWith('SHOP-')) return { source: 'shop' }
  return { source: 'main' }
}

/** Pure: Paystack status × our DB state → reconciliation state. */
export function deriveReconState(paystackStatus: string | undefined, dbState: DbState): ReconState {
  const ps = (paystackStatus || '').toLowerCase()
  if (ps === 'success') {
    if (dbState === 'processed') return 'reconciled'
    if (dbState === 'failed') return 'mismatch'
    return 'paid_unsettled' // missing or pending → can be reconciled
  }
  if (ps === 'failed' || ps === 'abandoned' || ps === 'reversed') return 'failed'
  if (ps === 'pending' || ps === 'ongoing' || ps === 'processing') return 'in_flight'
  return 'unknown'
}

export function isValidReferenceShape(reference: string): boolean {
  return REFERENCE_SHAPE.test(reference)
}

const PAYSTACK_TERMINAL = new Set(['failed', 'abandoned', 'reversed'])

export interface PaystackStatusResult {
  paystackStatus?: string
  amount?: number      // GHS
  raw?: any            // Paystack data.data — carries amount(kobo)+metadata for the processors
  via?: 'charge' | 'verify'
  unreachable?: boolean
  error?: string
}

async function paystackGet(url: string, key: string): Promise<{ ok: boolean; data?: any }> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } })
    const json = await res.json()
    if (!res.ok || !json?.status || !json?.data) return { ok: false }
    return { ok: true, data: json.data }
  } catch {
    return { ok: false }
  }
}

/**
 * Charge-first, verify-confirmed status check.
 * - A `success` from `/charge/{ref}` is acted on immediately (fast path) — crediting
 *   downstream is idempotent + amount-verified, so an early success is safe.
 * - A TERMINAL charge verdict (failed/abandoned/reversed) is DESTRUCTIVE for the caller
 *   (it marks the payment failed), so it is confirmed against the authoritative
 *   `/transaction/verify/{ref}` endpoint before being treated as terminal.
 * - A non-terminal charge state falls through to `/transaction/verify/{ref}`, which is
 *   authoritative and covers redirect/checkout refs that have no charge record.
 * - `unreachable` is returned only when BOTH endpoints fail and MUST NOT be treated as
 *   terminal by callers.
 */
export async function fetchPaystackStatus(reference: string): Promise<PaystackStatusResult> {
  const key = process.env.PAYSTACK_SECRET_KEY
  if (!key) return { unreachable: true, error: 'Payment service unavailable' }
  const enc = encodeURIComponent(reference)

  const charge = await paystackGet(`https://api.paystack.co/charge/${enc}`, key)
  if (charge.ok) {
    const st: string = charge.data.status
    // Fast path: a SUCCESS from /charge is safe to act on immediately — crediting is
    // idempotent and amount-verified downstream. This preserves the speed benefit.
    if (st === 'success') {
      return {
        paystackStatus: st,
        amount: typeof charge.data.amount === 'number' ? charge.data.amount / 100 : undefined,
        raw: charge.data, via: 'charge',
      }
    }
    // A TERMINAL verdict (failed/abandoned/reversed) is DESTRUCTIVE — it will mark the
    // payment failed (unrecoverable). NEVER trust /charge alone for that: confirm against
    // the authoritative /transaction/verify endpoint first. (security fix: PAYMENT-001)
    if (PAYSTACK_TERMINAL.has(st)) {
      const verifyT = await paystackGet(`https://api.paystack.co/transaction/verify/${enc}`, key)
      if (verifyT.ok) {
        return {
          paystackStatus: verifyT.data.status,
          amount: typeof verifyT.data.amount === 'number' ? verifyT.data.amount / 100 : undefined,
          raw: verifyT.data, via: 'verify',
        }
      }
      // verify UNREACHABLE on a destructive terminal verdict: do NOT fail the payment on the
      // charge signal alone. Report unreachable so the caller leaves the row pending and
      // retries when verify is reachable. (strictly fail-safe — PAYMENT-001 hardening)
      return { unreachable: true, error: 'Could not reach Paystack to confirm terminal status' }
    }
    // non-terminal charge state (pending/ongoing/send_otp) — prefer authoritative verify next
  }

  const verify = await paystackGet(`https://api.paystack.co/transaction/verify/${enc}`, key)
  if (verify.ok) {
    return {
      paystackStatus: verify.data.status,
      amount: typeof verify.data.amount === 'number' ? verify.data.amount / 100 : undefined,
      raw: verify.data, via: 'verify',
    }
  }

  if (charge.ok) {
    return {
      paystackStatus: charge.data.status,
      amount: typeof charge.data.amount === 'number' ? charge.data.amount / 100 : undefined,
      raw: charge.data, via: 'charge',
    }
  }
  return { unreachable: true, error: 'Could not reach Paystack' }
}

export interface VerifyResult {
  ok: boolean
  reference: string
  source: PaymentSource
  paystackStatus?: string
  amount?: number          // GHS
  processed: boolean
  alreadyProcessed?: boolean
  error?: string
}

/**
 * Verify a reference with Paystack, then route to the matching idempotent processor.
 * Safe to call repeatedly — every processor guards against double-processing.
 */
export async function verifyAndProcessReference(reference: string): Promise<VerifyResult> {
  const { source } = routeReference(reference)
  if (!isValidReferenceShape(reference)) {
    return { ok: false, reference, source, processed: false, error: 'Invalid reference' }
  }
  const status = await fetchPaystackStatus(reference)
  if (status.unreachable) {
    return { ok: false, reference, source, processed: false, error: status.error || 'Could not reach Paystack' }
  }
  const paystackStatus = status.paystackStatus
  const amount = status.amount
  const tx = status.raw

  if (paystackStatus !== 'success') {
    return { ok: true, reference, source, paystackStatus, amount, processed: false }
  }

  const metadata = (tx && tx.metadata) || {}
  try {
    if (source === 'results_checker') {
      const { processRCShopOrder } = await import('@/lib/results-checker-service')
      const r: ProcessorResult = await processRCShopOrder(reference, metadata, tx.amount || 0)
      return { ok: !!r?.success, reference, source, paystackStatus, amount, processed: !!r?.success, alreadyProcessed: r?.isDuplicate, error: r?.success ? undefined : r?.error }
    }
    if (source === 'shop') {
      const { processShopOrder } = await import('@/lib/shop-order-processor')
      const r: ProcessorResult = await processShopOrder(reference, metadata, tx.amount || 0, metadata.slug || metadata.shop_slug)
      return { ok: !!r?.success, reference, source, paystackStatus, amount, processed: !!r?.success, alreadyProcessed: r?.isDuplicate, error: r?.success ? undefined : r?.error }
    }
    // main
    if (metadata?.upgrade_type === 'dealer') {
      const { processCompletedDealerUpgradePayment } = await import('@/lib/dealer-payments')
      const r: ProcessorResult = await processCompletedDealerUpgradePayment(reference, tx)
      return { ok: !!r?.success, reference, source, paystackStatus, amount, processed: !!r?.success, alreadyProcessed: r?.alreadyProcessed }
    }
    if (metadata?.upgrade_type === 'agent') {
      const { processCompletedUpgradePayment } = await import('@/lib/payments')
      const r: ProcessorResult = await processCompletedUpgradePayment(reference, tx)
      return { ok: !!r?.success, reference, source, paystackStatus, amount, processed: !!r?.success, alreadyProcessed: r?.alreadyProcessed }
    }
    const { processCompletedWalletPayment } = await import('@/lib/payments')
    const r: ProcessorResult = await processCompletedWalletPayment(reference, tx)
    return { ok: !!r?.success, reference, source, paystackStatus, amount, processed: !!r?.success, alreadyProcessed: r?.alreadyProcessed }
  } catch (e: any) {
    console.error('[payment-reconciliation] processor error:', e)
    return { ok: false, reference, source, paystackStatus, amount, processed: false, error: 'Processing failed' }
  }
}

/**
 * Best-effort audit log. Never throws — if the table isn't migrated yet, it no-ops.
 * `detail` should contain only ids/status/outcome — never raw Paystack payloads (PII).
 */
export async function logAdminPaymentAction(
  adminId: string,
  action: 'verify' | 'reconcile' | 'retry_fulfillment' | 'run_check',
  info: { reference?: string; source?: PaymentSource; outcome?: string; detail?: any },
): Promise<void> {
  if (!adminId) return
  try {
    const db = createServerClient() as any
    await db.from('admin_payment_actions').insert({
      admin_id: adminId,
      action,
      reference: info.reference ?? null,
      source: info.source ?? null,
      outcome: info.outcome ?? null,
      detail: info.detail ?? null,
    })
  } catch (e) {
    console.error('[payment-reconciliation] audit log failed:', e)
  }
}
