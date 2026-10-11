import { waitUntil } from '@vercel/functions'

// Shared completed/failed finalize for KingFlexyGH orders (send response, webhook and reconcile all
// funnel here). Every side effect runs only when the guarded status update matched a row, and every
// side-effect module is dynamically imported inside that branch, so a duplicate/late signal is a no-op.

type Outcome = { state: 'completed' | 'failed'; reason?: string; raw?: unknown }

const LOG = '[KingFlexyFinalize]'

function kfEvent(state: string, outcome: { reason?: string; raw?: unknown }) {
    return { state, reason: outcome.reason ?? null, raw: outcome.raw ?? null, at: new Date().toISOString() }
}

async function adminAlert(title: string, body: string, url: string) {
    try {
        const { sendAdminPushNotification } = await import('@/lib/push-service')
        await sendAdminPushNotification({ title, body, url })
    } catch (e) { console.error(LOG, 'admin push failed:', e) }
}

async function lateSuccessAlert(supabase: any, table: 'airtime_orders' | 'utility_orders', orderId: string, ref: string) {
    const { data: freshRow } = await (supabase.from(table) as any).select('status').eq('id', orderId).maybeSingle()
    if (freshRow?.status !== 'refunded') return
    const kind = table === 'airtime_orders' ? 'airtime' : 'utility'
    await adminAlert(
        `KingFlexyGH reported success on an already-refunded ${kind} order`,
        `Order ${ref} was auto-refunded on an earlier failure signal, but KingFlexyGH now reports delivery — reconcile manually.`,
        kind === 'airtime' ? '/admin/airtime' : '/admin/utilities',
    )
}

export async function finalizeKfAirtime(
    supabase: any,
    order: {
        id: string
        reference_code: string
        network: string
        airtime_amount: number | string
        user_id: string | null
        source: string | null
        api_key_id: string | null
        fulfillment_metadata: Record<string, any> | null
    },
    outcome: Outcome,
): Promise<{ transitioned: boolean }> {
    const ref = order.reference_code
    const now = new Date().toISOString()
    const meta = { ...(order.fulfillment_metadata || {}), kf_event: kfEvent(outcome.state, outcome) }

    if (outcome.state === 'completed') {
        const { data: updated } = await (supabase.from('airtime_orders') as any)
            .update({ status: 'completed', fulfilled_at: now, fulfillment_metadata: meta, updated_at: now })
            .eq('id', order.id).in('status', ['processing', 'pending']).select('id')

        if (!updated || updated.length === 0) {
            await lateSuccessAlert(supabase, 'airtime_orders', order.id, ref)
            return { transitioned: false }
        }

        const { syncAirtimeShopMirror } = await import('@/lib/airtime-fulfillment')
        await syncAirtimeShopMirror(supabase, ref, 'completed')

        try {
            const { error } = await (supabase as any).rpc('credit_airtime_commission', { p_airtime_order_id: order.id })
            if (error) console.error(LOG, 'credit_airtime_commission failed:', error.message, 'order:', order.id)
        } catch (e) { console.error(LOG, 'credit_airtime_commission failed:', e) }

        if (order.user_id) {
            try {
                await (supabase.from('notifications') as any).insert({
                    user_id: order.user_id,
                    title: 'Airtime Delivered',
                    message: `Your airtime order ${ref} has been delivered.`,
                    type: 'order_update',
                    action_url: '/dashboard/airtime',
                })
            } catch { /* best-effort */ }
        }

        if (order.api_key_id) {
            const { dispatchApiWebhook } = await import('@/lib/api-webhook')
            waitUntil(dispatchApiWebhook(supabase, {
                apiKeyId: order.api_key_id, event: 'order.completed', product: 'airtime',
                reference: ref.replace(/^API-/, ''), status: 'completed',
                detail: { network: order.network, airtime_amount: Number(order.airtime_amount) },
            }))
        }
        return { transitioned: true }
    }

    const { data: updated } = await (supabase.from('airtime_orders') as any)
        .update({ status: 'failed', fulfillment_metadata: meta, updated_at: now })
        .eq('id', order.id).in('status', ['processing', 'pending']).select('id')
    if (!updated || updated.length === 0) return { transitioned: false }

    const { syncAirtimeShopMirror } = await import('@/lib/airtime-fulfillment')
    await syncAirtimeShopMirror(supabase, ref, 'failed')

    const { categorizeFailure, autoRefundApiOrderOnFailure } = await import('@/lib/api-order-failure')
    const { code: reasonCode, message: reasonMessage } = categorizeFailure('failed')
    const refund = await autoRefundApiOrderOnFailure(supabase, {
        product: 'airtime', orderId: order.id, source: order.source, reasonCode, reasonMessage,
    })
    if (order.api_key_id) {
        const { dispatchApiWebhook } = await import('@/lib/api-webhook')
        waitUntil(dispatchApiWebhook(supabase, {
            apiKeyId: order.api_key_id, event: 'order.failed', product: 'airtime',
            reference: ref.replace(/^API-/, ''), status: refund.refunded ? 'refunded' : 'failed',
            detail: {
                reason_code: reasonCode, reason: reasonMessage,
                ...(refund.refunded ? { refunded: true, refund_amount: refund.amount, new_balance: refund.newBalance } : {}),
            },
        }))
    }
    await adminAlert('Airtime auto-fulfillment failed', `Order ${ref} did not deliver: ${outcome.reason || 'KingFlexyGH reported failure'}.`, '/admin/airtime')
    return { transitioned: true }
}

export async function finalizeKfUtility(
    supabase: any,
    order: {
        id: string
        reference_code: string
        biller: string
        account_number: string
        amount: number | string
        user_id: string | null
        shop_id: string | null
        source: string | null
        api_key_id: string | null
        destination_phone: string | null
        fulfillment_metadata: Record<string, any> | null
    },
    outcome: Outcome & { commissionEarned?: number | null },
): Promise<{ transitioned: boolean }> {
    const ref = order.reference_code
    const now = new Date().toISOString()
    const meta = { ...(order.fulfillment_metadata || {}), kf_event: kfEvent(outcome.state, outcome) }

    if (outcome.state === 'completed') {
        const hasCommission = typeof outcome.commissionEarned === 'number' && Number.isFinite(outcome.commissionEarned)
        const { data: updated } = await (supabase.from('utility_orders') as any)
            .update({
                status: 'completed',
                ...(hasCommission ? { commission_amount: outcome.commissionEarned } : {}),
                fulfillment_metadata: meta,
                updated_at: now,
            })
            .eq('id', order.id).in('status', ['processing', 'pending']).select('id')

        if (!updated || updated.length === 0) {
            await lateSuccessAlert(supabase, 'utility_orders', order.id, ref)
            return { transitioned: false }
        }

        try {
            const { data: creditResult, error } = await (supabase as any).rpc('credit_utility_commission', { p_utility_order_id: order.id })
            if (error) console.error(LOG, 'credit_utility_commission failed:', error.message, 'order:', order.id)
            else if (creditResult?.message) console.log(LOG, 'no payout for order', order.id, '-', creditResult.message)
        } catch (e) { console.error(LOG, 'credit_utility_commission failed:', e) }

        if (order.user_id) {
            try {
                await (supabase.from('notifications') as any).insert({
                    user_id: order.user_id,
                    title: 'Bill Payment Successful',
                    message: `Your ${order.biller} payment (${ref}) has been delivered.`,
                    type: 'order_update',
                    action_url: '/dashboard/utilities',
                })
            } catch { /* best-effort */ }
        }

        const { sendUtilityCompletionSMS } = await import('@/lib/utility-completion-sms')
        sendUtilityCompletionSMS(supabase, { ...order, amount: Number(order.amount) })
            .catch((err) => console.error(LOG, 'utility completion SMS dispatch failed:', err))

        if (order.api_key_id) {
            const { dispatchApiWebhook } = await import('@/lib/api-webhook')
            waitUntil(dispatchApiWebhook(supabase, {
                apiKeyId: order.api_key_id, event: 'order.completed', product: 'utilities',
                reference: ref.replace(/^API-/, ''), status: 'completed',
                detail: { biller: order.biller, amount: Number(order.amount) },
            }))
        }
        return { transitioned: true }
    }

    const { data: updated } = await (supabase.from('utility_orders') as any)
        .update({ status: 'failed', fulfillment_metadata: meta, updated_at: now })
        .eq('id', order.id).in('status', ['processing', 'pending']).select('id')
    if (!updated || updated.length === 0) return { transitioned: false }

    const { categorizeFailure, autoRefundApiOrderOnFailure } = await import('@/lib/api-order-failure')
    const { code: reasonCode, message: reasonMessage } = categorizeFailure('failed')
    const refund = await autoRefundApiOrderOnFailure(supabase, {
        product: 'utilities', orderId: order.id, source: order.source, reasonCode, reasonMessage,
    })
    if (order.api_key_id) {
        const { dispatchApiWebhook } = await import('@/lib/api-webhook')
        waitUntil(dispatchApiWebhook(supabase, {
            apiKeyId: order.api_key_id, event: 'order.failed', product: 'utilities',
            reference: ref.replace(/^API-/, ''), status: refund.refunded ? 'refunded' : 'failed',
            detail: {
                biller: order.biller, amount: Number(order.amount),
                reason_code: reasonCode, reason: reasonMessage,
                ...(refund.refunded ? { refunded: true, refund_amount: refund.amount, new_balance: refund.newBalance } : {}),
            },
        }))
    }
    await adminAlert('Utility payment failed', `Utility ${ref} did not deliver: ${outcome.reason || 'KingFlexyGH reported failure'}.`, '/admin/utilities')
    return { transitioned: true }
}
