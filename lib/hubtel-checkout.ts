/**
 * lib/hubtel-checkout.ts
 *
 * Storefront utility-bill payment seam — delegates to the Hubtel Direct Receive Money
 * rail (lib/hubtel-receive-money.ts). Utilities are commission-based (customer pays
 * exact face value, shop earns a share of Hubtel's commission on completion), so this
 * NEVER routes through Paystack — a Paystack fee on top of a zero-markup sale would be
 * negative unit economics.
 *
 * Receive Money is a SERVER-INITIATED MoMo charge (like Paystack's Charge API) — there
 * is NO checkoutUrl/redirect. The customer approves a USSD/MoMo prompt on their phone,
 * which means a `hubtel_receive_charges` row (and the order it belongs to) MUST already
 * exist in the DB before this fires, because the prompt can be approved before this
 * call even returns. See the insert-before-init ordering in
 * app/api/shop/utility/charge/route.ts — a deliberate reversal of this seam's old
 * init-before-insert, which was only correct for the redirect model.
 *
 * Callers (app/api/shop/utility/charge and its status sibling) already handle
 * `notConfigured` as a first-class outcome — a 503 on charge ("Utility payments are
 * coming soon"), and a pass-through "still pending" on status polls.
 */
import { createServerClient } from '@/lib/supabase'
import { initiateReceiveMoney, checkReceiveMoneyStatus, channelForMsisdn } from '@/lib/hubtel-receive-money'
import { makeUtilityReference, UtilityBiller } from '@/lib/hubtel-utility/billers'
import { normalizePhone as normalizeToLocalGhanaPhone } from '@/lib/ussd/utils'
import { getNetworkMeta } from '@/lib/momo-verify'
import { sanitizeForStorage } from '@/lib/sanitize-for-storage'

export interface CheckoutInitArgs {
    amountPesewas: number
    description: string
    clientReference: string // = utility_orders.reference_code = hubtel_receive_charges.reference_code
    channel: string // mtn-gh | vodafone-gh | tigo-gh — the PAYER's network (channelForMsisdn)
    momoMsisdn: string // payer's MoMo number, 233XXXXXXXXX
    customerName?: string
    customerEmail?: string
}

export type CheckoutInitResult =
    | { success: true; providerRef: string; status: 'pending' | 'paid' }
    | { success: false; notConfigured?: true; ambiguous?: true; error: string }

/**
 * Fire a Direct Receive Money charge for a storefront utility purchase.
 *
 * Re-checks the enable toggle here too — the charge route already gates BEFORE any
 * insert to keep the dark seam row-free (the primary gate), so this is defense-in-depth
 * for any other future caller that might skip that check.
 */
export async function initiateStorefrontUtilityPayment(args: CheckoutInitArgs): Promise<CheckoutInitResult> {
    const db = createServerClient() as any
    const { data: toggleRow } = await db
        .from('admin_settings')
        .select('value')
        .eq('key', 'hubtel_receive_enabled_utility')
        .maybeSingle()
    const enabled = toggleRow?.value === true || toggleRow?.value === 'true'
    if (!enabled) {
        return { success: false, notConfigured: true, error: 'Hubtel receive not enabled' }
    }

    const r = await initiateReceiveMoney({
        channel: args.channel,
        msisdn: args.momoMsisdn,
        amount: args.amountPesewas / 100,
        description: args.description,
        clientReference: args.clientReference,
        customerName: args.customerName,
        customerEmail: args.customerEmail,
    })

    if (r.status === 'pending' || r.status === 'paid') {
        return { success: true, providerRef: r.providerRef!, status: r.status }
    }
    if (r.status === 'blocked') {
        return { success: false, error: 'Payment service temporarily unavailable' }
    }
    // r.status === 'failed'
    if (r.ambiguous) {
        // Timeout / network error — Hubtel may still have queued the prompt. Do NOT report
        // this as a definitive failure; the caller must leave the charge recoverable.
        return { success: false, ambiguous: true, error: 'Payment status unconfirmed — please check your phone.' }
    }
    return { success: false, error: r.message || 'Could not start payment' }
}

/**
 * Thin wrapper over checkReceiveMoneyStatus — a live provider verify for any caller that
 * needs one directly (the storefront status-poll route itself now goes through
 * settleReceivePaid, which owns the re-verify + atomic-claim + dispatch sequence; see
 * app/api/shop/utility/charge/status/route.ts).
 */
export async function verifyStorefrontUtilityPayment(
    clientReference: string
): Promise<{ success: boolean; paid: boolean; notConfigured?: true; error?: string }> {
    const v = await checkReceiveMoneyStatus(clientReference)
    return { success: v.ok, paid: v.paid }
}

/** Everything runHubtelUtilityCharge needs — either resolved fresh inside the charge
 * route's request handler, or restored verbatim from a phone_otp_verifications.pending_charge
 * jsonb column after a pre-charge OTP confirmation (see the UTLV- branch in
 * app/api/shop/charge/submit-otp/route.ts). Every field here must stay JSON-serializable
 * for that reason. */
export interface HubtelUtilityChargeParams {
    shop: { id: string }
    momo233: string // canonical 233XXXXXXXXX MoMo msisdn — must match isNumberVerified's key
    trimmedAccountName: string | null
    // Deliberately untyped beyond Record — this is computeShopCheckout's metadataPayload,
    // which callers pass through as-is (and, on the OTP-replay path, round-trips through a
    // jsonb column). biller/account_number/destination_phone are read below and are always
    // present at runtime; a structural interface here would fight computeShopCheckout's own
    // broader return type for no real safety gain.
    metadataPayload: Record<string, any>
    totalAmountPesewas: number
    paystackEmail: string
    validatedGuestEmail?: string | null
    snapshot: Record<string, unknown> | null
    billerLabel: string
}

/**
 * Runs the Hubtel Direct Receive Money charge for a storefront utility purchase —
 * extracted out of app/api/shop/utility/charge/route.ts's Hubtel branch so it can be
 * invoked from two places: the charge route itself (already-verified number), and the
 * submit-otp route's UTLV- branch (number just cleared the pre-charge OTP gate; see
 * lib/hubtel-receive/number-verification.ts's confirmVerificationOtp). Returns a plain
 * body/httpStatus pair rather than a NextResponse so both callers can shape their own
 * envelope around it.
 */
export async function runHubtelUtilityCharge(
    db: any,
    params: HubtelUtilityChargeParams,
): Promise<{ body: Record<string, unknown>; httpStatus: number }> {
    const {
        shop, momo233, trimmedAccountName, metadataPayload, totalAmountPesewas,
        paystackEmail, validatedGuestEmail, snapshot, billerLabel,
    } = params

    const channel = channelForMsisdn(momo233)
    if (!channel) {
        return { body: { error: 'Unsupported mobile network' }, httpStatus: 400 }
    }

    const clientReference = makeUtilityReference(metadataPayload.biller as UtilityBiller)

    // Payer's local-format MoMo number + network — already known here as momo233 (the
    // charge target), so persisted directly on insert rather than reverse-engineered
    // later. Powers the admin "View MoMo" refund-details button
    // (app/api/admin/utility-orders/[id]/momo-details) with no external lookup needed
    // for the number/network; only the payer's NAME needs on-demand resolution there.
    const payerLocalNumber = normalizeToLocalGhanaPhone(momo233)
    const payerNetwork = getNetworkMeta(payerLocalNumber)?.label || null

    const { data: order, error: orderError } = await db
        .from('utility_orders')
        .insert({
            source: 'storefront',
            shop_id: shop.id,
            user_id: null,
            biller: metadataPayload.biller,
            account_number: metadataPayload.account_number,
            account_name: trimmedAccountName,
            destination_phone: metadataPayload.destination_phone,
            customer_email: paystackEmail,
            amount: totalAmountPesewas / 100,
            payment_method: 'hubtel_receive',
            payment_reference: null, // filled after init
            payment_status: 'unpaid',
            status: 'pending',
            reference_code: clientReference,
            lookup_snapshot: snapshot,
            payer_momo_number: payerLocalNumber,
            payer_momo_network: payerNetwork,
        })
        .select('id, reference_code')
        .single()

    if (orderError || !order) {
        console.error('[Hubtel Utility Charge] Order creation error:', orderError)
        return { body: { error: 'Failed to create order record' }, httpStatus: 500 }
    }

    const { data: feesRow } = await db
        .from('admin_settings')
        .select('value')
        .eq('key', 'hubtel_receive_fees_on_customer_utility')
        .maybeSingle()
    const feesOnCustomer = feesRow?.value === true || feesRow?.value === 'true'

    const { error: chargeError } = await db
        .from('hubtel_receive_charges')
        .insert({
            reference_code: clientReference,
            service_type: 'utility',
            order_id: order.id,
            shop_id: shop.id,
            amount: totalAmountPesewas / 100,
            channel,
            fees_on_customer: feesOnCustomer,
        })

    if (chargeError) {
        console.error('[Hubtel Utility Charge] Charge-row creation error:', chargeError)
        // Never reached Hubtel — record WHY at the checkout step itself so admin isn't left
        // with a blank 'failed' row. Internal DB error, not provider text, so no sanitizeForStorage
        // truncation is needed — the message is ours.
        const { error: markError } = await db.from('utility_orders').update({
            status: 'failed',
            fulfillment_metadata: {
                stage: 'checkout',
                reason: 'internal_charge_row_failed',
                provider_message: chargeError.message || null,
                at: new Date().toISOString(),
            },
        }).eq('id', order.id)
        if (markError) console.error('[Hubtel Utility Charge] mark-failed (order only) error:', markError)
        return { body: { error: 'Failed to create order record' }, httpStatus: 500 }
    }

    const initResult = await initiateStorefrontUtilityPayment({
        amountPesewas: totalAmountPesewas,
        description: `${billerLabel} — ${metadataPayload.account_number}`,
        clientReference,
        channel,
        momoMsisdn: momo233,
        customerName: trimmedAccountName || undefined,
        // Use paystackEmail (validatedGuestEmail with the auto-generated fallback already
        // applied by the charge route via buildGuestEmail) rather than validatedGuestEmail
        // alone — a customer who leaves the email field blank must still get the SAME
        // auto-generated address Hubtel receives as everywhere else this order's email is
        // used (the DB row, receipts), not have it silently omitted from the charge itself.
        customerEmail: paystackEmail || undefined,
    })

    if (!initResult.success) {
        if (initResult.ambiguous) {
            // Timeout/network error AFTER Hubtel may have queued the prompt: leave BOTH
            // rows 'pending' (do NOT mark failed) so the poll + reconcile re-verify it.
            return {
                body: { reference: clientReference, status: 'pending', display_text: 'Approve the prompt on your phone', total: totalAmountPesewas / 100 },
                httpStatus: 200,
            }
        }

        // Never reached the ECG top-up step — the customer's MoMo charge itself was
        // rejected/declined by Hubtel. Record WHY on the order so admin isn't left with a
        // blank 'failed' row (raw Hubtel text sanitized + bounded; admin-only metadata).
        const checkoutFailureMeta = {
            stage: 'checkout',
            reason: initResult.notConfigured ? 'not_configured' : 'hubtel_receive_rejected',
            provider_message: sanitizeForStorage(initResult.error),
            at: new Date().toISOString(),
        }
        const [orderMark, chargeMark] = await Promise.all([
            db.from('utility_orders').update({ status: 'failed', fulfillment_metadata: checkoutFailureMeta }).eq('id', order.id),
            db.from('hubtel_receive_charges').update({ status: 'failed' }).eq('reference_code', clientReference),
        ])
        if (orderMark?.error) console.error('[Hubtel Utility Charge] mark-failed utility_orders error:', orderMark.error)
        if (chargeMark?.error) console.error('[Hubtel Utility Charge] mark-failed hubtel_receive_charges error:', chargeMark.error)

        if (initResult.notConfigured) {
            return { body: { error: 'Utility payments are coming soon' }, httpStatus: 503 }
        }
        return { body: { error: initResult.error || 'Failed to start payment' }, httpStatus: 502 }
    }

    const [orderRefUpdate, chargeRefUpdate] = await Promise.all([
        db.from('utility_orders').update({ payment_reference: initResult.providerRef }).eq('id', order.id),
        db.from('hubtel_receive_charges').update({ provider_transaction_id: initResult.providerRef }).eq('reference_code', clientReference),
    ])
    if (orderRefUpdate?.error) console.error('[Hubtel Utility Charge] providerRef persist (utility_orders) error:', orderRefUpdate.error)
    if (chargeRefUpdate?.error) console.error('[Hubtel Utility Charge] providerRef persist (hubtel_receive_charges) error:', chargeRefUpdate.error)

    return {
        body: { reference: clientReference, status: 'pending', display_text: 'Approve the prompt on your phone', total: totalAmountPesewas / 100 },
        httpStatus: 200,
    }
}
