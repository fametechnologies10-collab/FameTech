import { cookies } from 'next/headers'
import { createRouteClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'
import { generateReferenceCode, calculatePaystackFee } from '@/lib/utils'

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!

export async function POST(request: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { plan = '30d', upgrade_type = 'agent' } = await request.json().catch(() => ({}));
        const user = authUser

        // Fetch current user role
        const { data: dbUser } = await supabase
            .from('users')
            .select('role, agent_expires_at')
            .eq('id', user.id)
            .single()

        const currentRole = (dbUser as any)?.role
        const agentExpiresAt = (dbUser as any)?.agent_expires_at

        if (upgrade_type === 'dealer') {
            // Lifetime agents (new) OR existing dealers (extension) may pay for dealer membership
            const isLifetimeAgent = currentRole === 'agent' && agentExpiresAt === null
            const isCurrentDealer = currentRole === 'dealer'
            if (!isLifetimeAgent && !isCurrentDealer) {
                return NextResponse.json(
                    { error: 'Dealer membership is only available to Lifetime Agent members and existing Dealers' },
                    { status: 400 }
                )
            }
        } else {
            // Agent upgrade: only customers and existing agents may upgrade
            if (currentRole !== 'customer' && currentRole !== 'agent') {
                return NextResponse.json(
                    { error: 'Membership upgrades are only available for customers and existing agents' },
                    { status: 400 }
                )
            }
        }

        // Fetch upgrade prices from admin settings using service role to bypass RLS
        const { createClient } = await import('@supabase/supabase-js')
        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false
                }
            }
        )

        const { data: settings } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', [
                'agent_upgrade_price_3d',
                'agent_upgrade_price_14d',
                'agent_upgrade_price_30d',
                'agent_upgrade_price_permanent',
                'dealer_upgrade_price_1m',
                'dealer_upgrade_price_3m',
                'dealer_upgrade_price_6m',
            ])

        const getPrice = (key: string, def: number) => {
            const s = settings?.find((s: any) => s.key === key);
            return s ? Number(s.value) : def;
        };

        let upgradePrice = 100;
        let planLabel = 'Agent Status';
        let resolvedUpgradeType = upgrade_type === 'dealer' ? 'dealer' : 'agent'

        if (upgrade_type === 'dealer') {
            const dealerPlanMap: Record<string, { key: string; def: number; label: string }> = {
                '1m': { key: 'dealer_upgrade_price_1m', def: 99.99,  label: '1 Month Dealer Pass'  },
                '3m': { key: 'dealer_upgrade_price_3m', def: 199.99, label: '3 Months Dealer Pass' },
                '6m': { key: 'dealer_upgrade_price_6m', def: 299.99, label: '6 Months Dealer Pass' },
            }
            const dealerEntry = dealerPlanMap[plan] ?? dealerPlanMap['6m']
            upgradePrice = getPrice(dealerEntry.key, dealerEntry.def)
            planLabel = dealerEntry.label
        } else if (plan === '3d') {
            upgradePrice = getPrice('agent_upgrade_price_3d', 9.99);
            planLabel = '3 Days Agent Pass';
        } else if (plan === '14d') {
            upgradePrice = getPrice('agent_upgrade_price_14d', 49.99);
            planLabel = '14 Days Agent Pass';
        } else if (plan === 'permanent') {
            upgradePrice = getPrice('agent_upgrade_price_permanent', 149.99);
            planLabel = 'Permanent Agent Pass';
        } else {
            upgradePrice = getPrice('agent_upgrade_price_30d', 99.99);
            planLabel = '30 Days Agent Pass';
        }


        // No fees for membership payments - customer pays exact price
        const fee = 0
        const totalAmount = upgradePrice

        // Create a pending record in wallet_payments so the webhook can find it
        const reference = upgrade_type === 'dealer'
            ? `dealer_upgrade_${generateReferenceCode()}`
            : `agent_upgrade_${generateReferenceCode()}`

        // Get user's wallet
        const { data: wallet } = await supabaseAdmin
            .from('wallets')
            .select('id')
            .eq('user_id', user.id)
            .single()

        if (!wallet) {
            throw new Error('User wallet not found')
        }

        const dealerDaysMap: Record<string, number> = { '1m': 30, '3m': 90, '6m': 180 }
        const planDays = upgrade_type === 'dealer'
            ? (dealerDaysMap[plan] ?? 180)
            : (plan === 'permanent' ? null : (plan === '3d' ? 3 : (plan === '14d' ? 14 : 30)))

        const { error: paymentError } = await (supabaseAdmin
            .from('wallet_payments') as any)
            .insert({
                user_id: user.id,
                wallet_id: (wallet as any).id,
                amount: upgradePrice,
                fee: 0,
                total_amount: upgradePrice,
                reference,
                provider: 'paystack',
                status: 'pending',
                metadata: {
                    user_id: user.id,
                    upgrade_type: resolvedUpgradeType,
                    plan_type: plan,
                    plan_days: planDays,
                    plan_label: planLabel,
                    base_amount: upgradePrice,
                }
            })

        if (paymentError) {
            console.error('[UpgradeInit] Database error:', paymentError)
            throw new Error('Failed to record payment attempt')
        }

        // Initialize Paystack payment
        const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                email: user.email,
                amount: Math.round(totalAmount * 100), // Convert to pesewas
                reference,
                metadata: {
                    user_id: user.id,
                    upgrade_type: resolvedUpgradeType,
                    plan_type: plan,
                    plan_days: planDays,
                    plan_label: planLabel,
                    base_amount: upgradePrice,
                    fee: fee,
                },
                callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/upgrade?success=true&type=${resolvedUpgradeType}`,
            }),
        })

        if (!paystackResponse.ok) {
            throw new Error('Failed to initialize payment')
        }

        const paystackData = await paystackResponse.json()

        return NextResponse.json({
            authorization_url: paystackData.data.authorization_url,
            reference,
        })
    } catch (error: any) {
        console.error('Error initializing agent upgrade:', error)
        return NextResponse.json(
            { error: error.message || 'Failed to initialize upgrade' },
            { status: 500 }
        )
    }
}
