import { NextRequest, NextResponse } from 'next/server'
import { getAvailableTypes, getPriceForRole, effectiveRoleFromExpiry } from '@/lib/results-checker-service'
import {
    SUB_AGENT_PRICING_UNAVAILABLE_MESSAGE,
    SUB_AGENT_PRICING_UNAVAILABLE_STATUS,
} from '@/lib/results-checker-pricing'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentRcCost } from '@/lib/sub-agent-rc-pricing'

/**
 * GET /api/shop/results-checker/pricing?shopSlug=<slug>
 *
 * LIVE storefront RC pricing for a shop. The storefront's server-rendered rcTypes/markups
 * are a one-time snapshot; this endpoint lets the client re-pull the CURRENT base prices +
 * this shop's markups so the displayed price always matches what the charge route computes.
 * Returns exactly the fields the storefront displays (customer_price + per-exam/legacy markup).
 * No auth — public read; never exposes cost_price.
 */
export async function GET(request: NextRequest) {
    try {
        const shopSlug = new URL(request.url).searchParams.get('shopSlug')
        if (!shopSlug || !/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(shopSlug)) {
            return NextResponse.json({ error: 'Invalid shop identifier' }, { status: 400 })
        }

        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any

        const { data: shop } = await db
            .from('shop_profiles')
            .select('id, owner_id, results_checker_markup_customer, owner:users!shop_profiles_owner_id_fkey(role, dealer_expires_at, agent_expires_at)')
            .eq('shop_slug', shopSlug)
            .maybeSingle()
        if (!shop) return NextResponse.json({ error: 'Shop not found' }, { status: 404 })

        // The displayed base MUST match what the charge computes = the OWNER-ROLE price
        // (getPriceForRole), not the literal customer_price — a reseller shop sells at
        // agent/dealer_price + markup. Effective role respects expiry so an expired reseller is
        // shown (and charged) the customer tier consistently across surfaces.
        const ownerRole: string = effectiveRoleFromExpiry(
            (shop as any).owner?.role,
            (shop as any).owner?.agent_expires_at,
            (shop as any).owner?.dealer_expires_at,
        )
        const fullTypes = await getAvailableTypes()

        // ── Sub-agent storefront pricing (review finding C1) ────────────────────────────────
        // Same display drift as breakdown/initialize/charge: if the shop OWNER is a recruited
        // sub-agent, the flat getPriceForRole base below is NOT what they'll actually be
        // charged. An ineligible/suspended chain blocks the WHOLE list (the guest cannot buy
        // anything from this shop right now); a per-type pricing rejection (e.g. this sub's
        // ceiling breached for one specific exam type) excludes just that type rather than
        // failing the whole preview, since the other types may still be purchasable.
        const subCtx = await resolveSubAgentContext(db, shop.owner_id)
        if (subCtx.isSub && !subCtx.effectiveActive) {
            return NextResponse.json({ error: SUB_AGENT_PRICING_UNAVAILABLE_MESSAGE }, { status: SUB_AGENT_PRICING_UNAVAILABLE_STATUS })
        }

        const types: Array<{ id: string; name: string; customer_price: number; available_count?: number; bulk_pricing: any[] }> = []
        for (const t of fullTypes) {
            let basePrice = getPriceForRole(t, ownerRole)
            if (subCtx.isSub) {
                // Quantity 1 — this list shows the "starting from" per-unit price before any
                // quantity is chosen; the exact bulk-tier-aware total is resolved later by
                // /breakdown at checkout time, same as the non-sub path above.
                const subCostResult = await resolveSubAgentRcCost(db, shop.owner_id, t, 1)
                if (!subCostResult.ok) {
                    console.warn(`[RC Shop Pricing] Excluding type ${t.id} from preview for shop ${shop.id} — sub-agent pricing unavailable: ${subCostResult.reason}`)
                    continue
                }
                basePrice = subCostResult.subCost
            }
            types.push({
                id: t.id,
                name: t.name,
                customer_price: basePrice,
                available_count: t.available_count,
                bulk_pricing: Array.isArray(t.bulk_pricing) ? t.bulk_pricing : [],
            })
        }

        // Per-exam markups (override the legacy single markup) — matches app/shop/[shopSlug]/page.tsx.
        const markups: Record<string, number> = {}
        const { data: markupRows } = await db
            .from('shop_rc_markups')
            .select('exam_type_id, markup')
            .eq('shop_id', shop.id)
        for (const row of (markupRows as any[]) || []) {
            markups[row.exam_type_id] = parseFloat(String(row.markup)) || 0
        }

        const legacyMarkup = parseFloat(String(shop.results_checker_markup_customer || 0)) || 0

        return NextResponse.json({ success: true, types, markups, legacyMarkup })
    } catch (error) {
        console.error('[RC Shop Pricing] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
