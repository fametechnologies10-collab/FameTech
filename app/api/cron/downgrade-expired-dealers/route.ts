import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { validateCronAuth } from '@/lib/cron-utils'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

// Runs every 6 hours via cron-job.org
// Downgrades any dealer whose dealer_expires_at has passed back to lifetime agent.
export async function GET(request: Request) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    try {
        const now = new Date().toISOString()

        const { data: expired, error: fetchError } = await (supabaseAdmin as any)
            .from('users')
            .select('id, email, dealer_expires_at')
            .eq('role', 'dealer')
            .lt('dealer_expires_at', now)

        if (fetchError) {
            console.error('[DowngradeExpiredDealers] fetch error:', fetchError)
            return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
        }

        if (!expired || expired.length === 0) {
            return NextResponse.json({ success: true, downgraded: 0 })
        }

        const ids = expired.map((u: any) => u.id)

        const { error: updateError } = await (supabaseAdmin as any)
            .from('users')
            .update({ role: 'agent', dealer_expires_at: null })
            .in('id', ids)

        if (updateError) {
            console.error('[DowngradeExpiredDealers] update error:', updateError)
            return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
        }

        console.log(`[DowngradeExpiredDealers] Downgraded ${ids.length} expired dealer(s):`, ids)

        // FIX B (spec §8.2): re-sync each downgraded owner's shop pricing to the RISEN
        // agent cost basis and floor their wholesale sub_price. Previously NOT wired, so a
        // dealer's storefront kept dealer-basis selling prices after expiry — silently
        // collapsing margins (and, if thin, failing the checkout profit floor). Per-user +
        // logged: a silent failure here is a money bug, so it must be visible for reconcile.
        let repriced = 0
        for (const id of ids) {
            const { error: repriceError } = await (supabaseAdmin as any)
                .rpc('adjust_shop_pricing_for_role_change', {
                    p_user_id: id,
                    p_old_role: 'dealer',
                    p_new_role: 'agent',
                })
            if (repriceError) {
                console.error(`[DowngradeExpiredDealers] reprice FAILED for ${id} (manual reconcile needed):`, repriceError)
            } else {
                repriced++
            }
        }

        return NextResponse.json({ success: true, downgraded: ids.length, repriced })
    } catch (error: any) {
        console.error('[DowngradeExpiredDealers]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
