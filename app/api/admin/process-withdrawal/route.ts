import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import {
    buildWithdrawalReference,
    createMomoRecipient,
    initiateTransfer as initiatePaystackTransfer,
    getBalanceGhs,
    PAYSTACK_MOMO_BANK_CODE,
} from '@/lib/paystack-transfer-service'
import { sendShopWithdrawalProcessedSMS } from '@/lib/sms-service'
import { sendShopWithdrawalProcessedEmail } from '@/lib/email-service'
import { waitUntil } from '@vercel/functions'

const processSchema = z
    .object({
        transactionId: z.string().uuid('Invalid transaction ID').optional(),
        transactionIds: z.array(z.string().uuid()).min(1).max(100).optional(),
        // Moolre payouts were retired 2026-09-26 (owner decision): Paystack (MoMo) + manual only.
        // An 'moolre' action is now rejected by validation. Legacy moolre_pending rows are
        // still reconciled by app/api/cron/sync-moolre-withdrawals.
        action: z.enum(['manual', 'paystack', 'refund']),
        adminNote: z.string().max(500).trim().optional(),
    })
    .refine((d) => d.transactionId || d.transactionIds, {
        message: 'transactionId or transactionIds required',
    })

type ProcessAction = 'manual' | 'paystack' | 'refund'

// ─── PII redaction helpers ──────────────────────────────────────────────────
// Never log a full receiver number. Keep only the last 4 digits.
const maskNumber = (n: string | null | undefined) =>
    !n ? '' : n.length <= 4 ? '****' : '*'.repeat(n.length - 4) + n.slice(-4)
// Provider failure messages may echo account data — clamp + namespace them.
const maskNote = (e?: string) => (e ? `Paystack: ${e}`.slice(0, 500) : null)

export async function POST(req: NextRequest) {
    try {
        // 1. Auth — must be an admin (verified server-side, not trusting client role)
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { data: dbUser } = await supabase
            .from('users')
            .select('role')
            .eq('id', user.id)
            .single()

        // SEC-022: real MoMo/bank payouts are admin-only (sub-admin scope is orders-only).
        if (!dbUser || dbUser.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        // 2. Validate payload
        const body = await req.json()
        const parsed = processSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { error: 'Invalid input', details: parsed.error.errors.map((e) => e.message) },
                { status: 400 }
            )
        }

        const { action, adminNote } = parsed.data
        const adminId = user.id

        // 3. Use service client to bypass RLS for admin operations
        const db = createServerClient() as any

        // ─── Per-row processor ────────────────────────────────────────────────
        // All action logic lives here so a single transaction id and a bulk batch
        // share EXACTLY the same guards (atomic locks, balance preflight, recipient
        // caching, unlock-on-failure, SMS/email). Returns a plain status object —
        // the POST handler shapes the HTTP response.
        async function processOne(
            transactionId: string,
            act: ProcessAction
        ): Promise<{ status: string; error?: string; [k: string]: unknown }> {
            // Each row needs its own fetch of tx/shop/owner.
            const { data: tx, error: txFetchError } = await db
                .from('shop_wallet_transactions')
                .select(`
                    *,
                    wallet:shop_wallets!inner(
                        id,
                        owner_id,
                        balance,
                        total_withdrawn
                    )
                `)
                .eq('id', transactionId)
                .single()

            if (txFetchError || !tx) {
                return { status: 'not_found', error: 'Transaction not found' }
            }

            // ─── ACTION: REFUND ────────────────────────────────────────────────
            // Money is mutated only through the RPC (never a raw UPDATE). Returns
            // the gross debit to the wallet and marks the row 'reversed'.
            if (act === 'refund') {
                const { data: result, error: refundErr } = await db.rpc('refund_shop_withdrawal', {
                    p_tx_id: transactionId,
                    p_admin_id: adminId,
                    p_reason: adminNote || 'Rejected & refunded by admin',
                })
                if (refundErr) {
                    console.error('[process-withdrawal] refund', { tx: transactionId, msg: refundErr.message })
                    return { status: 'error', error: refundErr.message || 'Refund failed' }
                }
                return { status: 'reversed', method: 'refund', data: result }
            }

            const { data: shopProfile } = await db
                .from('shop_profiles')
                .select('shop_name, owner_phone, owner_id')
                .eq('owner_id', tx.wallet.owner_id)
                .single()

            const { data: owner } = await db
                .from('users')
                .select('first_name, last_name, email')
                .eq('id', tx.wallet.owner_id)
                .single()

            const shopName = shopProfile?.shop_name || 'Unknown Shop'
            const ownerPhone = shopProfile?.owner_phone || ''
            const ownerEmail = owner?.email || ''
            const firstName = owner?.first_name || shopName

            // Handle separation of MoMo and Bank account numbers
            const paymentReceiverNumber = tx.momo_number || tx.account_number || ''

            // ─── ACTION: MANUAL ────────────────────────────────────────────────
            if (act === 'manual') {
                // Atomic idempotency lock: only pending or failed rows may be manually completed.
                // moolre_pending is excluded — the provider may still pay out (double-pay risk).
                const { data: updatedTx, error: updateError } = await db
                    .from('shop_wallet_transactions')
                    .update({
                        status: 'completed',
                        payout_provider: 'manual',
                        processed_by: adminId,
                        admin_note: adminNote || null,
                        processed_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', transactionId)
                    .in('status', ['pending', 'failed'])
                    .select()

                if (updateError) throw updateError

                // If rowsAffected == 0, another admin beat us to it, or it was already completed
                if (!updatedTx || updatedTx.length === 0) {
                    return { status: 'error', error: 'This transaction is already completed or processing.' }
                }

                // Fix #10: Import directly, fire-and-forget, non-blocking
                // Receiver number passed in full intentionally — for the owner's own notification, not for logging.
                waitUntil(
                    Promise.allSettled([
                        sendShopWithdrawalProcessedSMS(ownerPhone, firstName, tx.net_amount, tx.network || 'MoMo', paymentReceiverNumber),
                        sendShopWithdrawalProcessedEmail(ownerEmail, firstName, shopName, tx.net_amount, paymentReceiverNumber, tx.network || 'MoMo'),
                    ]).catch((err) => console.warn('[ShopAlert SMS] Non-fatal error:', err))
                )

                return { status: 'completed', method: 'manual' }
            }

            // ─── ACTION: PAYSTACK ──────────────────────────────────────────────
            if (act === 'paystack') {
                // MoMo only — bank payouts never go through Paystack
                if (tx.payment_type === 'bank') {
                    return { status: 'error', error: 'Paystack payouts support mobile money only. Pay bank withdrawals manually.' }
                }
                const network = tx.network as 'MTN MoMo' | 'Telecel Cash' | 'AirtelTigo Money'
                if (!PAYSTACK_MOMO_BANK_CODE[network]) {
                    return { status: 'error', error: `Network "${tx.network}" is not supported on the Paystack rail.` }
                }

                // 1) Atomic idempotency lock pending -> paystack_pending BEFORE any API call.
                const reference = buildWithdrawalReference(transactionId)
                const { data: locked, error: lockErr } = await db
                    .from('shop_wallet_transactions')
                    .update({
                        status: 'paystack_pending',
                        payout_provider: 'paystack',
                        paystack_transfer_reference: reference,
                        processed_by: adminId,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', transactionId)
                    .eq('status', 'pending')
                    .select()
                if (lockErr) throw lockErr
                if (!locked || locked.length === 0) {
                    return { status: 'error', error: 'This transaction is already being processed or is completed.' }
                }

                // 2) Balance preflight (fail clean back to pending)
                const balance = await getBalanceGhs()
                if (balance !== null && balance < tx.net_amount) {
                    await db
                        .from('shop_wallet_transactions')
                        .update({ status: 'pending', payout_provider: null, paystack_transfer_reference: null, processed_by: null, updated_at: new Date().toISOString() })
                        .eq('id', transactionId)
                    return { status: 'error', error: `Insufficient Paystack balance (GH₵${balance.toFixed(2)}). Top up and retry.` }
                }

                // 3) Ensure a MoMo recipient
                let recipientCode = tx.paystack_recipient_code as string | null
                if (!recipientCode) {
                    const rec = await createMomoRecipient({ name: tx.account_name, momoNumber: paymentReceiverNumber, network })
                    if (!rec.success || !rec.recipientCode) {
                        await db
                            .from('shop_wallet_transactions')
                            .update({ status: 'pending', payout_provider: null, paystack_transfer_reference: null, processed_by: null, updated_at: new Date().toISOString() })
                            .eq('id', transactionId)
                        return { status: 'error', error: `Could not create Paystack recipient: ${rec.error}` }
                    }
                    recipientCode = rec.recipientCode
                    await db.from('shop_wallet_transactions').update({ paystack_recipient_code: recipientCode }).eq('id', transactionId)
                }

                // 4) Initiate (OTP is OFF -> expect 'pending'; URL approval gates it server-side)
                const tr = await initiatePaystackTransfer({
                    amountGhs: tx.net_amount,
                    recipientCode,
                    reference,
                    reason: `KingFlexy payout - ${shopName.substring(0, 20)}`,
                })
                if (!tr.success) {
                    await db
                        .from('shop_wallet_transactions')
                        .update({ status: 'pending', payout_provider: null, paystack_transfer_reference: null, processed_by: null, failure_reason: maskNote(tr.error), updated_at: new Date().toISOString() })
                        .eq('id', transactionId)
                    return { status: 'error', error: `Paystack transfer error: ${tr.error}. Reverted to pending.` }
                }
                await db
                    .from('shop_wallet_transactions')
                    .update({ paystack_transfer_code: tr.transferCode, paystack_transfer_status: tr.status, updated_at: new Date().toISOString() })
                    .eq('id', transactionId)

                if (tr.status === 'success') {
                    await db
                        .from('shop_wallet_transactions')
                        .update({ status: 'completed', processed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                        .eq('id', transactionId)
                        .eq('status', 'paystack_pending')
                    // Receiver number passed in full intentionally — for the owner's own notification, not for logging.
                    waitUntil(
                        Promise.allSettled([
                            sendShopWithdrawalProcessedSMS(ownerPhone, firstName, tx.net_amount, tx.network || 'MoMo', paymentReceiverNumber),
                            sendShopWithdrawalProcessedEmail(ownerEmail, firstName, shopName, tx.net_amount, paymentReceiverNumber, tx.network || 'MoMo'),
                        ]).catch(() => {})
                    )
                    return { status: 'completed', method: 'paystack' }
                }
                // pending/otp/queued -> webhook + cron resolve
                return {
                    status: 'paystack_pending',
                    method: 'paystack',
                    message: 'Transfer submitted to Paystack. Awaiting confirmation.',
                }
            }

            return { status: 'error', error: 'Unknown action' }
        }

        // ─── Bulk mode: loop ids serially, isolate per-row failures ────────────
        if (parsed.data.transactionIds && parsed.data.transactionIds.length > 0) {
            const results: Array<{ transactionId: string; status: string; error?: string }> = []
            for (const id of parsed.data.transactionIds) {
                try {
                    const r = await processOne(id, action) // serial: respects Paystack rate limits
                    results.push({ transactionId: id, status: r.status, error: r.error })
                } catch (e: any) {
                    // Never echo the receiver — log tx + message only.
                    console.error('[process-withdrawal]', { tx: id, msg: e?.message })
                    results.push({ transactionId: id, status: 'error', error: e?.message || 'failed' })
                }
            }
            return NextResponse.json({ success: true, results })
        }

        // ─── Single-row path ───────────────────────────────────────────────────
        const single = await processOne(parsed.data.transactionId!, action)
        return NextResponse.json(
            single.error ? { success: false, error: single.error } : { success: true, ...single },
            { status: single.error ? 400 : 200 }
        )
    } catch (error: any) {
        // PII-safe: never echo the receiver number — log the message only.
        console.error('[process-withdrawal]', { tx: null, msg: error?.message })
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
