// lib/user-role-status.ts
// Resolves a user's role into a status object answering "am I still a
// dealer/agent, and for how many more days?" — used by
// GET /api/v2/account/role. Mirrors the active/expired logic already used
// for pricing (data/purchase's isActiveDealerV1/isActiveAgentV1 pattern and
// effectiveRoleFromExpiry() in lib/results-checker-service.ts): a NULL
// expiry means permanent/lifetime; a non-NULL expiry that has passed means
// the role is no longer active, even though `role` itself hasn't changed in
// the users table.
export interface RoleStatus {
    role: string
    is_active: boolean
    is_permanent: boolean
    expires_at: string | null
    days_remaining: number | null
}

export function resolveRoleStatus(
    role: string,
    dealerExpiresAt: string | null,
    agentExpiresAt: string | null,
): RoleStatus {
    const expiresAt = role === 'dealer' ? dealerExpiresAt : role === 'agent' ? agentExpiresAt : null

    if (!expiresAt) {
        return { role, is_active: true, is_permanent: true, expires_at: null, days_remaining: null }
    }

    const now = Date.now()
    const expiry = new Date(expiresAt).getTime()
    // Boundary convention: an expiry exactly equal to `now` counts as EXPIRED
    // (strict `>`). This deliberately matches effectiveRoleFromExpiry() in
    // lib/results-checker-service.ts. Note it differs by one millisecond from
    // isActiveDealerV1/isActiveAgentV1 in lib/api-handlers/data-purchase.ts,
    // which derive "expired" as `expiry < now` and therefore still price an
    // exactly-now expiry as active. Those two pre-existing call sites already
    // disagreed with each other, so no single choice here can match both — do
    // NOT "harmonize" them without deciding which behaviour is authoritative
    // for pricing, since that is a real money decision, not a cleanup.
    const isActive = expiry > now

    const msRemaining = expiry - now
    const daysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)))

    return {
        role,
        is_active: isActive,
        is_permanent: false,
        expires_at: expiresAt,
        days_remaining: daysRemaining,
    }
}
