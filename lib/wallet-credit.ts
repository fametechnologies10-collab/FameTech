export type CreditRpcResult = {
    success: boolean
    already_processed?: boolean
    error?: string
    user_id?: string
    amount?: number | string
    new_balance?: number | string
    reference?: string
} | null

export interface WalletCreditOutcome {
    success: boolean
    alreadyProcessed?: boolean
    error?: string
    transient?: boolean
    userId?: string
    amount?: number
    newBalance?: number
}

/**
 * Maps the raw result of the wallet-credit RPC into a stable outcome.
 * `transient: true` means the failure may succeed on retry (callers should
 * not treat the payment as permanently failed).
 */
export function mapCreditResult(r: CreditRpcResult): WalletCreditOutcome {
    if (!r) {
        return { success: false, transient: true, error: 'Failed to credit wallet' }
    }
    if (r.success) {
        if (r.already_processed) {
            return { success: true, alreadyProcessed: true }
        }
        return {
            success: true,
            userId: r.user_id,
            amount: r.amount !== undefined ? parseFloat(String(r.amount)) : undefined,
            newBalance: r.new_balance !== undefined ? parseFloat(String(r.new_balance)) : undefined,
        }
    }
    switch (r.error) {
        case 'amount_mismatch':
            return { success: false, error: 'Amount mismatch' }
        case 'amount_unverified':
        case 'wallet_not_found':
            return { success: false, transient: true, error: r.error }
        case 'not_found':
            return { success: false, error: 'Payment not found' }
        case 'not_pending':
            return { success: true, alreadyProcessed: true }
        default:
            return { success: false, transient: true, error: r.error || 'Failed to credit wallet' }
    }
}
