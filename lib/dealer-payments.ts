import { createServerClient } from './supabase'
import { waitUntil } from '@vercel/functions'
import { sendDealerActivationSuccessEmail, sendDealerExtensionSuccessEmail } from './email-service'
import { sendDealerActivationSuccessSMS, sendDealerExtensionSuccessSMS } from './sms-service'
import { dealerMonthsFromPlan } from './wallet-upgrade'
import type { DealerPlan } from './wallet-upgrade'

/**
 * Processes a completed dealer upgrade payment.
 * Sets role='dealer', dealer_expires_at = now + 6 months.
 * On expiry the dealer auto-downgrades to lifetime agent via /api/dealer/downgrade.
 */
export async function processCompletedDealerUpgradePayment(reference: string, providerMetadata: any) {
    const supabase = createServerClient()

    // 1. Get payment record
    const { data: paymentData, error: paymentError } = await supabase
        .from('wallet_payments')
        .select('*')
        .eq('reference', reference)
        .single()

    const payment = paymentData as any

    if (paymentError || !payment) {
        console.error('[DealerUpgradeProcess] Payment not found:', reference)
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
            console.error(`[DealerUpgradeProcess] AMOUNT MISMATCH for ${reference}: expected ${expectedKobo} kobo, got ${providerAmountKobo} kobo`)
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

    // 2. Atomic idempotency check
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
        console.error('[DealerUpgradeProcess] Update payment error:', updatePaymentError)
        return { success: false, error: 'Failed to update payment status' }
    }

    if (!updatedPayment) return { success: true, alreadyProcessed: true }

    // 3. Fetch user
    const { data: userData, error: userError } = await supabase
        .from('users')
        .select('role, agent_expires_at, dealer_expires_at, email, first_name, phone_number')
        .eq('id', payment.user_id)
        .single()

    const user = userData as any

    if (userError || !user) {
        console.error('[DealerUpgradeProcess] User not found:', payment.user_id)
        return { success: false, error: 'User not found' }
    }

    // Lifetime agents (new dealers) OR existing dealers (extension) are eligible
    const isLifetimeAgent = user.role === 'agent' && user.agent_expires_at === null
    const isCurrentDealer = user.role === 'dealer'
    if (!isLifetimeAgent && !isCurrentDealer) {
        console.error('[DealerUpgradeProcess] User is not eligible:', payment.user_id)
        return { success: false, error: 'User must be a Lifetime Agent or current Dealer' }
    }

    // 4. Compute new expiry using the plan stored in payment metadata.
    const VALID_DEALER_PLANS: DealerPlan[] = ['1m', '3m', '6m']
    const planType: DealerPlan = VALID_DEALER_PLANS.includes(payment.metadata?.plan_type)
        ? payment.metadata.plan_type
        : '6m'
    const months = dealerMonthsFromPlan(planType)
    const planLabel = payment.metadata?.plan_label ?? `${months === 1 ? '1 Month' : `${months} Months`} Dealer Pass`
    const currentExpiry = user.dealer_expires_at ? new Date(user.dealer_expires_at) : null
    const base = currentExpiry && currentExpiry > new Date() ? currentExpiry : new Date()
    const dealerExpiry = new Date(base)
    dealerExpiry.setMonth(dealerExpiry.getMonth() + months)
    const isExtension = isCurrentDealer

    const { error: updateUserError } = await (supabase
        .from('users') as any)
        .update({
            role: 'dealer',
            dealer_expires_at: dealerExpiry.toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq('id', payment.user_id)

    if (updateUserError) {
        console.error('[DealerUpgradeProcess] Update user error:', updateUserError)
        return { success: false, error: 'Failed to update user role' }
    }

    const expiryFormatted = dealerExpiry.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    const durationText = months === 1 ? '1 month' : `${months} months`

    // 5. In-app notification
    await (supabase.from('notifications') as any).insert({
        user_id: payment.user_id,
        title: isExtension ? 'Dealer Membership Extended!' : 'Dealer Status Activated!',
        message: isExtension
            ? `Your Dealer membership has been extended by ${durationText}. New expiry: ${expiryFormatted}.`
            : `Congratulations! You are now a Dealer. Your ${durationText} dealer membership is active until ${expiryFormatted}.`,
        type: 'system',
        action_url: '/dashboard',
    })

    // 6. Push, SMS and email notifications (background, non-blocking)
    waitUntil((async () => {
        try {
            const { sendPushNotification } = await import('@/lib/push-service')
            await sendPushNotification(payment.user_id, {
                title: isExtension ? 'Dealer Membership Extended!' : 'Dealer Status Activated!',
                body: isExtension
                    ? `Your Dealer membership has been extended. New expiry: ${expiryFormatted}.`
                    : `You are now a Dealer. Enjoy priority pricing, API access, and more for ${durationText}.`,
                url: '/dashboard'
            }).catch(err => console.error('[DealerUpgradeProcess] Push error:', err))

            // SMS notification
            if (user.phone_number) {
                if (isExtension) {
                    await sendDealerExtensionSuccessSMS(user.phone_number, dealerExpiry)
                        .catch(err => console.error('[DealerUpgradeProcess] SMS error:', err))
                } else {
                    await sendDealerActivationSuccessSMS(user.phone_number, user.first_name || 'Dealer', dealerExpiry)
                        .catch(err => console.error('[DealerUpgradeProcess] SMS error:', err))
                }
            }

            // Email notification
            if (user.email) {
                if (isExtension) {
                    await sendDealerExtensionSuccessEmail(user.email, user.first_name || 'Dealer', dealerExpiry)
                        .catch(err => console.error('[DealerUpgradeProcess] Email error:', err))
                } else {
                    await sendDealerActivationSuccessEmail(user.email, user.first_name || 'Dealer', dealerExpiry)
                        .catch(err => console.error('[DealerUpgradeProcess] Email error:', err))
                }
            }
        } catch (err) {
            console.error('[DealerUpgradeProcess] Notification error:', err)
        }
    })())

    console.log(`[DealerUpgradeProcess] User ${payment.user_id} ${isExtension ? 'extended' : 'upgraded'} to dealer until ${dealerExpiry.toISOString()}`)

    return { success: true }
}
