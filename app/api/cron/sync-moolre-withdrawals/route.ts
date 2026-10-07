import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkTransferStatus } from '@/lib/moolre-transfer-service'
import { validateCronAuth } from '@/lib/cron-utils'
import { sendShopWithdrawalProcessedSMS } from '@/lib/sms-service'
import { sendShopWithdrawalProcessedEmail } from '@/lib/email-service'
import { waitUntil } from '@vercel/functions'

export async function GET(req: NextRequest) {
    // 1. Secure with CRON_SECRET
    const authError = validateCronAuth(req)
    if (authError) return authError

    const db = createServerClient() as any
    const results = {
        processed: 0,
        completed: 0,
        stillPending: 0,
        errors: 0,
    }

    try {
        // 2. Fetch moolre_pending transactions — capped at 20 per run.
        // Serial Moolre API calls make this the timeout-risk job; 20 keeps it well within limits.
        const { data: pendingTxns, error: fetchError } = await db
            .from('shop_wallet_transactions')
            .select(`
                id,
                moolre_external_ref,
                net_amount,
                momo_number,
                network,
                poll_attempts,
                wallet:shop_wallets!inner(
                    owner_id
                )
            `)
            .eq('status', 'moolre_pending')
            .limit(20)

        if (fetchError) {
            console.error('[sync-moolre] Failed to fetch pending transactions:', fetchError)
            return NextResponse.json({ error: 'Database error', details: fetchError.message }, { status: 500 })
        }

        if (!pendingTxns || pendingTxns.length === 0) {
            return NextResponse.json({ message: 'No moolre_pending transactions found.', results })
        }

        console.log(`[sync-moolre] Checking ${pendingTxns.length} moolre_pending transactions...`)

        // 3. Check each pending transaction in series to avoid overwhelming Moolre API
        for (const tx of pendingTxns) {
            results.processed++

            const externalref = tx.moolre_external_ref || tx.id

            try {
                const status = await checkTransferStatus(externalref)

                if (status.txstatus === null) {
                    // Could not get a response — skip, leave as moolre_pending, try next run
                    console.warn(`[sync-moolre] Could not get status for tx ${tx.id}:`, status.error)
                    results.errors++
                    continue
                }

                if (status.txstatus === 1) {
                    // ✅ Completed — update DB and send SMS
                    // SEC-W02: guard with .eq('status', 'moolre_pending') so a concurrent
                    // manual admin pay that already completed the row can't be overwritten.
                    const { data: updatedRows, error: updateError } = await db
                        .from('shop_wallet_transactions')
                        .update({
                            status: 'completed',
                            moolre_status: 1,
                            moolre_transaction_id: status.transactionid,
                            processed_at: new Date().toISOString(),
                            updated_at: new Date().toISOString(),
                        })
                        .eq('id', tx.id)
                        .eq('status', 'moolre_pending')
                        .select()

                    if (updateError) {
                        console.error(`[sync-moolre] Failed to update tx ${tx.id} to completed:`, updateError)
                        results.errors++
                        continue
                    }

                    // 0 rows affected → already resolved by admin; skip SMS
                    if (!updatedRows || updatedRows.length === 0) {
                        console.log(`[sync-moolre] tx ${tx.id} already resolved — skipping`)
                        continue
                    }

                    results.completed++
                    console.log(`[sync-moolre] ✅ tx ${tx.id} completed. Moolre ID: ${status.transactionid}`)

                    // Fetch owner details for SMS/email — CF-10: direct import + waitUntil
                    try {
                        const { data: shopProfile } = await db
                            .from('shop_profiles')
                            .select('shop_name, owner_phone')
                            .eq('owner_id', tx.wallet.owner_id)
                            .single()

                        const { data: ownerUser } = await db
                            .from('users')
                            .select('first_name, email')
                            .eq('id', tx.wallet.owner_id)
                            .single()

                        if (shopProfile && ownerUser) {
                            waitUntil(
                                Promise.allSettled([
                                    sendShopWithdrawalProcessedSMS(
                                        shopProfile.owner_phone,
                                        ownerUser.first_name,
                                        tx.net_amount,
                                        tx.network || 'MoMo',
                                        tx.momo_number,
                                    ),
                                    sendShopWithdrawalProcessedEmail(
                                        ownerUser.email,
                                        ownerUser.first_name,
                                        shopProfile.shop_name,
                                        tx.net_amount,
                                        tx.momo_number,
                                        tx.network || 'MoMo',
                                    ),
                                ])
                            )
                        }
                    } catch (smsErr) {
                        // Non-fatal — transaction is already marked completed
                        console.warn(`[sync-moolre] Could not send SMS for tx ${tx.id}:`, smsErr)
                    }

                } else if (status.txstatus === 2) {
                    // ❌ Moolre explicitly failed — CF-01/CF-06: increment poll_attempts;
                    // after 3 attempts transition to 'failed' so admin sees it for Reject & Refund.
                    // Never auto-credit wallet.
                    const currentAttempts = (tx.poll_attempts || 0) + 1
                    if (currentAttempts >= 3) {
                        const { error: failErr } = await db
                            .from('shop_wallet_transactions')
                            .update({
                                status: 'failed',
                                failure_reason: 'Moolre txstatus=2',
                                poll_attempts: currentAttempts,
                                updated_at: new Date().toISOString(),
                            })
                            .eq('id', tx.id)
                            .eq('status', 'moolre_pending')
                        if (failErr) {
                            console.error(`[sync-moolre] Failed to mark tx ${tx.id} as failed:`, failErr)
                        } else {
                            console.error(
                                `[sync-moolre] ❌ tx ${tx.id} transitioned to failed after ${currentAttempts} txstatus=2 poll(s). Admin must Reject & Refund.`
                            )
                        }
                    } else {
                        await db
                            .from('shop_wallet_transactions')
                            .update({
                                poll_attempts: currentAttempts,
                                updated_at: new Date().toISOString(),
                            })
                            .eq('id', tx.id)
                            .eq('status', 'moolre_pending')
                        console.error(
                            `[sync-moolre] ❌ Moolre returned txstatus=2 for tx ${tx.id} (attempt ${currentAttempts}/3). ` +
                            `Leaving as moolre_pending. Admin must use "Pay Manually".`
                        )
                    }
                    results.errors++

                } else {
                    // txstatus=0 or txstatus=3 — still pending, check again next run
                    console.log(`[sync-moolre] ⏳ tx ${tx.id} still pending (txstatus=${status.txstatus})`)
                    results.stillPending++
                }

            } catch (txErr: any) {
                console.error(`[sync-moolre] Unexpected error processing tx ${tx.id}:`, txErr.message)
                results.errors++
            }
        }

        console.log('[sync-moolre] Run complete:', results)
        return NextResponse.json({ success: true, results })

    } catch (error: any) {
        console.error('[sync-moolre] Fatal cron error:', error)
        return NextResponse.json({ error: error.message || 'Internal error' }, { status: 500 })
    }
}
