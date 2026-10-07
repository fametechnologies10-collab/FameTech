// lib/shop-checkout.ts
// Single-source pricing + validation for shop storefront checkouts (data, airtime, mashup).
// Used by both /api/shop/initialize (redirect/inline-card) and /api/shop/charge (native MoMo)
// so the charged amount is computed identically and the client can never set the price.

import crypto from 'crypto'
import { getAdminOOSNetworks, mergeOOS, isNetworkOOS } from '@/lib/network-stock'
import { resolveOwnerCost } from '@/lib/pricing/cost-basis'
import { roleFeeSettingKeys, resolveRoleFeeSetting } from '@/lib/pricing/shop-fee-resolver'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentDataCost } from '@/lib/sub-agent-data-pricing'
import { isUtilityBiller, UTILITY_BILLERS } from '@/lib/hubtel-utility/billers'
import { toMsisdn233 } from '@/lib/hubtel-commission-service'
import { parseSettingNumber } from '@/lib/paystack-fees'
import { checkMtnWhitelistGate } from '@/lib/mtn-whitelist-gate'

export interface ShopCheckoutInput {
    shopSlug: string
    packageId?: string
    guestPhone: string
    guestEmail?: string
    orderType?: 'data' | 'airtime' | 'mashup' | 'utility'
    network?: string
    amount?: number | string
    useExactAmount?: boolean
    bundlePreference?: string
    utilityBiller?: string
    utilityAccount?: string
    utilityPhone?: string
}

export interface ShopCheckoutResult {
    ok: true
    shop: any
    cleanPhone: string
    validatedGuestEmail: string | null
    totalAmountPesewas: number
    metadataPayload: Record<string, any>
    pkgNetwork: string
    pkgSize: string
    ownerRole: string
}
export interface ShopCheckoutError {
    ok: false
    status: number
    error: string
    contact?: { phone?: string; whatsapp?: string; email?: string }
}

export function sanitizeForPaystack(text: string): string {
    // Paystack metadata DB is 3-byte UTF-8; 4-byte emoji silently truncate the JSON.
    return text.replace(/[\u{10000}-\u{10FFFF}]/gu, '').trim()
}

/**
 * White-labelled synthetic email for guests who supply no email (or an invalid one).
 * Format: <shopname>-<phone>-<4 random digits>@gmail.com. We use gmail.com because it
 * has real MX records and is universally accepted by Paystack's live Charge AND Inline
 * (card) APIs — our own kingflexygh.com / shop.* domains are mail-less and get rejected,
 * which 502'd empty-email MoMo charges and blocked the card popup. The shop-name prefix
 * keeps the synthetic customer record tied to the storefront, and the random suffix keeps
 * it unique per attempt. Used by BOTH /api/shop/charge (MoMo) and /api/shop/initialize (card).
 */
export function buildGuestEmail(shopName: string | null | undefined, phone: string): string {
    const namePart = (shopName || 'shop')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .slice(0, 20) || 'shop'
    const cleanPhone = (phone || '').replace(/\D/g, '') || 'guest'
    const rand = crypto.randomInt(1000, 10000) // 4 random digits
    return `${namePart}-${cleanPhone}-${rand}@gmail.com`
}

/**
 * Validate + price a shop checkout. `db` is a service-role server client.
 * Does NOT call Paystack and does NOT create any DB rows — pure computation.
 */
export async function computeShopCheckout(db: any, body: ShopCheckoutInput): Promise<ShopCheckoutResult | ShopCheckoutError> {
    const {
        shopSlug, packageId, guestPhone, guestEmail, orderType, network, amount, useExactAmount, bundlePreference,
        utilityBiller, utilityAccount, utilityPhone,
    } = body

    if (!shopSlug || !guestPhone) return { ok: false, status: 400, error: 'Missing required fields' }

    if ((orderType === 'airtime' || orderType === 'mashup') && (!network || !amount)) {
        return { ok: false, status: 400, error: 'Missing airtime/mashup fields' }
    } else if (orderType === 'utility' && (!utilityBiller || !utilityAccount || !amount)) {
        return { ok: false, status: 400, error: 'Missing utility fields' }
    } else if (orderType !== 'airtime' && orderType !== 'mashup' && orderType !== 'utility' && !packageId) {
        return { ok: false, status: 400, error: 'Missing package identifier' }
    }
    if (orderType === 'mashup' && network !== 'MTN') {
        return { ok: false, status: 400, error: 'MTN Mashup is only available for MTN' }
    }
    const resolvedBundlePreference = orderType === 'mashup'
        ? (['balanced', 'data', 'voice'].includes(String(bundlePreference)) ? bundlePreference : 'balanced')
        : null

    let validatedGuestEmail: string | null = null
    if (guestEmail && typeof guestEmail === 'string' && guestEmail.trim()) {
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
        if (emailRegex.test(guestEmail.trim()) && guestEmail.trim().length <= 254) {
            validatedGuestEmail = guestEmail.trim().toLowerCase()
        }
    }

    if (typeof shopSlug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(shopSlug)) {
        return { ok: false, status: 400, error: 'Invalid shop identifier' }
    }
    if (orderType !== 'airtime' && orderType !== 'mashup' && orderType !== 'utility' && (typeof packageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(packageId))) {
        return { ok: false, status: 400, error: 'Invalid package identifier' }
    }
    if (typeof guestPhone !== 'string') return { ok: false, status: 400, error: 'Invalid phone number' }
    const cleanPhone = guestPhone.replace(/\s+/g, '')
    if (!/^(0\d{9}|233\d{9})$/.test(cleanPhone)) {
        return { ok: false, status: 400, error: 'Invalid phone number. Use format: 0XXXXXXXXX or 233XXXXXXXXX' }
    }

    const { data: shop, error: shopError } = await db
        .from('shop_profiles')
        .select(`
            id, shop_name, shop_slug, owner_id, approval_status, is_active,
            fulfillment_mode, paystack_fee_percent, owner_phone, whatsapp_number,
            airtime_fee_mtn, airtime_fee_telecel, airtime_fee_at, mashup_fee_percent,
            utilities_enabled,
            owner:users!shop_profiles_owner_id_fkey(role, email, dealer_expires_at, agent_expires_at)
        `)
        .eq('shop_slug', shopSlug)
        .single()

    if (shopError || !shop) return { ok: false, status: 404, error: 'Shop not found' }

    const ownerRole = shop.owner?.role || 'customer'
    if (shop.approval_status !== 'approved' || !shop.is_active || !['customer', 'agent', 'dealer', 'subagent', 'admin', 'sub-admin'].includes(shop.owner?.role)) {
        return {
            ok: false, status: 403, error: 'This shop is not currently active',
            contact: { phone: shop.owner_phone, whatsapp: shop.whatsapp_number, email: shop.owner?.email },
        }
    }

    // Sub-agent storefront gates (spec §5.1): eligibility is evaluated LIVE on every
    // checkout — membership active + recruiter currently eligible.
    // Subs may sell all four product types: data via the sub-agent markup tables
    // (resolveSubAgentDataCost below), airtime/mashup/utility at zero required
    // recruiter markup via the existing shop-level fee mechanism (shop's own
    // airtime_fee_*/mashup_fee_percent columns plus an admin fee keyed on
    // `${network}_${ownerRole}`, which resolves to 0 for any role without a
    // matching settings key) — no sub-specific pricing logic needed there.
    const subCtx = await resolveSubAgentContext(db, shop.owner_id)
    if (subCtx.isSub && !subCtx.effectiveActive) {
        return {
            ok: false, status: 403, error: 'This shop is not currently active',
            contact: { phone: shop.owner_phone, whatsapp: shop.whatsapp_number, email: shop.owner?.email },
        }
    }

    const { data: settingsRows } = await db
        .from('admin_settings')
        .select('key, value')
        .in('key', [
            'shop_feature_enabled', 'storefront_airtime_enabled', 'storefront_mashup_enabled',
            'airtime_enabled_mtn', 'airtime_enabled_telecel', 'airtime_enabled_at',
            'mashup_enabled_mtn', 'mashup_enabled_telecel', 'mashup_enabled_at',
            'airtime_min_amount_customer', 'airtime_max_amount_customer',
            'mashup_min_amount_customer', 'mashup_max_amount_customer',
            'airtime_fee_mtn_customer', 'airtime_fee_mtn_agent', 'airtime_fee_mtn_dealer',
            'airtime_fee_telecel_customer', 'airtime_fee_telecel_agent', 'airtime_fee_telecel_dealer',
            'airtime_fee_at_customer', 'airtime_fee_at_agent', 'airtime_fee_at_dealer',
            'mashup_fee_mtn_customer', 'mashup_fee_mtn_agent', 'mashup_fee_mtn_dealer',
            'utility_bills_enabled', 'storefront_utilities_enabled', 'hubtel_utility_billers',
            'utility_min_amount', 'utility_max_amount',
        ])
    const settings: Record<string, string> = {}
    for (const row of (settingsRows || [])) settings[row.key] = row.value

    const { data: paystackFeeRows } = await db
        .from('shop_global_settings')
        .select('key, value')
        .in('key', roleFeeSettingKeys(ownerRole, 'shop_paystack_fee_percent'))
    const paystackFeeMap: Record<string, string> = {}
    for (const row of (paystackFeeRows || [])) paystackFeeMap[row.key] = row.value

    if (settings.shop_feature_enabled === 'false') return { ok: false, status: 503, error: 'Shop feature is currently disabled' }

    let totalAmount = 0, sellingPrice = 0, costPrice = 0, profit = 0
    let metadataPayload: any = {}, pkgNetwork = '', pkgSize = ''

    if (orderType === 'airtime' || orderType === 'mashup') {
        if (orderType === 'airtime' && settings.storefront_airtime_enabled === 'false') return { ok: false, status: 503, error: 'Airtime purchase is disabled' }
        if (orderType === 'mashup' && settings.storefront_mashup_enabled !== 'true') return { ok: false, status: 503, error: 'Mashup purchase is disabled' }
        const effectiveNetwork = orderType === 'mashup' ? 'MTN' : (network as string)
        if (settings[`airtime_enabled_${effectiveNetwork.toLowerCase()}`] === 'false') return { ok: false, status: 503, error: `${effectiveNetwork} ${orderType === 'mashup' ? 'Mashup' : 'airtime'} is disabled` }
        // Mashup carries its own per-network kill-switch (mashup_enabled_<net>) independent of
        // airtime_enabled_<net> — an admin can disable Mashup on a network without touching plain
        // airtime. Checked in addition to (not instead of) airtime_enabled_mtn above, since Mashup
        // still rides the same MTN rail for delivery.
        if (orderType === 'mashup' && settings[`mashup_enabled_${effectiveNetwork.toLowerCase()}`] === 'false') return { ok: false, status: 503, error: `${effectiveNetwork} Mashup is disabled` }

        const numAmount = parseFloat(amount as string)
        const minAmount = orderType === 'mashup'
            ? parseFloat(settings.mashup_min_amount_customer || '1')
            : parseFloat(settings.airtime_min_amount_customer || '1')
        const maxAmount = orderType === 'mashup'
            ? parseFloat(settings.mashup_max_amount_customer || '500')
            : parseFloat(settings.airtime_max_amount_customer || '500')
        if (isNaN(numAmount) || numAmount < minAmount || numAmount > maxAmount) return { ok: false, status: 400, error: 'Invalid airtime amount' }

        const shopFeeKey = `airtime_fee_${effectiveNetwork.toLowerCase()}`
        const shopFee = orderType === 'mashup' ? parseFloat((shop as any).mashup_fee_percent || 1) : parseFloat((shop as any)[shopFeeKey] || 0)
        const feePrefix = orderType === 'mashup' ? 'mashup' : 'airtime'
        const adminFee = parseFloat(settings[`${feePrefix}_fee_${effectiveNetwork.toLowerCase()}_${ownerRole}`] || '0')
        if (shopFee + adminFee > 10) return { ok: false, status: 503, error: `${orderType === 'mashup' ? 'Mashup' : 'Airtime'} is temporarily unavailable (Fee cap exceeded). Please contact the shop owner.` }

        const totalFeeMultiplier = (shopFee + adminFee) / 100
        const feeAmount = numAmount * totalFeeMultiplier
        let actualAirtimeAmount = numAmount
        if (useExactAmount) {
            totalAmount = Math.round((numAmount + feeAmount) * 100)
        } else {
            totalAmount = Math.round(numAmount * 100)
            actualAirtimeAmount = Math.max(0, numAmount - feeAmount)
        }
        if (actualAirtimeAmount < minAmount) return { ok: false, status: 400, error: `The combined fees are too high for this amount. The minimum airtime deliverable is GHS ${minAmount}.` }

        profit = actualAirtimeAmount > 0 ? actualAirtimeAmount * (shopFee / 100) : 0
        sellingPrice = actualAirtimeAmount; costPrice = actualAirtimeAmount; pkgNetwork = effectiveNetwork
        pkgSize = orderType === 'mashup' ? `GHS ${actualAirtimeAmount.toFixed(2)} Mashup Bundle` : `GHS ${actualAirtimeAmount.toFixed(2)} Airtime`
        metadataPayload = {
            order_type: orderType, network: effectiveNetwork, package_size: pkgSize,
            airtime_amount: actualAirtimeAmount, selling_price: actualAirtimeAmount, cost_price: actualAirtimeAmount,
            profit, fee_amount: feeAmount, use_exact_amount: !!useExactAmount, original_amount: numAmount,
            bundle_preference: resolvedBundlePreference,
        }
    } else if (orderType === 'utility') {
        // COMMISSION-based: the customer pays exact face value, profit = 0 by design — this
        // is the ONE order type where a zero profit is legal (the shop owner instead earns a
        // configurable share of Hubtel's commission via credit_utility_commission, credited
        // automatically because utility_orders.shop_id is set). This branch therefore does
        // NOT flow through the `profit <= 0` rejection guarding the data branch below.
        if (!isUtilityBiller(utilityBiller)) {
            return { ok: false, status: 400, error: 'Invalid biller' }
        }
        const billerDef = UTILITY_BILLERS[utilityBiller]

        if (settings['utility_bills_enabled'] !== 'true' || settings['storefront_utilities_enabled'] !== 'true') {
            return { ok: false, status: 503, error: 'Utility bill payments are currently unavailable' }
        }
        const billersMap = settings['hubtel_utility_billers'] as unknown
        if (!billersMap || typeof billersMap !== 'object' || Array.isArray(billersMap) || (billersMap as Record<string, unknown>)[utilityBiller] !== true) {
            return { ok: false, status: 503, error: `${billerDef.label} is currently unavailable` }
        }
        // Per-shop opt-out (shop_profiles.utilities_enabled) is an owner-controlled toggle,
        // not a temporary outage — 403 "This service is not available in this shop", not the
        // 503 used for the global admin_settings kill-switches checked above.
        if ((shop as any).utilities_enabled !== true) {
            return { ok: false, status: 403, error: 'This service is not available in this shop' }
        }

        const trimmedUtilityAccount = typeof utilityAccount === 'string' ? utilityAccount.trim() : ''
        if (!trimmedUtilityAccount) return { ok: false, status: 400, error: `${billerDef.accountLabel} is required` }
        if (trimmedUtilityAccount.length > 30) return { ok: false, status: 400, error: `${billerDef.accountLabel} is too long` }

        let destinationPhone: string | null = null
        if (utilityBiller === 'ecg' || utilityBiller === 'ghana_water') {
            const trimmedUtilityPhone = typeof utilityPhone === 'string' ? utilityPhone.trim() : ''
            if (!trimmedUtilityPhone) return { ok: false, status: 400, error: `${billerDef.label} requires a customer phone number` }
            destinationPhone = toMsisdn233(trimmedUtilityPhone)
        }

        const numUtilityAmount = Number(amount)
        if (!Number.isFinite(numUtilityAmount) || numUtilityAmount <= 0) return { ok: false, status: 400, error: 'Invalid amount' }
        const roundedUtilityAmount = Math.round(numUtilityAmount * 100) / 100
        const minUtilityAmount = parseSettingNumber(settings['utility_min_amount'], 1)
        const maxUtilityAmount = parseSettingNumber(settings['utility_max_amount'], 1000)
        if (roundedUtilityAmount < minUtilityAmount) return { ok: false, status: 400, error: `Minimum amount is GHS ${minUtilityAmount.toFixed(2)}` }
        if (roundedUtilityAmount > maxUtilityAmount) return { ok: false, status: 400, error: `Maximum amount is GHS ${maxUtilityAmount.toFixed(2)}` }

        sellingPrice = roundedUtilityAmount
        costPrice = roundedUtilityAmount
        profit = 0
        totalAmount = Math.round(roundedUtilityAmount * 100)
        pkgNetwork = ''
        pkgSize = billerDef.label
        metadataPayload = {
            order_type: 'utility',
            biller: utilityBiller,
            account_number: trimmedUtilityAccount,
            destination_phone: destinationPhone,
            account_name: null,
        }
    } else {
        const { data: pkg } = await db.from('data_packages').select('*').eq('id', packageId).eq('is_available', true).single()
        if (!pkg) return { ok: false, status: 404, error: 'Package not found or unavailable' }

        // Per-network out-of-stock guard (admin ∪ this shop). Pre-charge.
        const adminOOS = await getAdminOOSNetworks(db)
        const { data: shopStock } = await db.from('shop_profiles').select('oos_networks').eq('id', shop.id).maybeSingle()
        if (isNetworkOOS(mergeOOS(adminOOS, shopStock?.oos_networks), pkg.network)) {
            return { ok: false, status: 409, error: `${pkg.network} is out of stock at the moment` }
        }

        // MTN AgentPortal whitelist gate — pre-charge, shared by both
        // /api/shop/initialize and /api/shop/charge since both call this function.
        const whitelistGate = await checkMtnWhitelistGate(cleanPhone, pkg.network, pkg.category)
        if (whitelistGate.blocked) {
            return { ok: false, status: 400, error: whitelistGate.reason! }
        }

        const { data: shopPrice } = await db.from('shop_pricing').select('selling_price').eq('shop_id', shop.id).eq('package_id', packageId).maybeSingle()
        // Sub shops may have NO row for a package (zero-markup default): they sell at the
        // Lead's wholesale sub_price and earn 0. Normal shops must have priced the package.
        if (!shopPrice && !subCtx.isSub) return { ok: false, status: 404, error: 'Package not available in this shop' }

        let subRecruiterId: string | null = null
        let subRecruiterEarns: number | null = null

        if (subCtx.isSub) {
            const resolved = await resolveSubAgentDataCost(db, shop.owner_id, packageId!, pkg, 'data')
            if (!resolved.ok) {
                // NEVER surface resolved.reason to a storefront visitor (spec §11) — it would
                // let a caller infer something about the recruiter relationship.
                console.error(`[ShopCheckout] sub cost unresolvable: ${resolved.reason} (shop ${shop.id}, pkg ${packageId})`)
                return { ok: false, status: 400, error: 'Package not available in this shop' }
            }

            // The leaf sells at its own retail price, or at cost when it has set none
            // (the no-markup default keeps the catalog sellable).
            sellingPrice = shopPrice ? parseFloat(shopPrice.selling_price) : resolved.subCost
            costPrice = resolved.subCost
            profit = sellingPrice - costPrice
            if (sellingPrice <= 0 || profit < 0) {
                // Zero profit is legal for a sub (no-markup default); strictly negative is not.
                return { ok: false, status: 400, error: 'Invalid pricing configuration' }
            }

            subRecruiterId = resolved.recruiterId ?? null
            subRecruiterEarns = resolved.recruiterEarns
        } else {
            sellingPrice = parseFloat(shopPrice.selling_price)
            // Owner cost via the single shared resolver (lib/pricing/cost-basis) — expiry-aware,
            // so an owner whose dealer/agent window lapsed reverts to customer cost. (Spec D17.)
            costPrice = resolveOwnerCost(pkg, {
                role: shop.owner?.role,
                agent_expires_at: shop.owner?.agent_expires_at,
                dealer_expires_at: shop.owner?.dealer_expires_at,
            })
            profit = sellingPrice - costPrice
            if (sellingPrice <= 0 || profit <= 0) return { ok: false, status: 400, error: 'Invalid pricing configuration' }
        }

        const paystackFeePercent = resolveRoleFeeSetting(
            paystackFeeMap, ownerRole, 'shop_paystack_fee_percent', 1.95, shop.paystack_fee_percent
        )

        const paystackFee = Math.round(sellingPrice * (paystackFeePercent / 100) * 100) / 100
        totalAmount = Math.round((sellingPrice + paystackFee) * 100)
        pkgNetwork = pkg.network; pkgSize = pkg.size
        metadataPayload = {
            order_type: 'data', package_id: packageId, network: pkg.network, package_size: pkg.size,
            selling_price: sellingPrice, cost_price: costPrice, profit, paystack_fee: paystackFee,
            // Sub-agent attribution (null for normal shops) — the processor re-verifies
            // ALL splits from the DB; these are display/trace hints, never trusted.
            recruiter_id: subRecruiterId, recruiter_earns: subRecruiterEarns,
        }
    }

    return {
        ok: true, shop, cleanPhone, validatedGuestEmail,
        totalAmountPesewas: totalAmount, metadataPayload, pkgNetwork, pkgSize, ownerRole,
    }
}
