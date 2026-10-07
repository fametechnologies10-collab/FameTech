// lib/sub-agent-rc-pricing.ts
// =============================================================================
// The shared Results-Checker pricing decision (spec §4, C9). product_ref is
// the voucher type's own id — Results-Checker has a real catalog, unlike AFA.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentMarkup } from '@/lib/sub-agent-pricing'
import { computeSubAgentCost } from '@/lib/pricing/sub-agent-cost'
// From the leaf pricing module, NOT lib/results-checker-service.ts — that was a real
// circular import (review finding I3): this file -> results-checker-service.ts ->
// (back to) this file, which also dragged results-checker-service's module-scope
// createServerClient()/createBrowserClient() calls into anything that only needed
// pricing math. See lib/results-checker-pricing.ts's own header for the full story.
import { resolveRcUnitPrice, type RCTypeLike } from '@/lib/results-checker-pricing'
import { effectiveRoleFromExpiry } from '@/lib/effective-role'

export interface SubAgentRcCostResult {
    ok: boolean
    reason?: string
    isSub: boolean
    subCost: number
    recruiterEarns: number
    recruiterId?: string
}

const NOT_A_SUB: SubAgentRcCostResult = { ok: true, isSub: false, subCost: 0, recruiterEarns: 0 }
const FAIL_CLOSED = (reason: string): SubAgentRcCostResult =>
    ({ ok: false, reason, isSub: true, subCost: 0, recruiterEarns: 0 })

export async function resolveSubAgentRcCost(
    db: SupabaseClient,
    subUserId: string,
    type: RCTypeLike & { id: string; name: string },
    quantity: number,
): Promise<SubAgentRcCostResult> {
    const ctx = await resolveSubAgentContext(db, subUserId)
    if (!ctx.isSub) return NOT_A_SUB
    if (!ctx.effectiveActive || !ctx.recruiter || !ctx.recruiterId) {
        return FAIL_CLOSED(ctx.inactiveReason ?? 'This account is not currently active')
    }

    const recruiterRole = effectiveRoleFromExpiry(
        ctx.recruiter.role, ctx.recruiter.agent_expires_at, ctx.recruiter.dealer_expires_at,
    )
    // Bulk-tier-aware, at the SAME quantity being purchased, via the resolver shared with
    // calculateRCPrice (review finding C1) — resolveRcUnitPrice already floors at
    // type.cost_price internally, so a recruiter is never quoted below the platform's own
    // cost basis for this type, same as before.
    const { unitPrice: recruiterCost } = resolveRcUnitPrice(type, quantity, recruiterRole)

    const markup = await resolveSubAgentMarkup(db, ctx.recruiterId, subUserId, 'results_checker', type.id)

    // The ceiling a sub may be charged is also bulk-tier-aware at this quantity — otherwise a
    // sub buying in bulk could be capped at the flat customer_price while an ordinary customer
    // buying the same quantity pays less via the bulk tier (the same C1 gap, on the ceiling
    // side rather than the cost side).
    const { unitPrice: customerCeiling } = resolveRcUnitPrice(type, quantity, 'customer')

    const result = computeSubAgentCost({ recruiterCost, markup, customerPrice: customerCeiling })
    if (!result.ok) return FAIL_CLOSED(result.reason ?? 'Pricing is not available for this type')

    return { ok: true, isSub: true, subCost: result.subCost, recruiterEarns: result.recruiterEarns, recruiterId: ctx.recruiterId }
}
