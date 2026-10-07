import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabase = createServerClient()

        const { data: user, error: fetchError } = await (supabase
            .from('users') as any)
            .select('id, role, dealer_expires_at')
            .eq('id', authUser.id)
            .single()

        if (fetchError || !user) {
            console.error('[DealerDowngrade] User fetch error:', fetchError)
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        if (user.role !== 'dealer') {
            return NextResponse.json({ error: 'User is not a dealer' }, { status: 400 })
        }

        // Downgrade dealer → lifetime agent (agent_expires_at stays null = permanent agent)
        const { error: updateError } = await (supabase
            .from('users') as any)
            .update({
                role: 'agent',
                agent_expires_at: null,
                dealer_expires_at: null,
                updated_at: new Date().toISOString(),
            })
            .eq('id', authUser.id)

        if (updateError) {
            console.error('[DealerDowngrade] Update error:', updateError)
            throw updateError
        }

        // Reset shop fee overrides to agent-level global settings (non-blocking)
        try {
            await (supabase
                .from('shop_profiles') as any)
                .update({
                    paystack_fee_percent:   null,
                    withdrawal_fee_percent: null,
                    withdrawal_fee_flat:    null,
                    min_withdrawal_amount:  null,
                    updated_at: new Date().toISOString(),
                })
                .eq('owner_id', authUser.id)
        } catch (resetErr) {
            console.error('[DealerDowngrade] Failed to reset shop fee overrides (non-fatal):', resetErr)
        }

        // FIX B (spec §8.2): re-sync this owner's shop pricing to the agent cost basis and
        // floor their wholesale sub_price. Non-blocking but logged — the downgrade already
        // committed above; a reprice failure must be visible for manual reconciliation.
        try {
            const { error: repriceError } = await (supabase as any)
                .rpc('adjust_shop_pricing_for_role_change', {
                    p_user_id: authUser.id,
                    p_old_role: 'dealer',
                    p_new_role: 'agent',
                })
            if (repriceError) {
                console.error('[DealerDowngrade] reprice FAILED (manual reconcile needed):', repriceError)
            }
        } catch (repriceErr) {
            console.error('[DealerDowngrade] reprice threw (non-fatal):', repriceErr)
        }

        console.log(`[DealerDowngrade] User ${authUser.id} downgraded to lifetime agent`)

        return NextResponse.json({
            success: true,
            message: 'Dealer status expired. You have been returned to Lifetime Agent.'
        })
    } catch (error: any) {
        console.error('Dealer Downgrade Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
