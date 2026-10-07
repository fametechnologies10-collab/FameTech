import type { SupabaseClient } from '@supabase/supabase-js'
import type { USSDUser } from './types'
import { normalizePhone } from './utils'
import { getPriceForRole, resolveShopRCMarkup, capRCMarkup, effectiveRoleFromExpiry, getRCSettings } from '@/lib/results-checker-service'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentRcCost } from '@/lib/sub-agent-rc-pricing'
import { resolveSubAgentAfaCost, AFA_PRODUCT_REF } from '@/lib/sub-agent-afa-pricing'
import { resolveSubAgentDataCost } from '@/lib/sub-agent-data-pricing'
import { hasSubAgentPricingConfigured } from '@/lib/sub-agent-pricing'
import { isMashupCategory } from '@/lib/mashup'
import { resolveOwnerCost, isShopSaleSellable } from '@/lib/pricing/cost-basis'
import { AFA_PRICE_KEYS } from '@/lib/afa-pricing'

// =============================================================================
// Price resolution for USSD
// Priority: dealer > agent (if active) > registered customer > ussd guest price
// =============================================================================

/** Look up a KingFlexy account by mobile number (0XXXXXXXXX normalised) */
export async function findUserByMobile(
    supabase: SupabaseClient,
    mobile: string,
): Promise<USSDUser | null> {
    const normalized = normalizePhone(mobile)

    const { data } = await supabase
        .from('users')
        .select('id, role, agent_expires_at, dealer_expires_at, first_name')
        .eq('phone_number', normalized)
        .maybeSingle()

    if (!data) return null

    // Fetch wallet info
    const { data: wallet } = await supabase
        .from('wallets')
        .select('id, balance')
        .eq('user_id', data.id)
        .maybeSingle()

    return {
        id: data.id as string,
        role: data.role as string,
        agentExpiresAt: data.agent_expires_at as string | null,
        dealerExpiresAt: (data as any).dealer_expires_at as string | null,
        firstName: (data as any).first_name as string | undefined,
        walletId: wallet?.id as string | undefined,
        walletBalance: wallet ? Number(wallet.balance) : undefined,
    }
}

/**
 * May this shop USSD data sale be charged at `sellingPrice`? Resolves the owner's
 * cost the same way the storefront checkout does (lib/shop-checkout.ts): the
 * sub-agent pricing engine for sub shops, resolveOwnerCost (expiry-aware) for the
 * rest — then applies the shared isShopSaleSellable rule. Fails closed: if the
 * shop, package or cost cannot be resolved, the sale is not allowed.
 */
export async function isShopDataPriceSellable(
    supabase: SupabaseClient,
    shopId: string,
    packageId: string,
    sellingPrice: number,
): Promise<boolean> {
    try {
        const { data: shop } = await supabase
            .from('shop_profiles')
            .select('owner_id')
            .eq('id', shopId)
            .maybeSingle()
        const ownerId = (shop as any)?.owner_id as string | undefined
        if (!ownerId) return false

        const { data: pkg } = await supabase
            .from('data_packages')
            .select('*')
            .eq('id', packageId)
            .maybeSingle()
        if (!pkg) return false

        const subCtx = await resolveSubAgentContext(supabase, ownerId)
        let cost: number
        if (subCtx.isSub) {
            const resolved = await resolveSubAgentDataCost(supabase, ownerId, packageId, pkg, 'data')
            if (!resolved.ok) return false
            cost = resolved.subCost
        } else {
            const { data: owner } = await supabase
                .from('users')
                .select('role, agent_expires_at, dealer_expires_at')
                .eq('id', ownerId)
                .maybeSingle()
            cost = resolveOwnerCost(pkg as any, {
                role: (owner as any)?.role,
                agent_expires_at: (owner as any)?.agent_expires_at,
                dealer_expires_at: (owner as any)?.dealer_expires_at,
            })
        }

        const sellable = isShopSaleSellable(sellingPrice, cost, subCtx.isSub)
        if (!sellable) {
            console.warn(`[USSD Price] shop ${shopId} package ${packageId} not sellable: price ${sellingPrice} vs owner cost ${cost}`)
        }
        return sellable
    } catch (err) {
        console.error('[USSD Price] sellable check failed — failing closed:', err)
        return false
    }
}

export type SubAgentSelfDataPrice =
    | { kind: 'not_sub' }
    | { kind: 'blocked' }
    | { kind: 'sub'; price: number; recruiterEarns: number; recruiterId: string }

/**
 * Price of a data package for a sub-agent buying for THEMSELVES (non-shop USSD).
 * Mirrors app/api/orders/purchase/route.ts: inactive chain, unconfigured pricing
 * (non-mashup) and unresolvable cost all fail closed ('blocked').
 */
export async function resolveSubAgentSelfDataPrice(
    supabase: SupabaseClient,
    userId: string,
    packageId: string,
    pkg: { category?: string | null } & Record<string, unknown>,
): Promise<SubAgentSelfDataPrice> {
    const ctx = await resolveSubAgentContext(supabase, userId)
    if (!ctx.isSub) return { kind: 'not_sub' }
    if (!ctx.effectiveActive || !ctx.recruiterId) return { kind: 'blocked' }

    if (
        !isMashupCategory(pkg.category) &&
        !(await hasSubAgentPricingConfigured(supabase, ctx.recruiterId, userId, 'data', packageId))
    ) {
        return { kind: 'blocked' }
    }

    const resolved = await resolveSubAgentDataCost(supabase, userId, packageId, pkg, pkg.category)
    if (!resolved.ok || !resolved.recruiterId || !(resolved.subCost > 0)) {
        console.error(`[USSD Price] sub cost unresolvable for pkg ${packageId} (user ${userId}): ${resolved.reason}`)
        return { kind: 'blocked' }
    }
    return { kind: 'sub', price: resolved.subCost, recruiterEarns: resolved.recruiterEarns, recruiterId: resolved.recruiterId }
}

/** Unit price of a results-checker voucher for a sub-agent buying for THEMSELVES (non-shop USSD). */
export async function resolveSubAgentSelfRcPrice(
    supabase: SupabaseClient,
    userId: string,
    rcType: { id: string; name: string } & Record<string, any>,
): Promise<SubAgentSelfDataPrice> {
    const ctx = await resolveSubAgentContext(supabase, userId)
    if (!ctx.isSub) return { kind: 'not_sub' }
    if (!ctx.effectiveActive || !ctx.recruiterId) return { kind: 'blocked' }
    if (!(await hasSubAgentPricingConfigured(supabase, ctx.recruiterId, userId, 'results_checker', rcType.id))) {
        return { kind: 'blocked' }
    }
    // USSD RC has no bulk tiers: always the single-voucher cost (flat unit price * qty).
    const resolved = await resolveSubAgentRcCost(supabase, userId, rcType as any, 1)
    if (!resolved.ok || !resolved.recruiterId || !(resolved.subCost > 0)) {
        console.error(`[USSD Price] sub RC cost unresolvable for type ${rcType.id} (user ${userId}): ${resolved.reason}`)
        return { kind: 'blocked' }
    }
    return { kind: 'sub', price: resolved.subCost, recruiterEarns: resolved.recruiterEarns, recruiterId: resolved.recruiterId }
}

/** AFA registration price for a sub-agent registering for THEMSELVES (non-shop USSD). */
export async function resolveSubAgentSelfAfaPrice(
    supabase: SupabaseClient,
    userId: string,
): Promise<SubAgentSelfDataPrice> {
    const ctx = await resolveSubAgentContext(supabase, userId)
    if (!ctx.isSub) return { kind: 'not_sub' }
    if (!ctx.effectiveActive || !ctx.recruiterId) return { kind: 'blocked' }
    if (!(await hasSubAgentPricingConfigured(supabase, ctx.recruiterId, userId, 'afa', AFA_PRODUCT_REF))) {
        return { kind: 'blocked' }
    }
    const { data: rows } = await supabase.from('admin_settings').select('key, value').in('key', AFA_PRICE_KEYS)
    const afaSettings: Record<string, unknown> = {}
    for (const row of (rows ?? []) as any[]) afaSettings[row.key] = row.value
    const resolved = await resolveSubAgentAfaCost(supabase, userId, afaSettings)
    if (!resolved.ok || !resolved.recruiterId || !(resolved.subCost > 0)) {
        console.error(`[USSD Price] sub AFA cost unresolvable (user ${userId}): ${resolved.reason}`)
        return { kind: 'blocked' }
    }
    return { kind: 'sub', price: resolved.subCost, recruiterEarns: resolved.recruiterEarns, recruiterId: resolved.recruiterId }
}

/**
 * Non-shop AFA base price for the dialer: a sub-agent pays their recruiter-set cost,
 * everyone else the unchanged role price. null = a sub who cannot buy right now (fail closed).
 */
export async function resolveNonShopAfaBase(
    supabase: SupabaseClient,
    mobile: string,
): Promise<{ price: number } | null> {
    const user = await findUserByMobile(supabase, mobile)
    if (user) {
        const sub = await resolveSubAgentSelfAfaPrice(supabase, user.id)
        if (sub.kind === 'blocked') return null
        if (sub.kind === 'sub') return { price: sub.price }
    }
    return { price: (await resolveAFAPrice(supabase, mobile)).price }
}

/** Determine the effective role for pricing (customer | agent | dealer). Delegates to the
 *  shared effectiveRoleFromExpiry so the web + USSD surfaces use one identical rule. */
export function effectiveRole(user: USSDUser | null): 'customer' | 'agent' | 'dealer' {
    if (!user) return 'customer'
    return effectiveRoleFromExpiry(user.role, user.agentExpiresAt, user.dealerExpiresAt)
}

/**
 * Resolve the USSD price for a data package.
 * If shopId provided: use shop_pricing.selling_price (shop USSD mode).
 * Otherwise: dealer > agent > registered customer > ussd_price (admin guest price).
 */
export async function resolveDataPrice(
    supabase: SupabaseClient,
    packageId: string,
    mobile: string,
    shopId?: string | null,
): Promise<{ price: number; role: string } | null> {
    // Shop USSD path
    if (shopId) {
        const { data: sp } = await supabase
            .from('shop_pricing')
            .select('selling_price')
            .eq('shop_id', shopId)
            .eq('package_id', packageId)
            .maybeSingle()

        if (!sp) return null
        const price = Number((sp as any).selling_price)
        // shop_pricing is owner-writable, so a stored price is not proof it is above
        // cost — re-check here, before any charge, exactly as the storefront does.
        if (!(await isShopDataPriceSellable(supabase, shopId, packageId, price))) return null
        return { price, role: 'shop_guest' }
    }

    // Admin USSD path (existing logic)
    const user = await findUserByMobile(supabase, mobile)
    const role = effectiveRole(user)

    const { data: pkg } = await supabase
        .from('data_packages')
        .select('price, agent_price, dealer_price, ussd_price, category')
        .eq('id', packageId)
        .eq('is_available', true)
        .maybeSingle()

    if (!pkg) return null

    // A sub-agent buying for themselves pays their recruiter-set cost — same as the
    // dashboard purchase route — never the plain role price.
    if (user) {
        const sub = await resolveSubAgentSelfDataPrice(supabase, user.id, packageId, pkg)
        if (sub.kind === 'blocked') return null
        if (sub.kind === 'sub') return { price: sub.price, role: 'subagent' }
    }

    let price: number
    if (role === 'dealer' && (pkg as any).dealer_price) {
        price = Number((pkg as any).dealer_price)
    } else if (role === 'agent' && (pkg as any).agent_price) {
        price = Number((pkg as any).agent_price)
    } else if (user) {
        price = Number(pkg.price)
    } else {
        price = Number((pkg as any).ussd_price ?? pkg.price)
    }

    return { price, role }
}

/**
 * Resolve the USSD price for a results checker exam type.
 * If shopId provided: OWNER-role base price (getPriceForRole, floored at cost) + the shop's
 *   per-exam markup (shop_rc_markups, falling back to the flat results_checker_markup_{role}),
 *   the markup CAPPED at the admin per-role max (capRCMarkup) — same base + capped-markup
 *   economics the storefront charges, so USSD and web price + credit consistently.
 *   Caveats (tracked follow-ups): USSD does NOT offer bulk-tier pricing (bulk buyers are steered
 *   to the website), and it resolves the owner's EFFECTIVE role (expiry-aware) whereas the RC
 *   storefront routes currently use the raw role column.
 * Otherwise: dealer > agent > registered customer > ussd_price.
 */
export async function resolveRCPrice(
    supabase: SupabaseClient,
    typeId: string,
    mobile: string,
    shopId?: string | null,
): Promise<{ price: number; role: string; shopMarkup: number; ownerRole?: string; rawMarkup?: number } | null> {
    const { data: rcType } = await supabase
        .from('results_checker_types')
        .select('id, name, customer_price, agent_price, dealer_price, cost_price, ussd_price, bulk_pricing')
        .eq('id', typeId)
        .eq('is_active', true)
        .maybeSingle()

    if (!rcType) return null

    // Shop USSD path — mirror the storefront's base + capped-markup economics. Base = the shop
    // OWNER's role-based price (a reseller sells off their dealer/agent tier, not admin retail),
    // floored at cost; markup = the per-exam shop_rc_markups override the pricing UI writes, else
    // the flat role-based field, CAPPED at the admin per-role max (capRCMarkup). The owner is
    // credited this capped markup per voucher, so a wrong/zero markup here previously meant zero
    // credit (the reported "RC doesn't work for shop owners" bug).
    if (shopId) {
        const { data: sp, error: spError } = await supabase
            .from('shop_profiles')
            .select('owner_id, results_checker_markup_customer, results_checker_markup_agent, results_checker_markup_dealer')
            .eq('id', shopId)
            .maybeSingle()
        if (spError) {
            // A transient lookup failure must not silently degrade to customer-role /
            // zero-markup pricing (guest quoted the wrong price, owner credited 0) —
            // fail the resolution instead; the handler re-prompts or releases.
            console.error(`[USSD RC Price] shop_profiles lookup failed for shop ${shopId}:`, spError.message)
            return null
        }

        // Owner's effective role (respects agent/dealer expiry, like the data path).
        let ownerRole: 'customer' | 'agent' | 'dealer' = 'customer'
        if ((sp as any)?.owner_id) {
            const { data: owner, error: ownerError } = await supabase
                .from('users')
                .select('role, agent_expires_at, dealer_expires_at')
                .eq('id', (sp as any).owner_id)
                .maybeSingle()
            if (ownerError) {
                console.error(`[USSD RC Price] owner lookup failed for shop ${shopId}:`, ownerError.message)
                return null
            }
            ownerRole = effectiveRole({
                id: (sp as any).owner_id,
                role: (owner as any)?.role,
                agentExpiresAt: (owner as any)?.agent_expires_at ?? null,
                dealerExpiresAt: (owner as any)?.dealer_expires_at ?? null,
            } as USSDUser)
        }

        // Sub-agent shop owner? (Task 3) Their true wholesale cost comes from the sub-agent
        // pricing engine instead of the plain role-tier lookup — the shop's own markup on top
        // (below) is completely unaffected either way, mirroring lib/shop-afa-checkout.ts's and
        // lib/shop-order-processor.ts's "owner cost basis swaps, selling economics don't" pattern.
        // Resolved ONCE and reused below for both the cost swap and the return-shape decision.
        const isSubAgentOwner = (sp as any)?.owner_id
            ? (await resolveSubAgentContext(supabase, (sp as any).owner_id)).isSub
            : false

        let base: number
        if (isSubAgentOwner) {
            // FAIL CLOSED: never quote a guest a price computed from an ineligible or
            // unresolvable sub-agent chain. Quantity is always 1 here — USSD RC has no
            // bulk-tier support for a shop sale (documented limitation, see below).
            const resolved = await resolveSubAgentRcCost(supabase, (sp as any).owner_id, rcType as any, 1)
            if (!resolved.ok) {
                console.error(`[USSD RC Price] sub-agent cost unresolvable for shop ${shopId}: ${resolved.reason}`)
                return null
            }
            base = resolved.subCost
        } else {
            const cost = Number((rcType as any).cost_price ?? 0)
            base = Math.max(Number(getPriceForRole(rcType as any, ownerRole)), cost)
        }

        const flatField = ownerRole === 'dealer' ? 'results_checker_markup_dealer'
            : ownerRole === 'agent' ? 'results_checker_markup_agent'
            : 'results_checker_markup_customer'
        const flatFallback = Number((sp as any)?.[flatField] ?? 0) || 0
        const rawMarkup = await resolveShopRCMarkup(supabase, shopId, typeId, flatFallback)
        // Cap at the admin per-role maximum, exactly like the storefront's calculateRCPrice, so
        // USSD never charges the guest or credits the owner more than platform policy allows.
        const settings = await getRCSettings()
        const markup = capRCMarkup(rawMarkup, ownerRole, settings)

        // A sub-agent owner's `role` column is literally 'subagent' (never 'agent'/'dealer'),
        // so `ownerRole` above always resolves to 'customer' for them via effectiveRole — that's
        // fine for the shop's OWN markup/cap (unrelated to the sub-agent cost swap above).
        // ownerRole + rawMarkup are DELIBERATELY OMITTED from a sub-agent shop's return: the
        // caller (lib/ussd/handlers/results-checker.ts) uses their presence to decide whether to
        // re-price a chosen quantity through calculateRCPrice's bulk-tier lookup — which derives
        // cost from getPriceForRole again and would silently clobber this sub-agent `base` back
        // to the plain role-tier price on every quantity change. Omitting them makes the handler
        // fall back to its flat unitPrice*qty path instead, which is exactly right: USSD RC has
        // no bulk-tier support for a shop sale in the first place (documented above), and a
        // sub-agent sale is doubly so.
        if (isSubAgentOwner) {
            return { price: base + markup, role: 'shop_subagent', shopMarkup: markup }
        }

        return { price: base + markup, role: `shop_${ownerRole}`, shopMarkup: markup, ownerRole, rawMarkup }
    }

    // Admin USSD path (existing logic)
    const user = await findUserByMobile(supabase, mobile)
    const role = effectiveRole(user)

    // A sub-agent buying for themselves pays their recruiter-set cost, like the dashboard.
    if (user) {
        const sub = await resolveSubAgentSelfRcPrice(supabase, user.id, rcType as any)
        if (sub.kind === 'blocked') return null
        if (sub.kind === 'sub') return { price: sub.price, role: 'subagent', shopMarkup: 0 }
    }

    let price: number
    if (role === 'dealer' && (rcType as any).dealer_price) {
        price = Number((rcType as any).dealer_price)
    } else if (role === 'agent' && (rcType as any).agent_price) {
        price = Number((rcType as any).agent_price)
    } else if (user) {
        price = Number(rcType.customer_price)
    } else {
        price = Number((rcType as any).ussd_price ?? rcType.customer_price)
    }

    return { price, role, shopMarkup: 0 }
}

/**
 * Resolve AFA registration price for USSD.
 * Registered agents get agent price; guests get afa_price_ussd setting.
 *
 * This tier logic (dealer > agent > customer > ussd guest) is the reference
 * implementation now shared via lib/afa-pricing.ts's resolveAfaPrice for every
 * other AFA pricing surface. Left untouched here deliberately — this is a live
 * USSD path with its own distinct guest fallback to afa_price_ussd, and a
 * correct untouched file beats a clever refactor on a live path.
 */
export async function resolveAFAPrice(
    supabase: SupabaseClient,
    mobile: string,
): Promise<{ price: number; role: string }> {
    const user = await findUserByMobile(supabase, mobile)
    const role = effectiveRole(user)

    const { data: settings } = await supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', ['afa_price_customer', 'afa_price_agent', 'afa_price_dealer', 'afa_price_ussd'])

    const map: Record<string, string> = {}
    for (const row of (settings ?? []) as any[]) {
        map[row.key] = row.value
    }

    let price: number
    if (role === 'dealer' && map['afa_price_dealer']) {
        price = parseFloat(map['afa_price_dealer'])
    } else if (role === 'agent' && map['afa_price_agent']) {
        price = parseFloat(map['afa_price_agent'])
    } else if (user && map['afa_price_customer']) {
        price = parseFloat(map['afa_price_customer'])
    } else {
        price = parseFloat(map['afa_price_ussd'] ?? '15.00')
    }

    return { price: isNaN(price) ? 15 : price, role }
}

/**
 * Shop-linked AFA pricing (Task 3, Step 6 — GLOBAL CONSTRAINT).
 *
 * For a NORMAL (non-sub-agent) shop, this preserves the pre-existing USSD AFA model
 * BYTE-FOR-BYTE: base = resolveAFAPrice(mobile) — the DIALER's own role-tier price, same
 * guest fallback to afa_price_ussd, completely independent of the shop owner's role or any
 * shop setting. `sellingBase` and `costPrice` are simply both that same value, exactly
 * mirroring how the old flat-fee code used one `basePrice` for both purposes.
 *
 * For a SUB-AGENT-owned shop ONLY, this moves onto the "shop sets a real selling price
 * against a real cost" model used everywhere else (data/RC/storefront AFA): `sellingBase` =
 * shop_profiles.afa_selling_price (the same field the storefront AFA flow already uses —
 * lib/shop-afa-checkout.ts), `costPrice` = resolveSubAgentAfaCost(...).subCost. The caller
 * applies the SAME resolveUSSDFeePercent/applyFee wrapping fee on top of `sellingBase`
 * either way — untouched — so a sub-agent shop's guest-facing total is computed exactly the
 * same way a normal shop's is, just off a different base.
 *
 * Fails closed (returns null) on any unresolvable pricing — a lookup error, an ineligible
 * sub-agent chain, or a sub-agent shop with no (or a non-positive, or underwater) configured
 * afa_selling_price — never quotes or charges at a fabricated price.
 */
export async function resolveShopAfaPricing(
    supabase: SupabaseClient,
    mobile: string,
    shopId: string,
): Promise<{
    sellingBase: number
    costPrice: number
    recruiterId?: string
    recruiterEarns?: number
} | null> {
    const { data: sp, error: spError } = await supabase
        .from('shop_profiles')
        .select('owner_id, afa_selling_price')
        .eq('id', shopId)
        .maybeSingle()
    if (spError) {
        console.error(`[USSD AFA Price] shop_profiles lookup failed for shop ${shopId}:`, spError.message)
        return null
    }
    const ownerId = (sp as any)?.owner_id as string | undefined

    // No resolvable owner: preserve old behavior (dialer-role pricing) rather than fail —
    // matches every other branch in this file that degrades gracefully on a missing owner_id.
    if (!ownerId) {
        const { price: basePrice } = await resolveAFAPrice(supabase, mobile)
        return { sellingBase: basePrice, costPrice: basePrice }
    }

    const subCtx = await resolveSubAgentContext(supabase, ownerId)
    if (!subCtx.isSub) {
        // NORMAL shop — GLOBAL CONSTRAINT: byte-for-byte the pre-existing flat-fee model.
        const { price: basePrice } = await resolveAFAPrice(supabase, mobile)
        return { sellingBase: basePrice, costPrice: basePrice }
    }

    // Sub-agent-owned shop: FAIL CLOSED on an ineligible chain.
    if (!subCtx.effectiveActive) {
        console.error(`[USSD AFA Price] sub-agent shop ${shopId} owner ${ownerId} ineligible: ${subCtx.inactiveReason}`)
        return null
    }

    const sellingBase = Number((sp as any)?.afa_selling_price)
    if (!Number.isFinite(sellingBase) || sellingBase <= 0) {
        console.error(`[USSD AFA Price] sub-agent shop ${shopId} has no afa_selling_price configured`)
        return null
    }

    const { data: afaSettingsRows } = await supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', AFA_PRICE_KEYS)
    const afaSettings: Record<string, unknown> = {}
    for (const row of (afaSettingsRows ?? []) as any[]) afaSettings[row.key] = row.value

    const resolved = await resolveSubAgentAfaCost(supabase, ownerId, afaSettings)
    if (!resolved.ok) {
        console.error(`[USSD AFA Price] sub-agent cost unresolvable for shop ${shopId}: ${resolved.reason}`)
        return null
    }

    // Underwater guard, mirroring lib/shop-afa-checkout.ts: an owner-configured selling price
    // that doesn't clear their own cost is a misconfiguration, not a sale to complete.
    if (sellingBase <= resolved.subCost) {
        console.error(`[USSD AFA Price] sub-agent shop ${shopId} afa_selling_price (${sellingBase}) does not exceed subCost (${resolved.subCost})`)
        return null
    }

    return {
        sellingBase,
        costPrice: resolved.subCost,
        recruiterId: resolved.recruiterId,
        recruiterEarns: resolved.recruiterEarns,
    }
}
