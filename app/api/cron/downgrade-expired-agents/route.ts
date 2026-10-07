import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { validateCronAuth } from '@/lib/cron-utils'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

// The dealer cron omits this, but 11 of the other cron routes set it: it stops
// Next from ever treating this GET as statically optimisable, which would serve
// a cached "downgraded: 0" instead of running.
export const dynamic = 'force-dynamic'

// Scheduled daily 02:15 UTC via cron-job.org — the twin of
// app/api/cron/downgrade-expired-dealers (daily 02:00 UTC), which handles
// dealer → agent. Offset 15 minutes so the two never overlap: a dealer whose
// tier lapses is turned into an agent by that job first, and only becomes a
// candidate here if their OWN agent_expires_at has also passed. (Today no
// dealer carries an agent_expires_at at all — all 21 have it NULL — so a
// downgraded dealer lands as a permanent agent and this job ignores them.)
//
// NOTE: downgrade-expired-dealers' own header comment claims "every 6 hours",
// which contradicts the registered daily 02:00 UTC schedule in
// .claude/skills/kingflexy-cron/SKILL.md. The schedule is the source of truth;
// that comment is stale.
//
// WHY THIS EXISTS: there was a downgrade cron for dealers but never one for
// agents, so `users.role` kept saying 'agent' indefinitely after
// agent_expires_at passed. Every pricing surface then had to decide for itself
// whether to honour the expiry, and they disagreed — data/purchase and the
// storefront charged customer prices while airtime and results-checker still
// gave the agent discount. lib/effective-role.ts now makes every READ path
// agree; this cron fixes the underlying DATA so the role column stops lying.
//
// The two are complementary, not redundant: effectiveRoleFromExpiry protects
// pricing the instant an expiry passes, while this cron reconciles the row
// within the next 6 hours. Keep both — the helper is the correctness guarantee,
// this is the cleanup.
//
// A NULL agent_expires_at means lifetime/permanent (see
// app/api/admin/extend-agent/permanent) and is never touched — the `.not(...)`
// + `.lt(...)` filters below both exclude NULL.
export async function GET(request: Request) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    // Bounded per run. Unlike the dealer cron (which only ever sees a handful),
    // this one starts with a 103-account backlog, and every function under
    // app/api/** is capped at maxDuration 60 in vercel.json. Draining in batches
    // keeps one invocation well inside that budget. At 50/run the initial
    // backlog clears in 3 daily runs; steady state is a handful per run. To
    // drain it faster, the endpoint is safe to call manually back-to-back — it
    // is idempotent (an already-downgraded user no longer matches role='agent').
    const BATCH_LIMIT = 50

    try {
        const now = new Date().toISOString()

        const { data: expired, error: fetchError } = await (supabaseAdmin as any)
            .from('users')
            .select('id, email, agent_expires_at')
            .eq('role', 'agent')
            .not('agent_expires_at', 'is', null)
            .lt('agent_expires_at', now)
            .limit(BATCH_LIMIT)

        if (fetchError) {
            console.error('[DowngradeExpiredAgents] fetch error:', fetchError)
            return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
        }

        if (!expired || expired.length === 0) {
            return NextResponse.json({ success: true, downgraded: 0 })
        }

        const ids = expired.map((u: any) => u.id)

        // Which of them own a shop? Only those need repricing / fee-override
        // clearing, so we avoid a round-trip per user for the majority who have
        // no shop at all (19 of the first 103 owned one). The RPC would return
        // early for them anyway — this just skips paying for that.
        const { data: shopRows, error: shopError } = await (supabaseAdmin as any)
            .from('shop_profiles')
            .select('owner_id')
            .in('owner_id', ids)

        if (shopError) {
            // Not fatal to the downgrade itself, but it means we cannot reprice.
            // Bail rather than downgrade-without-repricing: leaving a shop selling
            // at agent-basis prices while its owner is billed customer-basis
            // silently collapses that shop's margin. Next run retries the batch.
            console.error('[DowngradeExpiredAgents] shop lookup failed — aborting batch to avoid downgrading without repricing:', shopError)
            return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
        }

        const shopOwnerIds: string[] = Array.from(
            new Set(((shopRows || []) as any[]).map(r => r.owner_id))
        )

        const { error: updateError } = await (supabaseAdmin as any)
            .from('users')
            .update({ role: 'customer', agent_expires_at: null })
            .in('id', ids)

        if (updateError) {
            console.error('[DowngradeExpiredAgents] update error:', updateError)
            return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
        }

        console.log(`[DowngradeExpiredAgents] Downgraded ${ids.length} expired agent(s):`, ids)

        // Re-sync each downgraded owner's shop pricing to the RISEN customer cost
        // basis, exactly as the dealer cron does for dealer → agent. The owner's
        // wholesale cost goes UP when they lose the agent tier, so selling prices
        // must rise with it or the shop's margin silently collapses (and, if thin,
        // fails the checkout profit floor). adjust_shop_pricing_for_role_change
        // preserves the owner's existing profit per package rather than resetting
        // it, and floors sub_price at cost + 0.01.
        //
        // ORDERING IS DELIBERATE — DO NOT "FIX" IT BY REPRICING FIRST.
        // adjust_shop_pricing_for_role_change is NOT idempotent: it derives
        // profit as (selling_price - old_cost) and writes (new_cost + profit), so
        // running it twice for the same user adds the agent→customer delta twice
        // and permanently inflates that shop's prices, silently and
        // unrecoverably. Downgrading FIRST is what makes a re-run safe: an
        // already-downgraded user no longer matches role='agent', so they cannot
        // be selected into a second batch and cannot be repriced twice.
        //
        // The cost of this ordering is the opposite failure: if the process dies
        // mid-loop, a user is downgraded but not repriced, leaving their shop
        // selling at agent-basis prices while they are billed customer-basis.
        // That is a margin problem, but it is logged per-user below, detectable,
        // and fixable by calling the RPC once for the named ids — whereas double
        // repricing is neither visible nor reversible. Chose the recoverable
        // failure.
        //
        // Per-user + logged: a silent failure here is a money bug, so it must be
        // visible for reconcile.
        let repriced = 0
        const repriceFailures: string[] = []
        for (const id of shopOwnerIds) {
            const { error: repriceError } = await (supabaseAdmin as any)
                .rpc('adjust_shop_pricing_for_role_change', {
                    p_user_id: id,
                    p_old_role: 'agent',
                    p_new_role: 'customer',
                })
            if (repriceError) {
                console.error(`[DowngradeExpiredAgents] reprice FAILED for ${id} (manual reconcile needed):`, repriceError)
                repriceFailures.push(id)
            } else {
                repriced++
            }
        }

        // Clear agent-tier shop fee overrides so the shop falls back to the
        // customer global settings. Mirrors what the self-service downgrade at
        // app/api/agent/downgrade/route.ts already does, so an agent who lapses
        // ends up in exactly the same state as one who stepped down voluntarily.
        // Non-fatal: the downgrade itself has already committed.
        let feeOverridesCleared = 0
        if (shopOwnerIds.length > 0) {
            const { data: clearedRows, error: resetError } = await (supabaseAdmin as any)
                .from('shop_profiles')
                .update({
                    paystack_fee_percent: null,
                    withdrawal_fee_percent: null,
                    withdrawal_fee_flat: null,
                    min_withdrawal_amount: null,
                    updated_at: new Date().toISOString(),
                })
                .in('owner_id', shopOwnerIds)
                .select('id')
            if (resetError) {
                console.error('[DowngradeExpiredAgents] Failed to reset shop fee overrides (non-fatal):', resetError)
            } else {
                feeOverridesCleared = (clearedRows || []).length
            }
        }

        return NextResponse.json({
            success: true,
            downgraded: ids.length,
            shops_found: shopOwnerIds.length,
            repriced,
            reprice_failures: repriceFailures,
            fee_overrides_cleared: feeOverridesCleared,
            // Tells the operator (and the next run) that a backlog remains.
            batch_capped: ids.length === BATCH_LIMIT,
        })
    } catch (error: any) {
        console.error('[DowngradeExpiredAgents]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
