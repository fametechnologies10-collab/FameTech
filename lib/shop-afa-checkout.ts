// lib/shop-afa-checkout.ts
// Single-source pricing + validation for shop storefront AFA registration checkout.
// Mirrors lib/shop-checkout.ts's airtime/mashup percentage-markup branch (AFA has one
// fixed base price per role, not a per-item shop_pricing row like data bundles).

import { validateAfaRegistration } from '@/lib/afa-validation'
import { AFA_PRICE_KEYS, resolveAfaPrice } from '@/lib/afa-pricing'
import { roleFeeSettingKeys, resolveRoleFeeSetting } from '@/lib/pricing/shop-fee-resolver'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentAfaCost } from '@/lib/sub-agent-afa-pricing'

export interface ShopAfaCheckoutInput {
    shopSlug: string
    guestPhone: string
    formData: Record<string, any>
}

export interface ShopAfaCheckoutResult {
    ok: true
    shop: any
    cleanPhone: string
    costPrice: number
    sellingPrice: number
    profit: number
    totalAmountPesewas: number
    metadataPayload: Record<string, any>
}
export interface ShopAfaCheckoutError {
    ok: false
    status: number
    error: string
    contact?: { phone?: string; whatsapp?: string; email?: string }
}

/** Pure pricing calc — flat selling price set by the shop owner, rounded to 2dp like every other shop fee. */
export function computeAfaShopPricing(costPrice: number, sellingPrice: number): { sellingPrice: number; profit: number } {
    const roundedSellingPrice = Math.round(sellingPrice * 100) / 100
    const profit = Math.round((roundedSellingPrice - costPrice) * 100) / 100
    return { sellingPrice: roundedSellingPrice, profit }
}

/**
 * Validate + price a shop AFA checkout. `db` is a service-role server client.
 * Does NOT call Paystack and does NOT create any DB rows — pure computation,
 * matching computeShopCheckout's contract exactly.
 */
export async function computeShopAfaCheckout(db: any, body: ShopAfaCheckoutInput): Promise<ShopAfaCheckoutResult | ShopAfaCheckoutError> {
    const { shopSlug, guestPhone, formData } = body

    if (!shopSlug || !guestPhone || !formData || typeof formData !== 'object') {
        return { ok: false, status: 400, error: 'Missing required fields' }
    }
    if (typeof shopSlug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(shopSlug)) {
        return { ok: false, status: 400, error: 'Invalid shop identifier' }
    }
    if (typeof guestPhone !== 'string') return { ok: false, status: 400, error: 'Invalid phone number' }
    const cleanPhone = guestPhone.replace(/\s+/g, '')
    if (!/^(0\d{9}|233\d{9})$/.test(cleanPhone)) {
        return { ok: false, status: 400, error: 'Invalid phone number. Use format: 0XXXXXXXXX or 233XXXXXXXXX' }
    }

    const validation = validateAfaRegistration(formData)
    if (!validation.ok) {
        if (validation.field === '__config') {
            console.error(`[ShopAfaCheckout] ${validation.message} (id_type: "${formData.id_type}")`)
            return { ok: false, status: 500, error: validation.message }
        }
        return { ok: false, status: 400, error: validation.message }
    }

    const { data: shop, error: shopError } = await db
        .from('shop_profiles')
        .select(`
            id, shop_name, shop_slug, owner_id, approval_status, is_active,
            owner_phone, whatsapp_number, afa_selling_price, paystack_fee_percent,
            owner:users!shop_profiles_owner_id_fkey(role, email)
        `)
        .eq('shop_slug', shopSlug)
        .single()

    if (shopError || !shop) return { ok: false, status: 404, error: 'Shop not found' }

    if (shop.approval_status !== 'approved' || !shop.is_active) {
        return {
            ok: false, status: 403, error: 'This shop is not currently active',
            contact: { phone: shop.owner_phone, whatsapp: shop.whatsapp_number, email: shop.owner?.email },
        }
    }

    const { data: settingsRows } = await db
        .from('admin_settings')
        .select('key, value')
        .in('key', ['storefront_afa_enabled', ...AFA_PRICE_KEYS])
    const settings: Record<string, string> = {}
    for (const row of (settingsRows || [])) settings[row.key] = row.value

    // admin_settings.value is jsonb. Repo convention is a JSON STRING ('true'/'false'),
    // matching every sibling storefront toggle and what the admin UI writes — but a
    // boolean once slipped in here (fixed in 20260901c_fix_afa_toggle_jsonb_type.sql)
    // and a strict `!== 'true'` check would have kept the gate closed forever with no
    // error. Accept either representation defensively.
    const afaEnabled = settings.storefront_afa_enabled
    if (String(afaEnabled) !== 'true') {
        return { ok: false, status: 503, error: 'AFA registration is not currently available' }
    }
    // No separate enable flag — a shop is AFA-enabled purely by having saved a
    // selling price (matches RC/airtime: configuring a price is what turns it on).
    // Unlike the old percentage model, 0 is not a valid live value here — a selling
    // price must exceed cost, so <= 0 means "not configured".
    if (shop.afa_selling_price === null || shop.afa_selling_price === undefined || parseFloat(String(shop.afa_selling_price)) <= 0) {
        return { ok: false, status: 403, error: 'AFA registration is not available for this shop' }
    }

    const ownerRole = shop.owner?.role || 'customer'

    // Sub-agent storefront pricing (Plan 2c): the shop OWNER may themselves be a
    // recruited sub-agent. When so, their true wholesale cost comes from the
    // sub-agent pricing engine instead of the flat role price — the shop's own
    // markup to the guest below is completely unaffected either way.
    const subCtx = await resolveSubAgentContext(db, shop.owner_id)
    let costPrice: number
    if (subCtx.isSub) {
        const subCostResult = await resolveSubAgentAfaCost(db, shop.owner_id, settings)
        if (!subCostResult.ok) {
            return { ok: false, status: 500, error: 'Registration pricing is not configured. Please contact support.' }
        }
        costPrice = subCostResult.subCost
    } else {
        const resolvedCostPrice = resolveAfaPrice(settings, ownerRole)
        if (resolvedCostPrice === null) {
            return { ok: false, status: 500, error: 'Registration pricing is not configured. Please contact support.' }
        }
        costPrice = resolvedCostPrice
    }

    const { sellingPrice, profit } = computeAfaShopPricing(costPrice, parseFloat(String(shop.afa_selling_price)))
    // Underwater guard: if the admin later raises the base price above what the shop
    // saved, profit goes negative — block the sale rather than sell at a loss. Mirrors
    // the DATA branch's identical guard in lib/shop-checkout.ts.
    if (sellingPrice <= 0 || profit <= 0) return { ok: false, status: 400, error: 'Invalid pricing configuration' }

    const { data: paystackFeeRows } = await db
        .from('shop_global_settings')
        .select('key, value')
        .in('key', roleFeeSettingKeys(ownerRole, 'shop_paystack_fee_percent'))
    const paystackFeeMap: Record<string, string> = {}
    for (const row of (paystackFeeRows || [])) paystackFeeMap[row.key] = row.value

    const paystackFeePercent = resolveRoleFeeSetting(
        paystackFeeMap, ownerRole, 'shop_paystack_fee_percent', 1.95, shop.paystack_fee_percent
    )

    const paystackFee = Math.round(sellingPrice * (paystackFeePercent / 100) * 100) / 100
    const totalAmountPesewas = Math.round((sellingPrice + paystackFee) * 100)

    return {
        ok: true,
        shop,
        cleanPhone,
        costPrice,
        sellingPrice,
        profit,
        totalAmountPesewas,
        metadataPayload: {
            order_type: 'afa',
            selling_price: sellingPrice,
            cost_price: costPrice,
            profit,
            paystack_fee: paystackFee,
            form_data: formData,
        },
    }
}
