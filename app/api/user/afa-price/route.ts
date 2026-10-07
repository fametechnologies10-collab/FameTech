import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { AFA_PRICE_KEYS, resolveAfaPrice } from '@/lib/afa-pricing'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { hasSubAgentPricingConfigured } from '@/lib/sub-agent-pricing'
import { resolveSubAgentAfaCost, AFA_PRODUCT_REF } from '@/lib/sub-agent-afa-pricing'

/**
 * GET /api/user/afa-price
 *
 * Returns the AFA registration price applicable to the calling user's role.
 * Requires an active authenticated session — unauthenticated requests receive 401.
 * Uses the service-role client for the DB read so RLS on admin_settings does not
 * interfere with the price lookup.
 *
 * Plan 4, Task 8 (spec C4) — sub-agent-aware `configured` flag. This route was
 * NOT sub-agent-aware before this change: it always resolved a plain role-tier
 * price via resolveAfaPrice, which for a sub-agent falls into the same branch
 * as 'customer' (resolveAfaPrice only special-cases 'dealer'/'agent'), showing
 * a price that has nothing to do with what the sub would actually be charged.
 * The real charge at submission time comes from resolveSubAgentAfaCost, whose
 * markup resolution defaults to 0 (not a failure) when no sub_agent_pricing/
 * sub_agent_default_pricing row exists — so an unconfigured sub could still
 * submit and be charged the recruiter's raw cost with zero margin, silently
 * bypassing the fail-closed gate the business intends (mirrors Task 7's exact
 * reasoning for data packages). `configured` now makes that state visible to
 * the caller BEFORE checkout instead of only failing at submission.
 *
 * Only a genuine sub-agent (resolveSubAgentContext().isSub) takes this branch;
 * every other role's response is byte-identical to before this change.
 */

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function GET(request: NextRequest) {
    try {
        // ── 1. Verify the caller has a valid session ──────────────
        const cookieStore = await cookies()
        const supabaseUser = await createRouteClient()

        const { data: { user }, error: authError } = await supabaseUser.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // ── 2. Fetch the caller's role ────────────────────────────
        const { data: userRow } = await (supabaseUser
            .from('users')
            .select('role')
            .eq('id', user.id)
            .single() as any)

        const userRole: string = (userRow as any)?.role || 'customer'

        // ── 3. Fetch all role-tier prices via service role (bypasses RLS) ──
        const { data: rows, error: dbError } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', AFA_PRICE_KEYS)

        if (dbError) {
            console.error('[/api/user/afa-price] DB error fetching price:', dbError)
            return NextResponse.json({ error: 'Failed to load pricing' }, { status: 500 })
        }

        const settingsMap: Record<string, unknown> = {}
        for (const row of (rows || []) as any[]) settingsMap[row.key] = row.value

        // ── 4. Resolve the correct price for this role ────────────
        const price = resolveAfaPrice(settingsMap, userRole)

        if (price === null) {
            console.error(`[/api/user/afa-price] Invalid or missing customer price for role "${userRole}":`, settingsMap)
            return NextResponse.json({ error: 'Pricing not configured' }, { status: 503 })
        }

        // ── 5. Sub-agent-only: report whether AFA pricing is actually
        // configured for this caller, and if so, resolve their real price
        // instead of the role-tier one above. Every other role's response
        // is untouched — `ctx.isSub` is false for them and this block never
        // executes, so `configured` is simply omitted (as before this task).
        const ctx = await resolveSubAgentContext(supabaseAdmin, user.id)
        if (ctx.isSub) {
            if (!ctx.effectiveActive || !ctx.recruiter || !ctx.recruiterId) {
                // Fail closed, same as resolveSubAgentAfaCost: an inactive/unlinked
                // sub cannot transact, so AFA is not purchasable for them either.
                return NextResponse.json(
                    { price, role: userRole, configured: false },
                    { headers: { 'Cache-Control': 'private, no-store' } },
                )
            }

            const configured = await hasSubAgentPricingConfigured(
                supabaseAdmin, ctx.recruiterId, user.id, 'afa', AFA_PRODUCT_REF,
            )

            if (!configured) {
                return NextResponse.json(
                    { price, role: userRole, configured: false },
                    { headers: { 'Cache-Control': 'private, no-store' } },
                )
            }

            // Configured — resolve the real sub price so what's displayed matches
            // what resolveSubAgentAfaCost will actually charge at submission time.
            const subCost = await resolveSubAgentAfaCost(supabaseAdmin, user.id, settingsMap)
            if (!subCost.ok) {
                // Configured but unresolvable for some other reason (e.g. customer
                // price itself missing) — fail closed exactly like submission would.
                return NextResponse.json(
                    { price, role: userRole, configured: false },
                    { headers: { 'Cache-Control': 'private, no-store' } },
                )
            }

            return NextResponse.json(
                { price: subCost.subCost, role: userRole, configured: true },
                { headers: { 'Cache-Control': 'private, no-store' } },
            )
        }

        return NextResponse.json(
            { price, role: userRole },
            {
                headers: {
                    // Price data is user-specific — never cache publicly
                    'Cache-Control': 'private, no-store',
                },
            }
        )
    } catch (err) {
        console.error('[/api/user/afa-price] Unexpected error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
