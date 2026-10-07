import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyTransfer } from '@/lib/paystack-transfer-service'
import { validateCronAuth } from '@/lib/cron-utils'

async function sweepTable(db: any, table: 'shop_wallet_transactions' | 'commission_wallet_transactions') {
    const results = { processed: 0, completed: 0, failed: 0, stillPending: 0, errors: 0, fetchFailed: false }

    const { data: rows, error } = await db
        .from(table)
        .select('id, paystack_transfer_reference, poll_attempts')
        .eq('status', 'paystack_pending')
        .limit(20)

    if (error) {
        console.error(`[sync-paystack-withdrawals] ${table} DB fetch error:`, error)
        results.fetchFailed = true
        return results
    }
    if (!rows?.length) return results

    console.log(`[sync-paystack-withdrawals] ${table}: checking ${rows.length} paystack_pending transactions...`)

    for (const tx of rows) {
        results.processed++
        const ref = tx.paystack_transfer_reference
        if (!ref) {
            console.warn(`[sync-paystack-withdrawals] ${table} tx ${tx.id} has no reference — skipping`)
            results.errors++
            continue
        }
        try {
            const v = await verifyTransfer(ref)
            if (!v.status) {
                await db.from(table).update({ poll_attempts: (tx.poll_attempts || 0) + 1, last_polled_at: new Date().toISOString() }).eq('id', tx.id)
                console.warn(`[sync-paystack-withdrawals] ${table} No status for tx ${tx.id}:`, v.error)
                results.errors++
                continue
            }
            if (v.status === 'success') {
                await db.from(table)
                    .update({ status: 'completed', paystack_transfer_status: 'success', paystack_fee: v.feeGhs, processed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                    .eq('id', tx.id).eq('status', 'paystack_pending')
                results.completed++
                console.log(`[sync-paystack-withdrawals] ${table} tx ${tx.id} -> completed`)
            } else if (v.status === 'failed' || v.status === 'reversed' || v.status === 'abandoned') {
                await db.from(table)
                    .update({ status: 'failed', paystack_transfer_status: v.status, failure_reason: `Paystack ${v.status}`, updated_at: new Date().toISOString() })
                    .eq('id', tx.id).eq('status', 'paystack_pending')
                results.failed++
                console.log(`[sync-paystack-withdrawals] ${table} tx ${tx.id} -> failed (${v.status})`)
            } else {
                await db.from(table).update({ poll_attempts: (tx.poll_attempts || 0) + 1, last_polled_at: new Date().toISOString() }).eq('id', tx.id)
                results.stillPending++
                console.log(`[sync-paystack-withdrawals] ${table} tx ${tx.id} still in-flight (${v.status})`)
            }
        } catch (txErr: any) {
            console.error(`[sync-paystack-withdrawals] ${table} unexpected error for tx ${tx.id}:`, txErr.message)
            results.errors++
        }
    }
    return results
}

export async function GET(req: NextRequest) {
    const authError = validateCronAuth(req)
    if (authError) return authError

    const db = createServerClient() as any
    const [shopResults, commissionResults] = await Promise.all([
        sweepTable(db, 'shop_wallet_transactions'),
        sweepTable(db, 'commission_wallet_transactions'),
    ])

    const results = { shop: shopResults, commission: commissionResults }
    console.log('[sync-paystack-withdrawals] Run complete:', results)

    if (shopResults.fetchFailed || commissionResults.fetchFailed) {
        return NextResponse.json({ success: false, error: 'DB error during sweep', results }, { status: 500 })
    }
    return NextResponse.json({ success: true, results })
}
