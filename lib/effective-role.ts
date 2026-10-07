// lib/effective-role.ts
//
// Single source of truth for "what role should this user be PRICED at right
// now?" — as opposed to `users.role`, which is what they were last granted.
//
// The two differ because nothing downgrades an expired agent. There is a cron
// for dealers (app/api/cron/downgrade-expired-dealers) but no equivalent for
// agents, so `role` stays 'agent' indefinitely after agent_expires_at passes
// and every read path has to decide for itself whether to honour the expiry.
// Historically some did (data/purchase, the storefront, USSD) and some did not
// (airtime, results-checker), so the same account was charged different prices
// depending on which surface it used.
//
// Extracted from lib/results-checker-service.ts (where it lived as
// effectiveRoleFromExpiry) so lib/api-auth.ts can use it without importing the
// whole results-checker service, which would create an import cycle. That file
// re-exports this one, so its existing callers are unchanged.
//
// BOUNDARY CONVENTION: an expiry exactly equal to `now` counts as EXPIRED
// (strict `>` for active). This is deliberate and now authoritative for
// pricing. It matches what effectiveRoleFromExpiry and resolveRoleStatus
// already did; the one dissenter was isActiveDealerV1/isActiveAgentV1 in
// lib/api-handlers/data-purchase.ts, which used `expiry < now` and so priced an
// exactly-now expiry as still active. That one-millisecond disagreement is
// resolved in favour of the majority here. Practically unreachable either way —
// what matters is that one rule now governs every surface.

export type PricingRole = 'customer' | 'agent' | 'dealer'

export function effectiveRoleFromExpiry(
    role: string | null | undefined,
    agentExpiresAt: string | null,
    dealerExpiresAt: string | null,
): PricingRole {
    const now = Date.now()
    // A NULL expiry means permanent/lifetime for that tier, so fall back to the
    // granted role. A non-NULL expiry is authoritative regardless of `role`.
    const isDealer = dealerExpiresAt ? new Date(dealerExpiresAt).getTime() > now : role === 'dealer'
    if (isDealer) return 'dealer'
    const isAgent = agentExpiresAt ? new Date(agentExpiresAt).getTime() > now : role === 'agent'
    if (isAgent) return 'agent'
    return 'customer'
}
