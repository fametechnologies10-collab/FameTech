import { createServerClient } from '@/lib/supabase'
import { waitUntil } from '@vercel/functions'
import { parseCommission } from '@/lib/hubtel-commission-service'
import { checkCommissionStatus } from '@/lib/hubtel-commission-status'
import { fulfillAirtimeKingFlexy, checkAirtimeOrderStatus, kfKeyForOrder } from '@/lib/kingflexy-commission-service'
import { finalizeKfAirtime } from '@/lib/kingflexy-finalize'
import { categorizeFailure, autoRefundApiOrderOnFailure } from '@/lib/api-order-failure'

const MAX_ATTEMPTS = 5

/**
 * Best-effort double-send guard. With unique-per-attempt ClientReferences we no longer get Hubtel's
 * reference-dedupe, so before re-sending we ask the Status Check API whether the PREVIOUS attempt
 * already delivered. Returns delivered=true only on a definitive 'success' verdict.
 */
async function priorAttemptVerdict(meta: any): Promise<{ verdict: string; delivered: boolean }> {
    const priorRef = meta?.client_reference
    if (!priorRef) return { verdict: 'none', delivered: false }
    const r = await checkCommissionStatus(String(priorRef)).catch(() => null)
    if (!r || !r.configured) return { verdict: 'unknown', delivered: false }
    return { verdict: r.verdict, delivered: r.verdict === 'success' }
}

/**
 * Sync a terminal airtime_orders status down to the mirrored `orders`/`shop_orders` ledger rows
 * for shop-attributed references (SHOP- storefront, USSD-AIR- USSD shop airtime, USSD-MASH- USSD
 * shop mashup). Without this, any path that finalizes airtime_orders WITHOUT going through the
 * admin PATCH route or the Hubtel webhook's 'completed' branch leaves the shop owner's/customer's
 * view stuck on the pre-fulfillment status forever — exactly what the admin PATCH route and webhook
 * already do; this is that same logic, shared so every finalize path stays in sync.
 */
export async function syncAirtimeShopMirror(supabase: any, referenceCode: string | null | undefined, status: string): Promise<void> {
    if (!referenceCode) return
    try {
        if (referenceCode.startsWith('SHOP-')) {
            const refSuffix = referenceCode.replace('SHOP-', '')
            await (supabase.from('orders') as any).update({ status }).eq('reference_code', referenceCode)
            const { data: sOrder } = await (supabase.from('shop_orders') as any)
                .select('id').ilike('paystack_reference', `%${refSuffix}`).single()
            if (sOrder?.id) {
                await (supabase.from('shop_orders') as any)
                    .update({ status, updated_at: new Date().toISOString() }).eq('id', sOrder.id)
            }
        } else if (referenceCode.startsWith('USSD-AIR-') || referenceCode.startsWith('USSD-MASH-')) {
            const { data: mirror } = await (supabase.from('orders') as any)
                .select('id, shop_order_id').eq('reference_code', referenceCode).maybeSingle()
            if (mirror?.id) {
                await (supabase.from('orders') as any).update({ status }).eq('id', mirror.id)
            }
            if (mirror?.shop_order_id) {
                await (supabase.from('shop_orders') as any)
                    .update({ status, updated_at: new Date().toISOString() }).eq('id', mirror.shop_order_id)
            }
        }
    } catch (e) {
        console.error('[AirtimeFulfillment] syncAirtimeShopMirror failed:', e)
    }
}

export async function isAirtimeAutoFulfillmentEnabled(supabase: any, network: string): Promise<boolean> {
    const { data } = await supabase.from('admin_settings').select('key, value')
        .in('key', ['airtime_auto_fulfillment_enabled', 'hubtel_airtime_networks', 'hubtel_commission_paused'])
    const map: Record<string, string> = {}
    for (const r of (data || [])) map[r.key] = r.value
    if (map['airtime_auto_fulfillment_enabled'] !== 'true') return false
    if (map['hubtel_commission_paused'] === 'true') return false
    try {
        const nets = JSON.parse(map['hubtel_airtime_networks'] || '{}')
        return nets[network] === true
    } catch { return false }
}

/**
 * Auto-dispatch a single PENDING airtime order to KingFlexyGH commission services.
 * Idempotent + concurrency-safe via an atomic claim. NEVER refunds — transient
 * failures revert to 'pending' for the reconcile cron to retry.
 */
export async function dispatchAirtimeFulfillment(orderId: string): Promise<void> {
    const supabase = createServerClient()

    const { data: order } = await (supabase.from('airtime_orders') as any)
        .select('id, type, network, beneficiary_phone, airtime_amount, reference_code, status, airtime_fulfillment_attempts, fulfillment_metadata, api_key_id, source, fulfillment_service, user_id')
        .eq('id', orderId).single()
    if (!order || order.status !== 'pending') return
    if (order.type === 'mashup') return // Mashup is fulfilled manually — never sent as plain airtime

    if (!(await isAirtimeAutoFulfillmentEnabled(supabase, order.network))) return // off → manual

    // Provider caps airtime at 100 GHS/request — leave larger orders PENDING for manual fulfillment (never auto-fail).
    if (Number(order.airtime_amount) > 100) return

    const attempt = (order.airtime_fulfillment_attempts || 0) + 1
    if (attempt > MAX_ATTEMPTS) return

    // Legacy Hubtel double-send guard. KingFlexyGH replays (never re-charges) a repeated reference,
    // so kingflexy-tagged orders skip it.
    if (order.fulfillment_service !== 'kingflexy-commission' && order.fulfillment_metadata?.client_reference) {
        const prior = await priorAttemptVerdict(order.fulfillment_metadata)
        if (prior.delivered) {
            // .select('id') so only the caller that actually performs the pending→completed
            // transition fires the webhook. This branch runs before the atomic claim below, so
            // two concurrent invocations (the route's waitUntil and the reconcile cron) can both
            // read status='pending' here and would otherwise both send order.completed.
            const { data: settled } = await (supabase.from('airtime_orders') as any).update({
                status: 'completed',
                fulfilled_at: new Date().toISOString(),
                fulfillment_metadata: { ...order.fulfillment_metadata, status_check: { verdict: 'success', at: new Date().toISOString() } },
                updated_at: new Date().toISOString(),
            }).eq('id', orderId).eq('status', 'pending').select('id')
            await syncAirtimeShopMirror(supabase, order.reference_code, 'completed')
            if (settled && settled.length > 0 && order.api_key_id) {
                const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                waitUntil(dispatchApiWebhook(supabase, {
                    apiKeyId: order.api_key_id, event: 'order.completed', product: 'airtime',
                    reference: order.reference_code.replace(/^API-/, ''), status: 'completed',
                    detail: { network: order.network, airtime_amount: Number(order.airtime_amount) },
                }))
            }
            return
        }
        // Unverifiable legacy attempt (no Hubtel credentials => verdict 'unknown'): never re-send via
        // KingFlexyGH, the earlier Hubtel attempt may have delivered. Leave pending for admin handling.
        if (prior.verdict !== 'failed') return
    }

    // Atomic claim: only the worker that flips pending→processing proceeds.
    const { data: claimed } = await (supabase.from('airtime_orders') as any)
        .update({
            status: 'processing',
            fulfillment_service: 'kingflexy-commission',
            airtime_fulfillment_attempts: attempt,
            updated_at: new Date().toISOString(),
        })
        .eq('id', orderId).eq('status', 'pending').select('id')
    if (!claimed || claimed.length === 0) return

    // Stable key per order: KingFlexyGH replays a repeated reference instead of charging twice.
    const { key: clientRef, generation } = kfKeyForOrder(order, { bumpAfterFailure: false })
    const result = await fulfillAirtimeKingFlexy(
        order.network, order.beneficiary_phone, Number(order.airtime_amount), clientRef,
    )

    if (result.success) {
        // Guarded on status='processing': a webhook may have finalized the order while the POST was in flight.
        const { data: written } = await (supabase.from('airtime_orders') as any).update({
            fulfillment_request_id: result.transactionId || null,
            fulfillment_metadata: {
                supplier: 'kingflexy-commission',
                client_reference: clientRef,
                kf_generation: generation,
                attempt,
                api_response: result.apiResponse,
            },
            ...(result.pending ? {} : {
                status: 'completed',
                fulfilled_at: new Date().toISOString(),
            }),
            updated_at: new Date().toISOString(),
        }).eq('id', orderId).eq('status', 'processing').select('id')
        if (!result.pending && written && written.length > 0) {
            await syncAirtimeShopMirror(supabase, order.reference_code, 'completed')
            // Fire-safe: credit_airtime_commission is idempotent (atomic claim keyed on
            // commission_credited_at IS NULL) and no-ops while commission_amount is NULL / for non-'api' sources.
            try {
                const { error: creditError } = await (supabase as any).rpc('credit_airtime_commission', { p_airtime_order_id: orderId })
                if (creditError) console.error('[AirtimeFulfillment] credit_airtime_commission failed:', creditError.message, 'order:', orderId)
            } catch (e) { console.error('[AirtimeFulfillment] credit_airtime_commission failed:', e) }
            if (order.api_key_id) {
                const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                waitUntil(dispatchApiWebhook(supabase, {
                    apiKeyId: order.api_key_id, event: 'order.completed', product: 'airtime',
                    reference: order.reference_code.replace(/^API-/, ''), status: 'completed',
                    detail: { network: order.network, airtime_amount: Number(order.airtime_amount) },
                }))
            }
        }
        return
    }

    // Failure — NO refund. Insufficient float pauses auto globally + alerts.
    if (result.isInsufficientFloat) {
        await (supabase.from('admin_settings') as any).upsert(
            { key: 'hubtel_commission_paused', value: 'true' }, { onConflict: 'key' },
        )
    }
    const { data: failWritten } = await (supabase.from('airtime_orders') as any).update({
        status: result.isPermanentFailure ? 'failed' : 'pending', // transient → retry
        fulfillment_metadata: {
            supplier: 'kingflexy-commission',
            client_reference: clientRef,
            kf_generation: generation,
            attempt,
            error: result.error,
            api_response: result.apiResponse,
        },
        updated_at: new Date().toISOString(),
    }).eq('id', orderId).eq('status', 'processing').select('id')
    if (!failWritten || failWritten.length === 0) return
    if (result.isPermanentFailure) await syncAirtimeShopMirror(supabase, order.reference_code, 'failed')
    if (result.isPermanentFailure) {
        const { code: reasonCode, message: reasonMessage } = categorizeFailure('permanent_failure')
        const refund = await autoRefundApiOrderOnFailure(supabase, {
            product: 'airtime', orderId, source: order.source, reasonCode, reasonMessage,
        })
        if (order.api_key_id) {
            const { dispatchApiWebhook } = await import('@/lib/api-webhook')
            waitUntil(dispatchApiWebhook(supabase, {
                apiKeyId: order.api_key_id, event: 'order.failed', product: 'airtime',
                reference: order.reference_code.replace(/^API-/, ''), status: refund.refunded ? 'refunded' : 'failed',
                detail: {
                    network: order.network, airtime_amount: Number(order.airtime_amount),
                    reason_code: reasonCode, reason: reasonMessage,
                    ...(refund.refunded ? { refunded: true, refund_amount: refund.amount, new_balance: refund.newBalance } : {}),
                },
            }))
        }
    }

    // Auto-fulfillment failed to deliver → web-push the admins (web only; no SMS/email).
    try {
        const { sendAdminPushNotification } = await import('@/lib/push-service')
        await sendAdminPushNotification({
            title: 'Airtime auto-fulfillment failed',
            body: `${order.network} GHS ${Number(order.airtime_amount).toFixed(2)} to ${order.beneficiary_phone} did not go through: ${result.error || 'unknown error'} (ref ${order.reference_code}).`,
            url: '/admin/airtime',
        })
    } catch (e) { console.error('[airtime] admin failure push failed:', e) }
}

/**
 * MANUAL admin refulfillment via KingFlexyGH (force; bypasses the auto kill-switch).
 * Airtime only — never mashup. Refuses to resend a completed order. A stable key per order means
 * the provider replays any prior attempt (no double top-up); a FAILED order gets generation+1.
 * Returns a result object for the admin UI.
 */
export async function manualRefulfillAirtime(
    orderId: string,
): Promise<{ ok: boolean; status: string; message: string; commission?: number }> {
    const supabase = createServerClient()

    const { data: order } = await (supabase.from('airtime_orders') as any)
        .select('id, type, network, beneficiary_phone, airtime_amount, reference_code, status, airtime_fulfillment_attempts, fulfillment_metadata, api_key_id, source, fulfillment_service, user_id')
        .eq('id', orderId).single()
    if (!order) return { ok: false, status: 'not_found', message: 'Order not found' }
    if (order.type === 'mashup') return { ok: false, status: order.status, message: 'Commission refulfillment is for airtime only, not mashup' }
    if (order.status === 'completed') return { ok: false, status: 'completed', message: 'Order already completed — not resending' }
    if (Number(order.airtime_amount) > 100) return { ok: false, status: order.status, message: 'Exceeds 100 GHS per-request cap — cannot send via commission' }

    let keyStatus: string = order.status
    if (order.fulfillment_service === 'kingflexy-commission' && order.status === 'processing') {
        const existingKey = String(order.fulfillment_metadata?.client_reference ?? order.reference_code)
        const st = await checkAirtimeOrderStatus(existingKey)
        if (st.state === 'completed') {
            await finalizeKfAirtime(supabase, order, { state: 'completed', raw: st.raw })
            return { ok: true, status: 'completed', message: 'A previous attempt already delivered — marked completed (not resending).' }
        }
        if (st.state === 'pending') {
            return { ok: false, status: 'processing', message: 'Previous attempt still in flight at KingFlexyGH — use Sync' }
        }
        // failed: treat as failed so the key generation is bumped (the old key would just replay the failure).
        // unknown: proceed with the same key; replay is safe because the provider never re-charges a repeated reference.
        if (st.state === 'failed') keyStatus = 'failed'
    }

    // Legacy Hubtel double-send guard. With unique-per-attempt references we must never re-send a top-up that already
    // delivered, and never resend while a previous attempt is still in-flight (unconfirmed) at Hubtel.
    if (order.fulfillment_service !== 'kingflexy-commission' && order.fulfillment_metadata?.client_reference) {
        const prior = await priorAttemptVerdict(order.fulfillment_metadata)
        if (prior.delivered) {
            // .select('id') for the same reason as dispatchAirtimeFulfillment's prior-delivered
            // branch: this runs before the force-claim below, so a concurrent admin refulfill and
            // reconcile cron could otherwise both fire order.completed for one transition.
            const { data: settled } = await (supabase.from('airtime_orders') as any).update({
                status: 'completed',
                fulfilled_at: new Date().toISOString(),
                fulfillment_metadata: { ...order.fulfillment_metadata, status_check: { verdict: 'success', at: new Date().toISOString() } },
                updated_at: new Date().toISOString(),
            }).eq('id', orderId).in('status', ['pending', 'failed', 'processing']).select('id')
            await syncAirtimeShopMirror(supabase, order.reference_code, 'completed')
            if (settled && settled.length > 0 && order.api_key_id) {
                const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                waitUntil(dispatchApiWebhook(supabase, {
                    apiKeyId: order.api_key_id, event: 'order.completed', product: 'airtime',
                    reference: order.reference_code.replace(/^API-/, ''), status: 'completed',
                    detail: { network: order.network, airtime_amount: Number(order.airtime_amount) },
                }))
            }
            return { ok: true, status: 'completed', message: 'A previous attempt already delivered — marked completed (not resending).', commission: order.fulfillment_metadata.commission }
        }
        if (order.status === 'processing' && prior.verdict !== 'failed') {
            return { ok: false, status: 'processing', message: 'Previous attempt is still in-flight/unconfirmed at Hubtel. Use "Sync" to confirm — only resend once it shows failed.' }
        }
        if (order.status === 'pending' && prior.verdict !== 'failed') {
            return { ok: false, status: order.status, message: 'Legacy Hubtel attempt cannot be verified (no Hubtel credentials) — confirm the top-up was not delivered, then mark it failed and refulfill' }
        }
    }

    const attempt = (order.airtime_fulfillment_attempts || 0) + 1
    const { key: clientRef, generation } = kfKeyForOrder({ ...order, status: keyStatus }, { bumpAfterFailure: true })
    // Force-claim from pending/failed/processing (manual override of the auto kill-switch + status).
    // The in-flight key is persisted in the claim itself so the reconcile cron never status-checks a
    // stale key if this process dies mid-POST.
    const { data: claimed } = await (supabase.from('airtime_orders') as any)
        .update({
            status: 'processing',
            fulfillment_service: 'kingflexy-commission',
            airtime_fulfillment_attempts: attempt,
            fulfillment_metadata: { ...(order.fulfillment_metadata || {}), client_reference: clientRef, kf_generation: generation },
            updated_at: new Date().toISOString(),
        })
        .eq('id', orderId).in('status', ['pending', 'failed', 'processing']).select('id')
    if (!claimed || claimed.length === 0) return { ok: false, status: order.status, message: 'Order is not in a refulfillable state' }

    const result = await fulfillAirtimeKingFlexy(
        order.network, order.beneficiary_phone, Number(order.airtime_amount), clientRef,
    )

    if (result.success) {
        // Guarded on status='processing': a webhook may have finalized the order while the POST was in flight.
        const { data: written } = await (supabase.from('airtime_orders') as any).update({
            fulfillment_request_id: result.transactionId || null,
            fulfillment_metadata: {
                supplier: 'kingflexy-commission',
                client_reference: clientRef,
                kf_generation: generation,
                attempt,
                manual: true,
                api_response: result.apiResponse,
            },
            ...(result.pending ? {} : {
                status: 'completed',
                fulfilled_at: new Date().toISOString(),
            }),
            updated_at: new Date().toISOString(),
        }).eq('id', orderId).eq('status', 'processing').select('id')
        if (!written || written.length === 0) {
            return { ok: false, status: 'processing', message: 'Order was finalized by the provider while sending — refresh to see its status' }
        }
        if (!result.pending) await syncAirtimeShopMirror(supabase, order.reference_code, 'completed')
        // Fire-safe: credit_airtime_commission is idempotent (atomic claim keyed on
        // commission_credited_at IS NULL) and no-ops instantly for non-'api' sources,
        // so calling it unconditionally here is always safe for shop/web-sourced rows.
        if (!result.pending) {
            try {
                const { error: creditError } = await (supabase as any).rpc('credit_airtime_commission', { p_airtime_order_id: orderId })
                if (creditError) console.error('[AirtimeFulfillment] credit_airtime_commission failed:', creditError.message, 'order:', orderId)
            } catch (e) { console.error('[AirtimeFulfillment] credit_airtime_commission failed:', e) }
        }
        // Gated on !result.pending for the same reason the status write above is:
        // a still-pending dispatch has NOT completed, so firing a completed
        // webhook here would tell the developer the order landed when it hasn't.
        if (!result.pending) {
            if (order.api_key_id) {
                const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                waitUntil(dispatchApiWebhook(supabase, {
                    apiKeyId: order.api_key_id, event: 'order.completed', product: 'airtime',
                    reference: order.reference_code.replace(/^API-/, ''), status: 'completed',
                    detail: { network: order.network, airtime_amount: Number(order.airtime_amount) },
                }))
            }
        }
        return {
            ok: true,
            status: result.pending ? 'processing' : 'completed',
            message: result.pending ? 'Dispatched to KingFlexyGH — awaiting final confirmation' : 'Completed',
        }
    }

    // Failure — NO refund. Revert to a retryable state (do not auto-pause on a manual action).
    const { data: failWritten } = await (supabase.from('airtime_orders') as any).update({
        status: result.isPermanentFailure ? 'failed' : 'pending',
        fulfillment_metadata: {
            supplier: 'kingflexy-commission',
            client_reference: clientRef,
            kf_generation: generation,
            attempt,
            manual: true,
            error: result.error,
            api_response: result.apiResponse,
        },
        updated_at: new Date().toISOString(),
    }).eq('id', orderId).eq('status', 'processing').select('id')
    if (!failWritten || failWritten.length === 0) {
        return { ok: false, status: 'processing', message: 'Order was finalized by the provider while sending — refresh to see its status' }
    }
    if (result.isPermanentFailure) await syncAirtimeShopMirror(supabase, order.reference_code, 'failed')
    // Only a PERMANENT failure is terminal — a transient one reverts to 'pending'
    // for retry, and firing order.failed there would be a false alarm.
    if (result.isPermanentFailure) {
        const { code: reasonCode, message: reasonMessage } = categorizeFailure('permanent_failure')
        const refund = await autoRefundApiOrderOnFailure(supabase, {
            product: 'airtime', orderId, source: order.source, reasonCode, reasonMessage,
        })
        if (order.api_key_id) {
            const { dispatchApiWebhook } = await import('@/lib/api-webhook')
            waitUntil(dispatchApiWebhook(supabase, {
                apiKeyId: order.api_key_id, event: 'order.failed', product: 'airtime',
                reference: order.reference_code.replace(/^API-/, ''), status: refund.refunded ? 'refunded' : 'failed',
                detail: {
                    network: order.network, airtime_amount: Number(order.airtime_amount),
                    reason_code: reasonCode, reason: reasonMessage,
                    ...(refund.refunded ? { refunded: true, refund_amount: refund.amount, new_balance: refund.newBalance } : {}),
                },
            }))
        }
    }
    return {
        ok: false,
        status: result.isPermanentFailure ? 'failed' : 'pending',
        message: result.error || 'KingFlexyGH rejected the request',
    }
}

/**
 * MANUAL admin status sync — query the provider (KingFlexyGH, or Hubtel's Transaction Status Check for
 * legacy rows) for an order and apply the
 * verdict. Records the raw result to fulfillment_metadata.status_check every time. Completes the
 * order on a confirmed delivery (isFulfilled), marks failed on a confirmed failure, else leaves it.
 */
export async function manualStatusSyncAirtime(
    orderId: string,
): Promise<{ ok: boolean; status: string; verdict: string; message: string }> {
    const supabase = createServerClient()
    const { data: order } = await (supabase.from('airtime_orders') as any)
        .select('id, status, reference_code, fulfillment_metadata, api_key_id, source, fulfillment_service, network, airtime_amount, user_id')
        .eq('id', orderId).single()
    if (!order) return { ok: false, status: 'not_found', verdict: 'unknown', message: 'Order not found' }
    if (order.status === 'completed') return { ok: true, status: 'completed', verdict: 'success', message: 'Already completed' }
    if (!order.reference_code) return { ok: false, status: order.status, verdict: 'unknown', message: 'Order has no reference to check' }

    if (order.fulfillment_service === 'kingflexy-commission') {
        const st = await checkAirtimeOrderStatus(String(order.fulfillment_metadata?.client_reference ?? order.reference_code))
        if (!st.configured) return { ok: false, status: order.status, verdict: 'unknown', message: 'Status check not configured (set KINGFLEXY_COMMISSION_API_KEY)' }
        if (st.state === 'completed') {
            await finalizeKfAirtime(supabase, order, { state: 'completed', raw: st.raw })
            return { ok: true, status: 'completed', verdict: 'success', message: 'Confirmed delivered — marked completed' }
        }
        if (st.state === 'failed') {
            await finalizeKfAirtime(supabase, order, { state: 'failed', reason: st.reason, raw: st.raw })
            return { ok: false, status: 'failed', verdict: 'failed', message: 'KingFlexyGH reports this transaction failed' }
        }
        const verdict = st.state === 'pending' ? 'pending' : 'unknown'
        await (supabase.from('airtime_orders') as any)
            .update({
                fulfillment_metadata: {
                    ...(order.fulfillment_metadata || {}),
                    status_check: { verdict, http_ok: st.httpOk, found: st.found, at: new Date().toISOString(), raw: st.raw },
                },
                updated_at: new Date().toISOString(),
            })
            .eq('id', orderId).neq('status', 'completed')
        return { ok: false, status: order.status, verdict, message: st.found ? 'Still pending at KingFlexyGH' : 'No record found at KingFlexyGH yet' }
    }

    const result = await checkCommissionStatus(order.fulfillment_metadata?.client_reference || order.reference_code)
    if (!result.configured) return { ok: false, status: order.status, verdict: 'unknown', message: 'Status check not configured (set HUBTEL_COLLECTION_ACCOUNT)' }

    const meta = {
        ...(order.fulfillment_metadata || {}),
        status_check: { verdict: result.verdict, http_ok: result.httpOk, found: result.found, at: new Date().toISOString(), raw: result.raw },
    }

    if (result.verdict === 'success') {
        // Capture commission if the status-check response happens to carry one. NOTE: Hubtel's
        // Transaction Status Check (api-txnstatus) returns { responseCode, data: { status, isFulfilled, ... } }
        // and does NOT include a Meta/Commission field — commission is only delivered on the async
        // fulfillment callback (Data.Meta.Commission). We probe the plausible paths defensively in case a
        // variant of the response does carry it; if none is present we preserve any existing meta.commission
        // (never overwrite a real value with undefined).
        if (parseCommission((order.fulfillment_metadata || {})) === undefined) {
            const raw: any = result.raw
            const fromStatus = parseCommission(raw?.data?.meta ?? raw?.data?.Meta ?? raw?.Data?.Meta ?? raw?.data ?? raw?.Data)
            if (fromStatus !== undefined) meta.commission = fromStatus
        }
        // .select('id') so the webhook only fires on a real →completed transition. The early
        // return above only covers status === 'completed', so an order sitting at 'failed'
        // reaches here, the .in() filter matches zero rows and the row STAYS 'failed' — without
        // this guard we would tell the developer 'order.completed' about a row their own
        // GET /airtime/orders/:reference reports as failed. Mirrors manualStatusSyncUtility.
        const { data: updated } = await (supabase.from('airtime_orders') as any)
            .update({
                status: 'completed',
                fulfilled_at: new Date().toISOString(),
                fulfillment_metadata: meta,
                ...(meta.commission !== undefined ? { commission_amount: meta.commission } : {}),
                updated_at: new Date().toISOString(),
            })
            .eq('id', orderId).in('status', ['processing', 'pending']).select('id')
        await syncAirtimeShopMirror(supabase, order.reference_code, 'completed')
        try {
            const { error: creditError } = await (supabase as any).rpc('credit_airtime_commission', { p_airtime_order_id: orderId })
            if (creditError) console.error('[AirtimeFulfillment] credit_airtime_commission failed:', creditError.message, 'order:', orderId)
        } catch (e) { console.error('[AirtimeFulfillment] credit_airtime_commission failed:', e) }
        // detail omitted deliberately: this function's select does not carry
        // network/airtime_amount, and widening it purely to decorate a webhook
        // payload would add a money-path query cost for no functional gain.
        if (updated && updated.length > 0 && order.api_key_id) {
            const { dispatchApiWebhook } = await import('@/lib/api-webhook')
            waitUntil(dispatchApiWebhook(supabase, {
                apiKeyId: order.api_key_id, event: 'order.completed', product: 'airtime',
                reference: order.reference_code.replace(/^API-/, ''), status: 'completed',
            }))
        }
        return { ok: true, status: 'completed', verdict: 'success', message: 'Confirmed delivered — marked completed' }
    }
    if (result.verdict === 'failed') {
        // .select('id') so a repeat sync against a row already 'failed' does not re-fire
        // order.failed every single time — the .in() filter excludes it, so `updated` is empty.
        const { data: updated } = await (supabase.from('airtime_orders') as any)
            .update({ status: 'failed', fulfillment_metadata: meta, updated_at: new Date().toISOString() })
            .eq('id', orderId).in('status', ['processing', 'pending']).select('id')
        await syncAirtimeShopMirror(supabase, order.reference_code, 'failed')
        if (updated && updated.length > 0) {
            const { code: reasonCode, message: reasonMessage } = categorizeFailure('status_check_failed')
            const refund = await autoRefundApiOrderOnFailure(supabase, {
                product: 'airtime', orderId, source: order.source, reasonCode, reasonMessage,
            })
            if (order.api_key_id) {
                const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                waitUntil(dispatchApiWebhook(supabase, {
                    apiKeyId: order.api_key_id, event: 'order.failed', product: 'airtime',
                    reference: order.reference_code.replace(/^API-/, ''), status: refund.refunded ? 'refunded' : 'failed',
                    detail: {
                        reason_code: reasonCode, reason: reasonMessage,
                        ...(refund.refunded ? { refunded: true, refund_amount: refund.amount, new_balance: refund.newBalance } : {}),
                    },
                }))
            }
        }
        return { ok: false, status: 'failed', verdict: 'failed', message: 'Hubtel reports this transaction failed' }
    }
    // pending / unknown — record only, don't change order state (and never clobber a row that
    // raced to 'completed' between our read and this write — that would wipe its commission).
    await (supabase.from('airtime_orders') as any)
        .update({ fulfillment_metadata: meta, updated_at: new Date().toISOString() })
        .eq('id', orderId).neq('status', 'completed')
    return { ok: false, status: order.status, verdict: result.verdict, message: result.found ? 'Still pending at Hubtel' : 'No record found at Hubtel yet' }
}

/**
 * MANUAL admin refund of a RETAIL airtime order → credits the buyer's wallet via the idempotent
 * refund_airtime_wallet RPC (refund-once, FOR UPDATE + unique-reference guarded). Completed orders
 * are never refundable; already-refunded is a no-op. SHOP airtime orders are NOT handled here —
 * they must be refunded through the shop-order refund (owner-wallet / Paystack) which also reverses
 * the shop-profit leg; this returns a skip for them.
 */
export async function manualRefundAirtime(
    orderId: string, actorId: string, reason?: string,
): Promise<{ ok: boolean; status: string; message: string; amount?: number }> {
    const supabase = createServerClient()
    const { data, error } = await (supabase as any).rpc('refund_airtime_wallet', {
        p_order_id: orderId, p_actor_id: actorId, p_reason: reason ?? 'admin airtime refund',
    })
    if (error) return { ok: false, status: 'error', message: error.message }
    if (data?.already_refunded) return { ok: true, status: 'refunded', message: 'Already refunded' }
    if (data?.ok) return { ok: true, status: 'refunded', message: 'Refunded to wallet', amount: data?.amount }
    if (data?.error === 'not_retail_airtime') {
        return { ok: false, status: 'skipped', message: 'Shop airtime — refund via the shop order (owner wallet / Paystack)' }
    }
    if (data?.error === 'not_refundable') {
        return { ok: false, status: data?.status || 'skipped', message: `Not refundable (status: ${data?.status})` }
    }
    return { ok: false, status: 'error', message: data?.error || 'Refund failed' }
}

/**
 * MANUAL admin "mark completed" for a pending/processing airtime or mashup order — the shared
 * bulk-select counterpart to the single-order PATCH in app/api/admin/airtime/orders/route.ts
 * (kept in sync with it: status update, shop-mirror sync, in-app notification, completion SMS).
 * No wallet movement here — the buyer's wallet was already debited at order creation; this just
 * finalizes fulfillment state for orders completed manually (mashup) or confirmed out-of-band.
 */
export async function manualCompleteAirtime(
    orderId: string, adminUserId: string,
): Promise<{ ok: boolean; status: string; message: string }> {
    const supabase = createServerClient()
    const { data: order, error: fetchError } = await (supabase.from('airtime_orders') as any)
        .select('*').eq('id', orderId).single()
    if (fetchError || !order) return { ok: false, status: 'not_found', message: 'Order not found' }
    if (order.status === 'completed') return { ok: true, status: 'completed', message: 'Already completed' }
    if (!['pending', 'processing'].includes(order.status)) {
        return { ok: false, status: order.status, message: `Not eligible (status: ${order.status})` }
    }

    const { error: updateError } = await (supabase.from('airtime_orders') as any)
        .update({
            status: 'completed',
            fulfilled_by: adminUserId,
            fulfilled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
    if (updateError) return { ok: false, status: 'error', message: updateError.message }

    await syncAirtimeShopMirror(supabase, order.reference_code, 'completed')

    const orderTypeLabel = order.type === 'mashup' ? 'Mashup Bundle' : 'Airtime'
    ;(supabase.from('notifications') as any).insert({
        user_id: order.user_id,
        title: `${orderTypeLabel} Sent ✅`,
        message: `GHS ${order.airtime_amount.toFixed(2)} ${orderTypeLabel.toLowerCase()} for ${order.beneficiary_phone} has been sent successfully. Ref: ${order.reference_code}`,
        type: 'order_update',
        action_url: '/dashboard/airtime',
    }).then(() => {}).catch((e: any) => console.error('[AirtimeFulfillment] manualCompleteAirtime notification error:', e))

    import('@/lib/sms-service').then(async ({ sendAirtimeCompletedSMS, sendMashupCompletedSMS }) => {
        const { resolveOwnConfirmationSender } = await import('@/lib/sms-confirmation-sender')
        const smsFn = order.type === 'mashup' ? sendMashupCompletedSMS : sendAirtimeCompletedSMS
        const ownSender = await resolveOwnConfirmationSender(supabase, order.user_id).catch(() => null)
        await smsFn(order.beneficiary_phone, { amount: order.airtime_amount, sender: ownSender ?? undefined })
    }).catch((e: any) => console.error('[AirtimeFulfillment] manualCompleteAirtime SMS error:', e))

    return { ok: true, status: 'completed', message: 'Marked completed' }
}
