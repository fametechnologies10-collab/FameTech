import { BUNDLE_FAILURE_CUSTOMER_MESSAGE, decideAlertThrottle } from '@/lib/standard-bundles-logic'

// Shared completed/failed finalize for Standard Bundle orders (dispatch response, webhook and reconcile
// all funnel here). Every side effect runs only when the guarded status update matched a row, and every
// side-effect module is dynamically imported inside that branch, so a duplicate/late signal is a no-op.
// A late "completed" on an already failed/refunded order NEVER reverses the refund — it alerts an admin.

export interface BundleOrderRow {
    id: string
    reference_code: string
    user_id: string | null
    network: string
    kind: string
    bundle_label: string | null
    beneficiary_phone: string
    total_paid: number | string
    status?: string
    fulfillment_metadata: Record<string, any> | null
}

export interface BundleFinalizeOutcome {
    state: 'completed' | 'failed'
    reason?: string
    commission?: number | null
    raw?: unknown
    previouslyRefunded?: boolean
}

const LOG = '[StandardBundles]'
const ADMIN_URL = '/admin/standard-bundles'

async function adminAlert(title: string, body: string) {
    try {
        const { sendAdminPushNotification } = await import('@/lib/push-service')
        await sendAdminPushNotification({ title, body, url: ADMIN_URL })
    } catch (e) {
        console.error(LOG, 'admin push failed:', e)
    }
}

async function notifyUser(supabase: any, userId: string | null, title: string, message: string) {
    if (!userId) return
    try {
        await (supabase.from('notifications') as any).insert({
            user_id: userId,
            title,
            message,
            type: 'order_update',
            action_url: '/dashboard/standard-bundles',
        })
    } catch {
        /* best-effort */
    }
}

// The RPC locks the row and is idempotent: a repeat call cannot credit twice.
async function tryRefund(supabase: any, orderId: string): Promise<boolean> {
    try {
        const { data: refund, error } = await supabase.rpc('refund_standard_bundle_wallet', {
            p_order_id: orderId,
            p_actor_id: null,
        })
        if (error) {
            console.error(LOG, 'CRITICAL refund_standard_bundle_wallet failed:', error.message, 'order:', orderId)
            return false
        }
        if (refund?.refunded !== true) {
            console.error(LOG, 'CRITICAL refund RPC returned refunded:false for order:', orderId)
            return false
        }
        return true
    } catch (e) {
        console.error(LOG, 'CRITICAL refund_standard_bundle_wallet threw:', e, 'order:', orderId)
        return false
    }
}

export async function finalizeBundle(
    supabase: any,
    order: BundleOrderRow,
    outcome: BundleFinalizeOutcome,
): Promise<{ transitioned: boolean }> {
    const ref = order.reference_code
    const now = new Date().toISOString()
    const kf_event = {
        state: outcome.state,
        reason: outcome.reason ?? null,
        raw: outcome.raw ?? null,
        previously_refunded: outcome.previouslyRefunded === true,
        at: now,
    }
    const meta = { ...(order.fulfillment_metadata || {}), kf_event }

    if (outcome.state === 'completed') {
        const hasCommission = typeof outcome.commission === 'number' && Number.isFinite(outcome.commission)
        const { data: updated } = await (supabase.from('standard_bundle_orders') as any)
            .update({
                status: 'completed',
                ...(hasCommission ? { commission_amount: outcome.commission } : {}),
                completed_at: now,
                fulfillment_metadata: meta,
                updated_at: now,
            })
            .eq('id', order.id)
            .in('status', ['processing', 'pending'])
            .select('id')

        if (!updated || updated.length === 0) {
            const { data: fresh } = await (supabase.from('standard_bundle_orders') as any)
                .select('status')
                .eq('id', order.id)
                .maybeSingle()
            if (fresh?.status === 'refunded' || fresh?.status === 'failed') {
                await adminAlert(
                    `KingFlexyGH reported success on an already-${fresh.status} bundle order`,
                    `Bundle order ${ref} is marked ${fresh.status} but KingFlexyGH now reports delivery. Do NOT reverse the refund; reconcile manually.`,
                )
            }
            return { transitioned: false }
        }

        await notifyUser(
            supabase,
            order.user_id,
            'Bundle Delivered',
            `Your ${order.bundle_label || 'data'} bundle order ${ref} has been delivered.`,
        )
        return { transitioned: true }
    }

    const { data: updated } = await (supabase.from('standard_bundle_orders') as any)
        .update({ status: 'failed', fulfillment_metadata: meta, updated_at: now })
        .eq('id', order.id)
        .in('status', ['processing', 'pending'])
        .select('id')
    if (!updated || updated.length === 0) {
        // Order may already be 'failed' with its refund still outstanding (an earlier refund attempt
        // errored). Retry the idempotent RPC; any other status is a settled duplicate signal.
        const { data: fresh } = await (supabase.from('standard_bundle_orders') as any)
            .select('status, fulfillment_metadata')
            .eq('id', order.id)
            .maybeSingle()
        if (fresh?.status !== 'failed') return { transitioned: false }

        if (await tryRefund(supabase, order.id)) {
            await notifyUser(supabase, order.user_id, 'Bundle Not Delivered', BUNDLE_FAILURE_CUSTOMER_MESSAGE)
            await adminAlert('Standard bundle refunded on retry', `Order ${ref} was refunded on retry after an earlier refund failure.`)
            return { transitioned: true }
        }
        const throttle = decideAlertThrottle(fresh.fulfillment_metadata, 'refund_retry_failed', Date.now())
        if (throttle.send) {
            await (supabase.from('standard_bundle_orders') as any)
                .update({ fulfillment_metadata: throttle.meta })
                .eq('id', order.id)
                .eq('status', 'failed')
            await adminAlert(
                'Standard bundle failed - REFUND STILL NOT APPLIED',
                `Order ${ref} is failed and the wallet refund retry also failed. Refund it manually.`,
            )
        }
        return { transitioned: false }
    }

    const refunded = await tryRefund(supabase, order.id)

    if (refunded) {
        await notifyUser(supabase, order.user_id, 'Bundle Not Delivered', BUNDLE_FAILURE_CUSTOMER_MESSAGE)
        await adminAlert(
            'Standard bundle failed',
            `Order ${ref} did not deliver: ${outcome.reason || 'KingFlexyGH reported failure'}. Customer refunded.`,
        )
    } else {
        await adminAlert(
            'Standard bundle failed - REFUND NOT APPLIED',
            `Order ${ref} failed (${outcome.reason || 'KingFlexyGH reported failure'}) but the wallet refund did not complete. Order left as failed - refund it manually.`,
        )
    }
    return { transitioned: true }
}
