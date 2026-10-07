import type { SupabaseClient } from '@supabase/supabase-js'
import type { HubtelRequest, HubtelResponse, USSDState } from '../types'
import { respond, release, addToCart, formatGHS, isValidGhanaPhone } from '../utils'
import { savePendingOrder } from '../session'
import { findUserByMobile } from '../price-resolver'
import { createAdminClient } from '@/lib/supabase-admin'
import { processWalletPayment, recordWalletAwaitingFulfillment, clearWalletRefund, markWalletRefundFailed } from '../wallet-payment'
import { fulfillUtilityUSSDOrder, type UtilityOrderPayload } from '../fulfillment/utility'
import { queryUtilityAccount } from '@/lib/hubtel-utility/service'
import { toMsisdn233 } from '@/lib/hubtel-commission-service'
import { UTILITY_BILLERS, UTILITY_BILLER_KEYS, isUtilityBiller, type UtilityBiller } from '@/lib/hubtel-utility/billers'
import { parseSettingNumber } from '@/lib/paystack-fees'
import { waitUntil } from '@vercel/functions'

// =============================================================================
// Utility Bills purchase flow (Hubtel Commission Services — ECG / Ghana Water /
// DSTV / GOtv / StarTimes). Face value only: NO USSD fee, NO markup — CartItem
// Price = the amount entered.
//
// Steps: utility_start -> utility_biller
//        -> (ecg: utility_ecg_phone [-> utility_ecg_phone_entry] -> utility_ecg_meters)
//        -> (others: utility_account)
//        -> utility_confirm -> utility_amount -> utility_payment_method (registered) /
//           straight to MoMo (guest)
//
// The ECG "use my number" path is a UX gift the other billers don't get: Hubtel
// hands us the caller's own MSISDN on every request, so listing meters linked to
// it needs zero typing. Ghana Water's customer phone is likewise always the
// dialer's own number (Hubtel requires it on the query) — no separate phone step.
// =============================================================================

const ECG_METERS_PER_PAGE = 3
const MAX_ACCOUNT_LEN = 30
const MAX_LOOKUP_ATTEMPTS = 2 // friendly retry once, then release() on the 2nd failure

const BILLER_SHORT_LABEL: Record<UtilityBiller, string> = {
    ecg: 'ECG',
    ghana_water: 'Ghana Water',
    dstv: 'DSTV',
    gotv: 'GOtv',
    startimes: 'StarTimes',
}

const CONFIRM_HEADER: Record<UtilityBiller, string> = {
    ecg: 'ECG Top-Up',
    ghana_water: 'Ghana Water',
    dstv: 'DSTV',
    gotv: 'GOtv',
    startimes: 'StarTimes',
}

// =============================================================================
// Handler
// =============================================================================

export async function handleUtility(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    switch (state.step) {
        case 'utility_start':
            return showBillerMenu(req, state, supabase)
        case 'utility_biller':
            return handleBillerChoice(req, state, supabase)
        case 'utility_ecg_phone':
            return handleEcgPhoneChoice(req, state, supabase)
        case 'utility_ecg_phone_entry':
            return handleEcgPhoneEntry(req, state, supabase)
        case 'utility_ecg_meters':
            return handleEcgMeterChoice(req, state, supabase)
        case 'utility_account':
            return handleAccountInput(req, state, supabase)
        case 'utility_confirm':
            return handleUtilityConfirmChoice(req, state, supabase)
        case 'utility_amount':
            return handleAmountInput(req, state, supabase)
        case 'utility_payment_method':
            return handlePaymentMethod(req, state, supabase)
        default:
            return showBillerMenu(req, state, supabase)
    }
}

// ── Step 1: Biller selection ──────────────────────────────────────────────────

async function showBillerMenu(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const { data } = await supabase
        .from('admin_settings')
        .select('value')
        .eq('key', 'hubtel_utility_billers')
        .maybeSingle()

    const billersMap = (data as any)?.value
    const enabled: Record<string, boolean> =
        billersMap && typeof billersMap === 'object' && !Array.isArray(billersMap) ? billersMap : {}

    const lines = ['Pay Utility Bill']
    const menuMap: Record<string, string> = {}
    let n = 1
    for (const key of UTILITY_BILLER_KEYS) {
        if (enabled[key] === true) {
            lines.push(`${n}. ${BILLER_SHORT_LABEL[key]}`)
            menuMap[String(n)] = key
            n++
        }
    }

    if (Object.keys(menuMap).length === 0) {
        return release(req.SessionId, 'Utility bill payments are currently unavailable.')
    }
    lines.push('0. Back')

    const newState: USSDState = { ...state, step: 'utility_biller', service: 'utility', menuMap }
    return respond(req.SessionId, lines.join('\n'), newState, 'Pay Utility Bill')
}

async function handleBillerChoice(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const choice = req.Message.trim()
    // Mirrors airtime/data's "0. Back" on their FIRST screen — it re-shows this
    // same menu rather than exiting to the main menu (existing USSD convention).
    if (choice === '0') return showBillerMenu(req, state, supabase)

    const menuMap = (state.menuMap ?? {}) as Record<string, string>
    const biller = menuMap[choice]
    if (!biller || !isUtilityBiller(biller)) {
        if (Object.keys(menuMap).length === 0) return showBillerMenu(req, state, supabase)
        return respond(req.SessionId, 'Invalid choice. Enter a number from the list:', { ...state, step: 'utility_biller' }, 'Pay Utility Bill')
    }

    // menuMap has done its job (option -> biller key) — drop it so the rest of
    // this flow's ClientState stays well under Hubtel's truncation limit
    // (same P1-3 discipline data.ts uses once a bundle/exam type is picked).
    const newState: USSDState = {
        ...state,
        utilityBiller: biller,
        utilityLookupAttempts: 0,
        menuMap: undefined,
        step: biller === 'ecg' ? 'utility_ecg_phone' : 'utility_account',
    }

    if (biller === 'ecg') return showEcgPhoneChoice(req, newState)
    return showAccountPrompt(req, newState)
}

// ── Step 2a: ECG — "use my number" or enter another ────────────────────────────

function showEcgPhoneChoice(req: HubtelRequest, state: USSDState): HubtelResponse {
    const msg = "Use this number's meters?\n1. Yes\n2. Enter another number\n0. Back"
    return respond(req.SessionId, msg, { ...state, step: 'utility_ecg_phone' }, 'ECG Meters')
}

async function handleEcgPhoneChoice(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const choice = req.Message.trim()
    if (choice === '0') return showBillerMenu(req, { ...state, step: 'utility_biller' }, supabase)

    if (choice === '1') {
        const phone = toMsisdn233(req.Mobile)
        return showEcgMeterPage(req, { ...state, utilityPhone: phone, utilityMeterPage: 0 }, supabase)
    }
    if (choice === '2') {
        return respond(
            req.SessionId,
            'Enter meter phone number:\n(e.g. 0244123456)',
            { ...state, step: 'utility_ecg_phone_entry' },
            'Meter phone',
            'phone',
        )
    }
    return showEcgPhoneChoice(req, state)
}

async function handleEcgPhoneEntry(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const input = req.Message.trim()
    if (input === '0') return showEcgPhoneChoice(req, { ...state, step: 'utility_ecg_phone' })

    if (!isValidGhanaPhone(input)) {
        return respond(
            req.SessionId,
            'Invalid phone number.\nEnter a valid Ghana number:\n(e.g. 0244123456)',
            { ...state, step: 'utility_ecg_phone_entry' },
            'Meter phone',
            'phone',
        )
    }

    const phone = toMsisdn233(input)
    return showEcgMeterPage(req, { ...state, utilityPhone: phone, utilityMeterPage: 0 }, supabase)
}

// ── Step 2b: ECG meter list (paginated, data.ts menuMap idiom) ─────────────────

async function showEcgMeterPage(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const result = await queryUtilityAccount('ecg', state.utilityPhone!)

    if (!result.success || !result.info || result.info.meters.length === 0) {
        return handleLookupFailure(req, state)
    }

    const meters = result.info.meters
    const page = state.utilityMeterPage ?? 0
    const start = page * ECG_METERS_PER_PAGE
    const slice = meters.slice(start, start + ECG_METERS_PER_PAGE)

    if (slice.length === 0) {
        // Stale/out-of-range page (e.g. a shorter meter list on retry) — reset to page 0.
        return showEcgMeterPage(req, { ...state, utilityMeterPage: 0 }, supabase)
    }

    const hasMore = start + ECG_METERS_PER_PAGE < meters.length
    const lines = ['ECG - Select Meter:']
    const meterMap: Record<string, string> = {}

    slice.forEach((m, i) => {
        const n = i + 1
        const name24 = m.name.slice(0, 24).trim()
        const nameDisplay = m.name.slice(0, 14).trim()
        const last4 = m.meterNumber.slice(-4)
        lines.push(`${n}. ${nameDisplay} *${last4} GHS${m.outstanding.toFixed(2)}`)
        // "meterNumber|name24|outstanding" — packed so a selection never needs a second
        // Hubtel round-trip; the raw meter list itself is NEVER persisted across pages
        // (each page re-queries Hubtel, exactly like data.ts re-queries data_packages
        // on every "More" press) so ClientState never grows with the account's meter count.
        meterMap[String(n)] = `${m.meterNumber}|${name24}|${m.outstanding}`
    })

    const nextNum = slice.length + 1
    if (hasMore) {
        lines.push(`${nextNum}. More`)
        meterMap[String(nextNum)] = 'more'
    }
    lines.push('0. Back')

    const newState: USSDState = {
        ...state,
        step: 'utility_ecg_meters',
        utilityMeterPage: page,
        utilityMeterMap: meterMap,
        utilityLookupAttempts: 0,
    }
    return respond(req.SessionId, lines.join('\n'), newState, 'ECG Meters')
}

async function handleEcgMeterChoice(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const choice = req.Message.trim()
    const page = state.utilityMeterPage ?? 0

    if (choice === '0') {
        if (page > 0) return showEcgMeterPage(req, { ...state, utilityMeterPage: page - 1 }, supabase)
        // Backing out of the meter list entirely (not just a page) — drop its menuMap,
        // it is no longer "in use" once we return to the phone-choice screen.
        return showEcgPhoneChoice(req, { ...state, step: 'utility_ecg_phone', utilityMeterMap: undefined })
    }

    const meterMap = (state.utilityMeterMap ?? {}) as Record<string, string>
    const mapped = meterMap[choice]

    if (mapped === undefined) {
        if (Object.keys(meterMap).length === 0) return showEcgMeterPage(req, { ...state, utilityMeterPage: page }, supabase)
        return respond(req.SessionId, 'Invalid choice. Enter a number from the list:', { ...state, step: 'utility_ecg_meters' }, 'ECG Meters')
    }

    if (mapped === 'more') {
        return showEcgMeterPage(req, { ...state, utilityMeterPage: page + 1 }, supabase)
    }

    const [meterNumber, name, dueStr] = mapped.split('|')
    const newState: USSDState = {
        ...state,
        utilityAccount: meterNumber,
        utilityAccountName: name || undefined,
        utilityAmountDue: dueStr !== undefined && dueStr !== '' ? Number(dueStr) : undefined,
        // menuMap for this page has done its job — drop it before moving on.
        utilityMeterMap: undefined,
        step: 'utility_confirm',
    }
    return showUtilityConfirm(req, newState)
}

// ── Step 2c: Ghana Water / DSTV / GOtv / StarTimes — account entry ─────────────

function showAccountPrompt(req: HubtelRequest, state: USSDState): HubtelResponse {
    const biller = state.utilityBiller as UtilityBiller
    const def = UTILITY_BILLERS[biller]
    const msg = `${BILLER_SHORT_LABEL[biller]}\nEnter ${def.accountLabel}:`
    return respond(req.SessionId, msg, { ...state, step: 'utility_account' }, def.accountLabel)
}

async function handleAccountInput(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const input = req.Message.trim()
    const biller = state.utilityBiller as UtilityBiller
    const def = UTILITY_BILLERS[biller]

    if (input === '0') return showBillerMenu(req, { ...state, step: 'utility_biller' }, supabase)

    if (!input || input.length > MAX_ACCOUNT_LEN) {
        return respond(
            req.SessionId,
            `Invalid ${def.accountLabel}.\nEnter ${def.accountLabel}:`,
            { ...state, step: 'utility_account' },
            def.accountLabel,
        )
    }

    // Ghana Water queries REQUIRE the customer phone (&mobile=); it is always the
    // dialer's own MSISDN on USSD — same field airtime uses for the payer, no
    // separate phone-entry step. Other billers query by account/smartcard alone.
    const phone = toMsisdn233(req.Mobile)
    const mobileArg = biller === 'ghana_water' ? phone : undefined
    const result = await queryUtilityAccount(biller, input, mobileArg)

    if (!result.success || !result.info) {
        return handleLookupFailure(req, state)
    }

    const info = result.info
    const newState: USSDState = {
        ...state,
        utilityAccount: input,
        utilityAccountName: info.accountName ? info.accountName.slice(0, 24) : undefined,
        utilityAmountDue: info.amountDue !== null ? info.amountDue : undefined,
        utilityBouquet: info.bouquet ? info.bouquet.slice(0, 12) : undefined,
        utilityPhone: phone,
        utilityLookupAttempts: 0,
        step: 'utility_confirm',
    }
    return showUtilityConfirm(req, newState)
}

// ── Shared: lookup failure → friendly retry (2 attempts total), then release() ─

function handleLookupFailure(req: HubtelRequest, state: USSDState): HubtelResponse {
    const attempts = (state.utilityLookupAttempts ?? 0) + 1
    if (attempts >= MAX_LOOKUP_ATTEMPTS) {
        return release(req.SessionId, 'Could not verify this account right now. Please try again later.')
    }

    // Every failure path here leaves the meter-list screen (ECG) for good this
    // round — drop any stale utilityMeterMap so a failed "More" page-turn can
    // never leak a superseded page's menuMap into the retry/release state.
    const retryState: USSDState = { ...state, utilityLookupAttempts: attempts, utilityMeterMap: undefined }

    if (state.utilityBiller === 'ecg') {
        return respond(
            req.SessionId,
            "Couldn't find meters for that number.\n\nUse this number's meters?\n1. Yes\n2. Enter another number\n0. Back",
            { ...retryState, step: 'utility_ecg_phone' },
            'ECG Meters',
        )
    }

    const def = UTILITY_BILLERS[state.utilityBiller as UtilityBiller]
    return respond(
        req.SessionId,
        `Lookup failed. Try again.\nEnter ${def.accountLabel}:`,
        { ...retryState, step: 'utility_account' },
        def.accountLabel,
    )
}

// ── Step 3: Confirm ─────────────────────────────────────────────────────────────

function showUtilityConfirm(req: HubtelRequest, state: USSDState): HubtelResponse {
    const biller = state.utilityBiller as UtilityBiller
    const lines = [CONFIRM_HEADER[biller]]

    if (state.utilityAccountName) lines.push(state.utilityAccountName)

    const last4 = (state.utilityAccount ?? '').slice(-4)
    const acctLabel = biller === 'ecg' || biller === 'ghana_water' ? 'Mtr' : 'Acct'
    lines.push(`${acctLabel}: ...${last4}`)

    if (state.utilityAmountDue !== undefined && state.utilityAmountDue !== null) {
        lines.push(`Due: ${formatGHS(state.utilityAmountDue)}`)
    } else if (biller === 'startimes' && state.utilityBouquet) {
        lines.push(`Pkg: ${state.utilityBouquet}`)
    }

    // ECG NOTE: no separate consent screen on USSD — the customer IS the phone
    // owner dialing. When they entered a DIFFERENT number, warn on the confirm
    // screen instead. Derived by comparing the stored lookup phone to the
    // dialer's own MSISDN — no extra state flag needed.
    if (biller === 'ecg' && state.utilityPhone && toMsisdn233(req.Mobile) !== state.utilityPhone) {
        lines.push(`Meter will link to ${state.utilityPhone}`)
    }

    lines.push('1. Continue')
    lines.push('2. Cancel')

    return respond(req.SessionId, lines.join('\n'), { ...state, step: 'utility_confirm' }, CONFIRM_HEADER[biller])
}

async function handleUtilityConfirmChoice(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const choice = req.Message.trim()
    if (choice === '2') return release(req.SessionId, 'Order cancelled. Dial *713*9939# to start again.')
    if (choice !== '1') return showUtilityConfirm(req, state)
    return showAmountPrompt(req, { ...state, step: 'utility_amount' }, supabase)
}

// ── Step 4: Amount entry ────────────────────────────────────────────────────────

/** Global (not role-based) utility amount limits — re-fetched on every render/validate,
 *  same as airtime's resolveAirtimeLimits, so nothing needs to be carried in ClientState. */
async function resolveUtilityLimits(supabase: SupabaseClient): Promise<{ min: number; max: number }> {
    const { data } = await supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', ['utility_min_amount', 'utility_max_amount'])
    const map: Record<string, string> = {}
    for (const row of (data ?? []) as any[]) map[row.key] = row.value
    return {
        min: parseSettingNumber(map['utility_min_amount'], 1),
        max: parseSettingNumber(map['utility_max_amount'], 1000),
    }
}

async function showAmountPrompt(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const { min, max } = await resolveUtilityLimits(supabase)
    return respond(req.SessionId, `Enter amount (GHS ${min}-${max}):`, { ...state, step: 'utility_amount' }, 'Amount', 'decimal')
}

async function handleAmountInput(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const input = req.Message.trim()
    if (input === '0') return showUtilityConfirm(req, { ...state, step: 'utility_confirm' })

    const { min, max } = await resolveUtilityLimits(supabase)
    const amount = parseFloat(input)

    if (isNaN(amount) || amount <= 0) {
        return respond(req.SessionId, `Invalid amount.\nEnter a number (GHS ${min}-${max}):`, { ...state, step: 'utility_amount' }, 'Amount', 'decimal')
    }
    if (amount < min || amount > max) {
        return respond(req.SessionId, `Amount must be GHS ${min}-${max}.\nEnter amount:`, { ...state, step: 'utility_amount' }, 'Amount', 'decimal')
    }

    const roundedAmount = Math.round(amount * 100) / 100
    const newState: USSDState = { ...state, utilityAmount: roundedAmount, step: 'utility_payment_method' }

    const user = await findUserByMobile(supabase, req.Mobile)

    // Registered user → choose payment method (MoMo or wallet), mirrors airtime exactly.
    if (user) {
        const balance = user.walletBalance ?? 0
        const balanceLine = balance >= roundedAmount
            ? `2. Flexy-Wallet (Bal: ${formatGHS(balance)})`
            : '2. Flexy-Wallet (Insufficient)'
        return respond(req.SessionId, ['HOW TO PAY:', '1. Mobile Money (MoMo)', balanceLine, '0. Cancel'].join('\n'), newState, 'Payment Method')
    }

    // Guest → straight to MoMo.
    await savePendingOrder(supabase, {
        sessionId: req.SessionId,
        mobile: req.Mobile,
        serviceType: 'utility',
        orderPayload: buildUtilityPayload(newState) as unknown as Record<string, unknown>,
        userId: null,
        price: roundedAmount,
        shopId: newState.shopId ?? null,
        operator: req.Operator,
    })
    return addToCart(req.SessionId, 'Processing...\nYou will receive a payment prompt shortly.', {
        ItemName: `${BILLER_SHORT_LABEL[newState.utilityBiller as UtilityBiller]} GHS ${roundedAmount.toFixed(2)}`,
        Qty: 1,
        Price: roundedAmount,
    })
}

// ── Payload contract with Task F-fulfill (pinned — see lib/ussd/fulfillment/utility.ts) ──

function buildUtilityPayload(state: USSDState): UtilityOrderPayload {
    return {
        biller: state.utilityBiller as UtilityBiller,
        account: state.utilityAccount!,
        phone: state.utilityPhone!,
        accountName: state.utilityAccountName ?? null,
        amountGhs: state.utilityAmount!,
        shopId: state.shopId ?? null,
        shopName: state.shopName ?? null,
    }
}

// ── Step 5: Payment method (registered users) — mirrors airtime's handlePaymentMethod ──

async function handlePaymentMethod(req: HubtelRequest, state: USSDState, supabase: SupabaseClient): Promise<HubtelResponse> {
    const choice = req.Message.trim()
    if (choice === '0') return release(req.SessionId, 'Order cancelled. Dial again to start over.')

    const user = await findUserByMobile(supabase, req.Mobile)
    const amount = state.utilityAmount!
    const billerLabel = BILLER_SHORT_LABEL[state.utilityBiller as UtilityBiller]

    if (choice === '1') {
        // Mobile Money
        await savePendingOrder(supabase, {
            sessionId: req.SessionId,
            mobile: req.Mobile,
            serviceType: 'utility',
            orderPayload: buildUtilityPayload(state) as unknown as Record<string, unknown>,
            userId: user?.id ?? null,
            price: amount,
            shopId: state.shopId ?? null,
            operator: req.Operator,
        })
        return addToCart(req.SessionId, 'Processing...\nYou will receive a payment prompt shortly.', {
            ItemName: `${billerLabel} GHS ${amount.toFixed(2)}`,
            Qty: 1,
            Price: amount,
        })
    }

    if (choice === '2') {
        // Flexy-Wallet
        if (!user || !user.walletId) return release(req.SessionId, 'Wallet not available. Please try again.')
        const balance = user.walletBalance ?? 0
        if (balance < amount) {
            return respond(req.SessionId, ['Insufficient wallet balance.', '', '1. Mobile Money', `2. Flexy-Wallet (Bal: ${formatGHS(balance)})`, '0. Cancel'].join('\n'), { ...state, step: 'utility_payment_method' }, 'Payment Method')
        }

        const supabaseAdmin = createAdminClient()
        const reference = `USSD-WALLET-UTIL-${req.SessionId.toUpperCase()}`
        const result = await processWalletPayment({
            supabaseAdmin,
            userId: user.id,
            walletId: user.walletId,
            amount,
            description: `${billerLabel} - ${state.utilityAccount}`,
            reference,
        })

        if (!result.success) {
            if (result.error === 'INSUFFICIENT_BALANCE') {
                return respond(req.SessionId, ['Insufficient wallet balance.', '', '1. Mobile Money', `2. Flexy-Wallet (Bal: ${formatGHS(balance)})`, '0. Cancel'].join('\n'), { ...state, step: 'utility_payment_method' }, 'Payment Method')
            }
            return release(req.SessionId, 'Payment failed. Please try again.')
        }

        // Defensive double-charge guard: neutralize a stray MoMo pending order for this
        // session (e.g. the user toggled payment methods) — mirrors airtime exactly.
        await supabase
            .from('ussd_pending_orders')
            .update({ status: 'failed' })
            .eq('session_id', req.SessionId)
            .eq('status', 'pending')
            .is('hubtel_order_id', null)

        const payload = buildUtilityPayload(state)

        // Record the debit synchronously so it can never be lost if the background
        // promise drops — mirrors airtime's recordWalletAwaitingFulfillment call exactly.
        await recordWalletAwaitingFulfillment({
            supabaseAdmin, sessionId: req.SessionId, userId: user.id, mobile: req.Mobile,
            serviceType: 'utility', amount, walletDebitReference: reference,
        })

        waitUntil(
            (async () => {
                const fr = await fulfillUtilityUSSDOrder(supabaseAdmin, '', req.SessionId, req.Mobile, req.Operator, payload, user.id, null, 'wallet')
                if (fr.success) {
                    await clearWalletRefund(supabaseAdmin, req.SessionId)
                } else {
                    await markWalletRefundFailed({
                        supabaseAdmin, sessionId: req.SessionId, mobile: req.Mobile,
                        serviceType: 'utility', amount, reason: fr.error ?? 'fulfillment failed',
                    })
                }
            })(),
        )

        return release(req.SessionId, 'Payment successful!\nYour order is being processed.\nCheck My Orders for status.')
    }

    // Invalid choice — re-show payment menu with live balance.
    const balance = user?.walletBalance ?? 0
    const balanceLine = balance >= amount ? `2. Flexy-Wallet (Bal: ${formatGHS(balance)})` : '2. Flexy-Wallet (Insufficient)'
    return respond(req.SessionId, ['HOW TO PAY:', '1. Mobile Money (MoMo)', balanceLine, '0. Cancel'].join('\n'), { ...state, step: 'utility_payment_method' }, 'Payment Method')
}
