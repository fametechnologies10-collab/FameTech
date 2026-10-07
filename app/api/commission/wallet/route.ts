import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

export async function GET() {
    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    // sub_agents is queried on the service-role client, not the RLS-scoped one (final whole-plan
    // review finding, fixed before merge): sub_agents has exactly two SELECT policies today —
    // self_read (own row) and lead_read (keyed on the OLD model's upline_shop_id) — neither
    // matches upline_user_id = auth.uid(), which is what every NEW-model sub-agent row actually
    // has. Under RLS this recruiter can never see their own new-model downline here at all. Also
    // uses .limit(1) instead of .maybeSingle(), which throws PGRST116 (and silently returns
    // data:null) the moment a recruiter has more than one qualifying row.
    const admin = createServerClient() as any

    const [walletRes, shopWalletRes, keyRes, subAgentRes] = await Promise.all([
        (supabase.from('commission_wallets') as any).select('balance, total_earned, total_withdrawn').eq('owner_id', user.id).maybeSingle(),
        (supabase.from('shop_wallets') as any).select('id').eq('owner_id', user.id).maybeSingle(),
        (supabase.from('api_keys') as any).select('id').eq('user_id', user.id).eq('key_type', 'commission').eq('status', 'active').maybeSingle(),
        admin.from('sub_agents').select('id').eq('upline_user_id', user.id).eq('status', 'active').limit(1),
    ])

    const wallet = walletRes.data
    if (keyRes.error) {
        console.error('[Commission Wallet] api_keys lookup failed:', keyRes.error.message)
    }
    if (subAgentRes.error) {
        console.error('[Commission Wallet] sub_agents lookup failed:', subAgentRes.error.message)
    }
    return NextResponse.json({
        success: true,
        data: {
            has_wallet: !!wallet,
            has_commission_key: !!keyRes.data,
            balance: wallet?.balance ?? 0,
            total_earned: wallet?.total_earned ?? 0,
            total_withdrawn: wallet?.total_withdrawn ?? 0,
            has_shop_wallet: !!shopWalletRes.data,
            has_active_sub_agents: Array.isArray(subAgentRes.data) && subAgentRes.data.length > 0,
        },
    })
}
