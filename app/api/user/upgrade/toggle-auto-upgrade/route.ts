import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import type { PlanType, UpgradeType } from '@/lib/wallet-upgrade'

const VALID_PLANS: PlanType[] = ['3d', '14d', '30d', 'permanent', '1m', '3m', '6m']
const DEALER_PLANS: PlanType[] = ['1m', '3m', '6m']

export async function POST(request: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json().catch(() => ({}))
        const { enabled, plan } = body as { enabled: boolean; plan: PlanType }

        if (typeof enabled !== 'boolean') {
            return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
        }

        if (enabled && (!plan || !VALID_PLANS.includes(plan))) {
            return NextResponse.json(
                { error: `plan must be one of: ${VALID_PLANS.join(', ')}` },
                { status: 400 }
            )
        }

        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } }
        )

        // Validate plan matches user's role category
        const { data: dbUser } = await supabaseAdmin
            .from('users')
            .select('role, agent_expires_at')
            .eq('id', authUser.id)
            .single()

        if (!dbUser) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        const user = dbUser as any

        if (enabled) {
            const isDealer = user.role === 'dealer'
            const isLifetimeAgent = user.role === 'agent' && user.agent_expires_at === null

            // Dealer plans only valid for dealers and lifetime agents eligible for dealer
            if (DEALER_PLANS.includes(plan) && !isDealer && !isLifetimeAgent) {
                return NextResponse.json(
                    { error: 'Dealer auto-upgrade requires Dealer or Lifetime Agent status' },
                    { status: 400 }
                )
            }

            // Agent-only plans are invalid for dealers
            if (!DEALER_PLANS.includes(plan) && isDealer) {
                return NextResponse.json(
                    { error: 'Dealers must use a dealer plan (1m, 3m, or 6m) for auto-upgrade' },
                    { status: 400 }
                )
            }

            // Permanent plan cannot be auto-renewed (it's a one-time purchase)
            if (plan === 'permanent' && isLifetimeAgent) {
                return NextResponse.json(
                    { error: 'You already have permanent access — no auto-upgrade needed' },
                    { status: 400 }
                )
            }
        }

        const { error: updateError } = await (supabaseAdmin
            .from('users') as any)
            .update({
                auto_upgrade_enabled: enabled,
                auto_upgrade_plan: enabled ? plan : null,
                updated_at: new Date().toISOString(),
            })
            .eq('id', authUser.id)

        if (updateError) {
            console.error('[ToggleAutoUpgrade] DB error:', updateError)
            return NextResponse.json({ error: 'Failed to update auto-upgrade setting' }, { status: 500 })
        }

        return NextResponse.json({
            success: true,
            auto_upgrade_enabled: enabled,
            auto_upgrade_plan: enabled ? plan : null,
        })
    } catch (err: any) {
        console.error('[ToggleAutoUpgrade] Error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
