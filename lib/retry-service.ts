/**
 * Retry orchestration — server-only. Wraps the claim_order_retry RPC and dispatch.
 * Shared by the user single-retry route and the admin single/bulk-retry routes (DRY).
 *
 * Money never moves via direct table writes here — only via claim_order_retry
 * (SECURITY DEFINER). This module resolves the CURRENT price in TypeScript
 * (lib/pricing/cost-basis.ts is the single source of truth for that) and hands
 * it to the RPC as an opaque, already-correct number.
 */
import { isRetryEligible, checkRetryCooldown, resolveRetryFundingWallet } from '@/lib/retry-eligibility'
import { resolveOwnerCost } from '@/lib/pricing/cost-basis'
import { generateReferenceCode } from '@/lib/utils'
import { checkMtnWhitelistGate } from '@/lib/mtn-whitelist-gate'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentDataCost } from '@/lib/sub-agent-data-pricing'
import { recordPendingSubAgentEarning } from '@/lib/sub-agent-earnings'

export type RetryActorRole = 'admin' | 'user'

export type RetryOutcome =
  | 'retried'
  | 'admin_only'
  | 'not_owner'
  | 'not_retryable'
  | 'retry_too_soon'
  | 'retry_locked'
  | 'not_whitelisted'
  | 'paystack_refund_no_wallet'
  | 'insufficient_balance'
  | 'order_not_found'
  | 'invalid_actor_role'
  | 'invalid_charge_amount'
  | 'duplicate_attempt'
  | 'retry_already_in_progress'
  | 'owner_not_found'
  | 'no_wallet_user'
  | 'error'

export interface RetryOrderParams {
  orderId: string
  actorId: string
  actorRole: RetryActorRole
}

export interface RetryOrderResult {
  ok: boolean
  outcome: RetryOutcome
  message: string
  orderId: string
  targetOrderId?: string
  chargedAmount?: number
  referenceCode?: string
  /** Populated for insufficient_balance — what the retry needed vs. what the funding wallet holds. */
  required?: number
  available?: number
  /** Populated for retry_locked (24h lockout expiry) / retry_too_soon (60s cooldown expiry). */
  until?: string
  retryAfter?: string
  /** Populated for not_retryable — the order's actual current status. */
  currentStatus?: string
}

interface OrderRow {
  id: string
  user_id: string | null
  price: number
  status: string
  category: string | null
  network: string
  size: string
  phone_number: string
  shop_order_id: string | null
  reference_code: string | null
  retry_count: number
  last_retry_at: string | null
  refunded_at: string | null
}

export async function retryOrder(admin: any, params: RetryOrderParams): Promise<RetryOrderResult> {
  const { orderId, actorId, actorRole } = params

  const { data: order, error: fetchErr } = await admin
    .from('orders')
    .select('id, user_id, price, status, category, network, size, phone_number, shop_order_id, reference_code, retry_count, last_retry_at, refunded_at')
    .eq('id', orderId)
    .maybeSingle()

  if (fetchErr || !order) {
    return { ok: false, outcome: 'error', message: 'Order not found', orderId }
  }
  const o = order as OrderRow

  // Resolve the shop behind this order once — needed for BOTH the ownership check
  // and the funding wallet. For source='ussd_shop', orders.user_id is the USSD
  // caller (a guest, or null), NOT the shop owner — the owner is reachable only
  // via shop_orders.shop_id -> shop_profiles.owner_id. Web storefront orders
  // already set orders.user_id = owner, but this covers both uniformly.
  let shopOrderRow: { refund_method: string | null; owner_id: string | null } | null = null
  if (o.shop_order_id) {
    const { data: so } = await admin
      .from('shop_orders')
      .select('refund_method, shop_id')
      .eq('id', o.shop_order_id)
      .maybeSingle()
    let ownerId: string | null = null
    if (so?.shop_id) {
      const { data: shop } = await admin
        .from('shop_profiles')
        .select('owner_id')
        .eq('id', so.shop_id)
        .maybeSingle()
      ownerId = shop?.owner_id ?? null
    }
    shopOrderRow = { refund_method: so?.refund_method ?? null, owner_id: ownerId }
  }

  const isOwner = o.user_id === actorId || (!!shopOrderRow?.owner_id && shopOrderRow.owner_id === actorId)
  const elig = isRetryEligible({ status: o.status, refunded_at: o.refunded_at }, actorRole, isOwner)
  if (!elig.ok) {
    return {
      ok: false,
      outcome: elig.reason ?? 'not_retryable',
      message: elig.reason || 'not_retryable',
      orderId,
      currentStatus: elig.reason === 'not_retryable' ? o.status : undefined,
    }
  }

  const cooldown = checkRetryCooldown({ retry_count: o.retry_count, last_retry_at: o.last_retry_at })
  if (!cooldown.ok) {
    return {
      ok: false,
      outcome: cooldown.reason ?? 'error',
      message: cooldown.reason || 'error',
      orderId,
      retryAfter: cooldown.retryAfter?.toISOString(),
      until: cooldown.reason === 'retry_locked' ? cooldown.retryAfter?.toISOString() : undefined,
    }
  }

  // MTN AgentPortal whitelist gate — applies to BOTH retry modes (no-charge
  // re-dispatch and paid new-order retry), before claim_order_retry is ever
  // called: a still-failed order gets a doomed retry for free otherwise (burning
  // one of its limited attempts before the 24h lockout), and a refunded order
  // would get re-charged for a number that's certain to fail again for the same
  // reason. Independent of the number-registration gate; no-ops entirely when
  // the admin toggle is off, and fails open on any AgentPortal/DB error —
  // identical behavior to every purchase surface, just applied here too.
  const whitelistGate = await checkMtnWhitelistGate(o.phone_number, o.network, o.category)
  if (whitelistGate.blocked) {
    return {
      ok: false,
      outcome: 'not_whitelisted',
      message: whitelistGate.reason || 'This number is not currently eligible for MTN data.',
      orderId,
    }
  }

  let chargeAmount = 0
  let referenceCode: string | null = null
  let costPrice: number | null = null
  let fundingUserId: string | null = null
  // Populated only when the funding user is a currently-active sub-agent AND the
  // resolved recruiter margin is positive — recordPendingSubAgentEarning() itself
  // treats amount<=0 as "nothing to record" (spec §4.2), so we mirror that here
  // rather than call it unconditionally with a possibly-zero amount.
  let subAgentEarning: { recruiterId: string; amount: number } | null = null

  // Paid path is gated by refunded_at, not status === 'refunded' — a row can
  // drift to status='failed' after already being refunded (see comment on
  // isRetryEligible in lib/retry-eligibility.ts). Mirrors the RPC's branch
  // selection so this TS-side price/charge computation and the DB-side branch
  // never disagree.
  if (o.refunded_at) {
    const fundingWallet = resolveRetryFundingWallet(
      { shop_order_id: o.shop_order_id, user_id: o.user_id },
      shopOrderRow
    )
    if (!fundingWallet.ok) {
      return { ok: false, outcome: fundingWallet.error, message: fundingWallet.error || 'error', orderId }
    }
    fundingUserId = fundingWallet.userId

    // Resolve TODAY's price. Shop retries price at the network/size's current cost
    // basis for the owner's own role; retail retries price at the buyer's own role.
    const { data: pkg } = await admin
      .from('data_packages')
      .select('id, price, agent_price, dealer_price, cost_price')
      .eq('network', o.network)
      .eq('size', o.size)
      .eq('is_available', true)
      .maybeSingle()

    if (!pkg) {
      return { ok: false, outcome: 'error', message: 'Package no longer available for retry pricing', orderId }
    }

    // Sub-agent pricing takes precedence over the plain role-based cost basis —
    // resolveOwnerCost() below only recognizes 'dealer'/'agent' and would otherwise
    // silently charge a sub-agent the plain customer price and skip recording their
    // recruiter's margin entirely. Resolved from fundingWallet.userId — the shop
    // owner for a shop retry, the buyer for a retail retry (see resolveRetryFundingWallet
    // above) — matching every other purchase path's "price the funding user" rule.
    const subCtx = await resolveSubAgentContext(admin, fundingWallet.userId)
    if (subCtx.isSub && subCtx.effectiveActive) {
      const resolved = await resolveSubAgentDataCost(admin, fundingWallet.userId, (pkg as any).id, pkg, 'data')
      if (!resolved.ok) {
        return { ok: false, outcome: 'error', message: resolved.reason || 'Pricing is not available for this package right now', orderId }
      }
      chargeAmount = resolved.subCost
      costPrice = (pkg as any).cost_price ?? null
      if (resolved.recruiterEarns > 0 && resolved.recruiterId) {
        subAgentEarning = { recruiterId: resolved.recruiterId, amount: resolved.recruiterEarns }
      }
    } else {
      const { data: fundingUserRow } = await admin
        .from('users')
        .select('role, agent_expires_at, dealer_expires_at')
        .eq('id', fundingWallet.userId)
        .maybeSingle()

      chargeAmount = resolveOwnerCost(pkg as any, {
        role: fundingUserRow?.role,
        agent_expires_at: fundingUserRow?.agent_expires_at,
        dealer_expires_at: fundingUserRow?.dealer_expires_at,
      })
      costPrice = (pkg as any).cost_price ?? null
    }
    referenceCode = generateReferenceCode()
  }

  const { data: claimResult, error: claimErr } = await admin.rpc('claim_order_retry', {
    p_order_id: orderId,
    p_actor_id: actorId,
    p_actor_role: actorRole,
    p_charge_amount: chargeAmount,
    p_reference_code: referenceCode,
    p_cost_price: costPrice,
  })

  if (claimErr) {
    return { ok: false, outcome: 'error', message: claimErr.message, orderId }
  }
  if (!claimResult?.ok) {
    return {
      ok: false,
      outcome: (claimResult?.error as RetryOutcome) || 'error',
      message: claimResult?.error || 'claim_failed',
      orderId,
      required: claimResult?.required,
      available: claimResult?.available,
      until: claimResult?.until,
      retryAfter: claimResult?.retry_after,
      currentStatus: claimResult?.status,
    }
  }

  if (subAgentEarning && referenceCode) {
    await recordPendingSubAgentEarning(admin, {
      orderReference: referenceCode,
      orderTable: 'orders',
      recruiterId: subAgentEarning.recruiterId,
      subUserId: fundingUserId!,
      amount: subAgentEarning.amount,
    }).catch((e) => console.error('[Retry] recordPendingSubAgentEarning threw:', e))
  }

  const targetOrderId = claimResult.target_order_id as string
  const targetNetwork = o.network

  // Dispatch AFTER the claim commits — dispatch failure must not roll back the
  // charge/row-claim; triggerFulfillment already reverts the target row to
  // 'pending' on a definite supplier failure via its own existing logic.
  const { triggerFulfillment } = await import('@/lib/fulfillment-trigger')
  const dispatchKey = `${orderId}:${claimResult.attempt_no}`

  let dispatchUser = { email: 'Unknown', name: 'Customer' }
  // Only used to look up an email/name for the admin dispatch alert — o.user_id
  // may be null for guest USSD-shop orders, handled by the guard below.
  const dispatchUserId = o.user_id
  if (dispatchUserId) {
    const { data: u } = await admin.from('users').select('email, first_name, last_name').eq('id', dispatchUserId).maybeSingle()
    if (u) dispatchUser = { email: u.email || 'Unknown', name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'Customer' }
  }

  await triggerFulfillment(targetOrderId, targetNetwork, dispatchUser, { dispatchKey })
    .catch((e) => console.error('[Retry] triggerFulfillment threw:', e))

  // Finalize the order_retry_attempts ledger row — best-effort bookkeeping only. The
  // retry itself (claim + dispatch) already committed above; a failure here must never
  // surface to the caller or roll anything back. Without this, every attempt row stays
  // stuck at status='claimed' forever and supplier/supplier_reference/error_message are
  // never written.
  try {
    const { data: finalOrder } = await admin
      .from('orders')
      .select('status, fulfillment_method, codecraft_reference, dakazina_reference, ghdata_order_id, bundleportal_reference')
      .eq('id', targetOrderId)
      .maybeSingle()

    if (finalOrder) {
      const f = finalOrder as any
      if (f.status === 'processing') {
        const supplierReference = f.codecraft_reference || f.dakazina_reference || f.ghdata_order_id || f.bundleportal_reference || null
        await admin
          .from('order_retry_attempts')
          .update({ status: 'dispatched', supplier: f.fulfillment_method ?? null, supplier_reference: supplierReference })
          .eq('source_order_id', orderId)
          .eq('attempt_no', claimResult.attempt_no)
      } else if (f.status === 'pending') {
        // Fell back to pending — triggerFulfillment doesn't persist the supplier error
        // onto the order row, so pull the most recent tracking entry's reason instead.
        const { data: trackingRow } = await admin
          .from('mtn_fulfillment_tracking')
          .select('api_response')
          .eq('order_id', targetOrderId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        const errorMessage = (trackingRow as any)?.api_response?.error || 'Dispatch failed'
        await admin
          .from('order_retry_attempts')
          .update({ status: 'failed', error_message: errorMessage })
          .eq('source_order_id', orderId)
          .eq('attempt_no', claimResult.attempt_no)
      }
      // Any other status (e.g. auto-fulfillment skipped/disabled, order left as-is) —
      // leave the attempt row at 'claimed'; there's nothing terminal to record yet.
    }
  } catch (e) {
    console.error('[Retry] Failed to finalize order_retry_attempts row:', e)
  }

  if (claimResult.mode === 'new_order') {
    const { sendOrderRetryPushNotification } = await import('@/lib/push-service')
    sendOrderRetryPushNotification(targetOrderId, claimResult.charged_amount).catch((e) =>
      console.error('[Retry] Push error:', e)
    )
    // BUG FIX (found live 2026-09-17, confirmed via Vercel error clustering — first seen
    // 2026-08-22, so pre-existing for every role, not something this session's sub-agent
    // work introduced): supabase-js's PostgrestFilterBuilder implements `.then()` but NOT
    // `.catch()`/`.finally()` directly — calling `.catch()` straight off `.insert(...)`
    // (skipping `.then()`) throws synchronously ("...insert(...).catch is not a function"),
    // and since this whole function has no surrounding try/catch, that throw propagated
    // out of retryOrder() to the route handler's catch block, which returned a 500 to the
    // client — AFTER claim_order_retry had already committed and dispatch had already
    // fired. Net effect: every 'new_order'-mode retry (i.e. every refunded-order retry,
    // the common case) silently succeeded server-side while the caller saw a false error.
    // Fixed by awaiting the insert directly and checking its own error field, matching the
    // idiom used everywhere else in this codebase (e.g. recordPendingSubAgentEarning).
    const { error: notifyErr } = await admin.from('notifications').insert({
      user_id: fundingUserId,
      title: 'Order Retry',
      message: `Your order ${o.reference_code} is being retried. GHS ${Number(claimResult.charged_amount).toFixed(2)} has been debited from your wallet.`,
      type: 'order_update',
      action_url: '/dashboard/my-orders',
    })
    if (notifyErr) console.error('[Retry] Notification insert failed:', notifyErr)
  }

  return {
    ok: true,
    outcome: 'retried',
    message: claimResult.mode === 'in_place' ? 'Order retry dispatched' : 'New retry order created and dispatched',
    orderId,
    targetOrderId,
    chargedAmount: claimResult.charged_amount,
    referenceCode: claimResult.reference_code ?? undefined,
  }
}
