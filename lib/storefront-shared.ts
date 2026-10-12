// Shared server-side helpers for the two storefront entry points:
//   - app/shop-domain/[shopSlug]/page.tsx  (what shop.fametechgh.com actually serves)
//   - app/shop/[shopSlug]/page.tsx         (previews / non-apex hosts)
// Both used to carry their own copy of this logic and had drifted (is_active gate, the
// utilities gate, the full-row spread into the client component). Keep it HERE.

import { UTILITY_BILLER_KEYS, type UtilityBiller } from '@/lib/hubtel-utility/billers'
import { parseSettingNumber } from '@/lib/paystack-fees'

/** The columns the storefront client actually reads — nothing else may cross the RSC boundary. */
export const STOREFRONT_SHOP_COLUMNS =
    'id, shop_name, shop_slug, description, owner_phone, owner_email, whatsapp_number, logo_url, community_link, divider_style, brand_color, brand_accent, approval_status, pricing_status, is_active, owner_id, airtime_fee_mtn, airtime_fee_telecel, airtime_fee_at, mashup_fee_percent, results_checker_markup_customer, ussd_code, ussd_active, oos_networks, utilities_enabled, afa_selling_price, paystack_fee_percent'

export interface StorefrontClientShop {
    id: string
    shop_name: string
    shop_slug: string
    description: string
    owner_phone: string
    owner_email: string | null
    whatsapp_number: string | null
    logo_url: string | null
    community_link: string | null
    divider_style: string | null
    brand_color: string
    brand_accent: string
    ownerRole: string
    airtime_fee_mtn?: number
    airtime_fee_telecel?: number
    airtime_fee_at?: number
    mashup_fee_percent?: number
    ussd_code: string | null
    ussd_active?: boolean
    afa_selling_price: number | null
    paystack_fee_percent: number | null
}

/**
 * Explicit allowlist of what the browser receives. The page loads the whole shop row with the
 * service role (owner_id, approval/pricing status, oos list, results-checker markup, …); spreading
 * it into a client component serialises every column into the public HTML/RSC payload.
 */
export function toClientShop(shop: any, ownerRole: string): StorefrontClientShop {
    return {
        id: shop.id,
        shop_name: shop.shop_name,
        shop_slug: shop.shop_slug,
        description: shop.description,
        owner_phone: shop.owner_phone,
        owner_email: shop.owner_email ?? null,
        whatsapp_number: shop.whatsapp_number ?? null,
        logo_url: shop.logo_url ?? null,
        community_link: shop.community_link ?? null,
        divider_style: shop.divider_style ?? null,
        brand_color: shop.brand_color,
        brand_accent: shop.brand_accent,
        ownerRole,
        airtime_fee_mtn: shop.airtime_fee_mtn,
        airtime_fee_telecel: shop.airtime_fee_telecel,
        airtime_fee_at: shop.airtime_fee_at,
        mashup_fee_percent: shop.mashup_fee_percent,
        ussd_code: shop.ussd_code ?? null,
        ussd_active: shop.ussd_active,
        afa_selling_price: shop.afa_selling_price ?? null,
        paystack_fee_percent: shop.paystack_fee_percent ?? null,
    }
}

/** A shop may only be shown / transacted with when approved AND active. */
export function isShopLive(shop: { approval_status?: string | null; is_active?: boolean | null } | null | undefined): boolean {
    return !!shop && shop.approval_status === 'approved' && shop.is_active === true
}

/**
 * Utility Bills tab gate — resolved ONCE, server-side, into a single boolean so the client never
 * re-derives gating. Mirrors the gate chain in app/api/shop/utility/lookup and the 'utility'
 * branch of lib/shop-checkout.ts: global admin gates AND ≥1 biller enabled AND the shop's own
 * opt-in. Sub-agent shops are NOT excluded — computeShopCheckout lets them sell all four
 * product types, so hiding the tab for them would only desync the UI from the server.
 */
export function resolveUtilityStorefrontConfig(adminSettingsMap: Record<string, any>, shopUtilitiesEnabled: unknown) {
    const billersMapRaw = adminSettingsMap['hubtel_utility_billers']
    const enabledUtilityBillers: Partial<Record<UtilityBiller, boolean>> = {}
    for (const key of UTILITY_BILLER_KEYS as UtilityBiller[]) {
        enabledUtilityBillers[key] = !!(
            billersMapRaw && typeof billersMapRaw === 'object' && !Array.isArray(billersMapRaw) && billersMapRaw[key] === true
        )
    }
    const anyUtilityBillerEnabled = Object.values(enabledUtilityBillers).some(Boolean)

    const utilitiesEnabled =
        adminSettingsMap['utility_bills_enabled'] === 'true' &&
        adminSettingsMap['storefront_utilities_enabled'] === 'true' &&
        anyUtilityBillerEnabled &&
        shopUtilitiesEnabled === true

    return {
        utilitiesEnabled,
        enabledUtilityBillers,
        utilityMinAmount: parseSettingNumber(adminSettingsMap['utility_min_amount'], 1),
        utilityMaxAmount: parseSettingNumber(adminSettingsMap['utility_max_amount'], 1000),
    }
}
