import type { SupabaseClient } from '@supabase/supabase-js'
import { sendAdminPushNotification } from '@/lib/push-service'

// =============================================================================
// USSD Wallet Payment — atomically deducts wallet balance and records a
// debit transaction via the idempotent process_ussd_wallet_payment RPC.
// Used when a USSD session pays via wallet instead of MoMo.
// =============================================================================

export async function processWalletPayment(params: {
    supabaseAdmin: SupabaseClient
    userId: string
    walletId: string
    amount: number
    description: string
    reference: string
}): Promise<{ success: boolean; newBalance?: number; error?: string }> {
    const { data, error } = await params.supabaseAdmin
        .rpc('process_ussd_wallet_payment', {
            p_user_id: params.userId,
            p_amount: params.amount,
            p_description: params.description,
            p_reference: params.reference,
        })
        .single()

    if (error) {
        if (error.message.includes('INSUFFICIENT_BALANCE')) {
            return { success: false, error: 'INSUFFICIENT_BALANCE' }
        }
        return { success: false, error: error.message }
    }

    const result = data as { wallet_id: string; new_balance: number; already_processed: boolean }
    return { success: true, newBalance: result.new_balance }
}

// =============================================================================
// USSD Fulfillment Failure Alert — when a post-payment fulfillment step fails
// for a wallet-paid order, notify admins so they can manually refund the customer.
// No automatic wallet credit is issued; refunds are handled by admin.
// =============================================================================

export async function notifyAdminManualRefundNeeded(params: {
    userId: string
    amount: number
    description: string
    reference: string
    failureContext: string
}): Promise<void> {
    await sendAdminPushNotification({
        title: 'Manual Refund Required — USSD Wallet Order Failed',
        body: `Order "${params.description}" (ref: ${params.reference}) failed after wallet debit of GHS ${params.amount.toFixed(2)}. Customer ${params.userId} needs a manual refund. Reason: ${params.failureContext}`,
    })
}

// =============================================================================
// P0-3 / HIGH-4: durable wallet-failure tracking. The queue row is written the
// INSTANT money leaves the wallet (status 'awaiting_fulfillment', hidden from the
// admin refund queue) so a dropped waitUntil can never lose a debited order.
// Fulfillment success deletes it; failure promotes it to 'pending' (team refund).
// A stuck 'awaiting_fulfillment' row is caught by reconciliation, never auto-acted.
// =============================================================================
export async function recordWalletAwaitingFulfillment(params: {
    supabaseAdmin: SupabaseClient
    sessionId: string
    userId: string
    mobile: string
    serviceType: 'data' | 'results_checker' | 'afa' | 'airtime' | 'utility' | 'mashup'
    amount: number
    walletDebitReference: string
}): Promise<void> {
    const { error } = await (params.supabaseAdmin.from('ussd_refund_queue') as any).upsert(
        {
            session_id:             params.sessionId,
            user_id:                params.userId,
            mobile:                 params.mobile,
            service_type:           params.serviceType,
            amount:                 params.amount,
            payment_method:         'wallet',
            wallet_debit_reference: params.walletDebitReference,
            reason:                 'awaiting fulfillment',
            status:                 'awaiting_fulfillment',
        },
        { onConflict: 'session_id,payment_method' },
    )
    if (error) {
        // This row is the ONLY durable record that wallet money just left the
        // customer — if the write fails and the background fulfillment promise
        // is dropped, the debit becomes untraceable. Escalate immediately.
        console.error(`[USSD Wallet] awaiting-fulfillment tracking write FAILED for ${params.sessionId}:`, error.message)
        await sendAdminPushNotification({
            title: 'USSD wallet-debit tracking write FAILED',
            body: `Could not record awaiting-fulfillment row for session ${params.sessionId} (GHS ${params.amount.toFixed(2)}, ${params.mobile}). If fulfillment fails, this debit has NO refund record: ${error.message}`,
        }).catch(() => {})
    }
}

/** Fulfillment succeeded — the debit was legitimate; remove the tracking row. */
export async function clearWalletRefund(supabaseAdmin: SupabaseClient, sessionId: string): Promise<void> {
    await (supabaseAdmin.from('ussd_refund_queue') as any)
        .delete()
        .eq('session_id', sessionId)
        .eq('payment_method', 'wallet')
        .eq('status', 'awaiting_fulfillment')
}

/** Fulfillment failed — promote the tracking row to a pending refund + alert the team. */
export async function markWalletRefundFailed(params: {
    supabaseAdmin: SupabaseClient
    sessionId: string
    mobile: string
    serviceType: string
    amount: number
    reason: string
}): Promise<void> {
    await (params.supabaseAdmin.from('ussd_refund_queue') as any)
        .update({ status: 'pending', reason: params.reason })
        .eq('session_id', params.sessionId)
        .eq('payment_method', 'wallet')
    await sendAdminPushNotification({
        title: 'USSD wallet order failed — refund needed',
        body: `${params.serviceType} GHS ${params.amount.toFixed(2)} for ${params.mobile} failed after wallet debit. One-click refund in the admin queue. Session ${params.sessionId}.`,
    }).catch(() => {})
}
