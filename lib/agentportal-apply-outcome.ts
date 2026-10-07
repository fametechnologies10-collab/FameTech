// ─── AgentPortal per-order outcome application ──────────────────────────────────
//
// Extracted from app/api/webhooks/agentportal/route.ts so the webhook handler and the
// reconcile poller (lib/agentportal-reconcile.ts) apply a resolved outcome through the
// EXACT same path — that drift (webhook vs. reconcile disagreeing on how to resolve an
// order) is precisely how this integration has broken before. Both callers first turn
// AgentPortal's item data into `{ orderId, outcome, failedReason }` via
// lib/agentportal-status.ts, then hand it to applyAgentPortalOutcome here.
//
// SAFETY: this is the ONLY code path allowed to mark an agentportal order completed/failed.
//
// ── WHY THERE IS NO REFUND HERE ─────────────────────────────────────────────────
// This module used to call refund_order_wallet on AgentPortal's `failed` item status. That
// cost real money twice on 2026-07-26 and is now forbidden, for two independently sufficient
// reasons:
//
//  1. AgentPortal's `failed` is NOT the last word. A retriable failure spawns a retry order
//     (group_name …-R1-/-R2-) that frequently DELIVERS. Both refunds we issued that day were
//     for data the customer actually received ~60 seconds later, and AgentPortal never
//     credited our supplier wallet back (refunded_at stayed null) — so we paid the supplier
//     AND refunded the customer.
//  2. refund_order_wallet credits orders.price — the RETAIL/selling price — and is not
//     shop-aware. On a shop order the owner is only owed cost_price (they keep the profit,
//     which is already in their shop wallet, and out of the two they repay the guest the full
//     selling price). Refunding selling price over-credits by exactly the profit every time;
//     that leaked GHS 10.89 across 6 orders before this was caught. The shop-aware routing
//     lives in lib/refund-service.ts, which only the admin refund path goes through.
//
// Refunding is therefore an explicit admin decision made through lib/refund-service.ts, which
// moves the order on to its own `refunded` status. `failed` is simply where an order rests
// until an admin makes that call.
//
// ── THE RETRY RESCUE ────────────────────────────────────────────────────────────
// A `failed` order is NOT a dead end here. Because AgentPortal's retry can still deliver, a
// later `success` is allowed to move an order from `failed` to `completed` — but only while
// it is un-refunded. Once an admin refunds it (status `refunded`), it is settled and nothing
// below can touch it again. Without this rescue, marking an order failed would permanently
// hide a delivery that actually happened, which is how the customer ends up refunded for data
// they received.
import { createAdminClient } from '@/lib/supabase-admin'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { sanitizeForStorage } from '@/lib/sanitize-for-storage'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'
import type { AgentPortalTerminalOutcome } from '@/lib/agentportal-status'

const supabaseAdmin = createAdminClient()

export interface ApplyOutcomeResult {
    /** true only if the atomic conditional UPDATE matched exactly our row and the order actually transitioned. */
    applied: boolean
    /** true on a transient DB error — caller should treat the whole delivery as retryable rather than ack it. */
    retryable: boolean
}

/**
 * Applies one resolved AgentPortal outcome to one of our orders.
 *
 * Statuses come from AgentPortal's EXTERNAL order/item data only — never their internal queue.
 *
 * - Both outcomes are applied via an atomic conditional UPDATE scoped to
 *   fulfillment_method='agentportal', so a duplicate or late resolution matches zero rows and
 *   is a safe no-op.
 * - `failed` transitions pending/processing -> failed. It NEVER refunds; an admin refunds from
 *   the admin orders page, which moves the order on to `refunded`.
 * - `completed` transitions pending/processing -> completed, and additionally rescues an
 *   un-refunded `failed` order when AgentPortal's retry delivered after all.
 * - Push notification is fire-and-forget, matching the rest of the codebase's pattern.
 */
export async function applyAgentPortalOutcome(
    orderId: string,
    outcome: AgentPortalTerminalOutcome,
    failedReason: string | null,
    alertSourceLabel: string = 'AgentPortal'
): Promise<ApplyOutcomeResult> {
    const { data: updatedRows, error: updateError } = await supabaseAdmin
        .from('orders')
        .update({ status: outcome, updated_at: new Date().toISOString() })
        .eq('id', orderId)
        .eq('fulfillment_method', 'agentportal')
        .in('status', ['pending', 'processing'])
        .select('id')

    if (updateError) {
        console.error(`[AgentPortalApply] DB update failed for order ${orderId}:`, updateError.message)
        return { applied: false, retryable: true }
    }

    let rescuedFromFailed = false

    if (!updatedRows || updatedRows.length === 0) {
        // Nothing in flight matched. For a success, the order may be one we already marked
        // failed on an earlier attempt that AgentPortal has since retried and delivered —
        // rescue it, but only while it is still un-refunded (a `refunded` order is settled and
        // is excluded by the status filter; refunded_at is belt-and-braces on top).
        if (outcome !== 'completed') {
            console.log(`[AgentPortalApply] No matching pending/processing agentportal order for id=${orderId} (already resolved, or not an agentportal order) — safe no-op`)
            return { applied: false, retryable: false }
        }

        const { data: rescuedRows, error: rescueError } = await supabaseAdmin
            .from('orders')
            .update({ status: 'completed', updated_at: new Date().toISOString() })
            .eq('id', orderId)
            .eq('fulfillment_method', 'agentportal')
            .eq('status', 'failed')
            .is('refunded_at', null)
            .select('id')

        if (rescueError) {
            console.error(`[AgentPortalApply] Rescue update failed for order ${orderId}:`, rescueError.message)
            return { applied: false, retryable: true }
        }

        if (!rescuedRows || rescuedRows.length === 0) {
            console.log(`[AgentPortalApply] No matching agentportal order for id=${orderId} to complete (already completed/refunded, or not ours) — safe no-op`)
            return { applied: false, retryable: false }
        }

        rescuedFromFailed = true
    }

    await syncShopOrderStatus(orderId, outcome).catch(err =>
        console.error(`[AgentPortalApply] syncShopOrderStatus failed for ${orderId}:`, err)
    )

    if (outcome === 'failed') {
        await alertSupplierFailure(orderId, failedReason, alertSourceLabel)
    } else if (rescuedFromFailed) {
        await alertRetryRescued(orderId, alertSourceLabel)
    }

    try {
        const { sendOrderCompletedPushNotification, sendOrderFailedPushNotification } = await import('@/lib/push-service')
        const sendPush = outcome === 'completed' ? sendOrderCompletedPushNotification : sendOrderFailedPushNotification
        sendPush(orderId).catch(e => console.error('[AgentPortalApply] Push error:', e))
    } catch (err) {
        console.error('[AgentPortalApply] Failed to import push service:', err)
    }

    // waitUntil rather than an inline await, deliberately, because this function has
    // TWO callers: the AgentPortal webhook route (which should respond quickly) and
    // lib/agentportal-reconcile.ts's cron sweep (which can call this in a loop over
    // many orders — an inline await here would risk the same sequential-loop
    // maxDuration:60 exposure already found and fixed for airtime/utilities, finding
    // I3). waitUntil is safe from BOTH: it registers the promise against the current
    // function invocation regardless of which caller is running it, and does not
    // block the reconcile loop's next iteration.
    waitUntil(notifyDataOrderWebhook(
        supabaseAdmin, orderId,
        outcome === 'completed' ? 'order.completed' : 'order.failed',
    ))

    return { applied: true, retryable: false }
}

/** Shared alert plumbing — one order-row read, one deduped admin email. Never throws. */
async function sendOrderAdminAlert(orderId: string, dedupPrefix: string, alertSourceLabel: string, reasonFor: (humanReference: string) => string): Promise<void> {
    try {
        const { sendAdminNewOrderAlert } = await import('@/lib/email-service')
        const { data: orderRow } = await supabaseAdmin
            .from('orders')
            .select('reference_code, phone_number, network, size, price')
            .eq('id', orderId)
            .maybeSingle()
        const humanReference = (orderRow as any)?.reference_code || orderId
        // Dedup key MUST be distinct from the order's own reference_code — that key is shared
        // with other alert call sites for the SAME order, so reusing it would let an unrelated
        // earlier alert silently suppress this one.
        await sendAdminNewOrderAlert({
            referenceCode: `${dedupPrefix}-${orderId}`,
            phoneNumber: (orderRow as any)?.phone_number || 'N/A',
            network: (orderRow as any)?.network || 'unknown',
            size: (orderRow as any)?.size || 'unknown',
            price: (orderRow as any)?.price ?? 0,
            customerName: 'N/A',
            customerEmail: 'N/A',
            source: 'main_site',
            shopName: alertSourceLabel,
            reason: reasonFor(humanReference),
        }).catch((e: any) => console.error(`[AgentPortalApply] Admin alert send failed for ${orderId}:`, e))
    } catch (e) {
        console.error(`[AgentPortalApply] Failed to raise ${dedupPrefix} alert for ${orderId}:`, e)
    }
}

/**
 * Tells an admin that AgentPortal reported a failure. The order is now `failed`; the wallet is
 * untouched. Refunding is the admin's call — AgentPortal retries retriable failures under a new
 * order id and often succeeds, which is what caused the 2026-07-26 refund-then-deliver losses.
 */
async function alertSupplierFailure(orderId: string, failedReason: string | null, alertSourceLabel: string): Promise<void> {
    const safeFailedReason = sanitizeForStorage(failedReason, 300) || 'unknown reason'
    console.warn(`[AgentPortalApply] AgentPortal reported FAILED for order ${orderId} (${safeFailedReason}) — marked failed, NOT refunded.`)
    await sendOrderAdminAlert(orderId, 'AP-SUPPLIER-FAILED', alertSourceLabel, ref =>
        `⚠️ AgentPortal reported FAILED for order ${ref} (id ${orderId}): ${safeFailedReason}. The order is now marked failed and was NOT refunded. Before refunding, check AgentPortal — they retry retriable failures under a new order (group …-R1-) and often deliver; if a retry lands, this order will flip itself back to completed.`
    )
}

/**
 * Tells an admin that an order we had already marked `failed` was in fact delivered by an
 * AgentPortal retry, and has been moved back to `completed`. Worth surfacing loudly: the
 * customer may already have been told it failed, and it must not now be refunded.
 */
async function alertRetryRescued(orderId: string, alertSourceLabel: string): Promise<void> {
    console.warn(`[AgentPortalApply] Order ${orderId} was 'failed' but an AgentPortal retry DELIVERED it — moved back to completed.`)
    await sendOrderAdminAlert(orderId, 'AP-RETRY-RESCUED', alertSourceLabel, ref =>
        `✅ Order ${ref} (id ${orderId}) was previously marked FAILED, but AgentPortal's retry delivered it — it has been moved back to COMPLETED. Do NOT refund this order. If the customer was already told it failed, let them know the data went through.`
    )
}
