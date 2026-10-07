// lib/pricing/profit-engine.ts
// =============================================================================
// The documented rule for adjusting a sub-agent order's cost in platform profit
// math (spec: docs/superpowers/specs/2026-09-28-profit-engine-v2-design.md,
// Section 1). Not called from SQL — Postgres RPCs (supabase/migrations/
// 20260928_profit_engine_v2.sql) implement the identical rule directly, since
// this is the pure-logic "twin" documenting and testing the formula, the same
// pattern lib/pricing/cost-basis.ts uses for effective_owner_cost().
//
// A sub-agent's order records cost = recruiterCost + markup. The recruiter's
// markup is a real payout (sub_agent_order_earnings -> commission_wallets),
// not platform revenue. True platform cost = adminCost + (markup, if the
// recruiter was actually owed/paid it). A 'reversed' earning means the
// recruiter was never paid — the platform kept the full amount, so nothing
// is subtracted.
// =============================================================================

export type RecruiterMarginStatus = 'pending' | 'credited' | 'reversed' | null

export function netProfitAfterRecruiterMargin(
    revenue: number,
    adminCost: number,
    recruiterMarginAmount: number | null,
    recruiterMarginStatus: RecruiterMarginStatus,
): { cost: number; profit: number } {
    const owed = recruiterMarginAmount != null
        && (recruiterMarginStatus === 'pending' || recruiterMarginStatus === 'credited')
        ? recruiterMarginAmount
        : 0
    const cost = adminCost + owed
    return { cost, profit: revenue - cost }
}
