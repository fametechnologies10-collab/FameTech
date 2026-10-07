import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'

/**
 * GET /api/admin/users/[id]
 * Full profile for the admin detail drawer: user row + order/spend/wallet/complaint
 * aggregates + recent wallet transactions + shop ownership.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }
        const { id } = await ctx.params
        if (!id) return NextResponse.json({ error: 'User id required' }, { status: 400 })

        const supabase = createServerClient() as any

        // Explicit allow-list — future sensitive users columns are NOT exposed by default.
        const USER_COLUMNS = 'id, email, first_name, last_name, phone_number, role, status, '
            + 'suspended_until, suspension_reason, suspended_at, suspended_by, phone_verified, '
            + 'agent_expires_at, dealer_expires_at, order_success_sms_enabled, created_at, updated_at'

        const [
            userRes, walletRes, totalOrdersRes, completedOrdersRes, spentRes,
            complaintsRes, shopRes, txRes, subAgentRes,
        ] = await Promise.all([
            supabase.from('users').select(USER_COLUMNS).eq('id', id).single(),
            supabase.from('wallets').select('balance, total_spent').eq('user_id', id).maybeSingle(),
            supabase.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', id).is('shop_order_id', null),
            supabase.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', id).eq('status', 'completed').is('shop_order_id', null),
            supabase.from('orders').select('price').eq('user_id', id).eq('status', 'completed').is('shop_order_id', null).limit(5000),
            supabase.from('complaints').select('*', { count: 'exact', head: true }).eq('user_id', id),
            supabase.from('shop_profiles').select('id, shop_name, shop_slug').eq('owner_id', id).maybeSingle(),
            supabase.from('wallet_transactions').select('id, type, amount, description, source, status, created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(10),
            supabase.from('sub_agents').select('upline_user_id').eq('user_id', id).maybeSingle(),
        ])

        if (userRes.error || !userRes.data) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        const u = userRes.data

        const totalSpent = (spentRes.data || []).reduce((s: number, r: any) => s + (Number(r.price) || 0), 0)

        // Sub-agent recruiter lookup — resolve the upline's name only when this user is a
        // sub-agent with a resolvable upline_user_id (mirrors the shopRes pattern above).
        let recruitedBy: string | null = null
        const uplineUserId = subAgentRes.data?.upline_user_id
        if (uplineUserId) {
            const { data: uplineUser } = await supabase
                .from('users')
                .select('first_name, last_name')
                .eq('id', uplineUserId)
                .maybeSingle()
            if (uplineUser) {
                recruitedBy = `${uplineUser.first_name || ''} ${uplineUser.last_name || ''}`.trim() || null
            }
        }

        return NextResponse.json({
            user: u,
            stats: {
                totalOrders: totalOrdersRes.count || 0,
                completedOrders: completedOrdersRes.count || 0,
                totalSpent,
                walletBalance: walletRes.data?.balance ?? 0,
                walletTotalSpent: walletRes.data?.total_spent ?? 0,
                complaints: complaintsRes.count || 0,
                hasShop: !!shopRes.data,
                shopName: shopRes.data?.shop_name ?? null,
                shopSlug: shopRes.data?.shop_slug ?? null,
                recruitedBy,
            },
            recentTransactions: txRes.data || [],
        })
    } catch (error: any) {
        console.error('Admin User Detail Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
