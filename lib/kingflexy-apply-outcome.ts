// ─── KingFlexyGH data-supplier outcome application ──────────────────────────────
//
// SAFETY: the ONLY code path allowed to mark a `kingflexy` order completed/failed from a supplier
// signal (webhook, cron sweep, admin sync all funnel through here).
//
// Idempotency = compare-and-set + rows-affected gating (no dedupe table, by design): every status
// UPDATE is filtered on fulfillment_method='kingflexy' AND status='processing' AND the reference,
// and ALL side effects run only for ids the UPDATE actually returned. A duplicate event, or a
// `completed` followed by a later `refunded`, matches zero rows and is a silent no-op.
//
// `orders.error_message` is CUSTOMER-FACING: supplier text never goes there; reasons go to
// mtn_fulfillment_tracking.api_response. On completion any stale error_message is cleared.
import {
    mapKingflexyStatus,
    extractOrderIdFromReference,
    shouldRedeliver,
    type KfResolvedStatus,
} from '@/lib/kingflexy-data-service'
import { deliveredAtPatch } from '@/lib/delivery-stamp'

export type KingflexyOutcomeSource = 'webhook' | 'cron' | 'admin_sync'

/** Side-effect seams. Defaults lazily import the real services; tests inject fakes. */
export interface KingflexyOutcomeDeps {
    syncShopOrderStatus: (orderId: string, status: string) => Promise<unknown>
    sendCompletedPush: (orderId: string) => Promise<unknown>
    notifyOrderWebhook: (supabase: any, orderId: string, event: 'order.completed' | 'order.failed') => void
}

const defaultDeps: KingflexyOutcomeDeps = {
    syncShopOrderStatus: async (id, status) => {
        const { syncShopOrderStatus } = await import('@/lib/shop-service')
        return syncShopOrderStatus(id, status as any)
    },
    sendCompletedPush: async id => {
        const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
        return sendOrderCompletedPushNotification(id)
    },
    notifyOrderWebhook: (supabase, id, event) => {
        // Lazy so pure tests never load @vercel/functions / the webhook module.
        void (async () => {
            try {
                const [{ waitUntil }, { notifyDataOrderWebhook }] = await Promise.all([
                    import('@vercel/functions'),
                    import('@/lib/data-order-webhook'),
                ])
                waitUntil(notifyDataOrderWebhook(supabase, id, event))
            } catch (e) {
                console.error('[KingflexyApply] notifyDataOrderWebhook scheduling failed:', e)
            }
        })()
    },
}

export async function applyKingflexyOutcome(
    supabase: any,
    args: { reference: string; rawStatus: unknown; source: KingflexyOutcomeSource },
    deps: Partial<KingflexyOutcomeDeps> = {},
): Promise<{ resolved: KfResolvedStatus; applied: number }> {
    const d: KingflexyOutcomeDeps = { ...defaultDeps, ...deps }
    const { reference, rawStatus, source } = args
    const resolved = mapKingflexyStatus(rawStatus)
    if (resolved === 'processing') return { resolved, applied: 0 }
    if (typeof reference !== 'string' || reference.length === 0) return { resolved, applied: 0 }

    const patch = (extra: Record<string, unknown> = {}) => ({
        status: resolved,
        updated_at: new Date().toISOString(),
        ...(resolved === 'completed' ? { error_message: null } : {}),
        ...deliveredAtPatch(resolved, { allowNowFallback: true }),
        ...extra,
    })

    // Leg 1: by reference.
    const { data: byRefRows, error: byRefError } = await supabase
        .from('orders')
        .update(patch())
        .eq('kingflexy_reference', reference)
        .eq('fulfillment_method', 'kingflexy')
        .eq('status', 'processing')
        .select('id')
    if (byRefError) throw new Error(`kingflexy update-by-reference failed: ${byRefError.message}`)
    let ids: string[] = (byRefRows || []).map((r: any) => r.id)

    // Leg 2: by order id recovered from our own reference, ONLY while the row has no reference on
    // file (webhook raced the dispatch write). A non-null, different reference means a newer attempt
    // is in flight and this event belongs to a superseded one.
    if (ids.length === 0) {
        const orderId = extractOrderIdFromReference(reference)
        if (orderId) {
            const { data: byIdRows, error: byIdError } = await supabase
                .from('orders')
                .update(patch({ kingflexy_reference: reference }))
                .eq('id', orderId)
                .eq('fulfillment_method', 'kingflexy')
                .eq('status', 'processing')
                .is('kingflexy_reference', null)
                .select('id')
            if (byIdError) throw new Error(`kingflexy update-by-id failed: ${byIdError.message}`)
            ids = (byIdRows || []).map((r: any) => r.id)
        }
    }

    for (const id of ids) {
        console.log(`[KingflexyApply] orders.${id} -> ${resolved} (source=${source})`)

        await Promise.resolve(d.syncShopOrderStatus(id, resolved)).catch(e =>
            console.error(`[KingflexyApply] syncShopOrderStatus failed for ${id}:`, e),
        )

        if (resolved === 'completed') {
            try {
                Promise.resolve(d.sendCompletedPush(id)).catch(e =>
                    console.error(`[KingflexyApply] push failed for ${id}:`, e),
                )
            } catch (e) {
                console.error(`[KingflexyApply] push failed for ${id}:`, e)
            }
        } else {
            const { error: trackingError } = await supabase.from('mtn_fulfillment_tracking').insert({
                order_id: id,
                status: 'failed',
                api_response: {
                    supplier: 'kingflexy',
                    source,
                    kingflexy_status: typeof rawStatus === 'string' ? rawStatus.slice(0, 50) : null,
                    reference,
                },
            })
            if (trackingError) console.error(`[KingflexyApply] Tracking insert failed for ${id}:`, trackingError.message)
        }

        try {
            d.notifyOrderWebhook(supabase, id, resolved === 'completed' ? 'order.completed' : 'order.failed')
        } catch (e) {
            console.error(`[KingflexyApply] notify failed for ${id}:`, e)
        }
    }

    return { resolved, applied: ids.length }
}

// ─── Webhook decision helpers (pure / fake-testable, kept out of the route) ──────

/** True when at least one order carries this kingflexy_reference. Throws on DB error. */
export async function kingflexyReferenceExists(supabase: any, reference: string): Promise<boolean> {
    const { data, error } = await supabase
        .from('orders')
        .select('id')
        .eq('kingflexy_reference', reference)
        .limit(1)
    if (error) throw new Error(`kingflexy reference lookup failed: ${error.message}`)
    return Array.isArray(data) && data.length > 0
}

/**
 * 500 (ask KingFlexy to redeliver) only for the race where the event beat the reference write:
 * nothing applied, no order owns the reference yet, and the event is < 10 min old. Otherwise 200.
 */
export function decideWebhookStatus(input: {
    applied: number
    referenceKnown: boolean
    timestamp: unknown
    nowMs: number
}): 200 | 500 {
    if (input.applied > 0 || input.referenceKnown) return 200
    return shouldRedeliver(input.timestamp, input.nowMs) ? 500 : 200
}
