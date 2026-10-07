import { createServerClient } from './supabase'
import { fetchPaystackStatus } from './payment-reconciliation'

const TERMINAL = new Set(['failed', 'abandoned', 'reversed'])

// PII-minimised snapshot persisted on failed rows (no full Paystack payload).
function safePaystackSnapshot(raw: any) {
  if (!raw || typeof raw !== 'object') return null
  return {
    reference: raw.reference ?? null,
    amount_kobo: raw.amount ?? null,
    status: raw.status ?? null,
    channel: raw.channel ?? null,
    paid_at: raw.paid_at ?? raw.paidAt ?? null,
    gateway_response: raw.gateway_response ?? raw.message ?? null,
  }
}

export interface RunResult {
  processed: number
  verified: number
  failed: number
  agedOut: number
  stillPending: number
  hadSystemicError: boolean
}

export interface RunOptions {
  limit?: number
  olderThanMinutes?: number
  ageOutHours?: number
  concurrency?: number
}

async function resolveAgeOutHours(db: any, override?: number): Promise<number> {
  if (typeof override === 'number' && override > 0) return override
  try {
    const { data } = await db.from('admin_settings').select('value').eq('key', 'payment_ageout_hours').maybeSingle()
    if (data?.value != null) {
      const n = Number(data.value)
      if (Number.isFinite(n) && n > 0) return n
      console.warn('[PendingRunner] invalid payment_ageout_hours value, using 24h default:', data.value)
    }
  } catch { /* fall through to default */ }
  return 24
}

/**
 * Verifies a batch of pending wallet_payments via the dual-endpoint check and
 * settles / fails / ages-out each. Idempotent (processors guard with atomic
 * status='pending' updates). Used by the cron and the admin Run-check button.
 */
export async function runPendingPaymentCheck(opts: RunOptions = {}): Promise<RunResult> {
  const limit = opts.limit ?? 20
  const olderThanMinutes = opts.olderThanMinutes ?? 5
  const concurrency = opts.concurrency ?? 5
  const db = createServerClient() as any
  const ageOutHours = await resolveAgeOutHours(db, opts.ageOutHours)

  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString()
  const ageOutBefore = Date.now() - ageOutHours * 60 * 60 * 1000

  const { data: payments, error } = await db
    .from('wallet_payments')
    .select('id, reference, metadata, created_at')
    .eq('status', 'pending')
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true }) // FIFO — oldest first
    .limit(limit)

  if (error) {
    console.error('[PendingRunner] select error:', error)
    return { processed: 0, verified: 0, failed: 0, agedOut: 0, stillPending: 0, hadSystemicError: true }
  }

  const rows: any[] = payments || []
  const result: RunResult = { processed: rows.length, verified: 0, failed: 0, agedOut: 0, stillPending: 0, hadSystemicError: false }
  let unreachableCount = 0

  const markFailed = async (payment: any, extraMeta: Record<string, any>) => {
    const { error: upErr } = await db.from('wallet_payments')
      .update({
        status: 'failed',
        metadata: { ...(payment.metadata || {}), ...extraMeta },
        updated_at: new Date().toISOString(),
      })
      .eq('id', payment.id)
      .eq('status', 'pending') // guard: never clobber a concurrently-completed row
    if (upErr) console.error('[PendingRunner] markFailed error for', payment.id, upErr)
    return !upErr
  }

  const processOne = async (payment: any) => {
    try {
      const status = await fetchPaystackStatus(payment.reference)
      if (status.unreachable) { unreachableCount++; result.stillPending++; return }
      const ps = status.paystackStatus

      if (ps === 'success') {
        const tx = status.raw
        const metadata = (tx && tx.metadata) || {}
        let r: any
        if (metadata?.upgrade_type === 'dealer') {
          const { processCompletedDealerUpgradePayment } = await import('./dealer-payments')
          r = await processCompletedDealerUpgradePayment(payment.reference, tx)
        } else if (metadata?.upgrade_type === 'agent') {
          const { processCompletedUpgradePayment } = await import('./payments')
          r = await processCompletedUpgradePayment(payment.reference, tx)
        } else {
          const { processCompletedWalletPayment } = await import('./payments')
          r = await processCompletedWalletPayment(payment.reference, tx)
        }
        // Counting reflects the row state the processor leaves behind: success → verified;
        // 'Amount mismatch' is the ONLY non-success that marks the row failed; every other
        // non-success (e.g. transient credit-RPC failure) resets the row to pending → stillPending.
        if (r?.success) result.verified++
        else if (r?.error === 'Amount mismatch') result.failed++ // processor already marked it failed
        else result.stillPending++ // transient processor failure — next run retries
        return
      }

      if (ps && TERMINAL.has(ps)) {
        const ok = await markFailed(payment, { paystack_snapshot: safePaystackSnapshot(status.raw), failed_reason: ps })
        if (ok) result.failed++; else result.stillPending++
        return
      }

      // non-terminal (pending/ongoing/...) — age out only on a DEFINITIVE status + old enough
      // Age-out runs on the AUTHORITATIVE status: a non-terminal charge state already
      // falls through to /transaction/verify in fetchPaystackStatus, so `ps` here is
      // verify-confirmed. A payment that verify itself still reports non-success 24h+
      // after creation is realistically dead at Paystack. (Admins can raise payment_ageout_hours.)
      if (ps && new Date(payment.created_at).getTime() < ageOutBefore) {
        const ok = await markFailed(payment, { failed_reason: 'aged_out', last_paystack_status: ps, aged_out_at: new Date().toISOString() })
        if (ok) result.agedOut++; else result.stillPending++
        return
      }

      result.stillPending++
    } catch (e) {
      console.error('[PendingRunner] processOne error for', payment?.reference, e)
      result.stillPending++
    }
  }

  for (let i = 0; i < rows.length; i += concurrency) {
    await Promise.allSettled(rows.slice(i, i + concurrency).map(processOne))
  }
  // Only a truly systemic failure (Paystack down / missing secret) flags the run —
  // a single transient unreachable must NOT alarm the whole batch.
  if (rows.length > 0 && unreachableCount === rows.length) {
    result.hadSystemicError = true
  }
  return result
}
