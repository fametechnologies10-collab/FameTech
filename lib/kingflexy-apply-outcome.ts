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
    /** Internal-only admin alert for an anomaly worth a human look. Must never throw. */
    alertAdmin: (supabase: any, orderId: string, reference: string, reason: string) => Promise<unknown>
}

/**
 * Default admin alert: the same push-alert helper the other suppliers use (sendAdminNewOrderAlert,
 * dedupes 6h per referenceCode). Loaded lazily; internal text only, never any key. Never throws.
 */
export async function defaultKingflexyAlertAdmin(supabase: any, orderId: string, reference: string, reason: string) {
    try {
        const { sendAdminNewOrderAlert } = await import('@/lib/email-service')
        let o: any = null
        try {
            const { data } = await supabase
                .from('orders')
                .select('phone_number, network, size, price')
                .eq('id', orderId)
                .limit(1)
            o = Array.isArray(data) ? data[0] : null
        } catch { /* details are best-effort */ }
        await sendAdminNewOrderAlert({
            referenceCode: `KINGFLEXY-${orderId}-${reason.slice(0, 20).replace(/\W+/g, '-')}`,
            phoneNumber: o?.phone_number ?? 'unknown',
            network: o?.network ?? 'unknown',
            size: String(o?.size ?? 'unknown'),
            price: Number(o?.price) || 0,
            customerName: 'n/a',
            customerEmail: 'n/a',
            source: 'main_site',
            reason: `KingFlexy: ${reason} - order ${orderId}, reference ${reference}`,
        })
    } catch (e: any) {
        console.error('[KingflexyApply] Admin alert failed:', e?.message || 'unknown')
    }
}

/**
 * Records ONE deduped anomaly marker row (per order + note) and raises ONE admin alert, only at the
 * moment the row is first inserted. Status is neutral ('pending'): mtn_fulfillment_tracking.status
 * is unconstrained text, and 'failed' would make admin log views show a live/completed order as
 * failed. Never throws, never changes the order.
 */
export async function recordKingflexyAnomaly(
    supabase: any,
    args: { orderId: string; reference: string; source: string; note: string; alertReason: string },
    alertAdmin: KingflexyOutcomeDeps['alertAdmin'] = defaultKingflexyAlertAdmin,
): Promise<void> {
    try {
        const { data: existing, error: lookupError } = await supabase
            .from('mtn_fulfillment_tracking')
            .select('id')
            .eq('order_id', args.orderId)
            .contains('api_response', { note: args.note })
            .limit(1)
        if (lookupError || (existing && existing.length > 0)) return
        const { error } = await supabase.from('mtn_fulfillment_tracking').insert({
            order_id: args.orderId,
            status: 'pending',
            api_response: { supplier: 'kingflexy', source: args.source, note: args.note, reference: args.reference },
        })
        if (error) {
            console.error(`[KingflexyApply] Anomaly tracking insert failed for ${args.orderId}:`, error.message)
            return
        }
        await Promise.resolve(alertAdmin(supabase, args.orderId, args.reference, args.alertReason)).catch(e =>
            console.error(`[KingflexyApply] Alert failed for ${args.orderId}:`, e?.message || 'unknown'),
        )
    } catch (e: any) {
        console.error(`[KingflexyApply] Anomaly record failed for ${args.orderId}:`, e?.message || 'unknown')
    }
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
    alertAdmin: defaultKingflexyAlertAdmin,
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

    // Spec s5: a `completed` arriving after we already marked the order `failed` is never auto-applied,
    // but must be recorded + alerted. One cheap SELECT, only for an unapplied `completed`.
    if (resolved === 'completed' && ids.length === 0) {
        try {
            const { data: lateRows, error: lateError } = await supabase
                .from('orders')
                .select('id')
                .eq('kingflexy_reference', reference)
                .eq('fulfillment_method', 'kingflexy')
                .eq('status', 'failed')
                .limit(1)
            if (lateError) throw new Error(lateError.message)
            const lateId = Array.isArray(lateRows) && lateRows[0]?.id
            if (lateId) {
                await recordKingflexyAnomaly(
                    supabase,
                    {
                        orderId: lateId,
                        reference,
                        source,
                        note: 'late_completed_after_failure',
                        alertReason: 'supplier reports COMPLETED for an order we already marked failed (not reversed automatically; verify delivery and refund state)',
                    },
                    d.alertAdmin,
                )
            }
        } catch (e: any) {
            console.error('[KingflexyApply] Late-completed check failed:', e?.message || 'unknown', 'reference:', reference)
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

/**
 * Whole post-verification webhook decision (payload already signature-checked and JSON-parsed).
 * Returns the HTTP status. Deliberate no-ops are 200; ANY thrown error (DB/apply/lookup) is 500 so
 * KingFlexy redelivers (it retries on non-2xx); the CAS update makes redelivery idempotent.
 * Logs only the error message and reference, never the secret, signature or raw body.
 */
export async function handleKingflexyWebhookPayload(
    supabase: any,
    payload: any,
    nowMs: number,
    seams: {
        apply?: typeof applyKingflexyOutcome
        referenceExists?: typeof kingflexyReferenceExists
    } = {},
): Promise<{ status: 200 | 500; applied: number }> {
    if (!payload || typeof payload !== 'object' || payload.event === 'webhook.test' || payload.product !== 'data') {
        return { status: 200, applied: 0 }
    }
    const reference = payload.reference
    if (typeof reference !== 'string' || reference.length === 0) return { status: 200, applied: 0 }

    const apply = seams.apply ?? applyKingflexyOutcome
    const referenceExists = seams.referenceExists ?? kingflexyReferenceExists
    try {
        const { applied } = await apply(supabase, { reference, rawStatus: payload.status, source: 'webhook' })
        if (applied > 0) return { status: 200, applied }
        const referenceKnown = await referenceExists(supabase, reference)
        return { status: decideWebhookStatus({ applied, referenceKnown, timestamp: payload.timestamp, nowMs }), applied }
    } catch (e: any) {
        console.error('[KingflexyApply] webhook processing failed (returning 500 for redelivery):', e?.message || 'unknown', 'reference:', reference)
        return { status: 500, applied: 0 }
    }
}
