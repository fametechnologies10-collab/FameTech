// app/api/dashboard/subagents/[id]/pricing/route.ts
// =============================================================================
// Plan 4, Task 4 — per-sub-agent PRICING OVERRIDE
// (docs/superpowers/sdd/2026-09-14b-subagent-pricing-and-polish/task-4-brief.md).
//
// Same GET/PUT shape as app/api/dashboard/subagents/pricing/route.ts, scoped
// to one specific sub-agent — writes go into `sub_agent_pricing` (overrides),
// not `sub_agent_default_pricing`. GET additionally resolves override-over-
// default per row (mirrors resolveSubAgentMarkup's own precedence).
//
// Ownership check mirrors app/api/dashboard/subagents/[id]/regenerate/
// route.ts EXACTLY: 404 if no sub_agents row exists for [id] at all, 403 if
// it exists but the caller isn't its upline_user_id.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { hasTrustedRequestOrigin } from '@/lib/site-url'
import { DATA_NETWORKS, isDataNetwork } from '@/lib/network-stock'
import { resolveOwnerCost } from '@/lib/pricing/cost-basis'
import { effectiveRoleFromExpiry } from '@/lib/effective-role'
import { resolveRcUnitPrice, type RCTypeLike } from '@/lib/results-checker-pricing'
import { AFA_PRICE_KEYS, resolveAfaPrice } from '@/lib/afa-pricing'
import { AFA_PRODUCT_REF } from '@/lib/sub-agent-afa-pricing'
import {
    resolveRecruiterEligibility,
    fetchDefaultMarkupMap,
    fetchOverrideMarkupMap,
    resolveSubPriceForRow,
    buildValidatedWrites,
    buildFlatRateRows,
    buildMatchParentPriceRows,
    upsertSubPricingRows,
    enforceMarkupCeiling,
    parsePackageSizeGb,
} from '@/lib/sub-agent-pricing-config'

interface DataPackageRow {
    id: string
    network: string
    size: string
    price: number
    agent_price: number | null
    dealer_price: number | null
    sort_order: number | null
}

interface RCTypeRow extends RCTypeLike {
    id: string
    name: string
}

/** Mirrors regenerateSubAgentKey's Rule 2 (lib/sub-agent-regenerate.ts) exactly. */
async function verifySubOwnership(
    db: ReturnType<typeof createServerClient>,
    callerId: string,
    subUserId: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
    const { data: subRow, error } = await (db as any)
        .from('sub_agents')
        .select('upline_user_id')
        .eq('user_id', subUserId)
        .maybeSingle()

    if (error) {
        console.error('[api/dashboard/subagents/[id]/pricing] sub_agents lookup failed', error)
        return { ok: false, status: 500, error: 'Could not verify sub-agent' }
    }
    if (!subRow) {
        return { ok: false, status: 404, error: 'Sub-agent not found' }
    }
    if (subRow.upline_user_id !== callerId) {
        return { ok: false, status: 403, error: "You are not this sub-agent's recruiter" }
    }
    return { ok: true, status: 200 }
}

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        // ── 1. Authenticate ───────────────────────────────────────────────────
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const { id: subUserId } = await params
        if (!subUserId) {
            return NextResponse.json({ success: false, error: 'Missing sub-agent id' }, { status: 400 })
        }

        const admin = createServerClient()

        // ── 2. Recruiter eligibility + ownership ──────────────────────────────
        const eligibility = await resolveRecruiterEligibility(admin, user.id)
        if (!eligibility.ok || !eligibility.recruiterCtx) {
            return NextResponse.json({ success: false, error: eligibility.error }, { status: eligibility.status })
        }
        const ownership = await verifySubOwnership(admin, user.id, subUserId)
        if (!ownership.ok) {
            return NextResponse.json({ success: false, error: ownership.error }, { status: ownership.status })
        }

        const recruiterCtx = eligibility.recruiterCtx
        const recruiterRole = effectiveRoleFromExpiry(
            recruiterCtx.role, recruiterCtx.agent_expires_at ?? null, recruiterCtx.dealer_expires_at ?? null,
        )

        // ── 3. Load reference data + defaults + this sub's overrides ─────────
        const [pkgResult, typeResult, settingsResult, defaultMap, overrideMap] = await Promise.all([
            (admin.from('data_packages') as any)
                .select('id, network, size, price, agent_price, dealer_price, sort_order')
                .eq('is_available', true)
                .order('network', { ascending: true })
                .order('size', { ascending: true }),
            (admin.from('results_checker_types') as any)
                .select('id, name, customer_price, agent_price, dealer_price, cost_price, bulk_pricing')
                .eq('is_active', true)
                .order('display_order', { ascending: true }),
            (admin.from('admin_settings') as any)
                .select('key, value')
                .in('key', AFA_PRICE_KEYS),
            fetchDefaultMarkupMap(admin, user.id),
            fetchOverrideMarkupMap(admin, subUserId),
        ])

        if (pkgResult.error) {
            console.error('[api/dashboard/subagents/[id]/pricing] data_packages fetch failed', pkgResult.error)
            return NextResponse.json({ success: false, error: 'Could not load pricing data' }, { status: 500 })
        }
        if (typeResult.error) {
            console.error('[api/dashboard/subagents/[id]/pricing] results_checker_types fetch failed', typeResult.error)
            return NextResponse.json({ success: false, error: 'Could not load pricing data' }, { status: 500 })
        }

        const packages: DataPackageRow[] = pkgResult.data ?? []
        const types: RCTypeRow[] = typeResult.data ?? []
        const settingsMap: Record<string, unknown> = Object.fromEntries(
            (settingsResult.data ?? []).map((row: any) => [row.key, row.value]),
        )

        // ── 4. Build response ─────────────────────────────────────────────────
        const dataByNetwork: Record<string, Array<{ packageId: string; sizeLabel: string; yourPrice: number; subPrice: number | null; sortOrder: number | null }>> = {}
        for (const net of DATA_NETWORKS) dataByNetwork[net] = []
        for (const pkg of packages) {
            if (!isDataNetwork(pkg.network)) continue
            const yourPrice = resolveOwnerCost(pkg, recruiterCtx)
            dataByNetwork[pkg.network].push({
                packageId: pkg.id,
                sizeLabel: pkg.size,
                yourPrice,
                subPrice: resolveSubPriceForRow(yourPrice, 'data', pkg.id, defaultMap, overrideMap),
                sortOrder: pkg.sort_order,
            })
        }

        const checkerTypes = types.map((type) => {
            const { unitPrice } = resolveRcUnitPrice(type, 1, recruiterRole)
            return {
                typeId: type.id,
                name: type.name,
                yourPrice: unitPrice,
                subPrice: resolveSubPriceForRow(unitPrice, 'results_checker', type.id, defaultMap, overrideMap),
            }
        })

        // yourPrice stays null (not 0) when AFA pricing is unconfigured platform-wide — see the
        // identical comment in the sibling default-pricing route for why (review finding, Task 4).
        const afaYourPriceRaw = resolveAfaPrice(settingsMap, recruiterRole)
        const afa = {
            yourPrice: afaYourPriceRaw,
            subPrice: afaYourPriceRaw == null
                ? null
                : resolveSubPriceForRow(afaYourPriceRaw, 'afa', AFA_PRODUCT_REF, defaultMap, overrideMap),
        }

        return NextResponse.json({
            success: true,
            data: {
                networks: [...DATA_NETWORKS],
                dataByNetwork,
                checkerTypes,
                afa,
            },
        })
    } catch (error) {
        console.error('[api/dashboard/subagents/[id]/pricing] GET failed', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        if (!hasTrustedRequestOrigin(request)) {
            return NextResponse.json({ success: false, error: 'Invalid request origin' }, { status: 403 })
        }

        // ── 1. Authenticate ───────────────────────────────────────────────────
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const { id: subUserId } = await params
        if (!subUserId) {
            return NextResponse.json({ success: false, error: 'Missing sub-agent id' }, { status: 400 })
        }

        const admin = createServerClient()

        // ── 2. Recruiter eligibility + ownership ──────────────────────────────
        const eligibility = await resolveRecruiterEligibility(admin, user.id)
        if (!eligibility.ok || !eligibility.recruiterCtx) {
            return NextResponse.json({ success: false, error: eligibility.error }, { status: eligibility.status })
        }
        const ownership = await verifySubOwnership(admin, user.id, subUserId)
        if (!ownership.ok) {
            return NextResponse.json({ success: false, error: ownership.error }, { status: ownership.status })
        }

        const recruiterCtx = eligibility.recruiterCtx
        const recruiterRole = effectiveRoleFromExpiry(
            recruiterCtx.role, recruiterCtx.agent_expires_at ?? null, recruiterCtx.dealer_expires_at ?? null,
        )

        // ── 3. Parse body ────────────────────────────────────────────────────
        let body: unknown
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
        }
        const section = (body as any)?.section

        // ── 4. Section-specific validate + save ───────────────────────────────
        if (section === 'data') {
            const { network, mode, rows, matchParentPrice } = body as any
            if (!isDataNetwork(network)) {
                return NextResponse.json({ success: false, error: 'Invalid network' }, { status: 400 })
            }
            if (matchParentPrice !== true && mode !== 'package' && mode !== 'flat') {
                return NextResponse.json({ success: false, error: 'Invalid mode' }, { status: 400 })
            }

            const { data: packages, error: pkgError } = await (admin.from('data_packages') as any)
                .select('id, network, size, price, agent_price, dealer_price')
                .eq('network', network)
                .eq('is_available', true)
            if (pkgError) {
                console.error('[api/dashboard/subagents/[id]/pricing] PUT data_packages fetch failed', pkgError)
                return NextResponse.json({ success: false, error: 'Could not load packages for this network' }, { status: 500 })
            }

            const pkgRows: DataPackageRow[] = packages ?? []
            const yourPriceByRef = new Map<string, number>()
            for (const pkg of pkgRows) yourPriceByRef.set(pkg.id, resolveOwnerCost(pkg, recruiterCtx))

            let inputRows: Array<{ ref: string; subPrice: number }>
            if (matchParentPrice === true) {
                inputRows = buildMatchParentPriceRows(pkgRows.map((p) => p.id), yourPriceByRef)
            } else if (mode === 'flat') {
                const flatRatePerGB = Number((rows as any)?.flatRatePerGB)
                if (!Number.isFinite(flatRatePerGB) || flatRatePerGB <= 0) {
                    return NextResponse.json({ success: false, error: 'flatRatePerGB must be a positive number' }, { status: 400 })
                }
                inputRows = buildFlatRateRows(
                    flatRatePerGB,
                    pkgRows.map((p) => ({ packageId: p.id, sizeLabel: p.size })),
                )
            } else {
                if (!Array.isArray(rows)) {
                    return NextResponse.json({ success: false, error: 'rows must be an array' }, { status: 400 })
                }
                inputRows = rows.map((r: any) => ({ ref: String(r?.packageId), subPrice: Number(r?.subPrice) }))
            }

            const built = buildValidatedWrites(inputRows, yourPriceByRef)
            if (!built.ok) {
                return NextResponse.json({ success: false, error: built.error }, { status: 400 })
            }

            // Flat GHS/GB ceiling (2026-09-18): a recruiter may never charge a sub-agent
            // more than MAX_MARKUP_PER_GB per GB, regardless of mode (flat/package/match).
            const sizeGbByRef = new Map<string, number>()
            for (const pkg of pkgRows) sizeGbByRef.set(pkg.id, parsePackageSizeGb(pkg.size))
            const ceiling = enforceMarkupCeiling(built.writes, sizeGbByRef)
            if (!ceiling.ok) {
                return NextResponse.json({ success: false, error: ceiling.error }, { status: 400 })
            }

            const writeResult = await upsertSubPricingRows(admin, user.id, subUserId, 'data', built.writes)
            if (!writeResult.ok) {
                return NextResponse.json({ success: false, error: writeResult.error }, { status: 500 })
            }
            return NextResponse.json({ success: true })
        }

        if (section === 'checker') {
            const { rows, matchParentPrice } = body as any
            if (matchParentPrice !== true && !Array.isArray(rows)) {
                return NextResponse.json({ success: false, error: 'rows must be an array' }, { status: 400 })
            }

            const { data: types, error: typeError } = await (admin.from('results_checker_types') as any)
                .select('id, name, customer_price, agent_price, dealer_price, cost_price, bulk_pricing')
                .eq('is_active', true)
            if (typeError) {
                console.error('[api/dashboard/subagents/[id]/pricing] PUT results_checker_types fetch failed', typeError)
                return NextResponse.json({ success: false, error: 'Could not load checker types' }, { status: 500 })
            }

            const typeRows: RCTypeRow[] = types ?? []
            const yourPriceByRef = new Map<string, number>()
            for (const type of typeRows) {
                const { unitPrice } = resolveRcUnitPrice(type, 1, recruiterRole)
                yourPriceByRef.set(type.id, unitPrice)
            }

            const inputRows = matchParentPrice === true
                ? buildMatchParentPriceRows(typeRows.map((t) => t.id), yourPriceByRef)
                : rows.map((r: any) => ({ ref: String(r?.typeId), subPrice: Number(r?.subPrice) }))
            const built = buildValidatedWrites(inputRows, yourPriceByRef)
            if (!built.ok) {
                return NextResponse.json({ success: false, error: built.error }, { status: 400 })
            }
            const writeResult = await upsertSubPricingRows(admin, user.id, subUserId, 'results_checker', built.writes)
            if (!writeResult.ok) {
                return NextResponse.json({ success: false, error: writeResult.error }, { status: 500 })
            }
            return NextResponse.json({ success: true })
        }

        if (section === 'afa') {
            const { matchParentPrice } = body as any
            const subPrice = Number((body as any)?.subPrice)

            const { data: settingsData, error: settingsError } = await (admin.from('admin_settings') as any)
                .select('key, value')
                .in('key', AFA_PRICE_KEYS)
            if (settingsError) {
                console.error('[api/dashboard/subagents/[id]/pricing] PUT admin_settings fetch failed', settingsError)
                return NextResponse.json({ success: false, error: 'Could not load AFA pricing' }, { status: 500 })
            }
            const settingsMap: Record<string, unknown> = Object.fromEntries(
                (settingsData ?? []).map((row: any) => [row.key, row.value]),
            )
            const yourPrice = resolveAfaPrice(settingsMap, recruiterRole)
            if (yourPrice === null) {
                return NextResponse.json({ success: false, error: 'AFA pricing is not configured' }, { status: 500 })
            }

            const yourPriceByRef = new Map<string, number>([[AFA_PRODUCT_REF, yourPrice]])
            const inputRows = matchParentPrice === true
                ? buildMatchParentPriceRows([AFA_PRODUCT_REF], yourPriceByRef)
                : [{ ref: AFA_PRODUCT_REF, subPrice }]
            const built = buildValidatedWrites(inputRows, yourPriceByRef)
            if (!built.ok) {
                return NextResponse.json({ success: false, error: built.error }, { status: 400 })
            }
            const writeResult = await upsertSubPricingRows(admin, user.id, subUserId, 'afa', built.writes)
            if (!writeResult.ok) {
                return NextResponse.json({ success: false, error: writeResult.error }, { status: 500 })
            }
            return NextResponse.json({ success: true })
        }

        return NextResponse.json({ success: false, error: 'Invalid section' }, { status: 400 })
    } catch (error) {
        console.error('[api/dashboard/subagents/[id]/pricing] PUT failed', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
