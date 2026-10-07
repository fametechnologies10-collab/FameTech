// lib/data-order-webhook.ts
//
// The data-bundle equivalent of the webhook hooks already wired into
// dispatchAirtimeFulfillment / purchaseWithWallet / dispatchUtilityCore /
// process_afa_order (finding R1, deferred from Phase 2A). Deferred because data
// orders resolve through far more call sites than any other product — no single
// dispatch function owns "this order just finished": completion is signalled by
// whichever of ~7 supplier webhooks, cron polls, or admin sync routes gets there
// first, and lib/fulfillment-trigger.ts itself NEVER reaches a terminal state —
// its success branch only ever sets 'processing'; 'completed'/'failed'/'refunded'
// always come from one of those downstream resolvers.
//
// This helper factors the shared part — "given an order id a caller has ALREADY
// verified just underwent a real, CAS-guarded transition, look up its api_key_id
// and fire the webhook if one is configured" — out of every one of those call
// sites, rather than repeating the api_key_id lookup and payload shaping ~15
// times. The CAS guard itself stays at each call site (an `.update(...).eq(
// 'status', 'processing').select('id')` or equivalent) because that guard is
// already correctly implemented per-route today and differs in shape between a
// single-row webhook match and a bulk cron sweep — this helper only runs for an
// id the caller has already proven was actually transitioned.
import { dispatchApiWebhook } from '@/lib/api-webhook'

export type DataOrderWebhookEvent = 'order.completed' | 'order.failed' | 'order.refunded'

const EVENT_TO_STATUS: Record<DataOrderWebhookEvent, string> = {
    'order.completed': 'completed',
    'order.failed': 'failed',
    'order.refunded': 'refunded',
}

/**
 * Fire-and-forget, like dispatchApiWebhook itself — callers on a request path
 * should wrap this in `waitUntil()` so a lambda freeze immediately after the
 * response cannot drop it (the exact bug fixed for airtime/results-checker in
 * commit c63642e7 / the T8 webhook-await fix).
 *
 * No-ops silently if the order has no api_key_id (not an API order) or cannot
 * be found — never throws into the caller, matching dispatchApiWebhook's own
 * contract.
 */
export async function notifyDataOrderWebhook(
    supabase: any,
    orderId: string,
    event: DataOrderWebhookEvent,
): Promise<void> {
    try {
        const { data: order, error } = await supabase
            .from('orders')
            .select('api_key_id, reference_code, network, size')
            .eq('id', orderId)
            .maybeSingle()
        if (error || !order?.api_key_id) return

        await dispatchApiWebhook(supabase, {
            apiKeyId: order.api_key_id,
            event,
            product: 'data',
            // Strip the 'API-' prefix so the developer sees back exactly the
            // reference they sent — same convention as every other product.
            reference: String(order.reference_code || '').replace(/^API-/, ''),
            status: EVENT_TO_STATUS[event],
            detail: { network: order.network, size: order.size },
        })
    } catch (e: any) {
        console.error(`[DataOrderWebhook] notify failed for order ${orderId}:`, e?.message || e)
    }
}
