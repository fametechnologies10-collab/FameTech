import { createServerClient } from './supabase'
import { sendWalletTopupSuccessEmail, sendPermanentAgentUpgradeSuccessEmail } from './email-service'
import { sendWalletTopupSuccessSMS, sendAgentUpgradeSuccessSMS, sendAgentExtensionSuccessSMS, sendPermanentAgentUpgradeSuccessSMS } from './sms-service'
import { waitUntil } from '@vercel/functions'
import { mapCreditResult } from './wallet-credit'

export { processCompletedDealerUpgradePayment } from './dealer-payments'

/**
 * Processes a completed wallet top-up payment. All money-moving work (row lock,
 * amount verification, status flip, wallet credit, total_credited, ledger row)
 * happens atomically inside the `credit_wallet_topup` RPC, which is idempotent
 * per reference. This function only maps the result and sends notifications on
 * a first-time credit.
 */
export async function processCompletedWalletPayment(reference: string, providerMetadata?: any) {
    const supabase = createServerClient()

    // 1. Atomic credit (lock + verify + credit + ledger inside one DB transaction)
    const providerAmountKobo =
        typeof providerMetadata?.amount === 'number' && Number.isInteger(providerMetadata.amount)
            ? providerMetadata.amount
            : null

    const { data, error: rpcError } = await (supabase as any).rpc('credit_wallet_topup', {
        p_reference: reference,
        p_provider_amount_kobo: providerAmountKobo,
        p_currency: typeof providerMetadata?.currency === 'string' ? providerMetadata.currency : null,
        p_provider_metadata: providerMetadata ?? null,
    })

    if (rpcError) {
        console.error('[PaymentProcess] credit_wallet_topup RPC error:', reference, rpcError)
        return { success: false, error: 'Failed to credit wallet' }
    }

    const outcome = mapCreditResult(data)

    if (!outcome.success) {
        const rawError = (data as any)?.error
        if (outcome.transient && (rawError === 'amount_unverified' || rawError === 'wallet_not_found')) {
            console.warn(`[PaymentProcess] Transient credit failure for ${reference}: ${rawError}`)
        } else {
            console.error(`[PaymentProcess] Credit failed for ${reference}: ${rawError ?? 'unknown'}`)
        }
        // Only expose the two stable, caller-meaningful errors. Everything else
        // (raw RPC codes like amount_unverified / wallet_not_found) stays server-side.
        const publicError =
            outcome.error === 'Amount mismatch' ||
            outcome.error === 'Payment not found' ||
            outcome.error === 'Payment not pending'
                ? outcome.error
                : 'Failed to credit wallet'
        return { success: false, error: publicError }
    }

    if (outcome.alreadyProcessed) {
        return { success: true, alreadyProcessed: true }
    }

    // First-time success: the money is already credited. Notify.
    const { userId, amount, newBalance } = outcome
    if (!userId || amount === undefined || newBalance === undefined || !Number.isFinite(amount) || !Number.isFinite(newBalance)) {
        const missing = [
            !userId && 'user_id',
            (amount === undefined || !Number.isFinite(amount)) && 'amount',
            (newBalance === undefined || !Number.isFinite(newBalance)) && 'new_balance',
        ].filter(Boolean).join(',')
        console.error(`[PaymentProcess] Credit succeeded but RPC result incomplete (missing: ${missing}); skipping notifications:`, reference)
        return { success: true }
    }

    // 2. Create notification
    // Wrapped so a notification failure can never turn a committed credit into a failure.
    try {
        const { error: notifyError } = await (supabase.from('notifications') as any).insert({
            user_id: userId,
            title: 'Wallet Topped Up',
            message: `Your wallet has been credited with GHS ${amount.toFixed(2)}`,
            type: 'payment_success',
            action_url: '/dashboard/wallet',
        })

        if (notifyError) {
            console.error('[PaymentProcess] Notification error:', notifyError)
        }
    } catch (notifyErr) {
        console.error('[PaymentProcess] Notification step threw:', notifyErr)
    }

    // 3. Send push, email and SMS notification in background
    try {
    waitUntil((async () => {
        try {
            const { sendPushNotification } = await import('@/lib/push-service')
            await sendPushNotification(userId, {
                title: 'Wallet Topped Up',
                body: `Your wallet has been credited with GHS ${amount.toFixed(2)}`,
                url: '/dashboard/wallet'
            }).catch(err => console.error('[PaymentProcess] Push error:', err))

            // Get user details for email
            const { data: userData } = await supabase
                .from('users')
                .select('email, first_name, phone_number')
                .eq('id', userId)
                .single()

            if (userData) {
                // Await email first so it doesn't get blocked by SMS
                await sendWalletTopupSuccessEmail(
                    (userData as any).email,
                    (userData as any).first_name || 'Customer',
                    amount,
                    reference,
                    newBalance
                ).catch(err => console.error('[PaymentProcess] Email error:', err))

                // Send SMS notification
                if ((userData as any).phone_number) {
                    console.log('[PaymentProcess] Found user phone:', (userData as any).phone_number)
                    await sendWalletTopupSuccessSMS(
                        (userData as any).phone_number,
                        {
                            amount,
                            newBalance
                        }
                    ).then(res => console.log('[PaymentProcess] SMS Result:', res))
                        .catch(err => console.error('[PaymentProcess] SMS error:', err))
                } else {
                    console.warn('[PaymentProcess] No phone number found for user:', userId)
                }

            }
        } catch (emailError) {
            // Don't fail the payment process if email fails
            console.error('[PaymentProcess] Notification error:', emailError)
        }
    })())
    } catch (bgErr) {
        console.error('[PaymentProcess] Failed to schedule background notifications:', bgErr)
    }

    return { success: true }
}

/**
 * Processes a completed upgrade payment by updating the user's role 
 * and extending their agent membership duration.
 */
export async function processCompletedUpgradePayment(reference: string, providerMetadata: any) {
    const supabase = createServerClient()

    // 1. Get payment record
    const { data: paymentData, error: paymentError } = await supabase
        .from('wallet_payments')
        .select('*')
        .eq('reference', reference)
        .single()

    const payment = paymentData as any

    if (paymentError || !payment) {
        console.error('[UpgradeProcess] Payment not found:', reference)
        return { success: false, error: 'Payment not found' }
    }

    // 1b. Amount verification (defense-in-depth).
    // The Paystack webhook cross-checks the paid amount before calling us, but
    // the synchronous verify/check-pending paths do not — so we re-check here to
    // guarantee NO path can apply an upgrade for less than was actually due.
    // Paystack always reports `amount` in the minor unit (pesewas/kobo).
    const providerAmountKobo = providerMetadata?.amount
    const expectedTotal = Number((payment as any).total_amount)
    if (
        typeof providerAmountKobo === 'number' &&
        Number.isFinite(providerAmountKobo) &&
        Number.isFinite(expectedTotal) &&
        expectedTotal > 0
    ) {
        const expectedKobo = Math.round(expectedTotal * 100)
        if (providerAmountKobo !== expectedKobo) {
            console.error(`[UpgradeProcess] AMOUNT MISMATCH for ${reference}: expected ${expectedKobo} kobo, got ${providerAmountKobo} kobo`)
            await (supabase.from('wallet_payments') as any)
                .update({
                    status: 'failed',
                    metadata: {
                        ...((payment as any).metadata || {}),
                        mismatch_reason: `Amount mismatch: expected ${expectedKobo} kobo, received ${providerAmountKobo} kobo`,
                        mismatch_detected_at: new Date().toISOString(),
                    },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', (payment as any).id)
                .eq('status', 'pending')
            return { success: false, error: 'Amount mismatch' }
        }
    }

    // 2. Atomic Update (Idempotency Check)
    const { data: updatedPayment, error: updatePaymentError } = await (supabase
        .from('wallet_payments') as any)
        .update({
            status: 'completed',
            metadata: providerMetadata,
            updated_at: new Date().toISOString(),
        })
        .eq('id', payment.id)
        .eq('status', 'pending')
        .select()
        .single()

    if (updatePaymentError) {
        if (updatePaymentError.code === 'PGRST116') {
            return { success: true, alreadyProcessed: true }
        }
        console.error('[UpgradeProcess] Update payment error:', updatePaymentError)
        return { success: false, error: 'Failed to update payment status' }
    }

    if (!updatedPayment) return { success: true, alreadyProcessed: true }

    // 3. Get User and current expiry
    const { data: userData, error: userError } = await supabase
        .from('users')
        .select('role, agent_expires_at, email, first_name, phone_number')
        .eq('id', payment.user_id)
        .single()

    const user = userData as any

    if (userError || !user) {
        console.error('[UpgradeProcess] User not found:', payment.user_id)
        return { success: false, error: 'User not found' }
    }

    // 4. Calculate new expiry
    const isPermanent = (payment.metadata as any)?.plan_type === 'permanent';
    const planDays = (payment.metadata as any)?.plan_days || 30
    const now = new Date()
    let currentExpiry = user.agent_expires_at ? new Date(user.agent_expires_at) : null
    let newExpiry: Date | null = null;

    if (!isPermanent) {
        if (currentExpiry && currentExpiry > now) {
            // Extend existing
            newExpiry = new Date(currentExpiry.getTime() + (planDays * 24 * 60 * 60 * 1000))
        } else {
            // Start fresh
            newExpiry = new Date(now.getTime() + (planDays * 24 * 60 * 60 * 1000))
        }
    }

    // 5. Update user role and expiry
    const { error: updateUserError } = await (supabase
        .from('users') as any)
        .update({
            role: 'agent',
            agent_expires_at: isPermanent ? null : newExpiry?.toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq('id', payment.user_id)

    if (updateUserError) {
        console.error('[UpgradeProcess] Update user error:', updateUserError)
        return { success: false, error: 'Failed to update user role' }
    }

    // 6. Create notification
    await (supabase.from('notifications') as any).insert({
        user_id: payment.user_id,
        title: isPermanent ? 'Permanent Agent Unlocked! 💎' : 'Upgrade Successful',
        message: isPermanent 
            ? 'Congratulations! You now have lifetime access to premium agent benefits.' 
            : `Congratulations! Your Agent membership has been ${currentExpiry && currentExpiry > now ? 'extended' : 'activated'} until ${newExpiry?.toLocaleDateString()}.`,
        type: 'system',
        action_url: '/dashboard',
    })

    // Send push notification for upgrade
    try {
        const { sendPushNotification } = await import('@/lib/push-service')
        await sendPushNotification(payment.user_id, {
            title: isPermanent ? 'Permanent Agent Unlocked! 💎' : 'Upgrade Successful',
            body: isPermanent 
                ? 'Congratulations! You now have lifetime access to premium agent benefits.' 
                : `Congratulations! Your Agent membership has been activated/extended.`,
            url: '/dashboard'
        }).catch(err => console.error('[UpgradeProcess] Push error:', err))
    } catch (pushErr) {
        console.error('[UpgradeProcess] Failed to trigger push notification:', pushErr)
    }

    // 7. Send SMS notification
    try {
        if (user.phone_number) {
            if (isPermanent) {
                // Send Permanent/Lifetime notification (static import at top-level)
                await sendPermanentAgentUpgradeSuccessSMS(user.phone_number)
            } else if (newExpiry) {
                const planLabelText = (payment.metadata as any)?.plan_label ||
                    (planDays === 3 ? '3 Days' : planDays === 14 ? '14 Days' : '30 Days')

                // Calculate remaining days from now
                const diffMs = newExpiry.getTime() - now.getTime()
                const remainingDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))

                // Check if it was an extension (user was already agent and didn't expire)
                if (currentExpiry && currentExpiry > now) {
                    // Extension
                    await sendAgentExtensionSuccessSMS(
                        user.phone_number,
                        newExpiry
                    )
                } else {
                    // New Upgrade
                    await sendAgentUpgradeSuccessSMS(
                        user.phone_number,
                        user.first_name || 'Agent',
                        planLabelText,
                        remainingDays,
                        newExpiry.toISOString() // Pass the expiry date
                    )
                }
            }
        }
    } catch (smsError) {
        console.error('[UpgradeProcess] SMS error:', smsError)
        // Don't fail the transaction if SMS fails
    }

    // 8. Send permanent agent upgrade email notification
    // Migrated from /api/payments/webhook (old route) — lines 140-147
    if (isPermanent && user.email) {
        try {
            await sendPermanentAgentUpgradeSuccessEmail(
                user.email,
                user.first_name || 'User'
            )
        } catch (emailError) {
            console.error('[UpgradeProcess] Permanent upgrade email error:', emailError)
            // Don't fail the transaction if email fails
        }
    }

    return { success: true }
}
