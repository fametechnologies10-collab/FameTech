import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { processWalletUpgrade, fetchUpgradePrice } from '@/lib/wallet-upgrade'
import type { UpgradeType, PlanType } from '@/lib/wallet-upgrade'

export async function POST(request: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json().catch(() => ({}))
        const upgradeType: UpgradeType = body.upgrade_type === 'dealer' ? 'dealer' : 'agent'
        const DEALER_PLANS: PlanType[] = ['1m', '3m', '6m']
        const plan: PlanType = upgradeType === 'dealer'
            ? (DEALER_PLANS.includes(body.plan) ? body.plan : '6m')
            : (body.plan ?? '30d')

        // Price must ALWAYS come from admin_settings — never trust client-supplied price
        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } }
        )

        const { price, planLabel } = await fetchUpgradePrice(upgradeType, plan, supabaseAdmin)

        const result = await processWalletUpgrade({
            userId: authUser.id,
            upgradeType,
            plan,
            price,
            planLabel,
            isAutoUpgrade: false,
        })

        if (!result.success) {
            if (result.insufficientBalance) {
                return NextResponse.json(
                    {
                        error: 'Insufficient wallet balance',
                        insufficientBalance: true,
                        currentBalance: result.currentBalance,
                        requiredAmount: result.requiredAmount,
                        shortfall: (result.requiredAmount ?? 0) - (result.currentBalance ?? 0),
                    },
                    { status: 402 }
                )
            }
            return NextResponse.json({ error: result.error ?? 'Upgrade failed' }, { status: 400 })
        }

        return NextResponse.json({
            success: true,
            newExpiry: result.newExpiry,
            planLabel,
        })
    } catch (err: any) {
        console.error('[WalletUpgradeRoute] Error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
