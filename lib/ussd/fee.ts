import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// USSD service fee — a single percentage charged on all USSD MoMo payments.
// Applied silently at the price-lock step; never shown as a separate line.
// Admin configures via admin_settings key: ussd_fee_percent (default: 1).
// =============================================================================

/** Fetch the configured fee percentage from admin_settings. Returns 0 on error. */
export async function getUSSDFeePercent(supabase: SupabaseClient): Promise<number> {
    try {
        const { data } = await supabase
            .from('admin_settings')
            .select('value')
            .eq('key', 'ussd_fee_percent')
            .maybeSingle()

        const parsed = parseFloat((data as any)?.value ?? '0')
        return isNaN(parsed) || parsed < 0 ? 0 : parsed
    } catch {
        return 0
    }
}

/**
 * Dedicated service fee for SHOP storefront USSD orders (admin_settings key:
 * ussd_shop_fee_percent, default 0). This fee is charged to the guest on top of
 * the shop's selling price but is RETAINED BY THE PLATFORM — it is never credited
 * to the shop owner (exactly like the website shop Paystack fee). Returns 0 on error.
 */
export async function getShopUSSDFeePercent(supabase: SupabaseClient): Promise<number> {
    try {
        const { data } = await supabase
            .from('admin_settings')
            .select('value')
            .eq('key', 'ussd_shop_fee_percent')
            .maybeSingle()

        const parsed = parseFloat((data as any)?.value ?? '0')
        return isNaN(parsed) || parsed < 0 ? 0 : parsed
    } catch {
        return 0
    }
}

/**
 * Pick the right USSD fee: the dedicated shop fee for storefront (shop) orders,
 * otherwise the global USSD fee. Keeps shop pricing isolated from admin USSD pricing.
 */
export async function resolveUSSDFeePercent(
    supabase: SupabaseClient,
    shopId?: string | null,
): Promise<number> {
    return shopId
        ? getShopUSSDFeePercent(supabase)
        : getUSSDFeePercent(supabase)
}

/**
 * Apply a percentage fee to a base price and round to 2 decimal places.
 * E.g. applyFee(5.00, 1) → 5.05
 * A fee of 0 returns the base price unchanged.
 */
export function applyFee(basePrice: number, feePercent: number): number {
    if (feePercent <= 0) return basePrice
    return parseFloat((basePrice * (1 + feePercent / 100)).toFixed(2))
}
