// lib/afa-pricing.ts
//
// Single source of truth for resolving the AFA registration price for a role.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// The role→price mapping was duplicated across the dashboard price route, the
// dashboard registration route, the v2 developer API and the shop storefront
// checkout. Every one of those copies read only afa_price_customer /
// afa_price_agent, so `afa_price_dealer` — which IS configured and IS exposed
// in the admin UI — was dead config and dealers were silently charged the
// customer price. Only lib/ussd/price-resolver.ts got it right.
//
// Same shape as lib/afa-validation.ts: pure, dependency-free, no DB and no
// response shaping, so each caller keeps its own error envelope.

/** Every admin_settings key the AFA role tiers can read. Use for the .in() filter. */
export const AFA_PRICE_KEYS = ['afa_price_customer', 'afa_price_agent', 'afa_price_dealer'] as const

function parsePositive(raw: unknown): number | null {
    if (raw === null || raw === undefined || raw === '') return null
    const n = parseFloat(String(raw))
    return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Resolve the AFA price for a role from an admin_settings key→value map.
 *
 * Falls back to the customer price when a role-specific price is missing or
 * invalid — a missing dealer price must never make AFA free. Returns null only
 * when the customer price itself is unusable, which callers should treat as
 * "pricing not configured" (a 500, not a 400 — it is our misconfiguration).
 *
 * Mirrors the tier logic in lib/ussd/price-resolver.ts, which had it right.
 */
export function resolveAfaPrice(
    settings: Record<string, unknown>,
    role: string | null | undefined,
): number | null {
    if (role === 'dealer') {
        const dealer = parsePositive(settings['afa_price_dealer'])
        if (dealer !== null) return dealer
    } else if (role === 'agent') {
        const agent = parsePositive(settings['afa_price_agent'])
        if (agent !== null) return agent
    }
    return parsePositive(settings['afa_price_customer'])
}
