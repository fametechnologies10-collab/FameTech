// lib/sub-agent-account.ts
// =============================================================================
// Single-level sub-agent account resolution (spec §3). Deliberately simpler
// than the abandoned 2026-08-19 two-level design: a recruiter can never
// themselves be a sub (spec C1), so there is exactly ONE hop to resolve, ever.
// No depth field, no cycle guard, no recursion — there is nothing to walk.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { canOwnSubNetwork } from '@/lib/pricing/cost-basis'

export interface SubAgentAccountContext {
    /** True when a sub_agents row exists for this user (any status). */
    isSub: boolean
    status?: string
    recruiterId?: string
    /** The recruiter's live role snapshot. Populated ONLY when the whole relationship
     *  resolves healthy — see the INVARIANT note below. */
    recruiter?: { id: string; role: string | null; agent_expires_at: string | null; dealer_expires_at: string | null }
    /** True only when this sub may transact NOW: active membership + eligible recruiter. */
    effectiveActive: boolean
    inactiveReason?: string
}

const NOT_A_SUB: SubAgentAccountContext = { isSub: false, effectiveActive: false }

/**
 * Resolve who recruited this user and whether they may transact right now.
 *
 * Exactly two queries, no loop, no bound to enforce — there is only one hop in
 * this model. Evaluated LIVE on every call — never cache across requests: a
 * suspension must take effect immediately.
 *
 * final-review I4 (2026-09-14): the already-live `cascade_lead_suspend()`
 * trigger (supabase/migrations/20260706c_cascade_lead_suspend.sql) keys
 * exclusively on `sub_agents.upline_shop_id` and never reaches a new-model
 * sub-agent (who only has `upline_user_id` — see 20260907_sub_agent_account_
 * edge.sql / lib/sub-agent-create.ts). Investigated whether this is a
 * regression needing a parallel trigger keyed on `upline_user_id`. Conclusion:
 * NO trigger is needed for the money-security question. That trigger's own
 * comment is explicit that CHARGING was already blocked by the live
 * eligibility gate (`resolveSubAgentContext`, this function) BEFORE the
 * trigger existed — the trigger only adds the VISIBLE hard-offline so a
 * suspended Lead's sub storefronts stop rendering as "open" while a guest
 * browses them. `effectiveActive` above already fails closed the instant a
 * new-model recruiter becomes ineligible (role change or expiry, checked live
 * on every call, no cache) — no purchase can complete regardless of any
 * trigger. The one gap that IS real: a new-model sub who owns their own
 * `shop_profiles` storefront will keep rendering as visibly "open" (like the
 * old model briefly did before this trigger existed) even though a purchase
 * attempt against it will fail server-side. This is a UX/cosmetic gap, not a
 * money-security one, and is intentionally left undone in this fix round —
 * the "ineligible" event for the new model (a role/expiry change on `users`,
 * not a shop suspension) has no existing DB trigger surface to hang a
 * parallel cascade off, and building one is new-feature scope, not a
 * final-review bug fix. Documented here rather than silently left unexplained
 * so a future reader does not mistake this gap for an oversight.
 *
 * INVARIANT: `recruiter` is populated ONLY when the entire relationship
 * resolves healthy. A caller that prices from `recruiter` therefore cannot be
 * handed a plausible-looking wrong role snapshot; an absent recruiter must be
 * treated as "cannot price this sale" and fail closed (spec C7).
 */
export async function resolveSubAgentContext(
    db: SupabaseClient,
    userId: string,
): Promise<SubAgentAccountContext> {
    const { data: membership, error: membershipError } = await (db as any)
        .from('sub_agents')
        .select('user_id, status, upline_user_id')
        .eq('user_id', userId)
        .maybeSingle()

    if (membershipError) {
        console.error('[resolveSubAgentContext] sub_agents lookup failed', membershipError)
    }

    if (!membership) return NOT_A_SUB

    const status: string = membership.status
    const recruiterId: string | undefined = membership.upline_user_id ?? undefined

    let inactiveReason: string | undefined
    if (status !== 'active') {
        inactiveReason = status === 'pending'
            ? 'Your sub-agent account is awaiting approval'
            : 'Your sub-agent account has been suspended'
    }

    if (!recruiterId) {
        return {
            isSub: true, status, effectiveActive: false,
            inactiveReason: inactiveReason ?? 'This sub-agent account is not correctly linked',
        }
    }

    const { data: recruiterUser, error: recruiterError } = await (db as any)
        .from('users')
        .select('id, role, agent_expires_at, dealer_expires_at')
        .eq('id', recruiterId)
        .maybeSingle()

    if (recruiterError) {
        console.error('[resolveSubAgentContext] users lookup for recruiter failed', recruiterError)
    }

    if (!recruiterUser || !canOwnSubNetwork(recruiterUser)) {
        if (!inactiveReason) inactiveReason = 'This sub-agent network is currently paused'
        return { isSub: true, status, recruiterId, effectiveActive: false, inactiveReason }
    }

    // INVARIANT enforcement: `recruiter` (the role snapshot) is attached ONLY when the
    // membership itself is also active. A suspended/pending sub whose recruiter happens
    // to be a healthy lifetime agent must NOT get a role snapshot back — effectiveActive
    // is false either way, but a caller inspecting `recruiter` directly must never see a
    // plausible-looking snapshot for an unhealthy relationship (spec C7, fail closed).
    if (inactiveReason) {
        return { isSub: true, status, recruiterId, effectiveActive: false, inactiveReason }
    }

    return {
        isSub: true,
        status,
        recruiterId,
        recruiter: recruiterUser,
        effectiveActive: true,
    }
}

/**
 * Informational-only lookup: does this user have a sub_agents row with
 * must_change_password set? Used by the login response (an immediate notice)
 * and, independently, by a later dashboard-layout enforcement gate that does
 * its own DB read rather than trusting this response field. Never blocks a
 * non-sub-agent — a missing row resolves to `false`.
 */
export async function fetchMustChangePassword(db: SupabaseClient, userId: string): Promise<boolean> {
    const { data } = await (db.from('sub_agents') as any)
        .select('must_change_password')
        .eq('user_id', userId)
        .maybeSingle()
    return data?.must_change_password === true
}

/**
 * Clear the must-change-password flag after a genuinely successful password
 * change (call only after the caller's own update/auth call has succeeded).
 * No-op (and no error) for non-sub-agent users — the update just matches zero
 * rows.
 */
export async function clearMustChangePasswordIfSubAgent(db: SupabaseClient, userId: string): Promise<void> {
    const { error } = await (db.from('sub_agents') as any)
        .update({ must_change_password: false })
        .eq('user_id', userId)
    if (error) {
        console.error('[clearMustChangePasswordIfSubAgent] update failed', userId, error)
    }
}
