import type { SupabaseClient } from '@supabase/supabase-js'
import type { HubtelRequest, HubtelResponse, USSDState } from '../types'
import { respond, release, addToCart, formatGHS, isValidGhanaPhone, normalizePhone, orderCode } from '../utils'
import { showBeneficiaryMenu, parseBeneficiaryChoice, selfBeneficiaryPhone } from '../beneficiary'
import { savePendingOrder } from '../session'
import { findUserByMobile, effectiveRole } from '../price-resolver'
import { createAdminClient } from '@/lib/supabase-admin'
import { processWalletPayment, recordWalletAwaitingFulfillment, clearWalletRefund, markWalletRefundFailed } from '../wallet-payment'
import { fulfillAirtimeUSSDOrder, type AirtimeOrderPayload } from '../fulfillment/airtime'
import { computeAirtimePricing } from '../airtime-pricing'
import { waitUntil } from '@vercel/functions'

// =============================================================================
// Airtime purchase flow (Hubtel Commission auto-fulfillment)
// Steps: airtime_start → airtime_network → airtime_amount → airtime_beneficiary → airtime_phone
//        → airtime_confirm → airtime_payment_method (registered users only)
// Beneficiary receives the amount entered (exact mode); customer pays amount + fee.
// =============================================================================

// Hubtel airtime ServiceIDs only exist for these three networks (canonical keys).
const NETWORK_MAP: Record<string, string> = { '1': 'MTN', '2': 'Telecel', '3': 'AT' }
const networkLabel = (network?: string) => (network === 'AT' ? 'AirtelTigo' : network ?? '')

// Default per-role admin airtime fee (matches the dashboard create route + migration seed).
const FEE_DEFAULTS: Record<string, string> = { customer: '5', agent: '3', dealer: '2' }
const MAX_DEFAULTS: Record<string, string> = { customer: '500', agent: '1000', dealer: '2000' }
const HUBTEL_AIRTIME_CAP = 100 // Hubtel Commission per-request airtime cap (GHS)

/** Resolve airtime min/max for a buyer role, hard-capped at the Hubtel per-request limit. */
async function resolveAirtimeLimits(supabase: SupabaseClient, role: string): Promise<{ min: number; max: number }> {
    const { data } = await supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', [`airtime_min_amount_${role}`, `airtime_max_amount_${role}`])
    const map: Record<string, string> = {}
    for (const row of (data ?? []) as any[]) map[row.key] = row.value
    const min = parseFloat(map[`airtime_min_amount_${role}`] ?? '1') || 1
    const roleMax = parseFloat(map[`airtime_max_amount_${role}`] ?? (MAX_DEFAULTS[role] ?? '500')) || 500
    return { min, max: Math.min(roleMax, HUBTEL_AIRTIME_CAP) }
}

/**
 * Per-network kill-switch (airtime_enabled_mtn/telecel/at). Dashboard (app/api/airtime/create/route.ts)
 * and storefront (lib/shop-checkout.ts) both refuse a purchase on a network the admin has disabled —
 * USSD airtime previously did NOT check this at all, so a customer could keep buying MTN/Telecel/AT
 * airtime over USSD after an admin disabled it elsewhere (Task 9 audit fix; real money impact since the
 * wallet/MoMo debit and order creation would still proceed). Mirrors mashup.ts's isMtnEnabled check.
 */
async function isNetworkEnabled(supabase: SupabaseClient, network: string): Promise<boolean> {
    const key = `airtime_enabled_${network.toLowerCase()}`
    const { data } = await supabase
        .from('admin_settings')
        .select('value')
        .eq('key', key)
        .maybeSingle()
    return (data as any)?.value !== 'false'
}

/**
 * Resolve the per-network airtime fee + price for a USSD airtime sale (per-network airtime
 * fee model, identical to dashboard/storefront). For a shop sale the fee = admin fee
 * (airtime_fee_<net>_<ownerRole>) + the shop's own markup (shop_profiles.airtime_fee_<net>);
 * the shop earns the shop-fee portion. For a direct sale the fee = airtime_fee_<net>_<buyerRole>.
 */
export async function resolveAirtimeUSSDPricing(
    supabase: SupabaseClient,
    network: string,
    airtimeAmount: number,
    opts: { shopId?: string | null; buyerRole?: string },
): Promise<{
    price: number; feeAmount: number; adminFeeAmount: number; shopFeeAmount: number
    adminFeeRate: number; shopFeeRate: number
    shopOwnerId: string | null; shopOwnerRole: string; shopName: string | null
    feeCapExceeded: boolean
}> {
    const net = network.toLowerCase() // 'MTN'→'mtn', 'Telecel'→'telecel', 'AT'→'at'
    let shopOwnerId: string | null = null
    let shopOwnerRole = 'customer'
    let shopName: string | null = null
    let shopFeeRate = 0

    if (opts.shopId) {
        const { data: sp } = await supabase
            .from('shop_profiles')
            .select(`owner_id, shop_name, airtime_fee_${net}`)
            .eq('id', opts.shopId)
            .maybeSingle()
        shopOwnerId = (sp as any)?.owner_id ?? null
        shopName = (sp as any)?.shop_name ?? null
        shopFeeRate = parseFloat(String((sp as any)?.[`airtime_fee_${net}`] ?? 0)) || 0

        if (shopOwnerId) {
            const { data: owner } = await supabase
                .from('users')
                .select('role, agent_expires_at, dealer_expires_at')
                .eq('id', shopOwnerId)
                .maybeSingle()
            shopOwnerRole = effectiveRole({
                id: shopOwnerId,
                role: (owner as any)?.role,
                agentExpiresAt: (owner as any)?.agent_expires_at ?? null,
                dealerExpiresAt: (owner as any)?.dealer_expires_at ?? null,
            })
        }
    }

    // Admin fee role: the shop owner's role for a shop sale, else the buyer's role.
    const adminFeeRole = opts.shopId ? shopOwnerRole : (opts.buyerRole || 'customer')
    const { data: feeRow } = await supabase
        .from('admin_settings')
        .select('value')
        .eq('key', `airtime_fee_${net}_${adminFeeRole}`)
        .maybeSingle()
    const adminFeeRate = parseFloat(String((feeRow as any)?.value ?? FEE_DEFAULTS[adminFeeRole] ?? '5')) || 0

    // Fee-cap defense-in-depth — matches lib/shop-checkout.ts's `shopFee + adminFee > 10` guard.
    // See the identical comment in mashup.ts's resolveMashupUSSDPricing for why this must be
    // re-checked at read time, not just when the shop owner's rate was originally saved.
    const feeCapExceeded = (shopFeeRate + adminFeeRate) > 10

    const { adminFeeAmount, shopFeeAmount, feeAmount, price } = computeAirtimePricing(airtimeAmount, adminFeeRate, shopFeeRate)
    return { price, feeAmount, adminFeeAmount, shopFeeAmount, adminFeeRate, shopFeeRate, shopOwnerId, shopOwnerRole, shopName, feeCapExceeded }
}

// =============================================================================
// Handler
// =============================================================================

export async function handleAirtime(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    switch (state.step) {
        case 'airtime_start':
            return showNetworkMenu(req, state)
        case 'airtime_network':
            return handleNetworkChoice(req, state, supabase)
        case 'airtime_amount':
            return handleAmountInput(req, state, supabase)
        case 'airtime_beneficiary':
            return handleBeneficiaryChoice(req, state, supabase)
        case 'airtime_phone':
            return handlePhoneInput(req, state, supabase)
        case 'airtime_confirm':
            return handleConfirm(req, state, supabase)
        case 'airtime_payment_method':
            return handlePaymentMethod(req, state, supabase)
        default:
            return showNetworkMenu(req, state)
    }
}

// ── Step 1: Network selection ─────────────────────────────────────────────────
function showNetworkMenu(req: HubtelRequest, state: USSDState): HubtelResponse {
    const newState: USSDState = { ...state, step: 'airtime_network', service: 'airtime' }
    return respond(req.SessionId, 'Buy Airtime\nSelect Network:\n1. MTN\n2. Telecel\n3. AirtelTigo\n0. Back', newState, 'Select Network')
}

async function handleNetworkChoice(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const choice = req.Message.trim()
    if (choice === '0') return showNetworkMenu(req, state)

    const network = NETWORK_MAP[choice]
    if (!network) {
        return respond(req.SessionId, 'Invalid choice.\nSelect Network:\n1. MTN\n2. Telecel\n3. AirtelTigo\n0. Back', { ...state, step: 'airtime_network' }, 'Select Network')
    }
    return showAmountPrompt(req, { ...state, network, step: 'airtime_amount' }, supabase)
}

// ── Step 2: Amount entry ──────────────────────────────────────────────────────
async function showAmountPrompt(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const user = await findUserByMobile(supabase, req.Mobile)
    const { min, max } = await resolveAirtimeLimits(supabase, effectiveRole(user))
    return respond(req.SessionId, `${networkLabel(state.network)} Airtime\nEnter amount (GHS ${min} - ${max}):`, { ...state, step: 'airtime_amount' }, 'Airtime Amount', 'decimal')
}

async function handleAmountInput(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const input = req.Message.trim()
    if (input === '0') return showNetworkMenu(req, state)

    if (!(await isNetworkEnabled(supabase, state.network!))) {
        return release(req.SessionId, `${networkLabel(state.network)} Airtime is currently unavailable. Please try again later.`)
    }

    const user = await findUserByMobile(supabase, req.Mobile)
    const buyerRole = effectiveRole(user)
    const { min, max } = await resolveAirtimeLimits(supabase, buyerRole)
    const amount = parseFloat(input)

    if (isNaN(amount) || amount <= 0) {
        return respond(req.SessionId, `Invalid amount.\nEnter a number (GHS ${min} - ${max}):`, { ...state, step: 'airtime_amount' }, 'Airtime Amount', 'decimal')
    }
    if (amount < min || amount > max) {
        return respond(req.SessionId, `Amount must be GHS ${min} - ${max}.\nEnter amount:`, { ...state, step: 'airtime_amount' }, 'Airtime Amount', 'decimal')
    }

    const pricing = await resolveAirtimeUSSDPricing(supabase, state.network!, amount, { shopId: state.shopId, buyerRole })
    if (pricing.feeCapExceeded) {
        const feeCapMsg = state.shopId
            ? `${networkLabel(state.network)} Airtime is temporarily unavailable (fee cap exceeded). Please contact the shop owner or try again later.`
            : `${networkLabel(state.network)} Airtime is temporarily unavailable (fee cap exceeded). Please try again later.`
        return release(req.SessionId, feeCapMsg)
    }
    const newState: USSDState = {
        ...state,
        airtimeAmount: amount,
        price: pricing.price,
        feeAmount: pricing.feeAmount,
        adminFeeAmount: pricing.adminFeeAmount,
        shopFeeAmount: pricing.shopFeeAmount,
        shopBasePrice: amount,
        ...(pricing.shopOwnerId ? { shopOwnerId: pricing.shopOwnerId } : {}),
        shopOwnerRole: pricing.shopOwnerRole,
        ...(pricing.shopName ? { shopName: pricing.shopName } : {}),
    }
    return showBeneficiaryMenu(req, newState, 'airtime_beneficiary')
}

// ── Step 3a: Who is this for? (My Self / Someone Else) ────────────────────────
async function handleBeneficiaryChoice(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    switch (parseBeneficiaryChoice(req.Message)) {
        case 'back':
            return showAmountPrompt(req, { ...state, step: 'airtime_amount' }, supabase)
        case 'self':
            // Same blacklist check as a typed number — no shortcut.
            return acceptRecipient(req, state, supabase, selfBeneficiaryPhone(req.Mobile))
        case 'other':
            return respond(req.SessionId, 'Enter recipient phone number:\n(e.g. 0244123456)', { ...state, step: 'airtime_phone' }, 'Recipient phone', 'phone')
        default:
            return showBeneficiaryMenu(req, state, 'airtime_beneficiary')
    }
}

// ── Step 3b: Recipient phone ──────────────────────────────────────────────────
async function handlePhoneInput(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const input = req.Message.trim()
    if (input === '0') return showBeneficiaryMenu(req, state, 'airtime_beneficiary')

    if (!isValidGhanaPhone(input)) {
        return respond(req.SessionId, 'Invalid phone number.\nEnter a valid Ghana number:\n(e.g. 0244123456)', { ...state, step: 'airtime_phone' }, 'Recipient phone', 'phone')
    }

    return acceptRecipient(req, state, supabase, normalizePhone(input))
}

/** Blacklist check for a (normalized) recipient, shared by typed and "My Self" numbers. */
async function acceptRecipient(req: HubtelRequest, state: USSDState, supabase: SupabaseClient, normalized: string): Promise<HubtelResponse> {
    const { data: blacklisted } = await supabase
        .from('phone_blacklist')
        .select('phone_number')
        .eq('phone_number', normalized)
        .maybeSingle()
    if (blacklisted) {
        return respond(req.SessionId, 'This number cannot receive airtime. Enter a different number:', { ...state, step: 'airtime_phone' }, 'Recipient phone', 'phone')
    }

    return showAirtimeConfirm(req, { ...state, recipientPhone: normalized, step: 'airtime_confirm' })
}

// ── Step 4: Confirm ───────────────────────────────────────────────────────────
function showAirtimeConfirm(req: HubtelRequest, state: USSDState): HubtelResponse {
    const msg = [
        `${networkLabel(state.network)} Airtime`,
        `Amount: ${formatGHS(state.airtimeAmount!)}`,
        `To: ${state.recipientPhone}`,
        `Pay: ${formatGHS(state.price!)}`,
        '',
        '1. Confirm',
        '0. Cancel',
    ].join('\n')
    return respond(req.SessionId, msg, { ...state, step: 'airtime_confirm' }, 'Confirm Airtime')
}

function buildAirtimePayload(state: USSDState, buyerRole: string): Record<string, unknown> {
    return {
        network:        state.network,
        beneficiaryPhone: state.recipientPhone,
        airtimeAmount:  state.airtimeAmount,
        price:          state.price,
        feeAmount:      state.feeAmount ?? 0,
        adminFeeAmount: state.adminFeeAmount ?? 0,
        shopFeeAmount:  state.shopFeeAmount ?? 0,
        buyerRole,
        shopId:         state.shopId ?? null,
        shopName:       state.shopName ?? null,
        shopOwnerId:    state.shopOwnerId ?? null,
        shopOwnerRole:  state.shopOwnerRole ?? null,
    }
}

async function handleConfirm(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const choice = req.Message.trim()
    if (choice === '0') return release(req.SessionId, 'Order cancelled. Dial *713*9939# to start again.')
    if (choice !== '1') return showAirtimeConfirm(req, state)

    const user = await findUserByMobile(supabase, req.Mobile)

    // Registered user → choose payment method (MoMo or wallet).
    if (user) {
        const balance = user.walletBalance ?? 0
        const balanceLine = balance >= state.price!
            ? `2. FameTech Wallet (Bal: ${formatGHS(balance)})`
            : '2. FameTech Wallet (Insufficient)'
        return respond(req.SessionId, ['HOW TO PAY:', '1. Mobile Money (MoMo)', balanceLine, '0. Cancel'].join('\n'), { ...state, step: 'airtime_payment_method' }, 'Payment Method')
    }

    // Guest → straight to MoMo.
    await savePendingOrder(supabase, {
        sessionId: req.SessionId,
        mobile: req.Mobile,
        serviceType: 'airtime',
        orderPayload: buildAirtimePayload(state, 'customer'),
        userId: null,
        price: state.price!,
        shopId: state.shopId ?? null,
        operator: req.Operator,
    })
    return addToCart(req.SessionId, 'Processing...\nYou will receive a payment prompt shortly.', {
        // Recipient MSISDN dropped — see the ItemName policy note in lib/ussd/utils.ts.
        // Republished by Hubtel to the dashboard/CSV `description` and the public
        // receipt, so no PII belongs here. Real order detail is in
        // ussd_pending_orders.order_payload.
        ItemName: `${networkLabel(state.network)} Airtime GHS ${state.airtimeAmount} — ${orderCode(req.SessionId)}`,
        Qty: 1,
        Price: state.price!,
    })
}

// ── Step 5: Payment method (registered users) ─────────────────────────────────
async function handlePaymentMethod(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const choice = req.Message.trim()
    if (choice === '0') return release(req.SessionId, 'Order cancelled. Dial again to start over.')

    const user = await findUserByMobile(supabase, req.Mobile)
    const buyerRole = effectiveRole(user)

    if (choice === '1') {
        // Mobile Money
        await savePendingOrder(supabase, {
            sessionId: req.SessionId,
            mobile: req.Mobile,
            serviceType: 'airtime',
            orderPayload: buildAirtimePayload(state, buyerRole),
            userId: user?.id ?? null,
            price: state.price!,
            shopId: state.shopId ?? null,
            operator: req.Operator,
        })
        return addToCart(req.SessionId, 'Processing...\nYou will receive a payment prompt shortly.', {
            // Recipient MSISDN dropped — see the ItemName policy note in lib/ussd/utils.ts.
        // Republished by Hubtel to the dashboard/CSV `description` and the public
        // receipt, so no PII belongs here. Real order detail is in
        // ussd_pending_orders.order_payload.
        ItemName: `${networkLabel(state.network)} Airtime GHS ${state.airtimeAmount} — ${orderCode(req.SessionId)}`,
            Qty: 1,
            Price: state.price!,
        })
    }

    if (choice === '2') {
        // FameTech Wallet
        if (!user || !user.walletId) return release(req.SessionId, 'Wallet not available. Please try again.')
        const balance = user.walletBalance ?? 0
        const price = state.price!
        if (balance < price) {
            return respond(req.SessionId, ['Insufficient wallet balance.', '', '1. Mobile Money', `2. FameTech Wallet (Bal: ${formatGHS(balance)})`, '0. Cancel'].join('\n'), { ...state, step: 'airtime_payment_method' }, 'Payment Method')
        }

        const supabaseAdmin = createAdminClient()
        const reference = `USSD-WALLET-AIR-${req.SessionId.toUpperCase()}`
        const result = await processWalletPayment({
            supabaseAdmin,
            userId: user.id,
            walletId: user.walletId,
            amount: price,
            description: `Airtime - ${networkLabel(state.network)} GHS ${state.airtimeAmount}`,
            reference,
        })

        if (!result.success) {
            if (result.error === 'INSUFFICIENT_BALANCE') {
                return respond(req.SessionId, ['Insufficient wallet balance.', '', '1. Mobile Money', `2. FameTech Wallet (Bal: ${formatGHS(balance)})`, '0. Cancel'].join('\n'), { ...state, step: 'airtime_payment_method' }, 'Payment Method')
            }
            return release(req.SessionId, 'Payment failed. Please try again.')
        }

        // Defensive double-charge guard: if a MoMo pending order was saved for this session
        // (e.g. the user toggled payment methods), neutralize it so a stray Hubtel MoMo charge
        // can't bill the customer a second time after the wallet has already paid.
        await supabase
            .from('ussd_pending_orders')
            .update({ status: 'failed' })
            .eq('session_id', req.SessionId)
            .eq('status', 'pending')
            .is('hubtel_order_id', null)

        const payload = buildAirtimePayload(state, buyerRole) as unknown as AirtimeOrderPayload

        // Record the debit synchronously so it can never be lost if the background promise drops.
        await recordWalletAwaitingFulfillment({
            supabaseAdmin, sessionId: req.SessionId, userId: user.id, mobile: req.Mobile,
            serviceType: 'airtime', amount: price, walletDebitReference: reference,
        })

        waitUntil(
            (async () => {
                const fr = await fulfillAirtimeUSSDOrder(supabaseAdmin, '', req.SessionId, req.Mobile, req.Operator, payload, user.id, null, 'wallet')
                if (fr.success) {
                    await clearWalletRefund(supabaseAdmin, req.SessionId)
                } else {
                    await markWalletRefundFailed({
                        supabaseAdmin, sessionId: req.SessionId, mobile: req.Mobile,
                        serviceType: 'airtime', amount: price, reason: fr.error ?? 'fulfillment failed',
                    })
                }
            })(),
        )

        return release(req.SessionId, 'Payment successful!\nYour airtime is being processed.\nCheck My Orders for status.')
    }

    // Invalid choice — re-show payment menu.
    const balance = user?.walletBalance ?? 0
    const balanceLine = balance >= state.price! ? `2. FameTech Wallet (Bal: ${formatGHS(balance)})` : '2. FameTech Wallet (Insufficient)'
    return respond(req.SessionId, ['HOW TO PAY:', '1. Mobile Money (MoMo)', balanceLine, '0. Cancel'].join('\n'), { ...state, step: 'airtime_payment_method' }, 'Payment Method')
}
