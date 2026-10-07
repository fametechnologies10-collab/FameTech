// lib/results-checker-pricing.ts
// =============================================================================
// Leaf pricing module for Results-Checker. Deliberately has NO imports of its
// own beyond types — `lib/results-checker-service.ts` imports FROM here, and
// `lib/sub-agent-rc-pricing.ts` imports FROM here too. Neither of those two
// files may be imported back into this one; that was the real circular import
// (review finding I3, final review of
// docs/superpowers/plans/2026-09-09-subagent-afa-rc-dashboard-wiring.md):
// lib/sub-agent-rc-pricing.ts -> lib/results-checker-service.ts -> (back to)
// lib/sub-agent-rc-pricing.ts, which also dragged in results-checker-service's
// `./supabase` module-scope `createBrowserClient()` call any time only the
// pricing helper was needed (e.g. in a plain node test script with no
// NEXT_PUBLIC_SUPABASE_* env vars set).
// =============================================================================

export interface RCTypeLike {
    customer_price: number
    agent_price: number
    dealer_price: number
    cost_price: number
    bulk_pricing?: Array<{ min_qty: number; max_qty: number; unit_price: number }>
}

export interface RCBulkTier {
    min_qty: number
    max_qty: number
    unit_price: number
}

export interface RCBreakdown {
    unitPrice: number
    shopMarkup: number
    subtotal: number
    paystackFee: number
    total: number
    appliedBulkTier: RCBulkTier | null
}

// Shared verbatim across every RC route that can reject a purchase/preview because a
// recruited sub-agent's pricing engine returned !ok (review findings C1/m6, final review of
// docs/superpowers/plans/2026-09-10-subagent-storefront-afa-rc-wiring.md). Originally
// hardcoded independently in app/api/results-checker/purchase, app/api/v2/resultschecker/
// purchase, and the storefront initialize/charge routes — four copies that could (and, per
// that review, started to) drift. Import this pair instead of re-typing the string.
export const SUB_AGENT_PRICING_UNAVAILABLE_MESSAGE = 'Pricing is not available for this service right now'
export const SUB_AGENT_PRICING_UNAVAILABLE_STATUS = 409

/**
 * Returns the role-based unit price for a type. No bulk-tier or cost-floor
 * logic here — see resolveRcUnitPrice for the full price a purchase actually
 * uses.
 */
export function getPriceForRole(type: RCTypeLike, userRole: string): number {
    if (userRole === 'dealer' && type.dealer_price > 0) return type.dealer_price
    if (userRole === 'agent' && type.agent_price > 0) return type.agent_price
    return type.customer_price
}

/**
 * The single source of truth for "what does ONE unit of this type cost, for
 * this role, at this quantity" — bulk-tier matching included. Both
 * `calculateRCPrice` (storefront/dashboard/USSD quantity menu) and
 * `resolveSubAgentRcCost` (sub-agent pricing) must call this, never
 * re-derive it, so a bulk discount a customer would get is never silently
 * dropped for a sub-agent purchase at the same quantity (review finding C1 —
 * previously resolveSubAgentRcCost derived cost from getPriceForRole alone,
 * ignoring bulk_pricing entirely, so a sub-agent buying in bulk could end up
 * paying MORE per unit than a walk-in customer got via the bulk tier).
 *
 * Always floored at type.cost_price — a below-cost role tier or bulk tier
 * must never be quoted, to anyone, on any surface.
 */
export function resolveRcUnitPrice(
    type: RCTypeLike,
    quantity: number,
    userRole: string,
): { unitPrice: number; matchedTier: RCBulkTier | null } {
    let unitPrice = Math.max(getPriceForRole(type, userRole), type.cost_price)

    const bulkTiers: RCBulkTier[] = Array.isArray(type.bulk_pricing) ? type.bulk_pricing : []
    const matchedTier = bulkTiers.find(
        tier => quantity >= tier.min_qty && quantity <= tier.max_qty
    ) || null

    if (matchedTier) {
        // Bulk price still must not be below cost_price (security)
        unitPrice = Math.max(matchedTier.unit_price, type.cost_price)
    }

    return { unitPrice, matchedTier }
}

/**
 * Overrides a computed RCBreakdown's unit price with the sub-agent cost basis (Plan 2c,
 * Task 3), mirroring EXACTLY the composition purchaseWithWallet established for the
 * dashboard RC path (search resolveSubAgentRcCost): the sub's per-unit cost replaces
 * breakdown.unitPrice, and breakdown.shopMarkup — the shop's own storefront markup — stacks
 * on top unchanged. subtotal/total are then re-derived at the SAME quantity.
 *
 * The dashboard path never had a Paystack fee to worry about (wallet purchases pass
 * includePaystackFee: false, so breakdown.paystackFee is always 0 there and the override
 * skips straight to `total = subtotal + 0`). The storefront checkout routes DO charge a
 * Paystack fee, computed by calculateRCPrice as a fixed percentage of the pre-override
 * subtotal — left untouched, that fee would silently undercharge/overcharge once the unit
 * price changes. Rather than re-deriving the fee percent here (calculateRCPrice doesn't
 * expose it), the fee is rescaled by the same ratio calculateRCPrice already applied
 * (paystackFee / subtotal), which reduces to the identical zero-fee case the dashboard path
 * relies on when paystackFee is 0.
 *
 * Moved here (review finding m3) from lib/results-checker-service.ts — this function is
 * pure arithmetic with zero DB access, so it belongs in the leaf pricing module for the
 * same reason resolveRcUnitPrice/getPriceForRole do: importing it must never drag in
 * results-checker-service.ts's module-scope createServerClient() side effect (breaks a pure
 * node test script with no NEXT_PUBLIC_SUPABASE_* env vars set). Re-exported from
 * lib/results-checker-service.ts for existing importers.
 */
export function applySubAgentRcOverride(
    breakdown: RCBreakdown,
    subAgentUnitPrice: number,
    quantity: number,
): RCBreakdown {
    const overriddenSubtotal = parseFloat(((subAgentUnitPrice + breakdown.shopMarkup) * quantity).toFixed(2))
    const feeRatio = breakdown.subtotal > 0 ? breakdown.paystackFee / breakdown.subtotal : 0
    const overriddenFee = parseFloat((overriddenSubtotal * feeRatio).toFixed(2))
    return {
        ...breakdown,
        unitPrice: subAgentUnitPrice,
        subtotal: overriddenSubtotal,
        paystackFee: overriddenFee,
        total: parseFloat((overriddenSubtotal + overriddenFee).toFixed(2)),
    }
}
