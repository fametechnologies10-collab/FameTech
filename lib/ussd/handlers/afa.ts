import type { SupabaseClient } from '@supabase/supabase-js'
import type { HubtelRequest, HubtelResponse, USSDState } from '../types'
import { respond, release, addToCart, formatGHS, isValidGhanaPhone, normalizePhone, orderCode } from '../utils'
import { resolveNonShopAfaBase, resolveShopAfaPricing } from '../price-resolver'
import { savePendingOrder, isPhoneBlacklisted } from '../session'
import { findUserByMobile } from '../price-resolver'
import { resolveUSSDFeePercent, applyFee } from '../fee'
import { createAdminClient } from '@/lib/supabase-admin'
import { processWalletPayment, recordWalletAwaitingFulfillment, clearWalletRefund, markWalletRefundFailed } from '../wallet-payment'
import { fulfillAFAOrder, type AFAOrderPayload } from '../fulfillment/afa'
import { waitUntil } from '@vercel/functions'
import { showBeneficiaryMenu, parseBeneficiaryChoice, selfBeneficiaryPhone } from '../beneficiary'

// =============================================================================
// AFA Registration flow
// Steps: afa_intro → afa_name → afa_id_number →
//        afa_beneficiary → afa_phone → afa_region → afa_location → afa_dob → afa_occupation → afa_confirm
// (id_type step removed — Ghana Card is the only accepted ID)
// =============================================================================

const REGIONS_PAGE1 = [
    'Greater Accra', 'Ashanti', 'Western', 'Eastern',
    'Central', 'Volta', 'Northern', 'Bono',
]
const REGIONS_PAGE2 = [
    'Bono East', 'Ahafo', 'Upper East', 'Upper West',
    'Savannah', 'North East', 'Oti', 'Western North',
]

const GC_PATTERN = /^GHA-\d{9}-\d$/
const GC_HINT = 'Format: GHA-XXXXXXXXX-X'

export async function handleAfa(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    switch (state.step) {
        case 'afa_start':
        case 'afa_intro':
            return state.step === 'afa_start'
                ? showAfaIntro(req, state, supabase)
                : handleAfaIntroChoice(req, state, supabase)
        case 'afa_name':      return handleName(req, state)
        case 'afa_id_number': return handleIdNumber(req, state)
        case 'afa_beneficiary': return handleBeneficiary(req, state)
        case 'afa_phone':     return handlePhone(req, state)
        case 'afa_region':    return handleRegionChoice(req, state)
        case 'afa_location':  return handleLocation(req, state)
        case 'afa_dob':       return handleDob(req, state)
        case 'afa_occupation':return handleOccupation(req, state)
        case 'afa_confirm':        return handleConfirm(req, state, supabase)
        case 'afa_payment_method': return handleAFAPaymentMethod(req, state, supabase)
        default:                   return showAfaIntro(req, state, supabase)
    }
}

// ── Intro screen ──────────────────────────────────────────────────────────────

async function showAfaIntro(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    // GLOBAL CONSTRAINT (Task 3, Step 6): for a NORMAL (non-sub-agent) shop — and for the
    // non-shop admin/guest path — resolveShopAfaPricing/resolveAFAPrice reproduce the exact
    // pre-existing dialer-role-based `basePrice` byte-for-byte. Only a sub-agent-owned shop
    // gets a different sellingBase (shop_profiles.afa_selling_price).
    let sellingBase: number
    if (state.shopId) {
        const shopPricing = await resolveShopAfaPricing(supabase, req.Mobile, state.shopId)
        if (!shopPricing) {
            return release(req.SessionId, 'AFA registration is not available for this shop right now.')
        }
        sellingBase = shopPricing.sellingBase
    } else {
        const nonShop = await resolveNonShopAfaBase(supabase, req.Mobile)
        if (!nonShop) {
            return release(req.SessionId, 'AFA registration is not available for your account right now.')
        }
        sellingBase = nonShop.price
    }
    const feePercent = await resolveUSSDFeePercent(supabase, state.shopId)
    const price = applyFee(sellingBase, feePercent)
    const msg = [
        'AFA Registration',
        `Fee: ${formatGHS(price)}`,
        '',
        'Have your Ghana Card ready.',
        '',
        '1. Start Registration',
        '0. Back',
    ].join('\n')
    return respond(req.SessionId, msg, { ...state, step: 'afa_intro', price }, 'AFA Registration')
}

function handleAfaIntroChoice(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const choice = req.Message.trim()
    if (choice === '0') return showAfaIntro(req, { ...state, step: 'afa_start' }, supabase)
    if (choice === '1') {
        return Promise.resolve(
            respond(
                req.SessionId,
                'Enter your full name:\n(e.g. John Kwame Mensah)',
                { ...state, step: 'afa_name' },
                'Full Name',
                'text',
            ),
        )
    }
    return showAfaIntro(req, state, supabase)
}

// ── Name ──────────────────────────────────────────────────────────────────────

function handleName(req: HubtelRequest, state: USSDState): HubtelResponse {
    const name = req.Message.trim()
    // A5: reject angle brackets — this name is rendered into the admin AFA
    // alert email HTML. Validate-on-write so XSS can't be stored via USSD.
    if (name.length < 3 || name.length > 100 || /[<>]/.test(name)) {
        return respond(
            req.SessionId,
            'Please enter your full name (3-100 chars, no < or >):',
            { ...state, step: 'afa_name' },
            'Full Name',
            'text',
        )
    }
    // Skip id_type step — Ghana Card is the only accepted ID
    return respond(
        req.SessionId,
        `Enter Ghana Card number:\n${GC_HINT}`,
        { ...state, afaFullName: name, afaIdType: 'Ghana Card', step: 'afa_id_number' },
        'Ghana Card Number',
        'text',
    )
}

// ── ID Number ─────────────────────────────────────────────────────────────────

function handleIdNumber(req: HubtelRequest, state: USSDState): HubtelResponse {
    const idNumber = req.Message.trim().toUpperCase()

    if (!GC_PATTERN.test(idNumber)) {
        return respond(
            req.SessionId,
            `Invalid format.\n${GC_HINT}\nEnter Ghana Card number:`,
            { ...state, step: 'afa_id_number' },
            'Ghana Card Number',
            'text',
        )
    }

    return showAfaBeneficiaryMenu(req, { ...state, afaIdNumber: idNumber })
}

// ── Phone (registration updates: My Self / another number) ────────────────────

function showAfaBeneficiaryMenu(req: HubtelRequest, state: USSDState): HubtelResponse {
    return showBeneficiaryMenu(req, state, 'afa_beneficiary', {
        title: 'Send registration updates to:',
        otherLabel: 'Another Number',
    })
}

function showAfaPhonePrompt(req: HubtelRequest, state: USSDState): HubtelResponse {
    return respond(
        req.SessionId,
        'Enter phone number for\nregistration updates:\n(e.g. 0244123456)',
        { ...state, step: 'afa_phone' },
        'Phone',
        'phone',
    )
}

function handleBeneficiary(req: HubtelRequest, state: USSDState): HubtelResponse {
    switch (parseBeneficiaryChoice(req.Message)) {
        case 'back':
            return respond(
                req.SessionId,
                `Enter Ghana Card number:\n${GC_HINT}`,
                { ...state, step: 'afa_id_number' },
                'Ghana Card Number',
                'text',
            )
        case 'self':
            // Dialer's own number, taken from Hubtel's MSISDN — never from ClientState.
            return showRegionPage1(req, { ...state, afaPhone: selfBeneficiaryPhone(req.Mobile) })
        case 'other':
            return showAfaPhonePrompt(req, state)
        default:
            return showAfaBeneficiaryMenu(req, state)
    }
}

function handlePhone(req: HubtelRequest, state: USSDState): HubtelResponse {
    const input = req.Message.trim()
    if (input === '0') return showAfaBeneficiaryMenu(req, state)
    if (!isValidGhanaPhone(input)) {
        return respond(
            req.SessionId,
            'Invalid number.\nEnter a valid Ghana number:\n(e.g. 0244123456)',
            { ...state, step: 'afa_phone' },
            'Phone',
            'phone',
        )
    }
    return showRegionPage1(req, { ...state, afaPhone: normalizePhone(input) })
}

// ── Region ────────────────────────────────────────────────────────────────────

function showRegionPage1(req: HubtelRequest, state: USSDState): HubtelResponse {
    const lines = ['Select Region (1/2):']
    REGIONS_PAGE1.forEach((r, i) => lines.push(`${i + 1}. ${r}`))
    lines.push('9. More ->')
    lines.push('0. Back')
    return respond(
        req.SessionId,
        lines.join('\n'),
        { ...state, step: 'afa_region', afaRegionPage: 1 },
        'Region',
    )
}

function showRegionPage2(req: HubtelRequest, state: USSDState): HubtelResponse {
    const lines = ['Select Region (2/2):']
    REGIONS_PAGE2.forEach((r, i) => lines.push(`${i + 1}. ${r}`))
    lines.push('9. <- Back')
    return respond(
        req.SessionId,
        lines.join('\n'),
        { ...state, step: 'afa_region', afaRegionPage: 2 },
        'Region',
    )
}

function handleRegionChoice(req: HubtelRequest, state: USSDState): HubtelResponse {
    const choice = req.Message.trim()
    const page = state.afaRegionPage ?? 1

    if (choice === '0') return showAfaBeneficiaryMenu(req, state)

    // Pagination
    if (page === 1 && choice === '9') return showRegionPage2(req, state)
    if (page === 2 && choice === '9') return showRegionPage1(req, state)

    const idx = parseInt(choice, 10) - 1
    const regions = page === 1 ? REGIONS_PAGE1 : REGIONS_PAGE2

    if (isNaN(idx) || idx < 0 || idx >= regions.length) {
        const fn = page === 1 ? showRegionPage1 : showRegionPage2
        return fn(req, state)
    }

    const region = regions[idx]
    return respond(
        req.SessionId,
        'Enter your town or city:',
        { ...state, afaRegion: region, step: 'afa_location' },
        'Location',
        'text',
    )
}

// ── Location ──────────────────────────────────────────────────────────────────

function handleLocation(req: HubtelRequest, state: USSDState): HubtelResponse {
    const location = req.Message.trim()
    if (location.length < 2 || location.length > 100) {
        return respond(
            req.SessionId,
            'Enter your town or city:',
            { ...state, step: 'afa_location' },
            'Location',
            'text',
        )
    }
    return respond(
        req.SessionId,
        'Enter date of birth:\nFormat: DDMMYYYY\n(e.g. 15061990)',
        { ...state, afaLocation: location, step: 'afa_dob' },
        'Date of Birth',
        'number',
    )
}

// ── Date of Birth ─────────────────────────────────────────────────────────────

function handleDob(req: HubtelRequest, state: USSDState): HubtelResponse {
    const input = req.Message.trim()

    if (!/^\d{8}$/.test(input)) {
        return respond(
            req.SessionId,
            'Invalid format.\nEnter date of birth:\nDDMMYYYY (e.g. 15061990)',
            { ...state, step: 'afa_dob' },
            'Date of Birth',
            'number',
        )
    }

    const day = parseInt(input.slice(0, 2), 10)
    const month = parseInt(input.slice(2, 4), 10) - 1
    const year = parseInt(input.slice(4, 8), 10)
    const dob = new Date(year, month, day)

    if (
        isNaN(dob.getTime()) ||
        dob.getDate() !== day ||
        dob.getMonth() !== month ||
        dob.getFullYear() !== year
    ) {
        return respond(
            req.SessionId,
            'Invalid date.\nEnter date of birth:\nDDMMYYYY (e.g. 15061990)',
            { ...state, step: 'afa_dob' },
            'Date of Birth',
            'number',
        )
    }

    // Must be at least 18
    const today = new Date()
    let age = today.getFullYear() - dob.getFullYear()
    if (
        today.getMonth() < dob.getMonth() ||
        (today.getMonth() === dob.getMonth() && today.getDate() < dob.getDate())
    ) age--

    if (age < 18) {
        return respond(
            req.SessionId,
            'You must be at least 18 years old to register. Enter date of birth:',
            { ...state, step: 'afa_dob' },
            'Date of Birth',
            'number',
        )
    }

    // Store as ISO date string (YYYY-MM-DD)
    const isoDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

    return respond(
        req.SessionId,
        'Enter your occupation:\n(e.g. Farmer, Teacher, Trader)',
        { ...state, afaDob: isoDate, step: 'afa_occupation' },
        'Occupation',
        'text',
    )
}

// ── Occupation ────────────────────────────────────────────────────────────────

function handleOccupation(req: HubtelRequest, state: USSDState): HubtelResponse {
    const occupation = req.Message.trim()
    if (occupation.length < 2 || occupation.length > 100) {
        return respond(
            req.SessionId,
            'Enter your occupation:\n(e.g. Farmer, Teacher, Trader)',
            { ...state, step: 'afa_occupation' },
            'Occupation',
            'text',
        )
    }

    return showAfaConfirm(req, { ...state, afaOccupation: occupation })
}

// ── Confirm ───────────────────────────────────────────────────────────────────

/**
 * Cost/selling snapshot carried into the pending order so fulfillment can attribute
 * a shop sale and credit the owner.
 *
 * `state.price` is the SELLING price — it was computed at the intro screen as
 * applyFee(basePrice, resolveUSSDFeePercent(shopId)), i.e. it already includes the
 * shop's markup. The base (platform) cost is re-resolved here rather than carried in
 * USSDState on purpose: state round-trips to Hubtel as ClientState, which is already
 * close to the size at which Hubtel truncates it and silently resets the session
 * (see lib/ussd/utils.ts) — so it must not grow for data we can cheaply re-derive.
 */
async function resolveAfaPricingSnapshot(
    supabase: SupabaseClient,
    mobile: string,
    state: USSDState,
): Promise<{ costPrice: number; sellingPrice: number } | null> {
    // GLOBAL CONSTRAINT (Task 3, Step 6): for a NORMAL shop and the non-shop path, `costBase`
    // is exactly the old `basePrice` — byte-for-byte identical. Only a sub-agent-owned shop's
    // costBase differs (resolveSubAgentAfaCost's subCost instead of the dialer's role price).
    let costBase: number
    if (state.shopId) {
        const shopPricing = await resolveShopAfaPricing(supabase, mobile, state.shopId)
        if (!shopPricing) return null
        costBase = shopPricing.costPrice
    } else {
        const nonShop = await resolveNonShopAfaBase(supabase, mobile)
        if (!nonShop) return null
        costBase = nonShop.price
    }
    return {
        costPrice: Math.round(Number(costBase) * 100) / 100,
        sellingPrice: Math.round(Number(state.price ?? costBase) * 100) / 100,
    }
}

function showAfaConfirm(req: HubtelRequest, state: USSDState): HubtelResponse {
    const name = state.afaFullName!
    const displayName = name.length > 18 ? name.slice(0, 18) + '...' : name
    const msg = [
        'AFA Registration:',
        `Name: ${displayName}`,
        `ID: ${state.afaIdNumber}`,
        `Region: ${state.afaRegion}`,
        `Fee: ${formatGHS(state.price!)}`,
        '',
        '1. Confirm',
        '2. Cancel',
    ].join('\n')
    return respond(req.SessionId, msg, { ...state, step: 'afa_confirm' }, 'Confirm AFA Registration')
}

async function handleConfirm(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Mobile } = req
    const choice = req.Message.trim()

    if (choice === '2' || choice === '0') {
        return release(SessionId, 'Registration cancelled. Dial *713*9939# to start again.')
    }

    if (choice !== '1') return showAfaConfirm(req, state)

    // P2-3: block fraud-flagged applicant numbers from registering.
    if (state.afaPhone && await isPhoneBlacklisted(supabase, normalizePhone(state.afaPhone))) {
        return release(SessionId, 'This number cannot be registered. Please contact support.')
    }

    const user = await findUserByMobile(supabase, Mobile)

    // Registered user — show payment method selection
    if (user) {
        const balance = user.walletBalance ?? 0
        const price = state.price!
        const balanceLine = balance >= price
            ? `2. FameTech Wallet (Bal: ${formatGHS(balance)})`
            : `2. FameTech Wallet (Insufficient)`
        const msg = [
            'HOW TO PAY:',
            '1. Mobile Money (MoMo)',
            balanceLine,
            '0. Cancel',
        ].join('\n')
        return respond(
            SessionId,
            msg,
            { ...state, step: 'afa_payment_method' },
            'Payment Method',
        )
    }

    // Guest user — proceed directly to MoMo (unchanged path)
    const guestPricing = await resolveAfaPricingSnapshot(supabase, Mobile, state)
    if (!guestPricing) {
        return release(SessionId, 'AFA registration is not available for this shop right now.')
    }
    await savePendingOrder(supabase, {
        sessionId: SessionId,
        mobile: Mobile,
        serviceType: 'afa',
        orderPayload: {
            full_name:    state.afaFullName,
            phone:        state.afaPhone,
            id_type:      state.afaIdType,
            id_number:    state.afaIdNumber,
            region:       state.afaRegion,
            location:     state.afaLocation,
            date_of_birth: state.afaDob,
            occupation:   state.afaOccupation,
            price:        state.price,
            shopId:       state.shopId ?? null,
            costPrice:    guestPricing.costPrice,
            sellingPrice: guestPricing.sellingPrice,
        },
        userId: null,
        price:  state.price!,
        operator: req.Operator,
    })

    return addToCart(
        SessionId,
        `Processing...\nYou will receive a payment prompt shortly.`,
        {
            // Deliberately opaque — see orderCode() in lib/ussd/utils.ts. This string
            // is republished by Hubtel as the dashboard/CSV `description` and on the
            // public receipt, so it must not carry the applicant's legal name. The
            // real order detail lives in ussd_pending_orders.order_payload.
            ItemName: `KFT Order ${orderCode(SessionId)}`,
            Qty: 1,
            Price: state.price!,
        },
    )
}

// ── Payment Method Selection (registered users only) ──────────────────────────

async function handleAFAPaymentMethod(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Mobile, Operator } = req
    const choice = req.Message.trim()

    if (choice === '0') {
        return release(SessionId, 'Registration cancelled. Dial *713*9939# to start again.')
    }

    if (choice === '1') {
        // Mobile Money path — save pending order then trigger Hubtel MoMo
        const user = await findUserByMobile(supabase, Mobile)
        const momoPricing = await resolveAfaPricingSnapshot(supabase, Mobile, state)
        if (!momoPricing) {
            return release(SessionId, 'AFA registration is not available for this shop right now.')
        }

        await savePendingOrder(supabase, {
            sessionId: SessionId,
            mobile: Mobile,
            serviceType: 'afa',
            orderPayload: {
                full_name:    state.afaFullName,
                phone:        state.afaPhone,
                id_type:      state.afaIdType,
                id_number:    state.afaIdNumber,
                region:       state.afaRegion,
                location:     state.afaLocation,
                date_of_birth: state.afaDob,
                occupation:   state.afaOccupation,
                price:        state.price,
                shopId:       state.shopId ?? null,
                costPrice:    momoPricing.costPrice,
                sellingPrice: momoPricing.sellingPrice,
            },
            userId: user?.id ?? null,
            price:  state.price!,
            operator: Operator,
        })

        return addToCart(
            SessionId,
            `Processing...\nYou will receive a payment prompt shortly.`,
            {
                // Deliberately opaque — see orderCode() in lib/ussd/utils.ts. This string
            // is republished by Hubtel as the dashboard/CSV `description` and on the
            // public receipt, so it must not carry the applicant's legal name. The
            // real order detail lives in ussd_pending_orders.order_payload.
            ItemName: `KFT Order ${orderCode(SessionId)}`,
                Qty: 1,
                Price: state.price!,
            },
        )
    }

    if (choice === '2') {
        // FameTech Wallet path
        const user = await findUserByMobile(supabase, Mobile)

        if (!user || !user.walletId) {
            return release(SessionId, 'Wallet not available. Please try again.')
        }

        const balance = user.walletBalance ?? 0
        const price = state.price!

        if (balance < price) {
            const balanceLine = `2. FameTech Wallet (Bal: ${formatGHS(balance)})`
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
                { ...state, step: 'afa_payment_method' },
                'Payment Method',
            )
        }

        const supabaseAdmin = createAdminClient()

        const reference = `USSD-WALLET-AFA-${SessionId.toUpperCase()}`
        const result = await processWalletPayment({
            supabaseAdmin,
            userId: user.id,
            walletId: user.walletId,
            amount: price,
            description: `AFA Registration - ${state.afaFullName}`,
            reference,
        })

        if (!result.success) {
            if (result.error === 'INSUFFICIENT_BALANCE') {
                const balanceLine = `2. FameTech Wallet (Bal: ${formatGHS(balance)})`
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
                    { ...state, step: 'afa_payment_method' },
                    'Payment Method',
                )
            }
            return release(SessionId, 'Payment failed. Please try again.')
        }

        // Payment succeeded (wallet already debited) — trigger fulfillment in background.
        // Unlike the two pre-payment call sites above, a resolution failure here must NOT
        // release/abort: the guest's money has already moved. Fall through with
        // costPrice/sellingPrice omitted — fulfillAFAOrder's own legacy-payload fallback
        // (costPrice -> sellingPrice, profit 0, no credit) already handles this exact shape
        // safely rather than inventing a profit it cannot derive; the registration still
        // completes for the guest who already paid.
        const walletPricing = await resolveAfaPricingSnapshot(supabaseAdmin as any, Mobile, state)
        if (!walletPricing) {
            console.error(`[USSD AFA] wallet pricing snapshot unresolvable post-debit for session ${SessionId} shop ${state.shopId} — proceeding without a cost/profit snapshot (payment already captured).`)
        }
        const payload: AFAOrderPayload = {
            full_name:    state.afaFullName!,
            phone:        state.afaPhone!,
            id_type:      state.afaIdType!,
            id_number:    state.afaIdNumber!,
            region:       state.afaRegion!,
            location:     state.afaLocation!,
            date_of_birth: state.afaDob!,
            occupation:   state.afaOccupation!,
            price,
            shopId:       state.shopId ?? null,
            costPrice:    walletPricing?.costPrice,
            sellingPrice: walletPricing?.sellingPrice,
        }

        // HIGH-4: record the debit synchronously so it can never be lost.
        await recordWalletAwaitingFulfillment({
            supabaseAdmin, sessionId: SessionId, userId: user.id, mobile: Mobile,
            serviceType: 'afa', amount: price, walletDebitReference: reference,
        })

        waitUntil(
            (async () => {
                const fulfillResult = await fulfillAFAOrder(supabaseAdmin, '', SessionId, Mobile, Operator, payload, user.id, null, 'wallet')
                if (fulfillResult.success) {
                    await clearWalletRefund(supabaseAdmin, SessionId)
                } else {
                    await markWalletRefundFailed({
                        supabaseAdmin, sessionId: SessionId, mobile: Mobile,
                        serviceType: 'afa', amount: price,
                        reason: fulfillResult.error ?? 'fulfillment failed',
                    })
                }
            })(),
        )

        return release(
            SessionId,
            'Payment successful!\nYour AFA registration is being processed.\nCheck My Orders for status.',
        )
    }

    // Invalid choice — re-show payment method menu with live balance
    const user = await findUserByMobile(supabase, Mobile)
    const balance = user?.walletBalance ?? 0
    const price = state.price!
    const balanceLine = balance >= price
        ? `2. FameTech Wallet (Bal: ${formatGHS(balance)})`
        : `2. FameTech Wallet (Insufficient)`

    const msg = [
        'HOW TO PAY:',
        '1. Mobile Money (MoMo)',
        balanceLine,
        '0. Cancel',
    ].join('\n')

    return respond(
        SessionId,
        msg,
        { ...state, step: 'afa_payment_method' },
        'Payment Method',
    )
}
