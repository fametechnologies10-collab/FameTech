import { createServerClient } from '@/lib/supabase'
import { waitUntil } from '@vercel/functions'
import { UtilityBiller, isUtilityBiller } from '@/lib/hubtel-utility/billers'
import { fulfillUtilityCommission, UtilityFulfillResult } from '@/lib/hubtel-utility/service'
import { checkCommissionStatus } from '@/lib/hubtel-commission-status'
import { categorizeFailure, autoRefundApiOrderOnFailure } from '@/lib/api-order-failure'

const MAX_ATTEMPTS = 5

// ── Settings gate ────────────────────────────────────────────────────────────

/**
 * Reads admin_settings the same way lib/airtime-fulfillment.ts reads its keys:
 * scalar toggles are JSON-string-wrapped ('true'/'false' compared with ===),
 * while hubtel_utility_billers was seeded as a RAW JSONB object (not a
 * string-wrapped JSON blob) — so it is read via direct property access, not
 * JSON.parse (see supabase/migrations/20260709_utility_bills.sql §6 comment
 * and lib/network-stock.ts's parseAdminStock for the same object-setting idiom).
 */
export async function isUtilityAutoFulfillmentEnabled(supabase: any, biller: UtilityBiller): Promise<boolean> {
    const { data } = await supabase.from('admin_settings').select('key, value')
        .in('key', ['utility_bills_enabled', 'utility_auto_fulfillment_enabled', 'hubtel_commission_paused', 'hubtel_utility_billers'])
    const map: Record<string, any> = {}
    for (const r of (data || [])) map[r.key] = r.value
    if (map['utility_bills_enabled'] !== 'true') return false
    if (map['utility_auto_fulfillment_enabled'] !== 'true') return false
    if (map['hubtel_commission_paused'] === 'true') return false
    const billers = map['hubtel_utility_billers']
    if (!billers || typeof billers !== 'object' || Array.isArray(billers)) return false
    return billers[biller] === true
}

// ── Outcome -> action mapping (pure) ────────────────────────────────────────

export type UtilityDispatchAction =
    | 'complete' | 'stay_processing' | 'stay_processing_unknown'
    | 'revert_pending' | 'pause_float' | 'pause_config' | 'fail'

/** Single source of truth for how the dispatch pipeline reacts to each Hubtel-classified outcome. */
export function actionForOutcome(outcome: UtilityFulfillResult['outcome']): UtilityDispatchAction {
    switch (outcome) {
        case 'completed': return 'complete'
        case 'pending': return 'stay_processing'
        case 'unknown': return 'stay_processing_unknown'
        case 'insufficient_float': return 'pause_float'
        case 'config_error': return 'pause_config'
        case 'rate_limited':
        case 'network_error':
        case 'not_configured':
            return 'revert_pending'
        case 'permanent_failure':
        case 'failed':
        default:
            return 'fail'
    }
}

// ── Double-send guard (mirrors airtime's priorAttemptVerdict) ──────────────

/**
 * Double-send guard verdict on the PREVIOUS attempt's ClientReference, via the Status Check API.
 *
 * `verifiable` is the money-safety core: true ONLY when the status check produced a definitive
 * ANSWER — a 'success'/'failed' verdict, or a 2xx response in which Hubtel itself states what
 * it knows about the reference (including "no record"). If the status check itself failed
 * (threw, not configured, socket error/timeout, non-2xx), we CANNOT verify whether the prior
 * attempt delivered — the caller MUST block the re-send; "cannot verify" never falls through
 * to a dispatch.
 *
 * `found` distinguishes "Hubtel confirms it has SOME record of this ClientReference" from a
 * CONFIRMED "no record at all" (2xx + not found). The confirmed-not-found case matters because
 * a 'network_error' or 'not_configured' outcome can happen BEFORE we ever reach Hubtel's pay
 * endpoint (e.g. Ghana Water's mandatory pre-query step failing on an invalid meter, or the
 * circuit breaker being open). In that case there is nothing to double-send-guard against:
 * Hubtel has never heard of this ClientReference, so it is exactly as safe to retry as a
 * zero-prior-attempts order. See the caller for how this is used.
 */
interface PriorAttemptVerdict {
    verifiable: boolean // false = the status check itself failed → caller MUST block the re-send
    verdict: string
    delivered: boolean // true only on a definitive 'success' verdict
    found: boolean
    error?: string
}

async function priorAttemptVerdict(clientRef: string): Promise<PriorAttemptVerdict> {
    const r = await checkCommissionStatus(clientRef).catch(() => null)
    if (!r) {
        return { verifiable: false, verdict: 'unknown', delivered: false, found: false, error: 'status check threw' }
    }
    if (!r.configured) {
        return { verifiable: false, verdict: 'unknown', delivered: false, found: false, error: r.error || 'status check not configured' }
    }
    // Definitive verdicts are answers in themselves.
    if (r.verdict === 'success' || r.verdict === 'failed') {
        return { verifiable: true, verdict: r.verdict, delivered: r.verdict === 'success', found: r.found }
    }
    // 'pending'/'unknown' verdicts: only a 2xx response counts as an ANSWER (Hubtel spoke —
    // either "record exists but unresolved" or "no record"). A socket error / timeout /
    // non-2xx is NOT an answer (checkCommissionStatus resolves those as httpOk:false with
    // verdict 'unknown' — see lib/hubtel-commission-status.ts) → unverifiable → block.
    if (!r.httpOk) {
        return { verifiable: false, verdict: r.verdict, delivered: false, found: r.found, error: r.error || 'status check HTTP error' }
    }
    return { verifiable: true, verdict: r.verdict, delivered: false, found: r.found }
}

async function pauseFloat(supabase: any, message: string): Promise<void> {
    await (supabase.from('admin_settings') as any).upsert(
        { key: 'hubtel_commission_paused', value: 'true' }, { onConflict: 'key' },
    )
    try {
        const { sendAdminPushNotification } = await import('@/lib/push-service')
        await sendAdminPushNotification({ title: 'Utility auto-fulfillment paused', body: message, url: '/admin/utilities' })
    } catch (e) { console.error('[utility] admin pause push failed:', e) }
}

/**
 * Auto-dispatch a single PENDING utility order to Hubtel Commission Services.
 * Idempotent + concurrency-safe via an atomic claim. NEVER refunds — transient
 * failures revert to 'pending' for the reconcile cron / callback to retry.
 * (Thin wrapper: the public contract stays Promise<void>; the truthful-result
 * core below also serves manualRefulfillUtility with admin-intent semantics.)
 */
export async function dispatchUtilityFulfillment(orderId: string): Promise<void> {
    await dispatchUtilityCore(orderId, { manual: false })
}

interface DispatchOptions {
    // true = admin intent (manual refulfill): bypasses the auto-fulfillment ENABLEMENT gates
    // (utility_bills_enabled / utility_auto_fulfillment_enabled / hubtel_commission_paused /
    // per-biller map) exactly like lib/airtime-fulfillment.ts's manualRefulfillAirtime, which
    // never consults isAirtimeAutoFulfillmentEnabled; and never auto-pauses the shared float
    // flag on a failure ("do not auto-pause on a manual action" — airtime precedent).
    // Money-safety gates still apply to BOTH paths: MAX_ATTEMPTS, the prior-attempt
    // double-send guard, and the atomic claim.
    manual: boolean
}

/**
 * Dispatch core shared by auto + manual paths. Returns a truthful result: success:false with
 * a specific reason whenever the dispatch was blocked or the send failed — never a silent no-op.
 */
async function dispatchUtilityCore(orderId: string, opts: DispatchOptions): Promise<{ success: boolean; error?: string }> {
    const supabase = createServerClient()

    const { data: order } = await (supabase as any).from('utility_orders')
        .select('id, biller, account_number, destination_phone, customer_email, amount, reference_code, status, payment_status, fulfillment_attempts, fulfillment_metadata, user_id, api_key_id, source')
        .eq('id', orderId).single()
    if (!order) return { success: false, error: 'Order not found' }
    if (order.status !== 'pending') return { success: false, error: `Order is not pending (status: ${order.status})` }
    if (order.payment_status !== 'paid') return { success: false, error: `Order is not paid (payment_status: ${order.payment_status})` }
    if (!isUtilityBiller(order.biller)) return { success: false, error: `Unknown biller: ${order.biller}` }

    // Enablement gates apply to AUTO dispatch only — manual refulfill is admin intent and
    // bypasses them (incl. hubtel_commission_paused), mirroring manualRefulfillAirtime.
    if (!opts.manual && !(await isUtilityAutoFulfillmentEnabled(supabase, order.biller))) {
        return { success: false, error: 'Auto-fulfillment is disabled for this biller (or globally paused)' }
    }

    if ((order.fulfillment_attempts || 0) >= MAX_ATTEMPTS) {
        return { success: false, error: `Max fulfillment attempts (${MAX_ATTEMPTS}) reached — order left pending for admin attention` }
    }

    // Prior-attempt double-send guard: only relevant once we've actually sent at least once.
    if (order.fulfillment_attempts > 0) {
        const priorRef = `${order.reference_code}-r${order.fulfillment_attempts}`
        const prior = await priorAttemptVerdict(priorRef)
        if (prior.delivered) {
            const meta = { ...(order.fulfillment_metadata || {}), status_check: { verdict: 'success', at: new Date().toISOString() } }
            await (supabase as any).from('utility_orders').update({
                status: 'completed',
                fulfillment_metadata: meta,
                updated_at: new Date().toISOString(),
            }).eq('id', orderId).eq('status', 'pending')
            if (order.api_key_id) {
                const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                waitUntil(dispatchApiWebhook(supabase, {
                    apiKeyId: order.api_key_id, event: 'order.completed', product: 'utilities',
                    reference: order.reference_code.replace(/^API-/, ''), status: 'completed',
                    detail: { biller: order.biller, amount: Number(order.amount) },
                }))
            }
            // Commission is unknown from a status check (may still be zero/undefined) — the RPC
            // no-ops safely when commission_amount is NULL; a late callback can still fill it in.
            const { data: creditResult, error: creditError } = await (supabase as any)
                .rpc('credit_utility_commission', { p_utility_order_id: orderId })
            if (creditError) {
                console.error('[Utility Commission] credit RPC failed:', creditError.message, 'order:', orderId)
            } else if (creditResult?.message) {
                // The RPC returns success:true with an explanatory message for every no-pay outcome
                // (role ineligible, no partner, share rounds to zero, already credited). Log it —
                // without this, a permanently-skipped commission is indistinguishable from a normal
                // no-commission order when investigating a disputed payout.
                console.log('[Utility Commission] no payout for order', orderId, '—', creditResult.message)
            }
            return { success: true }
        }
        // Status check itself failed (threw / not configured / transport error / non-2xx):
        // we CANNOT verify whether the prior attempt delivered → BLOCK the re-send (a
        // "cannot verify" must never fall through to a dispatch) and merge a metadata note.
        if (!prior.verifiable) {
            await (supabase as any).from('utility_orders').update({
                fulfillment_metadata: {
                    ...(order.fulfillment_metadata || {}),
                    prior_attempt_check: {
                        client_reference: priorRef,
                        note: 'cannot verify prior attempt — dispatch blocked',
                        error: prior.error,
                        at: new Date().toISOString(),
                    },
                },
                updated_at: new Date().toISOString(),
            }).eq('id', orderId).eq('status', 'pending')
            return { success: false, error: 'Cannot verify whether the previous attempt delivered (status check unavailable) — not resending' }
        }
        // Hubtel confirms it HAS a record of the prior attempt that is neither delivered nor
        // definitively failed (still 'paid'-but-unfulfilled, or ambiguous) — do NOT re-dispatch;
        // it may still resolve asynchronously via callback. Only proceed on a definitive
        // 'failed' verdict, or when Hubtel CONFIRMS it has NO record at all for this
        // ClientReference (nothing was ever sent — e.g. a Ghana Water pre-query business
        // failure that never reached the POST step, or a circuit-breaker-open short-circuit).
        if (prior.found && prior.verdict !== 'failed') {
            return { success: false, error: 'Previous attempt is still in-flight/unconfirmed at Hubtel — use Sync to confirm; only resend once it shows failed' }
        }
    }

    const attempt = (order.fulfillment_attempts || 0) + 1

    // Atomic claim: only the worker that flips pending→processing proceeds.
    const { data: claimed } = await (supabase as any).from('utility_orders')
        .update({
            status: 'processing',
            fulfillment_attempts: attempt,
            updated_at: new Date().toISOString(),
        })
        .eq('id', orderId).eq('status', 'pending').select('id')
    if (!claimed || claimed.length === 0) {
        return { success: false, error: 'Order was claimed by another worker (state changed) — not resending' }
    }

    const clientRef = `${order.reference_code}-r${attempt}`
    const result = await fulfillUtilityCommission({
        biller: order.biller,
        account: order.account_number,
        phone: order.destination_phone ?? undefined,
        email: order.customer_email ?? undefined,
        amountGhs: Number(order.amount),
        clientReference: clientRef,
    })

    return applyDispatchResult(supabase, orderId, order, clientRef, attempt, result, opts.manual)
}

/**
 * Shared metadata-merge + state-transition logic, applied from both auto-dispatch and manual
 * refulfill. `manual` mirrors airtime's manual-path semantics: never auto-pause the shared
 * float flag on a manual action ("do not auto-pause on a manual action" — see
 * lib/airtime-fulfillment.ts manualRefulfillAirtime's failure branch). Returns a truthful
 * result for the manual caller; the auto wrapper discards it.
 */
async function applyDispatchResult(
    supabase: any, orderId: string, order: any, clientRef: string, attempt: number, result: UtilityFulfillResult, manual: boolean,
): Promise<{ success: boolean; error?: string }> {
    const baseMeta = { ...(order.fulfillment_metadata || {}) }
    const action = actionForOutcome(result.outcome)
    const nowIso = new Date().toISOString()

    switch (action) {
        case 'complete': {
            const meta = {
                ...baseMeta,
                supplier: 'hubtel-commission',
                client_reference: clientRef,
                attempt,
                response_code: '0000',
                ...(result.commission !== undefined ? { commission: result.commission } : {}),
                api_response: result.apiResponse,
            }
            await (supabase as any).from('utility_orders').update({
                status: 'completed',
                fulfillment_request_id: result.transactionId || null,
                ...(result.commission !== undefined ? { commission_amount: result.commission } : {}),
                fulfillment_metadata: meta,
                updated_at: nowIso,
            }).eq('id', orderId).eq('status', 'processing')
            if (order.api_key_id) {
                const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                waitUntil(dispatchApiWebhook(supabase, {
                    apiKeyId: order.api_key_id, event: 'order.completed', product: 'utilities',
                    reference: order.reference_code.replace(/^API-/, ''), status: 'completed',
                    detail: { biller: order.biller, amount: Number(order.amount) },
                }))
            }
            const { data: creditResult, error: creditError } = await (supabase as any)
                .rpc('credit_utility_commission', { p_utility_order_id: orderId })
            if (creditError) {
                console.error('[Utility Commission] credit RPC failed:', creditError.message, 'order:', orderId)
            } else if (creditResult?.message) {
                // The RPC returns success:true with an explanatory message for every no-pay outcome
                // (role ineligible, no partner, share rounds to zero, already credited). Log it —
                // without this, a permanently-skipped commission is indistinguishable from a normal
                // no-commission order when investigating a disputed payout.
                console.log('[Utility Commission] no payout for order', orderId, '—', creditResult.message)
            }
            if (order.user_id) {
                ;(supabase.from('notifications') as any).insert({
                    user_id: order.user_id,
                    title: 'Bill Payment Successful',
                    message: `Your ${order.biller} payment (${order.reference_code}) has been delivered.`,
                    type: 'order_update',
                    action_url: '/dashboard/utilities',
                }).then(() => {}).catch(() => {})
            }
            return { success: true }
        }
        case 'stay_processing': {
            const meta = {
                ...baseMeta,
                supplier: 'hubtel-commission',
                client_reference: clientRef,
                attempt,
                response_code: '0001',
                api_response: result.apiResponse,
            }
            await (supabase as any).from('utility_orders').update({
                fulfillment_metadata: meta,
                updated_at: nowIso,
            }).eq('id', orderId).eq('status', 'processing')
            return { success: true } // dispatched — callback/cron will finalize
        }
        case 'stay_processing_unknown': {
            const meta = {
                ...baseMeta,
                supplier: 'hubtel-commission',
                client_reference: clientRef,
                attempt,
                response_code: '0005',
                unknown_state: true,
                api_response: result.apiResponse,
            }
            await (supabase as any).from('utility_orders').update({
                fulfillment_metadata: meta,
                updated_at: nowIso,
            }).eq('id', orderId).eq('status', 'processing')
            try {
                const { sendAdminPushNotification } = await import('@/lib/push-service')
                await sendAdminPushNotification({
                    title: 'Utility order unknown state',
                    body: `Utility order ${order.reference_code}: Hubtel 0005 unknown state — will status-check; contact RSE if unresolved.`,
                    url: '/admin/utilities',
                })
            } catch (e) { console.error('[utility] admin unknown-state push failed:', e) }
            return { success: true } // dispatched — 0005 unknown state, status-check will resolve
        }
        case 'pause_float': {
            const meta = {
                ...baseMeta,
                supplier: 'hubtel-commission',
                client_reference: clientRef,
                attempt,
                error: result.error,
                api_response: result.apiResponse,
            }
            await (supabase as any).from('utility_orders').update({
                status: 'pending',
                fulfillment_metadata: meta,
                updated_at: nowIso,
            }).eq('id', orderId).eq('status', 'processing')
            // Never auto-pause on a manual action (airtime precedent) — the admin driving it
            // sees the truthful error below and decides; auto-dispatch pauses + alerts.
            if (!manual) {
                await pauseFloat(supabase, 'Hubtel Disbursement float exhausted — utilities+airtime paused. Top up float.')
            }
            return { success: false, error: result.error || 'Hubtel Disbursement float insufficient' }
        }
        case 'pause_config': {
            const meta = {
                ...baseMeta,
                supplier: 'hubtel-commission',
                client_reference: clientRef,
                attempt,
                error: result.error,
                api_response: result.apiResponse,
            }
            await (supabase as any).from('utility_orders').update({
                status: 'pending',
                fulfillment_metadata: meta,
                updated_at: nowIso,
            }).eq('id', orderId).eq('status', 'processing')
            if (!manual) {
                await pauseFloat(supabase, 'Hubtel Commission credentials/permission error (4101/4103) — check API keys. Paused.')
            }
            return { success: false, error: result.error || 'Hubtel credentials/permission error (4101/4103)' }
        }
        case 'revert_pending': {
            const meta = {
                ...baseMeta,
                supplier: 'hubtel-commission',
                client_reference: clientRef,
                attempt,
                note: 'transient: rate limit / network / not configured',
                error: result.error,
                api_response: result.apiResponse,
            }
            await (supabase as any).from('utility_orders').update({
                status: 'pending',
                fulfillment_metadata: meta,
                updated_at: nowIso,
            }).eq('id', orderId).eq('status', 'processing')
            return { success: false, error: result.error || 'Transient error (rate limit / network / not configured) — reverted to pending for retry' }
        }
        case 'fail': {
            const meta = {
                ...baseMeta,
                supplier: 'hubtel-commission',
                client_reference: clientRef,
                attempt,
                error: result.error,
                api_response: result.apiResponse,
            }
            await (supabase as any).from('utility_orders').update({
                status: 'failed',
                fulfillment_metadata: meta,
                updated_at: nowIso,
            }).eq('id', orderId).eq('status', 'processing')
            const { code: reasonCode, message: reasonMessage } = categorizeFailure(
                result.outcome === 'permanent_failure' ? 'permanent_failure' : 'failed'
            )
            const refund = await autoRefundApiOrderOnFailure(supabase, {
                product: 'utilities', orderId, source: order.source, reasonCode, reasonMessage,
            })
            if (order.api_key_id) {
                const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                waitUntil(dispatchApiWebhook(supabase, {
                    apiKeyId: order.api_key_id, event: 'order.failed', product: 'utilities',
                    reference: order.reference_code.replace(/^API-/, ''), status: refund.refunded ? 'refunded' : 'failed',
                    detail: {
                        biller: order.biller, amount: Number(order.amount),
                        reason_code: reasonCode, reason: reasonMessage,
                        ...(refund.refunded ? { refunded: true, refund_amount: refund.amount, new_balance: refund.newBalance } : {}),
                    },
                }))
            }
            // Auto-fulfillment failed to deliver → web-push the admins. Skip when THIS action is a
            // manual refulfill (the admin driving it gets the truthful error return instead) — keyed
            // on the current action's manual flag, not the persisted metadata stamp, so a stale
            // manual stamp from an earlier attempt never suppresses alerts for later AUTO retries.
            if (!manual) {
                try {
                    const { sendAdminPushNotification } = await import('@/lib/push-service')
                    await sendAdminPushNotification({
                        title: 'Utility auto-fulfillment failed',
                        body: `${order.biller} GHS ${Number(order.amount).toFixed(2)} (${order.account_number}) did not go through: ${result.error || 'unknown error'} (ref ${order.reference_code}).`,
                        url: '/admin/utilities',
                    })
                } catch (e) { console.error('[utility] admin failure push failed:', e) }
            }
            return { success: false, error: result.error || 'Hubtel rejected the request (permanent failure)' }
        }
    }
}

// ── Manual admin tools ───────────────────────────────────────────────────────

/**
 * MANUAL admin refulfillment (force; expresses ADMIN INTENT). Mirrors
 * lib/airtime-fulfillment.ts's manualRefulfillAirtime gate semantics: bypasses the
 * auto-fulfillment enablement gates — the kill-switches AND hubtel_commission_paused
 * (airtime's manual tool never consults isAirtimeAutoFulfillmentEnabled) — and never
 * auto-pauses the shared float flag on a failure. Money-safety gates still apply:
 * refuses completed orders, respects MAX_ATTEMPTS, the prior-attempt double-send
 * guard, and the atomic claim — and every block is reported truthfully as
 * { success:false, error } rather than a silent no-op.
 *
 * Allowed from 'pending' or 'failed' (resets a failed order to pending first, guarded).
 * Stamps a manual-action marker into fulfillment_metadata for audit.
 */
export async function manualRefulfillUtility(orderId: string, adminId: string): Promise<{ success: boolean; error?: string }> {
    const supabase = createServerClient()

    const { data: order } = await (supabase as any).from('utility_orders')
        .select('id, status, payment_status, fulfillment_metadata')
        .eq('id', orderId).single()
    if (!order) return { success: false, error: 'Order not found' }
    if (order.status === 'completed') return { success: false, error: 'Order already completed — not resending' }
    if (order.status !== 'pending' && order.status !== 'failed') {
        return { success: false, error: `Order is not refulfillable (status: ${order.status})` }
    }
    // Check payment BEFORE any state mutation below — dispatchUtilityCore also refuses to
    // fulfill an unpaid order, but only after this function has already flipped a 'failed'
    // order's status to 'pending' (see the failed-status reset below). Without this early
    // check, attempting to refulfill an abandoned/unpaid checkout would silently reclassify
    // a genuinely failed order as "pending" and leave it stuck there, even though the
    // dispatch itself correctly gets rejected a moment later.
    if (order.payment_status !== 'paid') {
        return { success: false, error: `Order is not paid (payment_status: ${order.payment_status}) — not resending` }
    }

    const manualMeta = { ...(order.fulfillment_metadata || {}), manual: { action: 'refulfill', by: adminId, at: new Date().toISOString() } }

    if (order.status === 'failed') {
        const { data: reset } = await (supabase as any).from('utility_orders')
            .update({ status: 'pending', fulfillment_metadata: manualMeta, updated_at: new Date().toISOString() })
            .eq('id', orderId).eq('status', 'failed').select('id')
        if (!reset || reset.length === 0) return { success: false, error: 'Order state changed — retry' }
    } else {
        await (supabase as any).from('utility_orders')
            .update({ fulfillment_metadata: manualMeta, updated_at: new Date().toISOString() })
            .eq('id', orderId).eq('status', 'pending')
    }

    // Truthful dispatch: any block (attempts exhausted, unverifiable/in-flight prior attempt,
    // claim lost) or send failure comes back as { success:false, error: <specific reason> }.
    return dispatchUtilityCore(orderId, { manual: true })
}

/**
 * MANUAL admin status sync — query Hubtel's Transaction Status Check for an order's
 * LAST attempt and apply the verdict. Records the raw result to fulfillment_metadata.status_check
 * every time. Completes the order on a confirmed delivery, marks failed on a confirmed failure
 * (never overwriting an already-completed order), else leaves state untouched.
 */
export async function manualStatusSyncUtility(orderId: string, adminId: string): Promise<{ success: boolean; error?: string; state?: string }> {
    const supabase = createServerClient()
    const { data: order } = await (supabase as any).from('utility_orders')
        .select('id, status, reference_code, fulfillment_attempts, fulfillment_metadata, api_key_id, biller, amount, source')
        .eq('id', orderId).single()
    if (!order) return { success: false, error: 'Order not found' }
    if (!order.fulfillment_attempts || order.fulfillment_attempts <= 0) {
        return { success: false, error: 'Never dispatched' }
    }

    const clientRef = `${order.reference_code}-r${order.fulfillment_attempts}`
    const result = await checkCommissionStatus(clientRef)
    if (!result.configured) return { success: false, error: 'Status check not configured (set HUBTEL_COLLECTION_ACCOUNT)' }

    const manualStamp = { action: 'status_sync', by: adminId, at: new Date().toISOString() }
    const meta = {
        ...(order.fulfillment_metadata || {}),
        status_check: { verdict: result.verdict, http_ok: result.httpOk, found: result.found, at: new Date().toISOString(), raw: result.raw },
        manual: manualStamp,
    }

    if (result.verdict === 'success') {
        const { data: updated } = await (supabase as any).from('utility_orders')
            .update({ status: 'completed', fulfillment_metadata: meta, updated_at: new Date().toISOString() })
            .eq('id', orderId).in('status', ['processing', 'pending', 'failed']).select('id')
        if (updated && updated.length > 0) {
            const { data: creditResult, error: creditError } = await (supabase as any)
                .rpc('credit_utility_commission', { p_utility_order_id: orderId })
            if (creditError) {
                console.error('[Utility Commission] credit RPC failed:', creditError.message, 'order:', orderId)
            } else if (creditResult?.message) {
                // The RPC returns success:true with an explanatory message for every no-pay outcome
                // (role ineligible, no partner, share rounds to zero, already credited). Log it —
                // without this, a permanently-skipped commission is indistinguishable from a normal
                // no-commission order when investigating a disputed payout.
                console.log('[Utility Commission] no payout for order', orderId, '—', creditResult.message)
            }
            if (order.api_key_id) {
                const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                waitUntil(dispatchApiWebhook(supabase, {
                    apiKeyId: order.api_key_id, event: 'order.completed', product: 'utilities',
                    reference: order.reference_code.replace(/^API-/, ''), status: 'completed',
                    detail: { biller: order.biller, amount: Number(order.amount) },
                }))
            }
        }
        return { success: true, state: 'completed' }
    }
    if (result.verdict === 'failed') {
        // .select('id') added so the webhook only fires on an actual pending/processing→failed
        // transition — never on a repeat status-sync call against a row already 'failed'
        // (the .in() filter excludes it, so `updated` would be empty).
        const { data: updated } = await (supabase as any).from('utility_orders')
            // Never overwrite an already-completed order.
            .update({ status: 'failed', fulfillment_metadata: meta, updated_at: new Date().toISOString() })
            .eq('id', orderId).in('status', ['processing', 'pending']).select('id')
        if (updated && updated.length > 0) {
            const { code: reasonCode, message: reasonMessage } = categorizeFailure('status_check_failed')
            const refund = await autoRefundApiOrderOnFailure(supabase, {
                product: 'utilities', orderId, source: order.source, reasonCode, reasonMessage,
            })
            if (order.api_key_id) {
                const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                waitUntil(dispatchApiWebhook(supabase, {
                    apiKeyId: order.api_key_id, event: 'order.failed', product: 'utilities',
                    reference: order.reference_code.replace(/^API-/, ''), status: refund.refunded ? 'refunded' : 'failed',
                    detail: {
                        biller: order.biller, amount: Number(order.amount),
                        reason_code: reasonCode, reason: reasonMessage,
                        ...(refund.refunded ? { refunded: true, refund_amount: refund.amount, new_balance: refund.newBalance } : {}),
                    },
                }))
            }
        }
        return { success: true, state: 'failed' }
    }
    // pending / unknown — record only, don't change order state (and never clobber a row that
    // raced to 'completed' between our read and this write).
    await (supabase as any).from('utility_orders')
        .update({ fulfillment_metadata: meta, updated_at: new Date().toISOString() })
        .eq('id', orderId).neq('status', 'completed')
    return { success: true, state: result.verdict }
}

// ── Paystack storefront settlement ──────────────────────────────────────────

/**
 * Settle a storefront utility order paid via Paystack (reference prefix `UTLP-`,
 * distinct from Hubtel Direct Receive Money's `UTIL-`). Called from BOTH the
 * Paystack webhook and the status-poll route, mirroring processRCShopOrder's
 * security-hardened pattern in lib/results-checker-service.ts:
 *
 *  1. The order row MUST already exist (inserted by the charge route BEFORE
 *     Paystack was ever called, exactly like the Hubtel Receive Money branch's
 *     insert-before-init — this function never creates an order from a
 *     caller's metadata). Refuses with ORDER_NOT_FOUND rather than trusting
 *     metadata to fabricate one.
 *  2. Amount is verified against the order's OWN server-computed `amount`
 *     column — NEVER against caller-supplied Paystack metadata, which a
 *     tampered client could have influenced. Mirrors the RC "A9" fix.
 *  3. Atomic claim (`payment_status` CAS unpaid->paid) so the webhook and a
 *     concurrent status poll can never both dispatch fulfillment for the same
 *     payment.
 *  4. Dispatches fulfillment inline (awaited) so the status-poll route can
 *     re-read the order's true post-dispatch state before answering the guest.
 */
export async function processUtilityShopOrder(
    reference: string,
    _metadata: Record<string, unknown>,
    paidAmountKobo: number,
): Promise<{ success: boolean; error?: string; orderId?: string; isDuplicate?: boolean }> {
    const supabase = createServerClient()
    const db = supabase as any

    try {
        const { data: order } = await db
            .from('utility_orders')
            .select('id, amount, paystack_fee, payment_status, status')
            .eq('reference_code', reference)
            .maybeSingle()

        if (!order) {
            console.error(`[Utility Paystack] Order not found for reference: ${reference}`)
            return { success: false, error: 'ORDER_NOT_FOUND' }
        }
        if (order.payment_status === 'paid') {
            return { success: true, orderId: order.id, isDuplicate: true }
        }

        // `amount` is face value ONLY (what dispatchUtilityFulfillment sends to the biller) —
        // the customer actually paid amount + paystack_fee, so the paid-amount check must
        // verify against that TOTAL, never `amount` alone (which would reject every
        // legitimately-paid Paystack-rail order as a false mismatch).
        const expectedTotalGhs = Number(order.amount) + Number(order.paystack_fee || 0)
        const expectedKobo = Math.round(expectedTotalGhs * 100)
        const diff = Math.abs(paidAmountKobo - expectedKobo)
        if (diff > 5) {
            console.error(`[Utility Paystack] AMOUNT MISMATCH: Ref=${reference} Paid=${paidAmountKobo} Expected=${expectedKobo}`)
            return { success: false, error: 'AMOUNT_MISMATCH' }
        }

        // Atomic claim: only the winner of a webhook-vs-poll race proceeds.
        const { data: claimed } = await db.from('utility_orders')
            .update({ payment_status: 'paid', updated_at: new Date().toISOString() })
            .eq('id', order.id)
            .neq('payment_status', 'paid')
            .select('id')
        if (!claimed || claimed.length === 0) {
            return { success: true, orderId: order.id, isDuplicate: true }
        }

        try {
            await dispatchUtilityFulfillment(order.id)
        } catch (e) {
            console.error('[Utility Paystack] fulfillment dispatch failed:', e, 'orderId:', order.id)
        }

        return { success: true, orderId: order.id }
    } catch (err) {
        console.error('[Utility Paystack] processUtilityShopOrder unexpected error:', err)
        return { success: false, error: 'INTERNAL_ERROR' }
    }
}

/** True when an order can be refunded via the one-click wallet-credit RPC:
 * a registered (non-guest), non-shop order paid by any of the three wallet-
 * style payment methods. Everything else must go through the manual queue
 * (lib/utility-fulfillment.ts's manualRefundUtility) — there is no automated
 * "push money back to a MoMo number" API in this codebase. */
export function isWalletRefundEligible(order: {
    payment_method: string
    shop_id: string | null
    user_id: string | null
}): boolean {
    return (
        ['wallet', 'ussd_wallet', 'ussd_momo'].includes(order.payment_method) &&
        order.shop_id === null &&
        order.user_id !== null
    )
}

/**
 * MANUAL admin refund of a utility order. Branches on isWalletRefundEligible:
 * eligible orders go through the idempotent refund_utility_wallet RPC
 * (never touches wallet tables directly here); everything else (guest and/or
 * shop-attributed orders — no automated "push money to MoMo" API exists in
 * this codebase) is queued in utility_refund_queue for a human to action.
 * Idempotent either way: a second call on an already-refunded or
 * already-queued order reports success without double-acting.
 */
export async function manualRefundUtility(orderId: string, adminId: string): Promise<{ success: boolean; queued?: boolean; error?: string }> {
    const supabase = createServerClient()

    const { data: order } = await (supabase as any).from('utility_orders')
        .select('id, payment_method, shop_id, user_id, fulfillment_metadata, status, payment_status, amount, biller, account_number, destination_phone, source, reference_code')
        .eq('id', orderId).single()
    if (!order) return { success: false, error: 'Order not found' }

    if (order.status === 'refunded' || order.payment_status === 'refunded') {
        return { success: true } // already refunded — idempotent no-op
    }
    if (!(order.status === 'pending' || order.status === 'failed') || order.payment_status !== 'paid') {
        return { success: false, error: `Order not refundable in its current status (status: ${order.status}, payment_status: ${order.payment_status})` }
    }

    if (isWalletRefundEligible(order)) {
        const { data, error } = await (supabase as any).rpc('refund_utility_wallet', { p_utility_order_id: orderId })
        if (error) return { success: false, error: error.message }

        const manualMeta = { ...(order.fulfillment_metadata || {}), manual: { action: 'refund', by: adminId, at: new Date().toISOString() } }
        await (supabase as any).from('utility_orders').update({ fulfillment_metadata: manualMeta, updated_at: new Date().toISOString() }).eq('id', orderId)

        if (data?.success === true) return { success: true, queued: false }
        switch (data?.error) {
            case 'order_not_found': return { success: false, error: 'Order not found' }
            case 'not_wallet_payment': return { success: false, error: 'Only wallet-paid orders can be refunded here' }
            case 'not_paid': return { success: false, error: `Order is not paid (status: ${data?.payment_status})` }
            case 'No wallet owner': return { success: false, error: 'No wallet owner' }
            case 'not_refundable': return { success: false, error: `Order not refundable in its current status (status: ${data?.status})` }
            default: return { success: false, error: data?.error || 'Refund failed' }
        }
    }

    // Not wallet-eligible — queue for manual MoMo payout. Idempotent via the
    // unique index on utility_order_id (Task 1); a second click reports the
    // existing row rather than erroring.
    const momoNumber = order.destination_phone || null
    // For storefront orders, destination_phone is the utility-contact number the
    // customer entered at checkout — it can differ from the actual payer's MoMo
    // number (see app/api/shop/utility/charge/route.ts) and for DSTV/GOtv/StarTimes
    // storefront orders it's always null. Flag this loudly in the reason so the
    // admin verifies against Hubtel Receive Money records before paying out —
    // persisting the real payer msisdn requires a checkout/charge migration,
    // parked out of scope for this fix.
    const reasonSuffix = order.source === 'storefront'
        ? ' — VERIFY payer MoMo number in Hubtel Receive Money records before paying out; destination_phone may not match the actual payer.'
        : ''
    const { error: insertError } = await (supabase as any).from('utility_refund_queue').insert({
        utility_order_id: orderId,
        source: order.source,
        biller: order.biller,
        amount: order.amount,
        momo_number: momoNumber,
        shop_id: order.shop_id,
        user_id: order.user_id, // carried so Task 3's SMS gate can match the spec's exact
        // "storefront/ussd_shop, no user_id" clause below.
        reason: `Manual refund queued by admin ${adminId}${reasonSuffix}`,
    })
    if (insertError && insertError.code !== '23505') { // 23505 = unique_violation -> already queued, treat as success
        return { success: false, error: insertError.message }
    }
    const queuedMeta = { ...(order.fulfillment_metadata || {}), manual: { action: 'refund_queued', by: adminId, at: new Date().toISOString() } }
    await (supabase as any).from('utility_orders').update({ fulfillment_metadata: queuedMeta, updated_at: new Date().toISOString() }).eq('id', orderId)
    return { success: true, queued: true }
}

/**
 * SMS notification fired ONLY when an admin resolves a queued MANUAL refund
 * (app/api/admin/utility-refunds/route.ts's POST) — never on the instant
 * wallet-credit path (lib/utility-fulfillment.ts's manualRefundUtility),
 * since a registered user already sees their balance change + the existing
 * in-app notification. Fully fire-and-forget-safe: never throws on its own
 * (mirrors sendUtilityCompletionSMS's contract), callers should still wrap
 * in try/catch as defense in depth (see app/api/admin/utility-refunds/route.ts).
 */
export async function sendUtilityRefundSMS(phone: string, biller: UtilityBiller, amount: number): Promise<void> {
    try {
        const billerLabel = biller.toUpperCase().replace(/_/g, ' ')
        const amountStr = Number(amount).toFixed(2)
        const message = `KFT: Your GHS ${amountStr} refund for your ${billerLabel} payment has been sent to your MoMo number.`
        const { sendSMS } = await import('@/lib/sms-service')
        const result = await sendSMS({ recipient: phone, message })
        if (!result.success) {
            console.error('[Utility Refund SMS] send failed:', result.error, 'phone:', phone)
        }
    } catch (err) {
        console.error('[Utility Refund SMS] unexpected error (suppressed):', err)
    }
}
