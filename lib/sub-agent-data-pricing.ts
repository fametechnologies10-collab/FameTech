// lib/sub-agent-data-pricing.ts
// =============================================================================
// The single shared pricing decision for data/mashup products (spec §4, C9).
// Every wiring site in Plan 2 (dashboard purchase, storefront checkout, storefront
// webhook) calls this ONE function rather than re-implementing "resolve context,
// look up markup, compute cost" three times. That triplication is exactly how the
// old chain-split engine's pricing logic drifted across files.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentMarkup } from '@/lib/sub-agent-pricing'
import { computeSubAgentCost } from '@/lib/pricing/sub-agent-cost'
import { resolveOwnerCost } from '@/lib/pricing/cost-basis'

export interface SubAgentDataCostResult {
    ok: boolean
    reason?: string
    /** False means "not a sub at all" — caller uses the normal role-price path. */
    isSub: boolean
    /** 0 on !ok or !isSub — never charge/credit on either. */
    subCost: number
    recruiterEarns: number
    recruiterId?: string
}

const NOT_A_SUB: SubAgentDataCostResult = { ok: true, isSub: false, subCost: 0, recruiterEarns: 0 }
const FAIL_CLOSED = (reason: string): SubAgentDataCostResult =>
    ({ ok: false, reason, isSub: true, subCost: 0, recruiterEarns: 0 })

/**
 * Resolve what a sub-agent pays for a data/mashup package, and what their
 * recruiter earns. `category === 'mashup'` forces markup to 0 WITHOUT querying
 * either pricing table (spec C9) — the zero is structural, not a looked-up value
 * that happens to be zero.
 */
export async function resolveSubAgentDataCost(
    db: SupabaseClient,
    subUserId: string,
    packageId: string,
    pkg: any,
    category: string | null | undefined,
): Promise<SubAgentDataCostResult> {
    const ctx = await resolveSubAgentContext(db, subUserId)
    if (!ctx.isSub) return NOT_A_SUB
    if (!ctx.effectiveActive || !ctx.recruiter || !ctx.recruiterId) {
        return FAIL_CLOSED(ctx.inactiveReason ?? 'This account is not currently active')
    }

    const recruiterCost = resolveOwnerCost(pkg, ctx.recruiter)
    const markup = category === 'mashup'
        ? 0
        : await resolveSubAgentMarkup(db, ctx.recruiterId, subUserId, 'data', packageId)

    const result = computeSubAgentCost({
        recruiterCost,
        markup,
        customerPrice: Number(pkg?.price) || 0,
    })
    if (!result.ok) return FAIL_CLOSED(result.reason ?? 'Pricing is not available for this package')

    return { ok: true, isSub: true, subCost: result.subCost, recruiterEarns: result.recruiterEarns, recruiterId: ctx.recruiterId }
}
