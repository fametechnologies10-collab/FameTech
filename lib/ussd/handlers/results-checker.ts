import type { SupabaseClient } from '@supabase/supabase-js'
import type { HubtelRequest, HubtelResponse, USSDState } from '../types'
import { respond, release, addToCart, formatGHS, normalizePhone } from '../utils'
import { resolveRCPrice } from '../price-resolver'
import { savePendingOrder, isPhoneBlacklisted } from '../session'
import { findUserByMobile } from '../price-resolver'
import { resolveUSSDFeePercent, applyFee } from '../fee'
import { getTypeById, getRCSettings, calculateRCPrice } from '@/lib/results-checker-service'
import { createAdminClient } from '@/lib/supabase-admin'
import { processWalletPayment, recordWalletAwaitingFulfillment, clearWalletRefund, markWalletRefundFailed } from '../wallet-payment'
import { fulfillRCOrder } from '../fulfillment/results-checker'
import { waitUntil } from '@vercel/functions'

// =============================================================================
// Results Checker flow
// Steps: rc_start → rc_type → rc_qty → rc_confirm
//        → rc_payment_method (registered users only)
//
// v3 changes:
//   - Title/header: "WAEC RESULTS CHECKER" (always all-caps)
//   - Blank line between choices and "0. Back" on every screen
//   - Quantity menu is paginated (PAGE_SIZE items per screen)
//   - "More" appears as last option if more pages follow
//   - Bulk redirect ("Visit kingflexygh.com") only on the final page
//   - Phone entry screen removed — delivery SMS goes to dialer's number
// =============================================================================

const MAX_QTY_SETTING = 'ussd_max_rc_quantity'
const RC_HEADER       = 'WAEC RESULTS CHECKER'
const PAGE_SIZE       = 5   // max quantity options visible per screen

export async function handleResultsChecker(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    switch (state.step) {
        case 'rc_start':
        case 'rc_type':
            return state.step === 'rc_start'
                ? showExamTypes(req, state, supabase)
                : handleTypeChoice(req, state, supabase)
        case 'rc_qty':
            return handleQtyChoice(req, state, supabase)
        case 'rc_confirm':
            return handleConfirm(req, state, supabase)
        case 'rc_payment_method':
            return handleRCPaymentMethod(req, state, supabase)
        default:
            return showExamTypes(req, state, supabase)
    }
}

// ── Step 1: Show active exam types (names only — no prices) ───────────────────

async function showExamTypes(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId } = req

    const { data: types } = await supabase
        .from('results_checker_types')
        .select('id, name')
        .eq('is_active', true)
        .order('display_order', { ascending: true })

    if (!types || types.length === 0) {
        return respond(
            SessionId,
            `${RC_HEADER}\n\nNo exam types available right now.\n\n0. Back`,
            { ...state, step: 'rc_type' },
            RC_HEADER,
        )
    }

    const lines = [`${RC_HEADER}`, '', 'Select Exam Type:']
    const optionMap: Record<string, string> = {}

    types.forEach((t, i) => {
        const n = i + 1
        lines.push(`${n}. ${(t as any).name}`)
        optionMap[String(n)] = t.id as string
    })

    // Blank line before "0. Back"
    lines.push('')
    lines.push('0. Back')

    const newState: USSDState = {
        ...state,
        step: 'rc_type',
        menuMap: optionMap,
    }

    return respond(SessionId, lines.join('\n'), newState, RC_HEADER)
}

// ── Step 2: Handle exam type choice → resolve price → show quantity menu ──────

async function handleTypeChoice(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Mobile } = req
    const choice = req.Message.trim()

    if (choice === '0') return showExamTypes(req, { ...state, step: 'rc_start' }, supabase)

    const optionMap = (state.menuMap ?? {}) as Record<string, string>
    const typeId = optionMap[choice]

    if (!typeId) {
        return respond(
            SessionId,
            `${RC_HEADER}\n\nInvalid choice. Please enter a number from the list.\n\n0. Back`,
            { ...state, step: 'rc_type' },
            RC_HEADER,
        )
    }

    // Fetch type name
    const { data: rcType } = await supabase
        .from('results_checker_types')
        .select('name')
        .eq('id', typeId)
        .maybeSingle()

    // Resolve the owner-role-based unit price + shop markup (per-exam override wins) in one
    // place. resolveRCPrice now mirrors the storefront, so USSD prices and credits the owner
    // identically — the flat-markup-only lookup here previously ignored per-exam pricing.
    const resolved = await resolveRCPrice(supabase, typeId, Mobile, state.shopId)
    if (!resolved) return release(SessionId, 'Service unavailable. Please try again.')

    const newState: USSDState = {
        ...state,
        rcTypeId:    typeId,
        rcTypeName:  (rcType as any)?.name ?? '',
        rcUnitPrice: resolved.price,
        rcQtyPage:   0,   // always start on page 0
        step: 'rc_qty',
        rcShopMarkup: resolved.shopMarkup,
        // Carry the pricing context so the quantity menu can re-price bulk tiers (shop path only).
        rcOwnerRole:  resolved.ownerRole,
        rcRawMarkup:  resolved.rawMarkup,
    }

    return showQuantityMenu(req, newState, supabase)
}

// ── Step 3: Show paginated quantity menu ───────────────────────────────────────
// Layout per page:
//   WAEC RESULTS CHECKER
//
//   [EXAM TYPE NAME]
//   Select Quantity:
//   1. GHS X.XX = 1
//   ...
//   N. More            ← if more quantities exist on the next page
//   OR
//   N. Bulk? Visit kingflexygh.com  ← only on the final page
//
//   0. Back

// Load the bulk-pricing context ONCE per render for a shop RC sale (the full type +
// admin settings), so the quantity loop can re-price every quantity through calculateRCPrice
// without re-fetching. Returns null on the admin (non-shop) path or when the type is gone.
async function loadRCBulkCtx(state: USSDState): Promise<{ type: any; settings: Record<string, string> } | null> {
    if (!(state.shopId && state.rcOwnerRole && state.rcTypeId)) return null
    const [type, settings] = await Promise.all([getTypeById(state.rcTypeId), getRCSettings()])
    return type ? { type, settings } : null
}

// Base subtotal (before the USSD fee) for a given quantity. Shop path re-prices via
// calculateRCPrice so bulk tiers + the markup cap apply EXACTLY like the storefront; the admin
// (non-shop) path keeps the flat unit price. Falls back to flat if the type context is missing.
async function rcBaseSubtotal(
    state: USSDState,
    qty: number,
    ctx: { type: any; settings: Record<string, string> } | null,
): Promise<number> {
    if (state.shopId && state.rcOwnerRole && ctx?.type) {
        const bd = await calculateRCPrice({
            type: ctx.type,
            quantity: qty,
            userRole: state.rcOwnerRole,
            shopMarkup: state.rcRawMarkup ?? 0,
            includePaystackFee: false,
            settings: ctx.settings,
        })
        return bd.subtotal
    }
    return parseFloat((state.rcUnitPrice! * qty).toFixed(2))
}

async function showQuantityMenu(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId } = req

    // ── Fetch admin max quantity ──
    const { data: maxQtySetting } = await supabase
        .from('admin_settings')
        .select('value')
        .eq('key', MAX_QTY_SETTING)
        .maybeSingle()
    const configuredMax = parseInt((maxQtySetting as any)?.value ?? '3', 10) || 3

    // ── Check available stock ──
    const { count: stockCount } = await supabase
        .from('results_checker_inventory')
        .select('id', { count: 'exact', head: true })
        .eq('type_id', state.rcTypeId!)
        .eq('status', 'available')

    const available = stockCount ?? 0

    if (available === 0) {
        return respond(
            SessionId,
            `${RC_HEADER}\n\n${state.rcTypeName?.toUpperCase()} is out of stock.\n\n0. Back`,
            { ...state, step: 'rc_type' },
            RC_HEADER,
        )
    }

    const effectiveMax = Math.min(configuredMax, available)
    const page         = state.rcQtyPage ?? 0

    const feePercent = await resolveUSSDFeePercent(supabase, state.shopId)
    // Bulk-pricing context for a shop sale (null on the admin path). Loaded once for this page.
    const bulkCtx = await loadRCBulkCtx(state)

    // ── Pagination math ──
    const startQty  = page * PAGE_SIZE + 1          // first quantity on this page (1-based)
    const endQty    = Math.min(startQty + PAGE_SIZE - 1, effectiveMax)
    const hasMore   = endQty < effectiveMax          // there are more quantity options after this page

    // ── Build lines ──
    const typeName = state.rcTypeName!.toUpperCase()
    const lines = [typeName, '', 'Select Quantity:']

    const optionMap: Record<string, number | 'more' | 'bulk'> = {}
    let listNum = 1  // the number shown on screen (always starts at 1 per page)

    for (let qty = startQty; qty <= endQty; qty++) {
        const baseTotal = await rcBaseSubtotal(state, qty, bulkCtx)
        const total = applyFee(baseTotal, feePercent)
        lines.push(`${listNum}. ${formatGHS(total)} - ${qty} Voucher`)
        optionMap[String(listNum)] = qty
        listNum++
    }

    if (hasMore) {
        // "More" leads to the next page
        lines.push(`${listNum}. More`)
        optionMap[String(listNum)] = 'more'
    } else {
        // Final page — show bulk redirect
        lines.push(`${listNum}. Bulk? Visit kingflexygh.com`)
        optionMap[String(listNum)] = 'bulk'
    }

    // Blank line before "0. Back"
    lines.push('')
    lines.push('0. Back')

    const newState: USSDState = {
        ...state,
        step: 'rc_qty',
        rcQtyPage: page,
        menuMap: optionMap,
    }

    return respond(SessionId, lines.join('\n'), newState, RC_HEADER)
}

// ── Step 3 (input): Handle quantity menu choice ────────────────────────────────

async function handleQtyChoice(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId } = req
    const choice = req.Message.trim()

    // "0. Back" — go back one page, or back to exam type list if on page 0
    if (choice === '0') {
        const currentPage = state.rcQtyPage ?? 0
        if (currentPage > 0) {
            // Go back to previous quantity page
            return showQuantityMenu(req, { ...state, rcQtyPage: currentPage - 1 }, supabase)
        }
        // Back to exam type list
        return showExamTypes(req, { ...state, step: 'rc_start' }, supabase)
    }

    const optionMap = (state.menuMap ?? {}) as Record<string, number | 'more' | 'bulk'>
    const selection = optionMap[choice]

    if (selection === undefined) {
        // Invalid input — re-show same page
        return showQuantityMenu(req, state, supabase)
    }

    // "More" — advance to next page
    if (selection === 'more') {
        const nextPage = (state.rcQtyPage ?? 0) + 1
        return showQuantityMenu(req, { ...state, rcQtyPage: nextPage }, supabase)
    }

    // "Bulk" — release with website redirect
    if (selection === 'bulk') {
        return release(
            SessionId,
            'For bulk orders visit\nkingflexygh.com\nfor special bulk pricing.',
        )
    }

    // Numeric quantity selected
    const qty = selection as number

    // Verify stock is still available for the chosen quantity
    const { count } = await supabase
        .from('results_checker_inventory')
        .select('id', { count: 'exact', head: true })
        .eq('type_id', state.rcTypeId!)
        .eq('status', 'available')

    if ((count ?? 0) < qty) {
        // Re-show menu; showQuantityMenu will handle out-of-stock
        return showQuantityMenu(req, { ...state, rcQtyPage: 0 }, supabase)
    }

    const deliveryPhone = normalizePhone(req.Mobile)
    const feePercent = await resolveUSSDFeePercent(supabase, state.shopId)

    // Bulk-aware final pricing for a shop sale: re-price the SELECTED quantity through
    // calculateRCPrice so a qualifying bulk tier + the markup cap apply, then persist the
    // resulting per-unit price + capped markup so confirm + fulfilment/credit use them.
    let rcUnitPrice  = state.rcUnitPrice!
    let rcShopMarkup = Number(state.rcShopMarkup ?? 0)
    let baseTotal: number
    const bulkCtx = await loadRCBulkCtx(state)
    if (bulkCtx?.type && state.rcOwnerRole) {
        const bd = await calculateRCPrice({
            type: bulkCtx.type, quantity: qty, userRole: state.rcOwnerRole,
            shopMarkup: state.rcRawMarkup ?? 0, includePaystackFee: false, settings: bulkCtx.settings,
        })
        baseTotal    = bd.subtotal
        rcUnitPrice  = parseFloat((bd.unitPrice + bd.shopMarkup).toFixed(2))
        rcShopMarkup = bd.shopMarkup
    } else {
        baseTotal = parseFloat((state.rcUnitPrice! * qty).toFixed(2))
    }
    const totalPrice = applyFee(baseTotal, feePercent)

    const newState: USSDState = {
        ...state,
        rcQuantity: qty,
        price: totalPrice,
        recipientPhone: deliveryPhone,
        rcUnitPrice,
        rcShopMarkup,
        step: 'rc_confirm',
    }

    return showRCConfirm(req, newState)
}

// ── Step 4: Order confirmation ─────────────────────────────────────────────────

function showRCConfirm(req: HubtelRequest, state: USSDState): HubtelResponse {
    const { SessionId } = req

    const msg = [
        'ORDER SUMMARY',
        `Description: ${state.rcTypeName}`,
        `Quantity: ${state.rcQuantity}`,
        `Amount: ${formatGHS(state.price!)}`,
        '',
        'Confirm your order?',
        '1. Confirm',
        '0. Cancel',
    ].join('\n')

    return respond(SessionId, msg, { ...state, step: 'rc_confirm' }, RC_HEADER)
}

async function handleConfirm(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Mobile } = req
    const choice = req.Message.trim()

    if (choice === '0') {
        return release(SessionId, 'Order cancelled. Dial again to start over.')
    }

    if (choice !== '1') return showRCConfirm(req, state)

    // P2-3: block fraud-flagged delivery numbers (RC PINs go to the dialer).
    if (await isPhoneBlacklisted(supabase, normalizePhone(Mobile))) {
        return release(SessionId, 'This number cannot be used for this service. Please contact support.')
    }

    const user = await findUserByMobile(supabase, Mobile)

    // Registered user: show payment method selection instead of going straight to MoMo
    if (user) {
        const balance = user.walletBalance ?? 0
        const price = state.price!
        const balanceLine = balance >= price
            ? `2. Flexy-Wallet (Bal: ${formatGHS(balance)})`
            : `2. Flexy-Wallet (Insufficient)`

        const msg = [
            'HOW TO PAY:',
            '1. Mobile Money (MoMo)',
            balanceLine,
            '0. Cancel',
        ].join('\n')

        return respond(
            SessionId,
            msg,
            { ...state, step: 'rc_payment_method' },
            'Payment Method',
        )
    }

    // Guest user: proceed directly to MoMo (existing flow)
    const deliveryPhone = normalizePhone(Mobile)
    const rcShopMarkup = Number(state.rcShopMarkup ?? 0)

    await savePendingOrder(supabase, {
        sessionId:    SessionId,
        mobile:       Mobile,
        serviceType:  'results_checker',
        orderPayload: {
            typeId:        state.rcTypeId,
            typeName:      state.rcTypeName,
            quantity:      state.rcQuantity,
            unitPrice:     state.rcUnitPrice,
            deliveryPhone,
            totalPrice:    state.price,
            shopId:        state.shopId ?? null,
            shopMarkup:    rcShopMarkup,
        },
        userId:  null,
        price:   state.price!,
        shopId:  state.shopId ?? null,
        operator: req.Operator,
    })

    return addToCart(
        SessionId,
        `Processing...\nYou will receive a payment prompt shortly.`,
        {
            ItemName: `${state.rcTypeName} x${state.rcQuantity} PIN(s)`,
            Qty: state.rcQuantity!,
            Price: state.price!,
        },
    )
}

// ── Step 5: Payment method selection (registered users only) ──────────────────

async function handleRCPaymentMethod(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Mobile, Operator } = req
    const choice = req.Message.trim()

    if (choice === '0') {
        return release(SessionId, 'Order cancelled. Dial again to start over.')
    }

    if (choice === '1') {
        // Mobile Money path — save pending order then trigger Hubtel MoMo
        const user = await findUserByMobile(supabase, Mobile)
        const deliveryPhone = normalizePhone(Mobile)
        const rcShopMarkup = Number(state.rcShopMarkup ?? 0)

        await savePendingOrder(supabase, {
            sessionId:    SessionId,
            mobile:       Mobile,
            serviceType:  'results_checker',
            orderPayload: {
                typeId:        state.rcTypeId,
                typeName:      state.rcTypeName,
                quantity:      state.rcQuantity,
                unitPrice:     state.rcUnitPrice,
                deliveryPhone,
                totalPrice:    state.price,
                shopId:        state.shopId ?? null,
                shopMarkup:    rcShopMarkup,
            },
            userId:  user?.id ?? null,
            price:   state.price!,
            shopId:  state.shopId ?? null,
            operator: Operator,
        })

        return addToCart(
            SessionId,
            `Processing...\nYou will receive a payment prompt shortly.`,
            {
                ItemName: `${state.rcTypeName} x${state.rcQuantity} PIN(s)`,
                Qty: state.rcQuantity!,
                Price: state.price!,
            },
        )
    }

    if (choice === '2') {
        // Flexy-Wallet path
        const user = await findUserByMobile(supabase, Mobile)

        if (!user || !user.walletId) {
            return release(SessionId, 'Wallet not available. Please try again.')
        }

        const balance = user.walletBalance ?? 0
        const price = state.price!

        if (balance < price) {
            const balanceLine = `2. Flexy-Wallet (Bal: ${formatGHS(balance)})`
            const msg = [
                'Insufficient wallet balance.',
                '',
                '1. Mobile Money',
                balanceLine,
                '0. Cancel',
            ].join('\n')
            return respond(
                SessionId,
                msg,
                { ...state, step: 'rc_payment_method' },
                'Payment Method',
            )
        }

        const supabaseAdmin = createAdminClient()

        const reference = `USSD-WALLET-RC-${SessionId.toUpperCase()}`
        const result = await processWalletPayment({
            supabaseAdmin,
            userId:      user.id,
            walletId:    user.walletId,
            amount:      price,
            description: `Results Checker - ${state.rcTypeName} x${state.rcQuantity}`,
            reference,
        })

        if (!result.success) {
            if (result.error === 'INSUFFICIENT_BALANCE') {
                const balanceLine = `2. Flexy-Wallet (Bal: ${formatGHS(balance)})`
                const msg = [
                    'Insufficient wallet balance.',
                    '',
                    '1. Mobile Money',
                    balanceLine,
                    '0. Cancel',
                ].join('\n')
                return respond(
                    SessionId,
                    msg,
                    { ...state, step: 'rc_payment_method' },
                    'Payment Method',
                )
            }
            return release(SessionId, 'Payment failed. Please try again.')
        }

        // Payment succeeded — trigger fulfillment in background
        const deliveryPhone = normalizePhone(Mobile)
        const rcShopMarkup = Number(state.rcShopMarkup ?? 0)

        const payload = {
            typeId:        state.rcTypeId!,
            typeName:      state.rcTypeName!,
            quantity:      state.rcQuantity!,
            unitPrice:     state.rcUnitPrice!,
            deliveryPhone,
            totalPrice:    price,
            shopId:        state.shopId ?? null,
            shopMarkup:    rcShopMarkup,
        }

        // HIGH-4: record the debit synchronously so it can never be lost.
        await recordWalletAwaitingFulfillment({
            supabaseAdmin, sessionId: SessionId, userId: user.id, mobile: Mobile,
            serviceType: 'results_checker', amount: price, walletDebitReference: reference,
        })

        waitUntil(
            (async () => {
                const fulfillResult = await fulfillRCOrder(supabaseAdmin, '', SessionId, Mobile, Operator, payload, user.id, null, 'wallet')
                if (fulfillResult.success) {
                    await clearWalletRefund(supabaseAdmin, SessionId)
                } else {
                    await markWalletRefundFailed({
                        supabaseAdmin, sessionId: SessionId, mobile: Mobile,
                        serviceType: 'results_checker', amount: price,
                        reason: fulfillResult.error ?? 'fulfillment failed',
                    })
                }
            })(),
        )

        return release(
            SessionId,
            'Payment successful!\nYour voucher(s) are being processed.\nCheck My Orders for status.',
        )
    }

    // Invalid choice — re-show payment method menu with live balance
    const user = await findUserByMobile(supabase, Mobile)
    const balance = user?.walletBalance ?? 0
    const price = state.price!
    const balanceLine = balance >= price
        ? `2. Flexy-Wallet (Bal: ${formatGHS(balance)})`
        : `2. Flexy-Wallet (Insufficient)`

    const msg = [
        'HOW TO PAY:',
        '1. Mobile Money (MoMo)',
        balanceLine,
        '0. Cancel',
    ].join('\n')

    return respond(
        SessionId,
        msg,
        { ...state, step: 'rc_payment_method' },
        'Payment Method',
    )
}
