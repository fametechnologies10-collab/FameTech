import type { SupabaseClient } from '@supabase/supabase-js'
import type { HubtelRequest, HubtelResponse, USSDState } from '../types'
import { respond, release, addToCart, formatGHS, isValidGhanaPhone, normalizePhone, orderCode } from '../utils'
import { resolveDataPrice, isShopDataPriceSellable, resolveSubAgentSelfDataPrice } from '../price-resolver'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { savePendingOrder } from '../session'
import { findUserByMobile, effectiveRole } from '../price-resolver'
import { resolveUSSDFeePercent, applyFee } from '../fee'
import { createAdminClient } from '@/lib/supabase-admin'
import { processWalletPayment, recordWalletAwaitingFulfillment, clearWalletRefund, markWalletRefundFailed } from '../wallet-payment'
import { fulfillDataOrder, type DataOrderPayload } from '../fulfillment/data'
import { waitUntil } from '@vercel/functions'
import { getAdminOOSNetworks, mergeOOS, isNetworkOOS } from '@/lib/network-stock'
import { checkMtnWhitelistGate } from '@/lib/mtn-whitelist-gate'
import { showBeneficiaryMenu, parseBeneficiaryChoice, selfBeneficiaryPhone } from '../beneficiary'

const BUNDLES_PER_PAGE = 5
const NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime'] as const

/**
 * Resolve the effective per-network out-of-stock set for the current session.
 * Global USSD uses the admin set; shop USSD uses admin ∪ that shop's oos_networks.
 * Used both at the bundle menu (display block) and at every charge chokepoint
 * (wallet debit + MoMo pending order) so a mid-session toggle or a replayed
 * ClientState past the bundle list can never move money for a hidden network.
 */
async function resolveStateOOS(
    supabase: SupabaseClient,
    state: USSDState,
): Promise<Set<string>> {
    const adminOOS = await getAdminOOSNetworks(supabase)
    if (state.shopId) {
        const { data: shopRow } = await supabase
            .from('shop_profiles').select('oos_networks').eq('id', state.shopId).maybeSingle()
        return mergeOOS(adminOOS, (shopRow as any)?.oos_networks)
    }
    return adminOOS
}

/**
 * Re-check, right before money moves, that a shop sale is still above the owner's
 * cost — the owner's price or role may have changed mid-session, and a resumed
 * session can reach the charge step without passing the bundle list again.
 * Non-shop sessions always pass; a shop session missing its price fails closed.
 */
async function shopPriceStillSellable(supabase: SupabaseClient, state: USSDState): Promise<boolean> {
    if (!state.shopId) return true
    if (!state.packageId || state.shopBasePrice == null) return false
    return isShopDataPriceSellable(supabase, state.shopId, state.packageId, Number(state.shopBasePrice))
}

const SHOP_PRICE_UNAVAILABLE = 'This bundle is not available right now. Please try again later.'

// =============================================================================
// Data bundle purchase flow
// Steps: data_start → data_network → data_bundles → data_beneficiary → data_phone → data_confirm
//        → data_payment_method (registered users only)
// =============================================================================

export async function handleData(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { step } = state

    switch (step) {
        case 'data_start':
        case 'data_network':
            return step === 'data_start' ? showNetworkMenu(req, state) : handleNetworkChoice(req, state, supabase)
        case 'data_bundles':
            return handleBundleChoice(req, state, supabase)
        case 'data_beneficiary':
            return handleBeneficiaryChoice(req, state, supabase)
        case 'data_phone':
            return handlePhoneInput(req, state, supabase)
        case 'data_confirm':
            return handleConfirm(req, state, supabase)
        case 'data_payment_method':
            return handleDataPaymentMethod(req, state, supabase)
        default:
            return showNetworkMenu(req, state)
    }
}

// ── Step 1: Show network selection ────────────────────────────────────────────

function showNetworkMenu(req: HubtelRequest, state: USSDState): HubtelResponse {
    const newState: USSDState = { ...state, step: 'data_network', service: 'data' }
    return respond(
        req.SessionId,
        'Select Network:\n1. MTN\n2. Telecel\n3. AT-iShare\n4. AT-BigTime\n0. Back',
        newState,
        'Select Network',
    )
}

// ── Step 2: Handle network choice, show bundle list ───────────────────────────

async function handleNetworkChoice(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Message } = req
    const choice = Message.trim()

    const networkMap: Record<string, string> = {
        '1': 'MTN', '2': 'Telecel', '3': 'AT-iShare', '4': 'AT-BigTime',
    }

    if (choice === '0') {
        // Back to main menu
        return respond(SessionId, 'Select Network:\n1. MTN\n2. Telecel\n3. AT-iShare\n4. AT-BigTime\n0. Back',
            { ...state, step: 'data_network' }, 'Select Network')
    }

    const network = networkMap[choice]
    if (!network) {
        return respond(
            SessionId,
            'Invalid choice.\nSelect Network:\n1. MTN\n2. Telecel\n3. AT-iShare\n4. AT-BigTime',
            { ...state, step: 'data_network' },
            'Select Network',
        )
    }

    const newState: USSDState = { ...state, network, bundlePage: 0, step: 'data_bundles' }
    return showBundleList(req, newState, supabase)
}

// ── Step 3: Show paginated bundle list / handle choice ────────────────────────

async function showBundleList(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Mobile } = req
    const page = state.bundlePage ?? 0
    const user = await findUserByMobile(supabase, Mobile)

    // Per-network out-of-stock guard. Global USSD uses the admin set; shop USSD
    // uses admin ∪ that shop. Show the same "Out of Stock at the Moment" copy.
    const oos = await resolveStateOOS(supabase, state)
    if (isNetworkOOS(oos, state.network!)) {
        return respond(
            SessionId,
            `${state.network} is Out of Stock at the Moment.\nPress 0 to go back.`,
            { ...state, step: 'data_network' },
            'Out of stock',
        )
    }

    const { data: packages } = await supabase
        .from('data_packages')
        .select('id, size, price, agent_price, dealer_price, ussd_price, category')
        .eq('network', state.network!)
        .eq('is_available', true)
        .eq('ussd_enabled', true)
        .order('sort_order', { ascending: true })

    if (!packages || packages.length === 0) {
        return respond(
            SessionId,
            `No ${state.network} bundles available on USSD right now.\nPress 0 to go back.`,
            { ...state, step: 'data_network' },
            'No bundles',
        )
    }

    // Use the canonical role resolver (price-resolver.effectiveRole) so the menu
    // display matches the charge path EXACTLY — including the lifetime/legacy
    // fallback where role is set but *_expires_at is NULL. Computing this inline
    // previously omitted that fallback, so lifetime agents/dealers saw retail.
    const role = effectiveRole(user)

    const lines = [`${state.network} Bundles:`]
    // Map option numbers back to package IDs
    const optionMap: Record<string, { id: string; size: string; price: number }> = {}

    const feePercent = await resolveUSSDFeePercent(supabase, state.shopId)

    // Shop USSD: prefetch this shop's pricing, filter to only priced packages
    let shopPriceMap: Record<string, number> | null = null
    if (state.shopId) {
        const packageIds = (packages as any[]).map((p: any) => p.id as string)
        const { data: spRows } = await supabase
            .from('shop_pricing')
            .select('package_id, selling_price')
            .eq('shop_id', state.shopId)
            .in('package_id', packageIds)

        shopPriceMap = {}
        for (const row of (spRows ?? []) as any[]) {
            shopPriceMap[row.package_id] = Number(row.selling_price)
        }
    }

    // Non-shop USSD by a sub-agent: show their recruiter-set cost (what resolveDataPrice
    // will actually charge) and hide packages they cannot buy.
    let subPriceMap: Record<string, number> | null = null
    if (!state.shopId && user) {
        const subCtx = await resolveSubAgentContext(supabase, user.id)
        if (subCtx.isSub) {
            subPriceMap = {}
            const results = await Promise.all((packages as any[]).map(async (p: any) => ({
                id: p.id as string,
                res: await resolveSubAgentSelfDataPrice(supabase, user.id, p.id, p),
            })))
            for (const { id, res } of results) {
                if (res.kind === 'sub') subPriceMap[id] = res.price
            }
        }
    }

    // For shop USSD, only show packages that the shop has priced
    const displayPackages = shopPriceMap
        ? (packages as any[]).filter((p: any) => shopPriceMap![p.id] !== undefined)
        : subPriceMap
            ? (packages as any[]).filter((p: any) => subPriceMap![p.id] !== undefined)
            : packages as any[]

    if (displayPackages.length === 0 && subPriceMap !== null) {
        return respond(
            SessionId,
            `No ${state.network} bundles are priced for your account yet.\nPress 0 to go back.`,
            { ...state, step: 'data_network' },
            'No bundles',
        )
    }

    if (displayPackages.length === 0 && shopPriceMap !== null) {
        return respond(
            SessionId,
            `No ${state.network} bundles are configured for this shop.\nPress 0 to go back.`,
            { ...state, step: 'data_network' },
            'No bundles',
        )
    }

    const total = displayPackages.length
    const start = page * BUNDLES_PER_PAGE
    const slice = displayPackages.slice(start, start + BUNDLES_PER_PAGE)
    const hasMore = start + BUNDLES_PER_PAGE < total

    slice.forEach((pkg, i) => {
        const n = i + 1
        let price: number
        // Shop USSD: use shop selling price directly
        if (shopPriceMap) {
            price = shopPriceMap[pkg.id]
        } else if (subPriceMap) {
            price = subPriceMap[pkg.id]
        } else if (role === 'dealer' && (pkg as any).dealer_price) {
            price = Number((pkg as any).dealer_price)
        } else if (role === 'agent' && (pkg as any).agent_price) {
            price = Number((pkg as any).agent_price)
        } else if (user) {
            price = Number(pkg.price)
        } else {
            price = Number((pkg as any).ussd_price ?? pkg.price)
        }

        const displayPrice = applyFee(price, feePercent)
        lines.push(`${n}. ${formatGHS(displayPrice)} - ${(pkg as any).size}`)
        optionMap[String(n)] = { id: pkg.id as string, size: (pkg as any).size as string, price }
    })

    // menuMap stores package IDs by option number (survives JSON round-trip).
    // The 'more' sentinel lives in the SAME map so handleBundleChoice resolves
    // every keypress against exactly the list the guest saw — for shop sessions
    // that list is shop_pricing-FILTERED, so a positional lookup into the
    // unfiltered table would pick the wrong package (or a package the shop
    // never priced) and charge real MoMo money for the wrong bundle.
    const menuMap: Record<string, string> = Object.fromEntries(
        Object.entries(optionMap).map(([k, v]) => [k, v.id]),
    )
    if (hasMore) {
        lines.push(`${slice.length + 1}. More Bundles`)
        menuMap[String(slice.length + 1)] = 'more'
    }
    lines.push('0. Back')

    const newState: USSDState = {
        ...state,
        step: 'data_bundles',
        bundlePage: page,
        menuMap,
    }

    return respond(
        SessionId,
        lines.join('\n'),
        newState,
        `${state.network} Bundles`,
    )
}

async function handleBundleChoice(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Message, Mobile } = req
    const choice = Message.trim()

    if (choice === '0') {
        const page = state.bundlePage ?? 0
        if (page > 0) {
            // Go back to previous bundle page
            return showBundleList(req, { ...state, bundlePage: page - 1 }, supabase)
        }
        // Back to network selection
        return respond(
            SessionId,
            'Select Network:\n1. MTN\n2. Telecel\n3. AT-iShare\n4. AT-BigTime\n0. Back',
            { ...state, step: 'data_network' },
            'Select Network',
        )
    }

    const page = state.bundlePage ?? 0

    // Resolve the keypress against the option→packageId map saved when THIS
    // menu page was rendered. Never re-derive positionally: shop menus are
    // filtered to shop_pricing, so the on-screen numbering does not match the
    // raw data_packages ordering — a positional lookup charged the wrong
    // bundle (or dead-ended the session) for partially-priced shops.
    const menuMap = (state.menuMap ?? {}) as Record<string, string | number>
    const mapped = menuMap[choice]

    if (mapped === undefined) {
        // Unknown option, or a legacy/truncated state with no menuMap —
        // re-render the current page so the guest picks from a fresh map.
        if (Object.keys(menuMap).length === 0) {
            return showBundleList(req, { ...state, bundlePage: page }, supabase)
        }
        return respond(
            SessionId,
            'Invalid choice. Enter a number from the list:',
            { ...state, step: 'data_bundles' },
            'Select Bundle',
        )
    }

    if (mapped === 'more') {
        const newState: USSDState = { ...state, bundlePage: page + 1 }
        return showBundleList(req, newState, supabase)
    }

    const { data: selectedPkg } = await supabase
        .from('data_packages')
        .select('id, size')
        .eq('id', String(mapped))
        .eq('is_available', true)
        .eq('ussd_enabled', true)
        .maybeSingle()

    if (!selectedPkg) return release(SessionId, 'Package not available. Please try again.')

    const resolved = await resolveDataPrice(supabase, selectedPkg.id as string, Mobile, state.shopId)
    if (!resolved) return release(SessionId, 'Package not available. Please try again.')

    const feePercent = await resolveUSSDFeePercent(supabase, state.shopId)
    const totalPrice = applyFee(resolved.price, feePercent)

    const newState: USSDState = {
        ...state,
        packageId: selectedPkg.id as string,
        packageSize: (selectedPkg as any).size as string,
        price: totalPrice,
        // For shop orders, remember the pre-fee selling price so the shop is
        // credited its margin only — the dedicated USSD shop fee stays with the platform.
        ...(state.shopId ? { shopBasePrice: resolved.price } : {}),
        // P1-3: menuMap (option→packageId for the bundle list) has done its job
        // once a bundle is picked; drop it so the rest of the flow's ClientState
        // stays well under Hubtel's truncation limit.
        menuMap: undefined,
    }

    return showBeneficiaryMenu(req, newState, 'data_beneficiary')
}

// ── Step 4a: Who is this for? (My Self / Someone Else) ────────────────────────

function showRecipientPrompt(req: HubtelRequest, state: USSDState): HubtelResponse {
    return respond(
        req.SessionId,
        `Enter recipient phone number:\n(e.g. 0244123456)`,
        { ...state, step: 'data_phone' },
        'Recipient phone',
        'phone',
    )
}

async function handleBeneficiaryChoice(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    switch (parseBeneficiaryChoice(req.Message)) {
        case 'back':
            return showBundleList(req, { ...state, bundlePage: state.bundlePage ?? 0, step: 'data_bundles' }, supabase)
        case 'self':
            // Same blacklist + MTN whitelist checks as a typed number — no shortcut.
            return acceptRecipient(req, state, supabase, selfBeneficiaryPhone(req.Mobile))
        case 'other':
            return showRecipientPrompt(req, state)
        default:
            return showBeneficiaryMenu(req, state, 'data_beneficiary')
    }
}

// ── Step 4b: Validate and store recipient phone ───────────────────────────────

async function handlePhoneInput(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Message } = req
    const input = Message.trim()

    if (input === '0') {
        return showBeneficiaryMenu(req, state, 'data_beneficiary')
    }

    if (!isValidGhanaPhone(input)) {
        return respond(
            SessionId,
            'Invalid phone number.\nEnter a valid Ghana number:\n(e.g. 0244123456)',
            { ...state, step: 'data_phone' },
            'Recipient phone',
            'phone',
        )
    }

    return acceptRecipient(req, state, supabase, normalizePhone(input))
}

/** Blacklist + MTN whitelist gate for a (normalized) recipient, shared by typed and "My Self" numbers. */
async function acceptRecipient(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
    normalized: string,
): Promise<HubtelResponse> {
    const { SessionId } = req

    // Check blacklist
    const { data: blacklisted } = await supabase
        .from('phone_blacklist')
        .select('phone_number')
        .eq('phone_number', normalized)
        .maybeSingle()

    if (blacklisted) {
        return respond(
            SessionId,
            'This number cannot receive data bundles. Enter a different number:',
            { ...state, step: 'data_phone' },
            'Recipient phone',
            'phone',
        )
    }

    // MTN AgentPortal whitelist gate — checked here so a blocked guest/user can
    // immediately retry with a different number, without leaving the USSD flow.
    // No package category is tracked in USSD state (mashup bundles are not sold
    // via USSD today), so this always evaluates for MTN — safe direction to err
    // in, since the check itself has no cost beyond the read/verify call.
    const whitelistGate = await checkMtnWhitelistGate(normalized, state.network!)
    if (whitelistGate.blocked) {
        return respond(
            SessionId,
            `${whitelistGate.reason}\nEnter a different number:`,
            { ...state, step: 'data_phone' },
            'Recipient phone',
            'phone',
        )
    }

    const newState: USSDState = { ...state, recipientPhone: normalized, step: 'data_confirm' }
    return showDataConfirm(req, newState)
}

// ── Step 5: Confirm screen ────────────────────────────────────────────────────

function showDataConfirm(req: HubtelRequest, state: USSDState): HubtelResponse {
    const { SessionId } = req
    const msg = [
        `${state.network} ${state.packageSize}`,
        `To: ${state.recipientPhone}`,
        `Amount: ${formatGHS(state.price!)}`,
        '',
        'Confirm your order?',
        '1. Confirm',
        '0. Cancel',
    ].join('\n')

    return respond(SessionId, msg, { ...state, step: 'data_confirm' }, 'Confirm Order')
}

async function handleConfirm(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Mobile } = req
    const choice = req.Message.trim()

    if (choice === '0') {
        return release(SessionId, 'Order cancelled. Dial *713*9939# to start again.')
    }

    if (choice !== '1') {
        return showDataConfirm(req, state)
    }

    // Find account (may be null for guests)
    const user = await findUserByMobile(supabase, Mobile)

    // Registered user: show payment method selection instead of going straight to MoMo
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
            { ...state, step: 'data_payment_method' },
            'Payment Method',
        )
    }

    // Re-check out-of-stock BEFORE creating the MoMo pending order, so a mid-session
    // toggle or a replayed ClientState past the bundle list cannot charge a hidden
    // network. Blocks before any money moves → no refund path needed.
    if (isNetworkOOS(await resolveStateOOS(supabase, state), state.network!)) {
        return respond(
            SessionId,
            `${state.network} is Out of Stock at the Moment.\nPress 0 to go back.`,
            { ...state, step: 'data_network' },
            'Out of stock',
        )
    }

    // Re-check the MTN AgentPortal whitelist gate for the same reason as the OOS
    // re-check above — a mid-session admin toggle, or a resumed/replayed session
    // (this codebase supports session resumption within a configurable window),
    // must never let money move for a number that would be blocked if checked
    // right now. checkMtnWhitelistGate fails open and never throws.
    const whitelistRecheckGuest = await checkMtnWhitelistGate(state.recipientPhone, state.network!)
    if (whitelistRecheckGuest.blocked) {
        return respond(
            SessionId,
            `${whitelistRecheckGuest.reason}\nEnter a different number:`,
            { ...state, step: 'data_phone' },
            'Recipient phone',
            'phone',
        )
    }

    // Shop price must still be above the owner's cost — blocks before any money moves.
    if (!(await shopPriceStillSellable(supabase, state))) {
        return release(SessionId, SHOP_PRICE_UNAVAILABLE)
    }

    // Guest user: proceed directly to MoMo (existing flow)
    await savePendingOrder(supabase, {
        sessionId: SessionId,
        mobile: Mobile,
        serviceType: 'data',
        orderPayload: {
            packageId:      state.packageId,
            packageSize:    state.packageSize,
            network:        state.network,
            recipientPhone: state.recipientPhone,
            price:          state.price,
            shopId:         state.shopId ?? null,
            shopBasePrice:  state.shopBasePrice ?? null,
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
            // Deliberately opaque — see orderCode() in lib/ussd/utils.ts. This string
            // is republished by Hubtel as the dashboard/CSV `description` and on the
            // public receipt, so it must not name the product or carry the recipient's
            // number. The real order detail lives in ussd_pending_orders.order_payload.
            ItemName: `KFT Order ${orderCode(SessionId)}`,
            Qty: 1,
            Price: state.price!,
        },
    )
}

// ── Step 6: Payment method selection (registered users only) ──────────────────

async function handleDataPaymentMethod(
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

        // Re-check out-of-stock BEFORE creating the MoMo pending order (blocks
        // before any money moves → no refund path needed).
        if (isNetworkOOS(await resolveStateOOS(supabase, state), state.network!)) {
            return respond(
                SessionId,
                `${state.network} is Out of Stock at the Moment.\nPress 0 to go back.`,
                { ...state, step: 'data_network' },
                'Out of stock',
            )
        }

        // Re-check the MTN AgentPortal whitelist gate BEFORE creating the MoMo
        // pending order — same reasoning as the OOS re-check above (mid-session
        // toggle / resumed session must never move money for a now-blocked number).
        const whitelistRecheckMomo = await checkMtnWhitelistGate(state.recipientPhone, state.network!)
        if (whitelistRecheckMomo.blocked) {
            return respond(
                SessionId,
                `${whitelistRecheckMomo.reason}\nEnter a different number:`,
                { ...state, step: 'data_phone' },
                'Recipient phone',
                'phone',
            )
        }

        // Shop price must still be above the owner's cost — blocks before any money moves.
        if (!(await shopPriceStillSellable(supabase, state))) {
            return release(SessionId, SHOP_PRICE_UNAVAILABLE)
        }

        await savePendingOrder(supabase, {
            sessionId: SessionId,
            mobile: Mobile,
            serviceType: 'data',
            orderPayload: {
                packageId:      state.packageId,
                packageSize:    state.packageSize,
                network:        state.network,
                recipientPhone: state.recipientPhone,
                price:          state.price,
                shopId:         state.shopId ?? null,
                shopBasePrice:  state.shopBasePrice ?? null,
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
                // Deliberately opaque — see orderCode() in lib/ussd/utils.ts. This string
            // is republished by Hubtel as the dashboard/CSV `description` and on the
            // public receipt, so it must not name the product or carry the recipient's
            // number. The real order detail lives in ussd_pending_orders.order_payload.
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
                { ...state, step: 'data_payment_method' },
                'Payment Method',
            )
        }

        // Re-check out-of-stock BEFORE debiting the wallet, so a mid-session
        // toggle or a replayed ClientState past the bundle list cannot charge a
        // hidden network. Blocks before any debit → no refund path needed.
        if (isNetworkOOS(await resolveStateOOS(supabase, state), state.network!)) {
            return respond(
                SessionId,
                `${state.network} is Out of Stock at the Moment.\nPress 0 to go back.`,
                { ...state, step: 'data_network' },
                'Out of stock',
            )
        }

        // Re-check the MTN AgentPortal whitelist gate BEFORE debiting the wallet —
        // same reasoning as the OOS re-check above (mid-session toggle / resumed
        // session must never move money for a now-blocked number).
        const whitelistRecheckWallet = await checkMtnWhitelistGate(state.recipientPhone, state.network!)
        if (whitelistRecheckWallet.blocked) {
            return respond(
                SessionId,
                `${whitelistRecheckWallet.reason}\nEnter a different number:`,
                { ...state, step: 'data_phone' },
                'Recipient phone',
                'phone',
            )
        }

        // Shop price must still be above the owner's cost — blocks before any debit.
        if (!(await shopPriceStillSellable(supabase, state))) {
            return release(SessionId, SHOP_PRICE_UNAVAILABLE)
        }

        const supabaseAdmin = createAdminClient()

        const reference = `USSD-WALLET-DATA-${SessionId.toUpperCase()}`
        const result = await processWalletPayment({
            supabaseAdmin,
            userId: user.id,
            walletId: user.walletId,
            amount: price,
            description: `Data Bundle - ${state.network} ${state.packageSize}`,
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
                    { ...state, step: 'data_payment_method' },
                    'Payment Method',
                )
            }
            return release(SessionId, 'Payment failed. Please try again.')
        }

        // Payment succeeded — trigger fulfillment in background
        const payload: DataOrderPayload = {
            packageId:      state.packageId!,
            packageSize:    state.packageSize!,
            network:        state.network!,
            recipientPhone: state.recipientPhone!,
            price:          price,
            shopId:         state.shopId ?? null,
            // Shop credit basis must be the PRE-FEE selling price, same as the
            // MoMo payloads — omitting it credited the fee-inclusive price.
            shopBasePrice:  state.shopBasePrice ?? null,
        }

        // HIGH-4: record the debit synchronously so it can never be lost if the
        // background promise is dropped (status 'awaiting_fulfillment', not in the queue).
        await recordWalletAwaitingFulfillment({
            supabaseAdmin, sessionId: SessionId, userId: user.id, mobile: Mobile,
            serviceType: 'data', amount: price, walletDebitReference: reference,
        })

        waitUntil(
            (async () => {
                const fulfillResult = await fulfillDataOrder(supabaseAdmin, '', SessionId, Mobile, Operator, payload, user.id, null, 'wallet')
                if (fulfillResult.success) {
                    await clearWalletRefund(supabaseAdmin, SessionId)
                } else {
                    await markWalletRefundFailed({
                        supabaseAdmin, sessionId: SessionId, mobile: Mobile,
                        serviceType: 'data', amount: price,
                        reason: fulfillResult.error ?? 'fulfillment failed',
                    })
                }
            })(),
        )

        return release(
            SessionId,
            'Payment successful!\nYour data bundle is being processed.\nCheck My Orders for status.',
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
        { ...state, step: 'data_payment_method' },
        'Payment Method',
    )
}
