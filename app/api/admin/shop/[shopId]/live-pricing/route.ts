import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { resolveOwnerCost } from '@/lib/pricing/cost-basis'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentDataCost } from '@/lib/sub-agent-data-pricing'

// Admin "Live Shop Pricing" cost column must match the SAME cost every real
// order uses (lib/shop-order-processor.ts) — plain role-tier lookup for a
// normal owner, recruiter-cost + markup for a sub-agent shop. The page used
// to inline a role==='dealer'/'agent' check with no expiry and no sub-agent
// branch, which silently showed the wrong cost (and therefore wrong profit)
// for expired dealers/agents and for every sub-agent shop.
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ shopId: string }> }
) {
    try {
        const { shopId } = await params

        // Admin-only (not sub-admin): this exposes per-package cost basis and, for
        // sub-agent-owned shops, recruiter markup/economics — business-sensitive
        // data, not order data. validateAdminAccess's sub-admin branch is scoped to
        // /api/admin/orders and /api/admin/batches only; passing allowSubAdmin here
        // would silently widen that policy for this route alone.
        const access = await validateAdminAccess(false)
        if (access.error) {
            return NextResponse.json({ success: false, error: access.error }, { status: access.status })
        }

        if (!shopId) {
            return NextResponse.json({ success: false, error: 'shopId is required' }, { status: 400 })
        }

        const db = createServerClient()

        const { data: shopProfile, error: shopError } = await (db as any)
            .from('shop_profiles')
            .select('id, owner_id')
            .eq('id', shopId)
            .single()
        if (shopError || !shopProfile) {
            return NextResponse.json({ success: false, error: 'Shop not found' }, { status: 404 })
        }

        const { data: ownerUser } = await (db as any)
            .from('users')
            .select('id, role, agent_expires_at, dealer_expires_at')
            .eq('id', shopProfile.owner_id)
            .single()

        const { data: rows, error: pricingError } = await (db as any)
            .from('shop_pricing')
            .select('id, shop_id, package_id, selling_price, profit_margin, last_auto_updated_at, data_packages(network, size, price, agent_price, dealer_price)')
            .eq('shop_id', shopId)
        if (pricingError) throw pricingError

        const subCtx = await resolveSubAgentContext(db, shopProfile.owner_id)

        const enriched = await Promise.all((rows || []).map(async (row: any) => {
            const pkg = row.data_packages
            let cost: number
            if (subCtx.isSub) {
                const resolved = await resolveSubAgentDataCost(db, shopProfile.owner_id, row.package_id, pkg, 'data')
                // Fail-closed sub still needs a cost to render — fall back to the
                // recruiter/customer tier rather than hiding the row from admin view.
                cost = resolved.ok && resolved.isSub
                    ? resolved.subCost
                    : resolveOwnerCost(pkg, ownerUser || { role: null })
            } else {
                cost = resolveOwnerCost(pkg, ownerUser || { role: null })
            }
            return { ...row, cost }
        }))

        return NextResponse.json({ success: true, data: enriched, isSubAgentShop: subCtx.isSub })
    } catch (error: any) {
        console.error('[AdminShopLivePricing API]', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal server error' }, { status: 500 })
    }
}
