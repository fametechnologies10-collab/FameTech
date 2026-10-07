import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { processCompletedWalletPayment } from '@/lib/payments'
import { sendShopWithdrawalProcessedSMS } from '@/lib/sms-service'
import { sendShopWithdrawalProcessedEmail } from '@/lib/email-service'
import { waitUntil } from '@vercel/functions'
import crypto from 'crypto'

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!

// Fire-and-forget admin alert (never throws / never breaks the webhook response).
async function notifyAdmins(supabase: any, title: string, message: string) {
    try {
        const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin')
        if (!admins?.length) return
        await supabase.from('notifications').insert(
            admins.map((a: any) => ({ user_id: a.id, title, message, type: 'order_update', action_url: '/admin/orders' }))
        )
    } catch (e) {
        console.error('[PaystackWebhook] notifyAdmins failed:', e)
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabase = createServerClient()

        // Verify webhook signature (constant-time)
        const signature = request.headers.get('x-paystack-signature') || ''
        const body = await request.text()

        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(body)
            .digest('hex')

        const hashBuf = Buffer.from(hash, 'hex')
        const sigBuf = Buffer.from(signature, 'hex')

        if (
            hashBuf.length !== sigBuf.length ||
            !crypto.timingSafeEqual(hashBuf, sigBuf)
        ) {
            console.error('[PaystackWebhook] Invalid webhook signature')
            return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
        }

        const event = JSON.parse(body)

        // ── transfer.* (payout resolution) ──────────────────────────────────────
        // Must come AFTER HMAC verification above; BEFORE charge.success.
        // Never credits a wallet — admin handles refunds manually.
        if (typeof event.event === 'string' && event.event.startsWith('transfer.')) {
            const d = event.data || {}
            const reference: string | undefined = d.reference
            if (!reference) return NextResponse.json({ received: true })

            const { data: row } = await (supabase as any)
                .from('shop_wallet_transactions')
                .select('id, status, net_amount, network, momo_number, account_number, shop_wallet_id')
                .eq('paystack_transfer_reference', reference)
                .maybeSingle()
            if (!row) return NextResponse.json({ received: true }) // not ours

            const feeGhs = typeof d.fee_charged === 'number' ? d.fee_charged / 100 : null

            if (event.event === 'transfer.success') {
                // Status-guard: only advance paystack_pending → completed (CAS).
                // .select('id') lets us detect whether WE transitioned the row (vs cron already did it),
                // so we only fire notifications once.
                const { data: updatedRows, error: updateErr } = await (supabase.from('shop_wallet_transactions') as any)
                    .update({
                        status: 'completed',
                        paystack_transfer_status: 'success',
                        paystack_transfer_code: d.transfer_code ?? null,
                        paystack_fee: feeGhs,
                        processed_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', row.id)
                    .eq('status', 'paystack_pending')
                    .select('id')
                if (updateErr) {
                    console.error('[PaystackWebhook] transfer update failed:', { ref: reference, msg: updateErr.message })
                    return NextResponse.json({ error: 'DB update failed' }, { status: 500 })
                }
                // Only notify if we actually transitioned the row (avoid duplicate notifications
                // if the cron already marked it completed before this webhook fired).
                if (updatedRows && updatedRows.length > 0) {
                    // Fetch owner contact details for notifications (fire-and-forget)
                    const { data: wallet } = await (supabase as any)
                        .from('shop_wallets')
                        .select('owner_id')
                        .eq('id', row.shop_wallet_id)
                        .maybeSingle()
                    const ownerId = wallet?.owner_id
                    if (ownerId) {
                        const [{ data: ownerUser }, { data: shopProfile }] = await Promise.all([
                            (supabase as any).from('users').select('first_name, email').eq('id', ownerId).maybeSingle(),
                            (supabase as any).from('shop_profiles').select('shop_name, owner_phone').eq('owner_id', ownerId).maybeSingle(),
                        ])
                        const firstName = ownerUser?.first_name || shopProfile?.shop_name || 'Shop Owner'
                        const ownerEmail = ownerUser?.email || ''
                        const ownerPhone = shopProfile?.owner_phone || ''
                        const shopName = shopProfile?.shop_name || 'Your Shop'
                        const paymentReceiverNumber = row.momo_number || row.account_number || ''
                        waitUntil(Promise.allSettled([
                            sendShopWithdrawalProcessedSMS(ownerPhone, firstName, row.net_amount, row.network || 'MoMo', paymentReceiverNumber),
                            sendShopWithdrawalProcessedEmail(ownerEmail, firstName, shopName, row.net_amount, paymentReceiverNumber, row.network || 'MoMo'),
                        ]))
                    }
                }
                console.log('[PaystackWebhook] transfer.success processed:', reference)
                return NextResponse.json({ received: true })
            }

            if (event.event === 'transfer.failed' || event.event === 'transfer.reversed') {
                // Status-guard: flip paystack_pending or completed → failed.
                // DO NOT credit the wallet — admin refunds manually via the payments centre.
                const { error: updateErr } = await (supabase.from('shop_wallet_transactions') as any)
                    .update({
                        status: 'failed',
                        paystack_transfer_status: event.event === 'transfer.reversed' ? 'reversed' : 'failed',
                        failure_reason: event.data?.reason ? `Paystack ${event.event}: ${event.data.reason}` : `Paystack ${event.event}`,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', row.id)
                    .in('status', ['paystack_pending', 'completed'])
                if (updateErr) {
                    console.error('[PaystackWebhook] transfer update failed:', { ref: reference, msg: updateErr.message })
                    return NextResponse.json({ error: 'DB update failed' }, { status: 500 })
                }
                return NextResponse.json({ received: true })
            }

            return NextResponse.json({ received: true })
        }
        // ── end transfer.* ───────────────────────────────────────────────────────

        // ── refund.* (Paystack refund lifecycle for shop orders) ─────────────────
        // Paystack refunds are async. The admin flow only INITIATES a refund and sets
        // shop_orders.refund_method='paystack'; these webhooks finalize the DB state so the
        // order is only marked refunded (and owner profit reversed) once Paystack confirms it.
        if (typeof event.event === 'string' && event.event.startsWith('refund.')) {
            const d = event.data || {}
            const txnRef: string | undefined = d.transaction_reference
            if (!txnRef) return NextResponse.json({ received: true })

            const { data: so } = await (supabase as any)
                .from('shop_orders').select('id, status, refund_method')
                .eq('paystack_reference', txnRef).maybeSingle()
            if (!so) return NextResponse.json({ received: true }) // not one of our shop orders
            const soId = so.id

            if (event.event === 'refund.processed') {
                // Confirmed by Paystack — finalize status only. Shop-owner profit is NEVER reversed on
                // a refund (matches the owner_wallet mechanism in settle_shop_refund_to_owner, which
                // only ever refunds cost): a Paystack refund only returns the guest's payment, the owner
                // still keeps their margin, same as a 'failed' order (see syncShopOrderStatus).
                const { error } = await (supabase as any).rpc('mark_shop_order_refunded', {
                    p_shop_order_id: soId, p_actor_id: null, p_reason: 'Paystack refund processed', p_reverse_profit: false,
                })
                if (error) {
                    console.error('[PaystackWebhook] refund.processed finalize failed:', { soId, msg: error.message })
                    return NextResponse.json({ error: 'DB update failed' }, { status: 500 })
                }
                console.log('[PaystackWebhook] refund.processed finalized shop order', soId)
                return NextResponse.json({ received: true })
            }

            if (event.event === 'refund.failed') {
                // Money did NOT reach the customer; Paystack credited our balance back. Leave the ORDER
                // STATUS UNCHANGED (only a processed refund changes status). Record a durable, visible
                // failure marker on refund_method and alert admins.
                await (supabase as any).from('shop_orders')
                    .update({ refund_method: 'paystack_failed', refund_reason: 'Paystack refund failed — customer not refunded' })
                    .eq('id', soId).neq('status', 'refunded')
                waitUntil(notifyAdmins(supabase, 'Paystack refund FAILED',
                    `Refund for shop order ${soId} failed — the customer was NOT refunded and the amount was credited back to the platform. The order status is unchanged. Re-attempt or resolve manually.`))
                return NextResponse.json({ received: true })
            }

            if (event.event === 'refund.needs-attention') {
                // Order status unchanged; record a visible marker and alert admins to complete it.
                await (supabase as any).from('shop_orders')
                    .update({ refund_method: 'paystack_attention' }).eq('id', soId).neq('status', 'refunded')
                waitUntil(notifyAdmins(supabase, 'Paystack refund needs attention',
                    `Refund for shop order ${soId} needs the customer's bank details. Complete it via Paystack "Retry with customer details".`))
                return NextResponse.json({ received: true })
            }

            // refund.pending / refund.processing — informational, no state change.
            return NextResponse.json({ received: true })
        }
        // ── end refund.* ─────────────────────────────────────────────────────────

        if (event.event === 'charge.success') {
            const { reference, amount: paidAmountKobo } = event.data
            const metadata = event.data.metadata

            // ✅ RC ORDERS: References starting with RC- are Results Checker storefront orders.
            // Must be checked BEFORE SHOP- to route correctly.
            if (reference && reference.startsWith('RC-')) {
                const { processRCShopOrder } = await import('@/lib/results-checker-service')
                console.log(`[PaystackWebhook] Routing RC order: ${reference}`)
                await processRCShopOrder(reference, metadata || {}, paidAmountKobo)
                return NextResponse.json({ received: true })
            }

            // ✅ UTILITY ORDERS: References starting with UTLP- are storefront utility-bill
            // payments made via the Paystack rail (as opposed to UTIL-, which is Hubtel Direct
            // Receive Money and is settled via lib/hubtel-receive/settle.ts, never this webhook).
            // processUtilityShopOrder is idempotent on reference_code, so racing this against
            // the browser's own status poll is safe — see its doc comment for the ordering.
            if (reference && reference.startsWith('UTLP-')) {
                const { processUtilityShopOrder } = await import('@/lib/utility-fulfillment')
                console.log(`[PaystackWebhook] Routing utility order: ${reference}`)
                await processUtilityShopOrder(reference, metadata || {}, paidAmountKobo)
                return NextResponse.json({ received: true })
            }

            // ✅ SHOP AFA ORDERS: References starting with SHOPAFA- are storefront AFA
            // registrations. Checked BEFORE SHOP- so the more specific prefix wins.
            // Without this the flow is callback-only: a guest who pays and never
            // returns to the site gets no registration, and the purge cron destroys
            // their staged KYC 48h later. processShopAfaOrder is idempotent on
            // paystack_reference, so racing this against the browser callback is safe.
            if (reference && reference.startsWith('SHOPAFA-')) {
                const { processShopAfaOrder } = await import('@/lib/shop-afa-order-processor')
                console.log(`[PaystackWebhook] Routing shop AFA order: ${reference}`)
                await processShopAfaOrder(reference, metadata, paidAmountKobo, metadata?.shop_slug)
                return NextResponse.json({ received: true })
            }

            // ✅ SHOP ORDERS: References starting with SHOP- are storefront guest orders.
            // They are NOT stored in wallet_payments, so we must handle them separately
            // before the DB lookup to avoid "Payment not found" errors.
            if (reference && reference.startsWith('SHOP-')) {
                const { processShopOrder } = await import('@/lib/shop-order-processor')
                console.log(`[PaystackWebhook] Routing shop order: ${reference}`)
                await processShopOrder(reference, metadata, paidAmountKobo, metadata?.slug)
                return NextResponse.json({ received: true })
            }

            // Get payment record for verification
            const { data: payment } = await supabase
                .from('wallet_payments')
                .select('total_amount, status, user_id, metadata')
                .eq('reference', reference)
                .single()

            if (!payment) {
                console.error('[PaystackWebhook] Payment not found:', reference)
                return NextResponse.json({ received: true })
            }

            // ✅ IDEMPOTENCY CHECK: Prevent duplicate webhook processing
            if ((payment as any).status === 'completed') {
                console.log(`[PaystackWebhook] Payment ${reference} already processed, ignoring duplicate webhook`)
                return NextResponse.json({ received: true })
            }

            // ✅ AMOUNT VERIFICATION: Cross-check paid amount against DB-stored expected amount
            const expectedAmountKobo = Math.round((payment as any).total_amount * 100)
            if (paidAmountKobo !== expectedAmountKobo) {
                console.error(`[PaystackWebhook] AMOUNT MISMATCH: Expected ${expectedAmountKobo}, got ${paidAmountKobo}`)

                // Mark payment as failed with mismatch metadata
                try {
                    await (supabase
                        .from('wallet_payments') as any)
                        .update({
                            status: 'failed',
                            metadata: {
                                ...((payment as any).metadata || {}),
                                mismatch_reason: `Amount mismatch: expected ${expectedAmountKobo} kobo, received ${paidAmountKobo} kobo`,
                                mismatch_detected_at: new Date().toISOString(),
                            },
                            updated_at: new Date().toISOString(),
                        })
                        .eq('reference', reference)
                } catch (updateError) {
                    console.error('[PaystackWebhook] Failed to mark payment as failed:', updateError)
                }

                // Create user notification
                try {
                    await (supabase.from('notifications') as any).insert({
                        user_id: (payment as any).user_id,
                        title: 'Payment Issue Detected',
                        message: `A payment issue was detected with reference ${reference}. Your account was not charged. Please contact support if you were debited.`,
                        type: 'system',
                        action_url: '/dashboard/wallet',
                    })
                } catch (notificationError) {
                    console.error('[PaystackWebhook] Failed to create notification:', notificationError)
                }

                return NextResponse.json({ received: true })
            }

            // Route by payment type based on metadata
            if (metadata?.upgrade_type === 'dealer') {
                // Dealer membership upgrade
                const { processCompletedDealerUpgradePayment } = await import('@/lib/dealer-payments')
                await processCompletedDealerUpgradePayment(reference, event.data)
            } else if (metadata?.upgrade_type === 'agent') {
                // Agent membership upgrades
                const { processCompletedUpgradePayment } = await import('@/lib/payments')
                await processCompletedUpgradePayment(reference, event.data)
            } else {
                // Standard wallet top-up
                await processCompletedWalletPayment(reference, event.data)
            }
        }

        return NextResponse.json({ received: true })
    } catch (error) {
        console.error('[PaystackWebhook] Webhook error:', error)
        return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
    }
}
