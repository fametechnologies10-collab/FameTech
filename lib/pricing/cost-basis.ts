// lib/pricing/cost-basis.ts
// =============================================================================
// SINGLE SHARED cost-basis source (spec §7.1, D17).
//
// Before this module, five places independently resolved "role -> cost" and had
// already DRIFTED (the single-owner reprice RPC was missing its dealer branch).
// Every TypeScript charge path must import from here — no local copies.
//
// Pure + synchronous + no I/O so it can be unit-tested and kept in lock-step with
// the SQL twin `effective_owner_cost()` via scripts/test-cost-basis.ts (parity).
//
// The documented rule (mirrored in SQL):
//   owner_cost(pkg, role, expiries) =
//     dealer_price  if active dealer  AND dealer_price > 0
//     agent_price   if active/lifetime agent AND agent_price > 0
//     price         otherwise (customer tier / fallback when a tier price is null|0)
// =============================================================================

/** The three price tiers carried on a data_packages row (agent/dealer nullable). */
export interface PackageTiers {
  price: number | string | null | undefined // customer tier (always present in practice)
  agent_price?: number | string | null
  dealer_price?: number | string | null
}

/** The role + expiry snapshot for the party whose cost we are resolving. */
export interface RoleContext {
  role?: string | null
  agent_expires_at?: string | null
  dealer_expires_at?: string | null
}

/** Coerce a DB numeric/string/null into a finite number (0 when absent/invalid). */
function num(v: number | string | null | undefined): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

/** A timestamp is "expired" only when present AND strictly in the past. */
export function isExpired(ts: string | null | undefined, now: Date = new Date()): boolean {
  return !!ts && new Date(ts) < now
}

/** Active dealer = role 'dealer' with a non-expired dealer window. */
export function isActiveDealer(ctx: RoleContext, now: Date = new Date()): boolean {
  return ctx.role === 'dealer' && !isExpired(ctx.dealer_expires_at, now)
}

/**
 * Active agent (for PRICING) = role 'agent' with a non-expired agent window.
 * A lifetime agent (agent_expires_at null) is always active.
 * NOTE: this is the PRICING check; ownership eligibility is stricter — see
 * canOwnSubNetwork (lifetime-only). Do not conflate the two.
 */
export function isActiveAgent(ctx: RoleContext, now: Date = new Date()): boolean {
  return ctx.role === 'agent' && !isExpired(ctx.agent_expires_at, now)
}

/**
 * Pure role -> tier-price mapping, NO expiry. This is the canonical core mirrored
 * by the SQL twin `effective_owner_cost()` (Phase 2.2), used at REPRICE time where
 * an explicit old_role/new_role is supplied (expiry is irrelevant — the label changed).
 * Falls back to customer `price` when the requested tier is unpriced (null|0).
 */
export function tierCost(pkg: PackageTiers, role: string | null | undefined): number {
  const dealer = num(pkg.dealer_price)
  const agent = num(pkg.agent_price)
  const customer = num(pkg.price)
  if (role === 'dealer' && dealer > 0) return dealer
  if (role === 'agent' && agent > 0) return agent
  return customer
}

/**
 * Resolve the CHARGE-TIME cost price for a party buying/selling a package. Layers
 * expiry on top of tierCost: an expired dealer/agent reverts to customer pricing
 * (their `role` may still say 'dealer' for up to 6h until the downgrade cron runs).
 * This is the ONE function every TS charge path uses for owner/buyer cost.
 */
export function resolveOwnerCost(pkg: PackageTiers, ctx: RoleContext, now: Date = new Date()): number {
  if (isActiveDealer(ctx, now)) return tierCost(pkg, 'dealer')
  if (isActiveAgent(ctx, now)) return tierCost(pkg, 'agent')
  return tierCost(pkg, 'customer') // == pkg.price
}

/**
 * Eligibility to OWN/run a sub-agent network (spec §8.1, D15).
 * Stricter than isActiveAgent: only LIFETIME agents (agent_expires_at IS NULL) or
 * ACTIVE dealers qualify — because no cron demotes an expired temporary agent, so
 * `role='agent'` alone is not proof of standing. Evaluate LIVE at every gate.
 */
export function canOwnSubNetwork(ctx: RoleContext, now: Date = new Date()): boolean {
  if (ctx.role === 'agent' && (ctx.agent_expires_at === null || ctx.agent_expires_at === undefined)) return true
  if (ctx.role === 'dealer' && !isExpired(ctx.dealer_expires_at, now)) return true
  return false
}

// =============================================================================
// Small shared leftover used by both checkout and webhook re-verify so the two
// paths can never disagree. The old chain-split math that used to live in this
// section (multi-hop `ChainHop`/`computeSubSplitChain` machinery, plus
// MAX_SUB_CHAIN_DEPTH and DEFAULT_SUB_MARKUP_CEILING) was removed when the
// single-recruiter engine replaced the N-party chain-split engine. Those two
// constants survived that first cleanup pass only because their last reader,
// `lib/sub-agent.ts`, was retired later — Task 10 of this plan (2026-09-14,
// commit d69e983b) deleted that file and its remaining call sites, so both
// constants became genuinely dead at that point. Confirmed via repo-wide grep
// (final-review Minor, 2026-09-14): no other file references either name.
// Deleted rather than kept with a comment — there is no forward-looking use
// for either (the depth cap and markup-ceiling concepts do not exist in the
// single-recruiter model at all; C1 in both subagent specs is "one level
// only", not "capped depth"). All amounts in GHS, 2dp.
// =============================================================================

export const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * May a shop sale at `sellingPrice` be charged, given the owner's `cost`?
 * The storefront rule (lib/shop-checkout.ts): a normal shop needs profit > 0; a
 * sub-agent shop may sell at zero markup (profit >= 0). Compared at pesewa
 * precision. Invalid or non-positive prices are never sellable. Used by the USSD
 * shop path, which reads shop_pricing directly and would otherwise sell below
 * cost — with the platform absorbing the loss.
 */
export function isShopSaleSellable(sellingPrice: number, cost: number, isSub: boolean): boolean {
  if (!Number.isFinite(sellingPrice) || !Number.isFinite(cost) || sellingPrice <= 0) return false
  const profit = r2(sellingPrice - cost)
  return isSub ? profit >= 0 : profit > 0
}
