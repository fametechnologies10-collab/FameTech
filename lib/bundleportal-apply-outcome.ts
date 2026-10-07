// ─── Bundle Portal webhook outcome application ──────────────────────────────────
//
// SAFETY: this is the ONLY code path allowed to mark a bundleportal order completed/failed
// from a supplier signal (mirrors lib/agentportal-apply-outcome.ts's role for AgentPortal).
//
// Unlike AgentPortal, Bundle Portal's `failed` (and `cancelled`/`refunded`) events are
// documented as terminal — v2 docs: "failed: Not delivered. Any charge is reversed." There is
// no AgentPortal-style retry-under-a-new-order-id that can later deliver the same order, so
// there is deliberately NO "rescue a failed order back to completed" logic here (that logic
// exists in lib/agentportal-apply-outcome.ts specifically because AgentPortal's failures can
// still resolve successfully later — Bundle Portal's cannot, per their own docs).
//
// order.cancelled and order.refunded both map to our 'failed' status, never directly to our
// own 'refunded' status — that status specifically means we already ran the wallet-credit RPC
// (lib/refund-service.ts), and setting it from a webhook without running that RPC would show
// "refunded" to the customer without the money having moved.
import { createAdminClient } from '@/lib/supabase-admin'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { sanitizeForStorage } from '@/lib/sanitize-for-storage'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'

const supabaseAdmin = createAdminClient()

// Single source of truth for the four Bundle Portal event names — the route handler derives its
// KNOWN_EVENTS set from this array instead of hand-listing the same four strings a second time.
export const BUNDLEPORTAL_EVENTS = ['order.completed', 'order.failed', 'order.cancelled', 'order.refunded'] as const
export type BundlePortalEvent = (typeof BUNDLEPORTAL_EVENTS)[number]

/** Pure mapping, unit-tested directly — see scripts/test-bundleportal-apply-outcome.ts. */
export function mapBundlePortalEventToStatus(event: BundlePortalEvent): 'completed' | 'failed' {
    return event === 'order.completed' ? 'completed' : 'failed'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RETRY_COMPOSITE_RE = /^([0-9a-f-]{36}):(\d+)$/i

export type ParsedBundlePortalOrderId =
    | { type: 'uuid'; id: string }
    | { type: 'retry'; sourceOrderId: string; attemptNo: number }
    | { type: 'unknown' }

/**
 * Pure parsing of the raw `order_id` Bundle Portal echoes back in its webhook payload.
 *
 * Two shapes are possible on the wire:
 *  - A plain `orders.id` UUID — the common, non-retry case (most orders send their own row id
 *    as the dispatch key straight through `lib/bundleportal-service.ts`'s `fulfillOrder`).
 *  - A composite `"<sourceOrderId>:<attemptNo>"` string — `lib/retry-service.ts`'s
 *    `dispatchKey = \`${orderId}:${claimResult.attempt_no}\`` for a retry dispatch. That string is
 *    NOT a valid orders.id and must be resolved via `order_retry_attempts` before it can be used
 *    in a `.eq('id', ...)` lookup — see `resolveBundlePortalOrderId` below.
 *
 * Kept separate from the DB-querying resolution logic so the regex matching itself is directly
 * unit-testable — see scripts/test-bundleportal-apply-outcome.ts.
 */
export function parseBundlePortalOrderId(raw: string): ParsedBundlePortalOrderId {
    if (UUID_RE.test(raw)) return { type: 'uuid', id: raw }

    const retryMatch = raw.match(RETRY_COMPOSITE_RE)
    if (retryMatch) {
        return { type: 'retry', sourceOrderId: retryMatch[1], attemptNo: Number(retryMatch[2]) }
    }

    return { type: 'unknown' }
}

/**
 * Resolves the raw `order_id` Bundle Portal echoes back in its webhook payload to the actual
 * `orders.id` row that should be updated. Never throws — always returns `null` on any failure
 * (DB error, no matching row) so the webhook route can always ack 200 regardless.
 *
 * Resolution order:
 *  1. Plain UUID → used as-is (the common case).
 *  2. Composite retry key (`"<sourceOrderId>:<attemptNo>"`, from `lib/retry-service.ts`'s
 *     `dispatchKey`) → look up `order_retry_attempts` by `source_order_id` + `attempt_no` and
 *     resolve to whichever id was actually dispatched to the supplier for that attempt:
 *       - `mode = 'in_place'`  → the retry reused the SAME order row → `source_order_id`
 *         (per `claim_order_retry`'s `in_place` branch: `target_order_id = p_order_id`, and no
 *         `new_order_id` is ever stored for this mode).
 *       - `mode = 'new_order'` → the retry created a NEW order row → `new_order_id`
 *         (per `claim_order_retry`'s `new_order` branch: `target_order_id = v_new_order_id`,
 *         the same value stored in `order_retry_attempts.new_order_id`).
 *     Verified directly against `supabase/migrations/20260925b_claim_order_retry_clear_spfastit.sql`
 *     (the live function body) — not guessed.
 *  3. Anything else (unrecognized shape, or a retry lookup that found no matching row) → fall
 *     back to looking up `orders` by `bundleportal_reference = reference AND
 *     fulfillment_method = 'bundleportal'`, only if a non-empty `reference` was provided.
 */
export async function resolveBundlePortalOrderId(rawOrderId: string, reference: string | undefined): Promise<string | null> {
    const parsed = parseBundlePortalOrderId(rawOrderId)

    if (parsed.type === 'uuid') return parsed.id

    if (parsed.type === 'retry') {
        try {
            const { data, error } = await supabaseAdmin
                .from('order_retry_attempts')
                .select('mode, source_order_id, new_order_id')
                .eq('source_order_id', parsed.sourceOrderId)
                .eq('attempt_no', parsed.attemptNo)
                .maybeSingle()

            if (error) {
                console.warn(`[BundlePortalApply] order_retry_attempts lookup failed for source=${parsed.sourceOrderId} attempt=${parsed.attemptNo}:`, error.message)
            } else if (data) {
                const row = data as { mode: string; source_order_id: string; new_order_id: string | null }
                if (row.mode === 'in_place') return row.source_order_id
                if (row.mode === 'new_order' && row.new_order_id) return row.new_order_id
                console.warn(`[BundlePortalApply] order_retry_attempts row for source=${parsed.sourceOrderId} attempt=${parsed.attemptNo} has unexpected mode/new_order_id combination — falling back to reference lookup`)
            } else {
                console.warn(`[BundlePortalApply] No order_retry_attempts row for source=${parsed.sourceOrderId} attempt=${parsed.attemptNo} — falling back to reference lookup`)
            }
        } catch (e) {
            console.warn(`[BundlePortalApply] order_retry_attempts lookup threw for source=${parsed.sourceOrderId} attempt=${parsed.attemptNo}:`, e)
        }
    }

    if (!reference) return null

    try {
        const { data, error } = await supabaseAdmin
            .from('orders')
            .select('id')
            .eq('bundleportal_reference', reference)
            .eq('fulfillment_method', 'bundleportal')
            .maybeSingle()

        if (error) {
            console.warn('[BundlePortalApply] orders lookup by bundleportal_reference failed:', error.message)
            return null
        }
        return (data as { id: string } | null)?.id ?? null
    } catch (e) {
        console.warn('[BundlePortalApply] orders lookup by bundleportal_reference threw:', e)
        return null
    }
}

export interface ApplyOutcomeResult {
    /** true only if the atomic conditional UPDATE matched exactly our row and the order actually transitioned. */
    applied: boolean
    /** true on a transient DB error — caller should treat the whole delivery as retryable for logging purposes (Bundle Portal itself never redelivers, see the route handler). */
    retryable: boolean
}

/**
 * Applies one Bundle Portal webhook event to one of our orders.
 *
 * Idempotent: the UPDATE is scoped to fulfillment_method='bundleportal' AND
 * status IN ('pending','processing'), so a duplicate delivery (should Bundle Portal ever send
 * one) matches zero rows and is a safe no-op — never a double-transition, never a double alert.
 */
export async function applyBundlePortalOutcome(
    orderId: string,
    event: BundlePortalEvent,
    failureReason: string | null,
): Promise<ApplyOutcomeResult> {
    // orderId here is the RESOLVED, DB-verified order id (see resolveBundlePortalOrderId), but
    // sanitize before it ever touches a log line or admin-alert field for defense-in-depth and
    // consistency with `event`/`failureReason`, which already go through sanitizeForStorage().
    // The RAW orderId (not safeOrderId) is what's used in every DB call below — sanitization
    // must never touch the value used for the actual `.eq('id', orderId)` lookup.
    const safeOrderId = sanitizeForStorage(orderId, 200)
    const status = mapBundlePortalEventToStatus(event)

    const { data: updatedRows, error: updateError } = await supabaseAdmin
        .from('orders')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', orderId)
        .eq('fulfillment_method', 'bundleportal')
        .in('status', ['pending', 'processing'])
        .select('id')

    if (updateError) {
        console.error(`[BundlePortalApply] DB update failed for order ${safeOrderId}:`, updateError.message)
        return { applied: false, retryable: true }
    }

    if (!updatedRows || updatedRows.length === 0) {
        console.log(`[BundlePortalApply] No matching pending/processing bundleportal order for id=${safeOrderId} (already resolved, or not a bundleportal order) — safe no-op`)
        return { applied: false, retryable: false }
    }

    await syncShopOrderStatus(orderId, status).catch(err =>
        console.error(`[BundlePortalApply] syncShopOrderStatus failed for ${orderId}:`, err)
    )

    if (status === 'failed') {
        await alertSupplierFailure(orderId, event, failureReason)
    }

    try {
        const { sendOrderCompletedPushNotification, sendOrderFailedPushNotification } = await import('@/lib/push-service')
        const sendPush = status === 'completed' ? sendOrderCompletedPushNotification : sendOrderFailedPushNotification
        sendPush(orderId).catch(e => console.error('[BundlePortalApply] Push error:', e))
    } catch (err) {
        console.error('[BundlePortalApply] Failed to import push service:', err)
    }

    // waitUntil, not an inline await — the webhook route must respond quickly (Bundle Portal
    // never redelivers, so there's no safety net if the function is frozen mid-await).
    waitUntil(notifyDataOrderWebhook(
        supabaseAdmin, orderId,
        status === 'completed' ? 'order.completed' : 'order.failed',
    ))

    return { applied: true, retryable: false }
}

/**
 * Tells an admin that Bundle Portal reported a non-completed terminal outcome. The order is now
 * `failed`; the wallet is untouched — refunding is an explicit admin decision made through
 * lib/refund-service.ts, same as every other supplier in this codebase. Since we deleted the
 * polling cron (no stale-order safety net), this alert is the only automatic signal an admin
 * gets that a bundleportal order needs attention.
 */
async function alertSupplierFailure(orderId: string, event: BundlePortalEvent, failureReason: string | null): Promise<void> {
    // See the comment at the top of applyBundlePortalOutcome — safeOrderId is for display/logging
    // only; the raw orderId is still what's used in the `.eq('id', orderId)` DB lookup below.
    const safeOrderId = sanitizeForStorage(orderId, 200)
    const safeReason = sanitizeForStorage(failureReason, 300) || 'no reason given'
    const safeEvent = sanitizeForStorage(event, 50)
    console.warn(`[BundlePortalApply] Bundle Portal reported ${safeEvent} for order ${safeOrderId} (${safeReason}) — marked failed, NOT refunded.`)
    try {
        const { sendAdminNewOrderAlert } = await import('@/lib/email-service')
        const { data: orderRow } = await supabaseAdmin
            .from('orders')
            .select('reference_code, phone_number, network, size, price')
            .eq('id', orderId)
            .maybeSingle()
        const humanReference = (orderRow as any)?.reference_code || safeOrderId
        await sendAdminNewOrderAlert({
            referenceCode: `BP-SUPPLIER-FAILED-${safeOrderId}`,
            phoneNumber: (orderRow as any)?.phone_number || 'N/A',
            network: (orderRow as any)?.network || 'unknown',
            size: (orderRow as any)?.size || 'unknown',
            price: (orderRow as any)?.price ?? 0,
            customerName: 'N/A',
            customerEmail: 'N/A',
            source: 'main_site',
            shopName: 'Bundle Portal Webhook',
            reason: `⚠️ Bundle Portal reported ${safeEvent} for order ${humanReference} (id ${safeOrderId}): ${safeReason}. The order is now marked failed and was NOT refunded — refund manually from the admin orders page if appropriate.`,
        }).catch((e: any) => console.error(`[BundlePortalApply] Admin alert send failed for ${safeOrderId}:`, e))
    } catch (e) {
        console.error(`[BundlePortalApply] Failed to raise supplier-failed alert for ${safeOrderId}:`, e)
    }
}
