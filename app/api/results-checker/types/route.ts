import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { getAvailableTypes, getTypeById, getPriceForRole } from '@/lib/results-checker-service'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { hasSubAgentPricingConfigured } from '@/lib/sub-agent-pricing'
import { resolveSubAgentRcCost } from '@/lib/sub-agent-rc-pricing'

/**
 * GET /api/results-checker/types
 *
 * Public endpoint returning active RC types with available inventory.
 * If the request carries a valid session cookie, prices are adjusted
 * to the user's role. Unauthenticated callers receive customer prices.
 *
 * Plan 4, Task 9 (spec C4) — sub-agent-aware `configured` flag, per type.
 * This route was NOT sub-agent-aware before this change: it always resolved
 * a plain role-tier price via getPriceForRole, which for a sub-agent falls
 * into the plain 'customer'/'agent'/'dealer' branch (no sub-agent concept
 * at all) — showing a price that has nothing to do with what the sub would
 * actually be charged. The real charge at purchase time comes from
 * resolveSubAgentRcCost (via purchaseWithWallet in results-checker-service.ts,
 * already confirmed sub-agent-aware from Plan 2b/2c), whose markup resolution
 * defaults to 0 (not a failure) when no sub_agent_pricing/
 * sub_agent_default_pricing row exists for that specific voucher type — so an
 * unconfigured sub could still purchase a type they have no pricing for and be
 * charged the recruiter's raw cost with zero margin, silently bypassing the
 * fail-closed gate the business intends (mirrors Task 7/8's exact reasoning).
 * `configured` now makes that state visible to the caller PER TYPE, before
 * checkout, instead of only failing at purchase time — a sub might have
 * pricing configured for BECE but not WASSCE, so this is never all-or-nothing.
 *
 * Only a genuine sub-agent (resolveSubAgentContext().isSub) takes the new
 * branch; every other role's response is byte-identical to before this change
 * (the `configured` key is simply omitted, as it always was for non-subs).
 */
export async function GET(request: NextRequest) {
    try {
        // Attempt optional auth — do not block if unauthenticated
        let userRole = 'customer'
        let db: any = null
        let userId: string | null = null
        try {
            const cookieStore = await cookies()
            const supabaseUser = await createRouteClient()
            const { data: { user } } = await supabaseUser.auth.getUser()
            if (user) {
                userId = user.id
                const { createServerClient } = await import('@/lib/supabase')
                db = createServerClient() as any
                const { data: profile } = await db
                    .from('users')
                    .select('role')
                    .eq('id', user.id)
                    .single()
                if (profile?.role === 'dealer') userRole = 'dealer'
                else if (profile?.role === 'agent') userRole = 'agent'
                else userRole = 'customer'
            }
        } catch {
            // Optional auth — silently continue as guest
        }

        const types = await getAvailableTypes()

        // Return role-adjusted prices (never expose cost_price)
        const result: any[] = types.map(type => ({
            id:              type.id,
            name:            type.name,
            price:           getPriceForRole(type, userRole),
            customer_price:  type.customer_price,
            agent_price:     type.agent_price,
            dealer_price:    type.dealer_price,
            cost_price:      undefined, // never expose to client
            is_active:       type.is_active,
            display_order:   type.display_order,
            available_count: type.available_count,
            bulk_pricing:    (type as any).bulk_pricing || [],
        }))

        // Sub-agent-only: report whether RC pricing is actually configured for
        // this caller, PER TYPE, and if so, resolve their real price instead of
        // the role-tier one above. Every other role's response is untouched —
        // `ctx.isSub` is false for them and this block never executes, so
        // `configured` is simply omitted (as before this task).
        if (db && userId) {
            const ctx = await resolveSubAgentContext(db, userId)
            if (ctx.isSub) {
                if (!ctx.effectiveActive || !ctx.recruiter || !ctx.recruiterId) {
                    // Fail closed, same as resolveSubAgentRcCost: an inactive/unlinked
                    // sub cannot transact, so nothing is purchasable for them.
                    for (const t of result) t.configured = false
                } else {
                    const recruiterId = ctx.recruiterId
                    await Promise.all(result.map(async (t) => {
                        const configured = await hasSubAgentPricingConfigured(
                            db, recruiterId, userId as string, 'results_checker', t.id,
                        )
                        if (!configured) {
                            t.configured = false
                            return
                        }

                        // Configured — resolve the real sub price so what's displayed
                        // matches what resolveSubAgentRcCost will actually charge at
                        // purchase time. Quantity 1 mirrors `price` above, which is
                        // likewise a flat per-unit figure with no quantity context at
                        // list time — bulk tiers are applied client-side once a
                        // quantity is chosen, unaffected by this override.
                        const fullType = await getTypeById(t.id)
                        if (!fullType) {
                            t.configured = false
                            return
                        }
                        const subCost = await resolveSubAgentRcCost(db, userId as string, fullType, 1)
                        if (!subCost.ok) {
                            // Configured but unresolvable for some other reason (e.g.
                            // pricing rejected) — fail closed exactly like purchase would.
                            t.configured = false
                            return
                        }

                        t.configured = true
                        t.price = subCost.subCost
                    }))
                }
            }
        }

        return NextResponse.json({ success: true, types: result, userRole })
    } catch (error) {
        console.error('[RC Types] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
