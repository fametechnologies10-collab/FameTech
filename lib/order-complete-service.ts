// lib/order-complete-service.ts
// Self-service "Confirm Received" — flips a stuck `processing` order to
// `completed` when the buyer (or the shop owner acting for their customer)
// confirms delivery. No wallet movement. The RPC (claim_self_order_complete,
// see supabase/migrations/20260823b_self_order_complete.sql) is the sole
// authority for ownership + eligibility — this function only shapes its
// result into friendly outcomes/messages for the route layer.

export type ConfirmReceivedOutcome =
    | 'order_not_found'
    | 'not_owner'
    | 'not_eligible'
    | 'already_completed'
    | 'ok'
    | 'error'

export interface ConfirmReceivedResult {
    ok: boolean
    outcome: ConfirmReceivedOutcome
    role?: 'customer' | 'shop_owner'
    currentStatus?: string
    message: string
}

export async function confirmOrderReceived(
    admin: any,
    params: { orderId: string; actorId: string }
): Promise<ConfirmReceivedResult> {
    const { orderId, actorId } = params

    const { data, error } = await admin.rpc('claim_self_order_complete', {
        p_order_id: orderId,
        p_actor_id: actorId,
    })

    if (error) {
        console.error('[ConfirmReceived] RPC error:', error.message)
        return { ok: false, outcome: 'error', message: 'Failed to confirm order received' }
    }

    const result = data as any

    if (result?.already_completed) {
        return { ok: true, outcome: 'already_completed', message: 'This order was already marked complete' }
    }

    if (!result?.ok) {
        const err = (result?.error as ConfirmReceivedOutcome) || 'error'
        const messages: Partial<Record<ConfirmReceivedOutcome, string>> = {
            order_not_found: 'Order not found',
            not_owner: 'You are not authorized to confirm this order',
            not_eligible: result?.status
                ? `This order is currently "${result.status}" and can't be confirmed received — only in-progress orders are eligible`
                : 'This order is not eligible to be marked complete',
        }
        return {
            ok: false,
            outcome: err,
            currentStatus: result?.status,
            message: messages[err] || 'Could not confirm order received',
        }
    }

    return { ok: true, outcome: 'ok', role: result.role, message: 'Order marked as completed' }
}
