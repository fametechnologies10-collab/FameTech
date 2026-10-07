// lib/sub-agent-afa-pricing.ts
// =============================================================================
// The shared AFA pricing decision (spec §4, C9). AFA has no per-package
// catalog — every sub uses the same fixed product_ref sentinel. The customer
// price ceiling comes from AFA's own resolveAfaPrice at the 'customer' role
// rather than a separate package lookup, since resolveAfaPrice already knows
// how to compute that tier.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentMarkup } from '@/lib/sub-agent-pricing'
import { computeSubAgentCost } from '@/lib/pricing/sub-agent-cost'
import { resolveAfaPrice } from '@/lib/afa-pricing'
import { effectiveRoleFromExpiry } from '@/lib/effective-role'

/** AFA has no per-package catalog — every sub-agent AFA sale shares this product_ref. */
export const AFA_PRODUCT_REF = 'afa_registration'

export interface SubAgentAfaCostResult {
    ok: boolean
    reason?: string
    isSub: boolean
    subCost: number
    recruiterEarns: number
    recruiterId?: string
}

const NOT_A_SUB: SubAgentAfaCostResult = { ok: true, isSub: false, subCost: 0, recruiterEarns: 0 }
const FAIL_CLOSED = (reason: string): SubAgentAfaCostResult =>
    ({ ok: false, reason, isSub: true, subCost: 0, recruiterEarns: 0 })

export async function resolveSubAgentAfaCost(
    db: SupabaseClient,
    subUserId: string,
    afaSettings: Record<string, unknown>,
): Promise<SubAgentAfaCostResult> {
    const ctx = await resolveSubAgentContext(db, subUserId)
    if (!ctx.isSub) return NOT_A_SUB
    if (!ctx.effectiveActive || !ctx.recruiter || !ctx.recruiterId) {
        return FAIL_CLOSED(ctx.inactiveReason ?? 'This account is not currently active')
    }

    const recruiterRole = effectiveRoleFromExpiry(
        ctx.recruiter.role, ctx.recruiter.agent_expires_at, ctx.recruiter.dealer_expires_at,
    )
    const recruiterCost = resolveAfaPrice(afaSettings, recruiterRole)
    if (recruiterCost === null) return FAIL_CLOSED('Pricing is not available for this service')

    const customerPrice = resolveAfaPrice(afaSettings, 'customer')
    if (customerPrice === null) return FAIL_CLOSED('Pricing is not available for this service')

    const markup = await resolveSubAgentMarkup(db, ctx.recruiterId, subUserId, 'afa', AFA_PRODUCT_REF)

    const result = computeSubAgentCost({ recruiterCost, markup, customerPrice })
    if (!result.ok) return FAIL_CLOSED(result.reason ?? 'Pricing is not available for this service')

    return { ok: true, isSub: true, subCost: result.subCost, recruiterEarns: result.recruiterEarns, recruiterId: ctx.recruiterId }
}
