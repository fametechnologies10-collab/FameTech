import { createServerClient } from '@/lib/supabase'
import { purchaseBundle } from '@/lib/kingflexy-bundles-service'
import { finalizeBundle, type BundleOrderRow } from '@/lib/standard-bundles-finalize'
import {
    bundleKillSwitchKeys,
    decideAlertThrottle,
    decideDispatchAction,
    isBundleFlagEnabled,
    shouldAlertExhausted,
    type BundleKind,
} from '@/lib/standard-bundles-logic'

const LOG = '[StandardBundles]'
const MAX_ATTEMPTS = 5

async function isBundleDispatchEnabled(supabase: any, network: string, kind: BundleKind): Promise<boolean> {
    const keys = bundleKillSwitchKeys(network, kind)
    const { data } = await supabase.from('admin_settings').select('key, value').in('key', keys)
    const map: Record<string, unknown> = {}
    for (const r of data || []) map[r.key] = r.value
    return keys.every((k) => isBundleFlagEnabled(map[k]))
}

async function adminAlert(title: string, body: string) {
    try {
        const { sendAdminPushNotification } = await import('@/lib/push-service')
        await sendAdminPushNotification({ title, body, url: '/admin/standard-bundles' })
    } catch (e) {
        console.error(LOG, 'admin push failed:', e)
    }
}

function exhaustedAlertBody(reference: string, outcome: string): string {
    return `gave up after ${MAX_ATTEMPTS} attempts on order ${reference} (last outcome ${outcome}): refund or re-dispatch manually`
}

export async function markExhaustedAndAlert(supabase: any, order: any, outcome: string) {
    const { data: marked } = await supabase
        .from('standard_bundle_orders')
        .update({
            fulfillment_metadata: { ...(order.fulfillment_metadata || {}), exhausted_at: new Date().toISOString() },
        })
        .eq('id', order.id)
        .eq('status', 'pending')
        .select('id')
    if (marked && marked.length > 0) {
        await adminAlert('Standard bundle dispatch gave up', exhaustedAlertBody(order.reference_code, outcome))
    }
}

/**
 * Auto-dispatch one PENDING bundle order to KingFlexyGH. Atomic claim pending->processing, the same
 * reference_code on every attempt (KingFlexyGH replays a repeated reference instead of charging twice).
 * Never throws; a failure after the claim reverts the order to pending (guarded on 'processing').
 */
export async function dispatchBundleFulfillment(orderId: string): Promise<void> {
    let supabase: any
    let claimed = false
    try {
        supabase = createServerClient()
        const { data: order } = await supabase
            .from('standard_bundle_orders')
            .select('id, reference_code, user_id, network, kind, catalog_value, pack_id, catalog_price, bundle_label, beneficiary_phone, total_paid, status, fulfillment_attempts, fulfillment_metadata')
            .eq('id', orderId)
            .maybeSingle()
        if (!order || order.status !== 'pending') return

        // Retries exhausted: alert once (exhausted_at marks it). No auto-refund - an earlier attempt may have delivered.
        if ((order.fulfillment_attempts || 0) >= MAX_ATTEMPTS) {
            if (shouldAlertExhausted(order.fulfillment_attempts || 0, MAX_ATTEMPTS, order.fulfillment_metadata)) {
                await markExhaustedAndAlert(supabase, order, 'unknown')
            }
            return
        }

        if (!(await isBundleDispatchEnabled(supabase, order.network, order.kind))) return // off -> stays pending

        const attempt = (order.fulfillment_attempts || 0) + 1

        // Atomic claim: only the worker that flips pending->processing proceeds.
        const { data: claimedRows } = await supabase
            .from('standard_bundle_orders')
            .update({ status: 'processing', fulfillment_attempts: attempt, updated_at: new Date().toISOString() })
            .eq('id', orderId)
            .eq('status', 'pending')
            .eq('fulfillment_attempts', order.fulfillment_attempts || 0)
            .select('id')
        if (!claimedRows || claimedRows.length === 0) return
        claimed = true

        const result = await purchaseBundle({
            kind: order.kind,
            network: order.network,
            phone: order.beneficiary_phone,
            reference: order.reference_code,
            value: order.catalog_value ?? undefined,
            amount: Number(order.catalog_price),
            packId: order.pack_id ?? undefined,
        })

        const action = decideDispatchAction(result.outcome)
        const now = new Date().toISOString()
        const baseMeta: Record<string, unknown> = {
            ...(order.fulfillment_metadata || {}),
            last_dispatch: { outcome: result.outcome, attempt, at: now },
        }
        const row = order as BundleOrderRow

        if (action === 'accepted') {
            claimed = false
            await supabase
                .from('standard_bundle_orders')
                .update({
                    ...(result.kfOrderRef ? { kf_order_ref: result.kfOrderRef } : {}),
                    fulfillment_metadata: baseMeta,
                    updated_at: now,
                })
                .eq('id', orderId)
                .eq('status', 'processing')
            if (result.status === 'completed' || result.status === 'failed') {
                await finalizeBundle(supabase, { ...row, fulfillment_metadata: baseMeta }, {
                    state: result.status,
                    raw: result.raw,
                })
            }
            return
        }

        if (action === 'finalize_failed') {
            claimed = false
            await finalizeBundle(supabase, { ...row, fulfillment_metadata: baseMeta }, {
                state: 'failed',
                reason: result.error || 'KingFlexyGH rejected the purchase',
                raw: result.raw,
            })
            return
        }

        if (action === 'stay_processing') {
            claimed = false
            await supabase
                .from('standard_bundle_orders')
                .update({ fulfillment_metadata: baseMeta, updated_at: now })
                .eq('id', orderId)
                .eq('status', 'processing')
            return
        }

        // revert_pending: retriable condition. The same reference is reused on the next attempt.
        const exhausted = attempt >= MAX_ATTEMPTS
        const throttle = decideAlertThrottle(baseMeta, result.outcome, Date.now())
        const nextMeta = exhausted ? { ...throttle.meta, exhausted_at: new Date().toISOString() } : throttle.meta
        const { data: reverted } = await supabase
            .from('standard_bundle_orders')
            .update({ status: 'pending', fulfillment_metadata: nextMeta, updated_at: new Date().toISOString() })
            .eq('id', orderId)
            .eq('status', 'processing')
            .select('id')
        claimed = false
        if (reverted && reverted.length > 0 && exhausted) {
            await adminAlert('Standard bundle dispatch gave up', exhaustedAlertBody(order.reference_code, result.outcome))
        } else if (reverted && reverted.length > 0 && throttle.send) {
            await adminAlert(
                'Standard bundle dispatch delayed',
                `Order ${order.reference_code} could not be sent (${result.outcome}). It will be retried automatically.`,
            )
        }
    } catch (e) {
        console.error(LOG, 'dispatchBundleFulfillment failed:', e instanceof Error ? e.message : e, 'order:', orderId)
        if (claimed && supabase) {
            try {
                await supabase
                    .from('standard_bundle_orders')
                    .update({ status: 'pending', updated_at: new Date().toISOString() })
                    .eq('id', orderId)
                    .eq('status', 'processing')
            } catch (e2) {
                console.error(LOG, 'revert to pending failed:', e2, 'order:', orderId)
            }
        }
    }
}
