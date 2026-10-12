import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Safety net for the legacy Paystack-paid upgrade processors (lib/payments.ts,
 * lib/dealer-payments.ts), which only exist now to settle payments that were already in flight
 * when upgrades moved to the wallet.
 *
 * If a paid upgrade can't be applied (the user is no longer eligible, or the role write failed),
 * keeping the money without granting anything is the worst outcome. Instead the amount is credited
 * to the user's FameTech wallet through `refund_ussd_wallet` — which is idempotent per reference
 * (a unique index covers `REFUND-%` ledger rows), so webhook retries / reconciliation re-runs can
 * never refund twice.
 */
export async function refundUpgradePaymentToWallet(
    supabase: SupabaseClient,
    payment: { id: string; user_id: string; reference: string; total_amount: number | string; metadata?: any },
    reason: string
): Promise<{ success: boolean; refunded: boolean; error?: string }> {
    const amount = Number(payment.total_amount)
    if (!Number.isFinite(amount) || amount <= 0) {
        console.error(`[UpgradeRefund] ${payment.reference}: unusable amount, cannot refund`)
        return { success: false, refunded: false, error: 'Unusable payment amount' }
    }

    const { error } = await supabase.rpc('refund_ussd_wallet', {
        p_user_id: payment.user_id,
        p_amount: amount,
        p_reference: `REFUND-upgrade-${payment.reference}`,
        p_description: `Refund: membership upgrade could not be applied (${reason})`,
    })

    if (error) {
        console.error(`[UpgradeRefund] ${payment.reference}: refund RPC failed:`, error.message)
        return { success: false, refunded: false, error: 'Refund failed' }
    }

    await (supabase.from('wallet_payments') as any)
        .update({
            metadata: {
                ...(payment.metadata || {}),
                refunded_to_wallet: true,
                refund_reason: reason,
                refunded_at: new Date().toISOString(),
            },
            updated_at: new Date().toISOString(),
        })
        .eq('id', payment.id)

    await (supabase.from('notifications') as any).insert({
        user_id: payment.user_id,
        title: 'Upgrade payment refunded to wallet',
        message: `We couldn't apply your membership upgrade, so GHS ${amount.toFixed(2)} has been returned to your FameTech wallet.`,
        type: 'system',
        action_url: '/dashboard/wallet',
    })

    console.warn(`[UpgradeRefund] ${payment.reference}: GHS ${amount.toFixed(2)} refunded to wallet (${reason})`)
    return { success: true, refunded: true }
}
