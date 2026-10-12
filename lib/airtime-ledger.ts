// lib/airtime-ledger.ts
//
// Records the wallet_transactions DEBIT row for an airtime/mashup order.
//
// WHY A HELPER: the old call sites were
//     supabase.from('wallet_transactions').insert(...).then(() => {}).catch(log)
// supabase-js does NOT reject on a database error — it resolves with `{ error }` — so that
// `.catch` could never fire and every failed ledger write vanished silently. The wallet had already
// been debited, so each one was a permanent hole in the customer's statement (the
// 20260925b_backfill_missing_airtime_ledger migration exists to patch exactly that). The
// create route also did not wrap the insert in waitUntil, so a lambda freeze could drop it.

export interface AirtimeLedgerRow {
    wallet_id: string
    user_id: string
    amount: number
    description: string
    reference: string
}

/**
 * Inserts the debit row, checking the `{ error }` result and retrying once. Never throws: the
 * order already exists and the wallet is already debited, so the caller must not fail the request
 * over bookkeeping — but a persistent failure is logged loudly with the reference so it can be
 * reconciled.
 */
export async function recordAirtimeDebitLedger(supabase: any, row: AirtimeLedgerRow): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const { error } = await (supabase.from('wallet_transactions') as any).insert({
                wallet_id: row.wallet_id,
                user_id: row.user_id,
                type: 'debit',
                amount: row.amount,
                description: row.description,
                reference: row.reference,
                source: 'airtime',
                status: 'completed',
            })
            if (!error) return true
            if (error.code === '23505') return true // already recorded — a retry of the same debit
            console.error(`[AirtimeLedger] insert failed (attempt ${attempt}) for ${row.reference}:`, error.message)
        } catch (e) {
            console.error(`[AirtimeLedger] insert threw (attempt ${attempt}) for ${row.reference}:`, e)
        }
    }
    console.error(`[AirtimeLedger] CRITICAL: wallet was debited GHS ${row.amount} for ${row.reference} but no ledger row was written; reconcile manually.`)
    return false
}
