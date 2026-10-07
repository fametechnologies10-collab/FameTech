// Single source of truth for Paystack top-up fee % and amount limits.
// Used by BOTH the charge/initialize routes (authoritative) and the
// claim-momo settings endpoint (display), so the fee a user SEES always
// equals the fee they are CHARGED.

export interface RoleFeeContext {
    role?: string | null
    agentExpiresAt?: string | null
    dealerExpiresAt?: string | null
}

/**
 * admin_settings.value is JSONB; supabase-js writes plain strings as JSON
 * strings (e.g. the literal `"1.95"`), so reads may be a number, a bare
 * string, or a quote-wrapped string. Parse all of them, falling back when
 * the value is missing, blank, or non-numeric.
 */
export function parseSettingNumber(raw: unknown, fallback: number): number {
    if (raw === undefined || raw === null) return fallback
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : fallback
    if (typeof raw === 'string') {
        const cleaned = raw.replace(/^"|"$/g, '').trim()
        if (cleaned === '') return fallback
        const n = parseFloat(cleaned)
        return Number.isFinite(n) ? n : fallback
    }
    return fallback
}

function isActive(expiresAt?: string | null): boolean {
    // No expiry recorded → treat as active (matches existing route logic).
    if (!expiresAt) return true
    const t = new Date(expiresAt).getTime()
    if (!Number.isFinite(t)) return true
    return t > Date.now()
}

/**
 * Resolve the effective Paystack top-up fee percent for a user.
 * Dealer fee falls back to the customer base fee when unset (user decision),
 * then to 1.95 as a hard floor.
 */
export function resolvePaystackFeePercent(
    ctx: RoleFeeContext,
    settings: Record<string, unknown>,
): number {
    const base = parseSettingNumber(settings['paystack_fee_percent'], 1.95)

    if (ctx.role === 'dealer' && isActive(ctx.dealerExpiresAt)) {
        return parseSettingNumber(settings['dealer_paystack_fee_percent'], base)
    }
    if (ctx.role === 'agent' && isActive(ctx.agentExpiresAt)) {
        return parseSettingNumber(settings['agent_paystack_fee_percent'], base)
    }
    return base
}

/**
 * Resolve admin-configured top-up limits, with defensive guards so a
 * malformed/inverted admin value can never open an unbounded charge.
 */
export function resolveTopupLimits(
    settings: Record<string, unknown>,
): { min: number; max: number } {
    let min = parseSettingNumber(settings['paystack_min_topup'], 5)
    let max = parseSettingNumber(settings['paystack_max_topup'], 5000)
    if (!(min >= 1)) min = 5
    // Keep the range non-degenerate even if an admin inverts min/max.
    if (!(max >= min)) max = Math.max(5000, min + 1)
    return { min, max }
}
