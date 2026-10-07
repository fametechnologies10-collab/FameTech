// lib/pricing/shop-fee-resolver.ts
// =============================================================================
// Shared role-based shop fee resolution (Paystack checkout fee %, withdrawal
// fee %/flat, min withdrawal amount). This exact 3-tier lookup
// (per-shop override -> role-tagged global -> untagged legacy global) was
// duplicated near-identically across 6 call sites (lib/shop-checkout.ts,
// lib/shop-order-processor.ts, lib/shop-afa-checkout.ts,
// lib/shop-afa-order-processor.ts, app/api/shop/withdraw/route.ts x2 fee
// kinds) with no shared source — exactly the "five places independently
// resolved role -> cost and had already drifted" failure mode
// lib/pricing/cost-basis.ts's own header warns about, and precisely how this
// one drifted: no site ever fell back to the customer rate for a sub-agent,
// so a sub-agent with no `${prefix}_subagent` global row (no admin UI has
// ever created one) silently landed on the untagged legacy rate instead of
// the customer rate (2026-09-17 finding).
//
// Resolution order for one fee value:
//   1. Per-shop override (shop_profiles column) — always wins, unconditionally.
//   2. Role-tagged global: `${keyPrefix}_${role}`
//   3. Sub-agents ONLY: customer-tagged global `${keyPrefix}_customer` — a
//      sub-agent has no product-tier pricing of their own; their shop is
//      priced off the customer rate unless the recruiter's own network has
//      been given an explicit `_subagent`-tagged override.
//   4. Untagged legacy global: `${keyPrefix}` (what every other role without
//      its own tagged row already falls back to).
//   5. hardcodedDefault.
// =============================================================================

/** The settings keys to SELECT from shop_global_settings for one fee prefix + role. */
export function roleFeeSettingKeys(role: string | null | undefined, keyPrefix: string): string[] {
    const keys = [`${keyPrefix}_${role}`, keyPrefix]
    if (role === 'subagent') keys.push(`${keyPrefix}_customer`)
    return keys
}

/**
 * Resolve one fee value given a settings map already fetched via
 * roleFeeSettingKeys()'s key list (or a superset of it).
 */
export function resolveRoleFeeSetting(
    settingsMap: Record<string, string | number | null | undefined>,
    role: string | null | undefined,
    keyPrefix: string,
    hardcodedDefault: number,
    perShopOverride?: number | string | null,
): number {
    if (perShopOverride !== null && perShopOverride !== undefined && perShopOverride !== '') {
        const overrideNum = parseFloat(String(perShopOverride))
        if (Number.isFinite(overrideNum)) return overrideNum
    }

    const roleKey = `${keyPrefix}_${role}`
    if (settingsMap[roleKey] != null) {
        const n = parseFloat(String(settingsMap[roleKey]))
        if (Number.isFinite(n)) return n
    }

    if (role === 'subagent') {
        const customerKey = `${keyPrefix}_customer`
        if (settingsMap[customerKey] != null) {
            const n = parseFloat(String(settingsMap[customerKey]))
            if (Number.isFinite(n)) return n
        }
    }

    if (settingsMap[keyPrefix] != null) {
        const n = parseFloat(String(settingsMap[keyPrefix]))
        if (Number.isFinite(n)) return n
    }

    return hardcodedDefault
}
