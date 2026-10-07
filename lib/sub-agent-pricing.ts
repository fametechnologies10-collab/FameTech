// lib/sub-agent-pricing.ts
// =============================================================================
// Markup resolution (spec §4.1): per-sub override -> recruiter default -> zero.
//
// ONLY called for markup-eligible product types (spec C9): 'data', 'afa',
// 'results_checker'. Airtime and mashup must never call this — their markup is
// hardcoded to 0 at the call site, so a stray row in either pricing table can
// never reintroduce a margin the platform forbids for those two products.
//
// Both queries below filter on ALL THREE of the row's identifying columns
// (sub_user_id/recruiter_id + product_type + product_ref) before resolving a
// single row — a row for the wrong product_type or product_ref must never
// leak in as if it applied to the requested one.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type SubAgentProductType = 'data' | 'afa' | 'results_checker'

export async function resolveSubAgentMarkup(
    db: SupabaseClient,
    recruiterId: string,
    subUserId: string,
    productType: SubAgentProductType,
    productRef: string,
): Promise<number> {
    const { data: override } = await (db as any)
        .from('sub_agent_pricing')
        .select('markup')
        .eq('sub_user_id', subUserId)
        .eq('product_type', productType)
        .eq('product_ref', productRef)
        .maybeSingle()
    if (override?.markup != null) return Number(override.markup)

    const { data: def } = await (db as any)
        .from('sub_agent_default_pricing')
        .select('markup')
        .eq('recruiter_id', recruiterId)
        .eq('product_type', productType)
        .eq('product_ref', productRef)
        .maybeSingle()
    return def?.markup != null ? Number(def.markup) : 0
}

// =============================================================================
// Existence check (additive): does ANY pricing — override or default — exist
// for this recruiter/sub/product? Purely for UI purchasability gating (does
// NOT resolve or return a markup value). Mirrors resolveSubAgentMarkup's
// exact two-query lookup shape (same tables, same match columns, same
// override-then-default order), just checking row existence instead of
// reading `markup`.
// =============================================================================
export async function hasSubAgentPricingConfigured(
    db: SupabaseClient,
    recruiterId: string,
    subUserId: string,
    productType: SubAgentProductType,
    productRef: string,
): Promise<boolean> {
    const { data: override } = await (db as any)
        .from('sub_agent_pricing')
        .select('id')
        .eq('sub_user_id', subUserId)
        .eq('product_type', productType)
        .eq('product_ref', productRef)
        .maybeSingle()
    if (override != null) return true

    const { data: def } = await (db as any)
        .from('sub_agent_default_pricing')
        .select('id')
        .eq('recruiter_id', recruiterId)
        .eq('product_type', productType)
        .eq('product_ref', productRef)
        .maybeSingle()
    return def != null
}
