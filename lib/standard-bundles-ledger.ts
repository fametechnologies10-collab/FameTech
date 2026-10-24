// lib/standard-bundles-ledger.ts
//
// Records the wallet_transactions DEBIT row for a Standard Bundles order. Same retry-once /
// never-throw semantics as lib/airtime-ledger.ts (supabase-js resolves with `{ error }` rather than
// rejecting, so the result must be checked explicitly).

export interface BundleLedgerRow {
    wallet_id: string
    user_id: string
    amount: number
    description: string
    reference: string
}

export async function recordBundleDebitLedger(supabase: any, row: BundleLedgerRow): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const { error } = await (supabase.from('wallet_transactions') as any).insert({
                wallet_id: row.wallet_id,
                user_id: row.user_id,
                type: 'debit',
                amount: row.amount,
                description: row.description,
                reference: row.reference,
                source: 'standard_bundles',
                status: 'completed',
            })
            if (!error) return true
            if (error.code === '23505') return true // already recorded: a retry of the same debit
            console.error(`[BundleLedger] insert failed (attempt ${attempt}) for ${row.reference}:`, error.message)
        } catch (e) {
            console.error(`[BundleLedger] insert threw (attempt ${attempt}) for ${row.reference}:`, e)
        }
    }
    console.error(`[BundleLedger] CRITICAL: wallet was debited GHS ${row.amount} for ${row.reference} but no ledger row was written; reconcile manually.`)
    return false
}
