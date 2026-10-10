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
// MTN Mashup purchase flow (MANUAL fulfillment — never sent to Hubtel).
// Steps: mashup_start → mashup_amount → mashup_beneficiary → mashup_phone → mashup_confirm → mashup_payment_method
// MTN-only, no network step. Always bundle_preference='balanced' — no USSD prompt for it,
// matching the dashboard's mashup quick-buy and saving a screen/character budget.
// Beneficiary receives the amount entered (exact mode); customer pays amount + fee.
// =============================================================================

// Default per-role admin mashup fee/limit (matches app/api/airtime/create/route.ts).
const FEE_DEFAULTS: Record<string, string> = { customer: '5', agent: '3', dealer: '2' }
const MAX_DEFAULTS: Record<string, string> = { customer: '500', agent: '1000', dealer: '2000' }
const MASHUP_MIN_DEFAULT = '5'

/** Resolve mashup min/max for a buyer role. No Hubtel cap — mashup is manual fulfillment. */
async function resolveMashupLimits(supabase: SupabaseClient, role: string): Promise<{ min: number; max: number }> {
    const { data } = await supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', [`mashup_min_amount_${role}`, `mashup_max_amount_${role}`])
    const map: Record<string, string> = {}
    for (const row of (data ?? []) as any[]) map[row.key] = row.value
    const min = parseFloat(map[`mashup_min_amount_${role}`] ?? MASHUP_MIN_DEFAULT) || 5
    const max = parseFloat(map[`mashup_max_amount_${role}`] ?? (MAX_DEFAULTS[role] ?? '500')) || 500
    return { min, max }
}

/**
 * MTN network kill-switch. Mashup rides the same MTN rail as airtime, so if admin
 * disables MTN via airtime_enabled_mtn, mashup must also refuse — matching how the
 * dashboard (app/api/airtime/create/route.ts) and storefront (lib/shop-checkout.ts)
 * gate a mashup order on this same key. Mashup ALSO carries its own independent
 * per-network toggle (mashup_enabled_mtn) — exposed in the admin airtime settings
 * panel — so an admin can disable Mashup specifically without touching plain airtime
 * on the same network; both dashboard and storefront now check it too (Task 9 audit
 * fix — it was previously dead config that the admin UI exposed but nothing read).
 */
async function isMtnEnabled(supabase: SupabaseClient): Promise<boolean> {
    const { data } = await supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', ['airtime_enabled_mtn', 'mashup_enabled_mtn'])
    const map: Record<string, string> = {}
    for (const row of (data ?? []) as any[]) map[row.key] = row.value
    return map['airtime_enabled_mtn'] !== 'false' && map['mashup_enabled_mtn'] !== 'false'
}

/**
 * Resolve mashup fee + price for a USSD mashup sale — same shape as
 * resolveAirtimeUSSDPricing in airtime.ts, but network fixed to MTN and rates
 * read from the mashup_* settings / shop_profiles.mashup_fee_percent instead of
 * airtime's equivalents. Reuses computeAirtimePricing — the fee math is identical.
 */
export async function resolveMashupUSSDPricing(
    supabase: SupabaseClient,
    mashupAmount: number,
    opts: { shopId?: string | null; buyerRole?: string },
): Promise<{
    price: number; feeAmount: number; adminFeeAmount: number; shopFeeAmount: number
    adminFeeRate: number; shopFeeRate: number
    shopOwnerId: string | null; shopOwnerRole: string; shopName: string | null
    feeCapExceeded: boolean
}> {
    let shopOwnerId: string | null = null
    let shopOwnerRole = 'customer'
    let shopName: string | null = null
    let shopFeeRate = 0

    if (opts.shopId) {
        const { data: sp } = await supabase
            .from('shop_profiles')
            .select('owner_id, shop_name, mashup_fee_percent')
            .eq('id', opts.shopId)
            .maybeSingle()
        shopOwnerId = (sp as any)?.owner_id ?? null
        shopName = (sp as any)?.shop_name ?? null
        shopFeeRate = parseFloat(String((sp as any)?.mashup_fee_percent ?? 1)) || 1

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

    const adminFeeRole = opts.shopId ? shopOwnerRole : (opts.buyerRole || 'customer')
    const { data: feeRow } = await supabase
        .from('admin_settings')
        .select('value')
        .eq('key', `mashup_fee_mtn_${adminFeeRole}`)
        .maybeSingle()
    const adminFeeRate = parseFloat(String((feeRow as any)?.value ?? FEE_DEFAULTS[adminFeeRole] ?? '5')) || 0

    // Fee-cap defense-in-depth — matches lib/shop-checkout.ts's `shopFee + adminFee > 10` guard.
    // shop_profiles.mashup_fee_percent is capped at write time (app/api/shop/pricing/route.ts),
    // but that cap is computed against the admin fee AT THE TIME the shop owner set it — if the
    // admin later raises the admin fee, a previously-valid shop rate can push the combined total
    // fee arbitrarily high with no re-validation. The storefront re-checks this on every checkout;
    // USSD mashup must too, or a shop owner's markup could misrepresent what the admin configured.
    const feeCapExceeded = (shopFeeRate + adminFeeRate) > 10

    const { adminFeeAmount, shopFeeAmount, feeAmount, price } = computeAirtimePricing(mashupAmount, adminFeeRate, shopFeeRate)
    return { price, feeAmount, adminFeeAmount, shopFeeAmount, adminFeeRate, shopFeeRate, shopOwnerId, shopOwnerRole, shopName, feeCapExceeded }
}

// =============================================================================
// Handler
// =============================================================================

export async function handleMashup(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    switch (state.step) {
        case 'mashup_start':
            return showAmountPrompt(req, { ...state, network: 'MTN', service: 'mashup', step: 'mashup_amount' }, supabase)
        case 'mashup_amount':
            return handleAmountInput(req, state, supabase)
        case 'mashup_beneficiary':
            return handleBeneficiaryChoice(req, state, supabase)
        case 'mashup_phone':
            return handlePhoneInput(req, state, supabase)
        case 'mashup_confirm':
            return handleConfirm(req, state, supabase)
        case 'mashup_payment_method':
            return handlePaymentMethod(req, state, supabase)
        default:
            return showAmountPrompt(req, { ...state, network: 'MTN', service: 'mashup', step: 'mashup_amount' }, supabase)
    }
}

// ── Step 1: Amount entry (no network step — MTN only) ─────────────────────────
// Screen text explicitly says "MTN Mashup" — the first thing the user sees after
// choosing "Buy Mashup" from the menu, so they know the network is fixed.
async function showAmountPrompt(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const user = await findUserByMobile(supabase, req.Mobile)
    const { min, max } = await resolveMashupLimits(supabase, effectiveRole(user))
    return respond(req.SessionId, `MTN Mashup\nEnter amount (GHS ${min} - ${max}):`, { ...state, step: 'mashup_amount' }, 'MTN Mashup Amount', 'decimal')
}

async function handleAmountInput(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const input = req.Message.trim()
    if (input === '0') return release(req.SessionId, 'Order cancelled. Dial *713*9939# to start again.')

    if (!(await isMtnEnabled(supabase))) {
        return release(req.SessionId, 'MTN Mashup is currently unavailable. Please try again later.')
    }

    const user = await findUserByMobile(supabase, req.Mobile)
    const buyerRole = effectiveRole(user)
    const { min, max } = await resolveMashupLimits(supabase, buyerRole)
    const amount = parseFloat(input)

    if (isNaN(amount) || amount <= 0) {
        return respond(req.SessionId, `Invalid amount.\nEnter a number (GHS ${min} - ${max}):`, { ...state, step: 'mashup_amount' }, 'MTN Mashup Amount', 'decimal')
    }
    if (amount < min || amount > max) {
        return respond(req.SessionId, `Amount must be GHS ${min} - ${max}.\nEnter amount:`, { ...state, step: 'mashup_amount' }, 'MTN Mashup Amount', 'decimal')
    }

    const pricing = await resolveMashupUSSDPricing(supabase, amount, { shopId: state.shopId, buyerRole })
    if (pricing.feeCapExceeded) {
        const feeCapMsg = state.shopId
            ? 'MTN Mashup is temporarily unavailable (fee cap exceeded). Please contact the shop owner or try again later.'
            : 'MTN Mashup is temporarily unavailable (fee cap exceeded). Please try again later.'
        return release(req.SessionId, feeCapMsg)
    }
    const newState: USSDState = {
        ...state,
        network: 'MTN',
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
    return showBeneficiaryMenu(req, newState, 'mashup_beneficiary')
}

// ── Step 2a: Who is this for? (My Self / Someone Else) ────────────────────────
async function handleBeneficiaryChoice(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    switch (parseBeneficiaryChoice(req.Message)) {
        case 'back':
            return showAmountPrompt(req, { ...state, step: 'mashup_amount' }, supabase)
        case 'self':
            // Same blacklist check as a typed number — no shortcut.
            return acceptRecipient(req, state, supabase, selfBeneficiaryPhone(req.Mobile))
        case 'other':
            return respond(req.SessionId, 'Enter recipient phone number:\n(e.g. 0244123456)', { ...state, step: 'mashup_phone' }, 'Recipient phone', 'phone')
        default:
            return showBeneficiaryMenu(req, state, 'mashup_beneficiary')
    }
}

// ── Step 2b: Recipient phone ──────────────────────────────────────────────────
async function handlePhoneInput(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const input = req.Message.trim()
    if (input === '0') return showBeneficiaryMenu(req, state, 'mashup_beneficiary')

    if (!isValidGhanaPhone(input)) {
        return respond(req.SessionId, 'Invalid phone number.\nEnter a valid Ghana number:\n(e.g. 0244123456)', { ...state, step: 'mashup_phone' }, 'Recipient phone', 'phone')
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
        return respond(req.SessionId, 'This number cannot receive a mashup bundle. Enter a different number:', { ...state, step: 'mashup_phone' }, 'Recipient phone', 'phone')
    }

    return showMashupConfirm(req, { ...state, recipientPhone: normalized, step: 'mashup_confirm' })
}

// ── Step 3: Confirm ───────────────────────────────────────────────────────────
function showMashupConfirm(req: HubtelRequest, state: USSDState): HubtelResponse {
    const msg = [
        'MTN Mashup Bundle',
        `Amount: ${formatGHS(state.airtimeAmount!)}`,
        `To: ${state.recipientPhone}`,
        `Pay: ${formatGHS(state.price!)}`,
        '',
        '1. Confirm',
        '0. Cancel',
    ].join('\n')
    return respond(req.SessionId, msg, { ...state, step: 'mashup_confirm' }, 'Confirm MTN Mashup')
}

function buildMashupPayload(state: USSDState, buyerRole: string): Record<string, unknown> {
    return {
        network:        'MTN',
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
        orderType:      'mashup',
        bundlePreference: 'balanced',
    }
}

async function handleConfirm(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const choice = req.Message.trim()
    if (choice === '0') return release(req.SessionId, 'Order cancelled. Dial *713*9939# to start again.')
    if (choice !== '1') return showMashupConfirm(req, state)

    const user = await findUserByMobile(supabase, req.Mobile)

    // Registered user → choose payment method (MoMo or wallet).
    if (user) {
        const balance = user.walletBalance ?? 0
        const balanceLine = balance >= state.price!
            ? `2. FameTech Wallet (Bal: ${formatGHS(balance)})`
            : '2. FameTech Wallet (Insufficient)'
        return respond(req.SessionId, ['HOW TO PAY:', '1. Mobile Money (MoMo)', balanceLine, '0. Cancel'].join('\n'), { ...state, step: 'mashup_payment_method' }, 'Payment Method')
    }

    // Guest → straight to MoMo.
    await savePendingOrder(supabase, {
        sessionId: req.SessionId,
        mobile: req.Mobile,
        serviceType: 'mashup',
        orderPayload: buildMashupPayload(state, 'customer'),
        userId: null,
        price: state.price!,
        shopId: state.shopId ?? null,
        operator: req.Operator,
    })
    return addToCart(req.SessionId, 'Processing...\nYou will receive a payment prompt shortly.', {
        // Recipient MSISDN dropped — see the ItemName policy note in lib/ussd/utils.ts.
        ItemName: `MTN Mashup GHS ${state.airtimeAmount} — ${orderCode(req.SessionId)}`,
        Qty: 1,
        Price: state.price!,
    })
}

// ── Step 4: Payment method (registered users) ─────────────────────────────────
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
            serviceType: 'mashup',
            orderPayload: buildMashupPayload(state, buyerRole),
            userId: user?.id ?? null,
            price: state.price!,
            shopId: state.shopId ?? null,
            operator: req.Operator,
        })
        return addToCart(req.SessionId, 'Processing...\nYou will receive a payment prompt shortly.', {
            ItemName: `MTN Mashup GHS ${state.airtimeAmount} — ${orderCode(req.SessionId)}`,
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
            return respond(req.SessionId, ['Insufficient wallet balance.', '', '1. Mobile Money', `2. FameTech Wallet (Bal: ${formatGHS(balance)})`, '0. Cancel'].join('\n'), { ...state, step: 'mashup_payment_method' }, 'Payment Method')
        }

        const supabaseAdmin = createAdminClient()
        const reference = `USSD-WALLET-MASH-${req.SessionId.toUpperCase()}`
        const result = await processWalletPayment({
            supabaseAdmin,
            userId: user.id,
            walletId: user.walletId,
            amount: price,
            description: `Mashup - MTN GHS ${state.airtimeAmount}`,
            reference,
        })

        if (!result.success) {
            if (result.error === 'INSUFFICIENT_BALANCE') {
                return respond(req.SessionId, ['Insufficient wallet balance.', '', '1. Mobile Money', `2. FameTech Wallet (Bal: ${formatGHS(balance)})`, '0. Cancel'].join('\n'), { ...state, step: 'mashup_payment_method' }, 'Payment Method')
            }
            return release(req.SessionId, 'Payment failed. Please try again.')
        }

        // Defensive double-charge guard — same as airtime.ts: neutralize any stray pending
        // MoMo order for this session so it can't bill the customer a second time.
        await supabase
            .from('ussd_pending_orders')
            .update({ status: 'failed' })
            .eq('session_id', req.SessionId)
            .eq('status', 'pending')
            .is('hubtel_order_id', null)

        const payload = buildMashupPayload(state, buyerRole) as unknown as AirtimeOrderPayload

        // Record the debit synchronously so it can never be lost if the background promise drops.
        await recordWalletAwaitingFulfillment({
            supabaseAdmin, sessionId: req.SessionId, userId: user.id, mobile: req.Mobile,
            serviceType: 'mashup', amount: price, walletDebitReference: reference,
        })

        waitUntil(
            (async () => {
                const fr = await fulfillAirtimeUSSDOrder(supabaseAdmin, '', req.SessionId, req.Mobile, req.Operator, payload, user.id, null, 'wallet')
                if (fr.success) {
                    await clearWalletRefund(supabaseAdmin, req.SessionId)
                } else {
                    await markWalletRefundFailed({
                        supabaseAdmin, sessionId: req.SessionId, mobile: req.Mobile,
                        serviceType: 'mashup', amount: price, reason: fr.error ?? 'fulfillment failed',
                    })
                }
            })(),
        )

        return release(req.SessionId, 'Payment successful!\nYour Mashup bundle is being processed.\nCheck My Orders for status.')
    }

    // Invalid choice — re-show payment menu.
    const balance = user?.walletBalance ?? 0
    const balanceLine = balance >= state.price! ? `2. FameTech Wallet (Bal: ${formatGHS(balance)})` : '2. FameTech Wallet (Insufficient)'
    return respond(req.SessionId, ['HOW TO PAY:', '1. Mobile Money (MoMo)', balanceLine, '0. Cancel'].join('\n'), { ...state, step: 'mashup_payment_method' }, 'Payment Method')
}
