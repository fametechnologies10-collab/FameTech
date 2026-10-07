// app/api/dashboard/subagents/my-pricing/route.ts
// =============================================================================
// Plan 4, Task 7 — sub-agent's OWN resolved pricing for one data network
// (.superpowers/sdd/2026-09-14b-subagent-pricing-and-polish/task-7-brief.md).
//
// Why this route exists (investigation, see task-7-report.md): the data-packages
// page (app/dashboard/data-packages/page.tsx) fetches `data_packages` directly
// client-side via an RLS-scoped Supabase client and prices with plain role
// tiers (getEffectivePrice). That is structurally incapable of answering "is
// this configured for ME as a sub-agent, and at what price" — RLS on
// `sub_agent_pricing`/`sub_agent_default_pricing` lets a sub read only their
// OWN override rows, never the recruiter's default rows, so a client-side
// query can see at most half the picture. Only a service-role, sub-agent-aware
// resolver (this route) can see both tables and answer correctly.
//
// SUB-AGENT CALLERS ONLY. Returns, for the given network, ONLY the packages
// that have pricing configured (override or default) — an unconfigured
// package must be invisible to a sub-agent, never shown and left to fail at
// checkout (spec C4). Response shape is intentionally a flat map so the page
// can filter/annotate in one lookup:
//   { success: true, data: { [packageId]: { subPrice: number, configured: true } } }
//
// Mashup is out of scope for this route entirely (spec C9 — mashup markup is
// structurally always 0, nothing to configure, and a sub-agent sees mashup
// exactly like any other role) — callers must not pass mashup packages in and
// this route does not special-case them.
//
// Performance note: resolveSubAgentContext (2 queries: sub_agents + users) is
// resolved ONCE here and reused for every package in the network, rather than
// calling the higher-level resolveSubAgentDataCost per package (which would
// re-resolve the same context on every row). Every actual pricing decision
// still goes through the same shared primitives Task 3/4 built
// (hasSubAgentPricingConfigured, resolveSubAgentMarkup, resolveOwnerCost,
// computeSubAgentCost) — nothing here reimplements their logic.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { isDataNetwork } from '@/lib/network-stock'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { hasSubAgentPricingConfigured, resolveSubAgentMarkup } from '@/lib/sub-agent-pricing'
import { resolveOwnerCost } from '@/lib/pricing/cost-basis'
import { computeSubAgentCost } from '@/lib/pricing/sub-agent-cost'

interface DataPackageRow {
    id: string
    network: string
    price: number
    agent_price: number | null
    dealer_price: number | null
}

export async function GET(request: NextRequest) {
    try {
        // ── 1. Authenticate ───────────────────────────────────────────────────
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        // ── 2. Validate query ────────────────────────────────────────────────
        const network = request.nextUrl.searchParams.get('network')
        if (!isDataNetwork(network)) {
            return NextResponse.json({ success: false, error: 'Invalid network' }, { status: 400 })
        }

        const admin = createServerClient()

        // ── 3. Confirm caller IS a sub-agent, and resolve their recruiter context.
        // This route is sub-agent-only — a non-sub caller (including their own
        // recruiter) gets 403, matching resolveSubAgentContext's fail-closed
        // INVARIANT (recruiter is populated only when the relationship is fully
        // healthy).
        const ctx = await resolveSubAgentContext(admin, user.id)
        if (!ctx.isSub) {
            return NextResponse.json({ success: false, error: 'Not a sub-agent account' }, { status: 403 })
        }
        if (!ctx.effectiveActive || !ctx.recruiter || !ctx.recruiterId) {
            // Fail closed: an inactive/unlinked sub cannot transact, so nothing is
            // "purchasable" for them either — an empty map, not an error, since this
            // is a legitimate (if unfortunate) state, not a request failure.
            return NextResponse.json({ success: true, data: {} })
        }

        // ── 4. Load this network's non-mashup packages ───────────────────────
        const { data: packages, error: pkgError } = await (admin.from('data_packages') as any)
            .select('id, network, category, price, agent_price, dealer_price')
            .eq('network', network)
            .eq('is_available', true)
            .neq('category', 'mtn_mashup')

        if (pkgError) {
            console.error('[api/dashboard/subagents/my-pricing] data_packages fetch failed', pkgError)
            return NextResponse.json({ success: false, error: 'Could not load pricing data' }, { status: 500 })
        }

        const pkgRows: DataPackageRow[] = packages ?? []
        const recruiterCost = new Map<string, number>()
        for (const pkg of pkgRows) recruiterCost.set(pkg.id, resolveOwnerCost(pkg, ctx.recruiter))

        // ── 5. Resolve configured/subPrice per package ────────────────────────
        const result: Record<string, { subPrice: number; configured: true }> = {}
        for (const pkg of pkgRows) {
            const configured = await hasSubAgentPricingConfigured(admin, ctx.recruiterId, user.id, 'data', pkg.id)
            if (!configured) continue

            const markup = await resolveSubAgentMarkup(admin, ctx.recruiterId, user.id, 'data', pkg.id)
            const cost = computeSubAgentCost({
                recruiterCost: recruiterCost.get(pkg.id) ?? 0,
                markup,
                customerPrice: Number(pkg.price) || 0,
            })
            // A row exists ("configured") but the computed price is invalid/rejected
            // (e.g. exceeds the customer-price ceiling) — fail closed on that single
            // package by omitting it, not the whole response.
            if (!cost.ok) continue

            result[pkg.id] = { subPrice: cost.subCost, configured: true }
        }

        return NextResponse.json({ success: true, data: result })
    } catch (error) {
        console.error('[api/dashboard/subagents/my-pricing] GET failed', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
