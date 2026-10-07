// lib/sub-agent-package-filter.ts
// =============================================================================
// Plan 4, Task 7 — pure filtering decision for the data-packages page
// (spec C4): a sub-agent viewer must never see a data package that has no
// sub-agent pricing configured (neither a per-sub override nor a recruiter
// default) — it must be hidden from the listing entirely, not shown and left
// to fail at checkout.
//
// Kept pure/synchronous/no I/O (mirrors lib/pricing/cost-basis.ts's own
// rationale) so it is unit-testable without a fake Supabase client — the
// actual DB-backed "is this configured" answer is resolved server-side by
// GET /api/dashboard/subagents/my-pricing (lib/sub-agent-pricing.ts's
// hasSubAgentPricingConfigured), this module only applies that already-
// resolved answer to a package list.
//
// Callers MUST NOT pass mashup packages through this filter (spec C9 —
// mashup markup is structurally always zero, nothing to configure, and a
// sub-agent sees mashup exactly like any other role) — see task-7-report.md
// for how the caller (app/dashboard/data-packages/page.tsx) keeps mashup out
// of this path entirely.
// =============================================================================

export interface SubAgentPricingEntry {
    subPrice: number
    configured: true
}

export type SubAgentPricingMap = Record<string, SubAgentPricingEntry>

/**
 * Keep only packages the sub-agent has pricing configured for. `pricing` is
 * the exact map GET /api/dashboard/subagents/my-pricing returns for the
 * viewer's current network — a package absent from the map (or present but
 * not marked `configured`) is dropped, never shown.
 */
export function filterPackagesForSubAgent<T extends { id: string }>(
    packages: T[],
    pricing: SubAgentPricingMap,
): T[] {
    return packages.filter((pkg) => pricing[pkg.id]?.configured === true)
}
