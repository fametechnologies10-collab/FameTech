import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'

// GET — all ledger data for the profit-logs page.
// Centralising here means every DB query runs behind a server-side
// auth.getUser() check instead of relying solely on browser-side RLS.
export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const { data: shopData } = await supabase
            .from('shop_profiles')
            .select('id')
            .eq('owner_id', user.id)
            .maybeSingle()

        if (!shopData) {
            return NextResponse.json({ success: true, data: { wallet: null, orders: [], rcOrders: [], withdrawals: [], smsPurchases: [], smsActs: [], utilityCommissions: [] } })
        }

        const shopId = (shopData as any).id

        const { data: walletRow } = await supabase
            .from('shop_wallets')
            .select('id, balance, total_earned, total_withdrawn')
            .eq('owner_id', user.id)
            .maybeSingle()

        const walletId: string | null = (walletRow as any)?.id ?? null

        const [ordersRes, rcRes, afaRes, wdRes, smsRes, smsActRes, utilCommRes] = await Promise.allSettled([
            supabase
                .from('shop_orders')
                .select('id, network, package_size, package_id, guest_phone, profit, status, created_at, source')
                .eq('shop_id', shopId)
                .order('created_at', { ascending: false })
                .limit(500),
            supabase
                .from('results_checker_orders')
                .select('id, type_name, quantity, customer_phone, shop_markup, status, created_at, source')
                .eq('shop_id', shopId)
                .neq('payment_status', 'pending_payment')
                .order('created_at', { ascending: false })
                .limit(200),
            // AFA registrations live in their own table, same as results_checker_orders
            // above — joined in here as a fourth parallel array (afaOrders) rather than
            // merged into `orders`, since AFA rows have no package_id/network shape to
            // reuse. Deliberately select only non-KYC columns: never full_name/ghana_card.
            supabase
                .from('afa_orders')
                .select('id, phone, selling_price, profit, status, created_at, source')
                .eq('shop_id', shopId)
                .order('created_at', { ascending: false })
                .limit(200),
            walletId
                ? supabase
                    .from('shop_wallet_transactions')
                    .select('id, amount, fee, net_amount, status, account_name, momo_number, created_at')
                    .eq('shop_wallet_id', walletId)
                    .eq('type', 'withdrawal')
                    .order('created_at', { ascending: false })
                    .limit(200)
                : Promise.resolve({ data: [] }),
            supabase
                .from('shop_sms_purchases')
                .select('id, credits, price, created_at, shop_sms_bundles(name)')
                .eq('shop_id', shopId)
                .order('created_at', { ascending: false })
                .limit(100),
            supabase
                .from('shop_sms_activations')
                .select('id, amount_paid, created_at')
                .eq('shop_id', shopId)
                .order('created_at', { ascending: false })
                .limit(10),
            walletId
                ? supabase
                    .from('shop_wallet_transactions')
                    .select('id, amount, description, created_at')
                    .eq('shop_wallet_id', walletId)
                    .eq('type', 'utility_commission')
                    .order('created_at', { ascending: false })
                    .limit(200)
                : Promise.resolve({ data: [] }),
        ])

        return NextResponse.json({
            success: true,
            data: {
                wallet:              walletRow || null,
                orders:              (ordersRes.status  === 'fulfilled' ? ordersRes.value?.data  : null) || [],
                rcOrders:            (rcRes.status       === 'fulfilled' ? rcRes.value?.data       : null) || [],
                afaOrders:           (afaRes.status      === 'fulfilled' ? afaRes.value?.data      : null) || [],
                withdrawals:         (wdRes.status       === 'fulfilled' ? wdRes.value?.data       : null) || [],
                smsPurchases:        (smsRes.status      === 'fulfilled' ? smsRes.value?.data      : null) || [],
                smsActs:             (smsActRes.status   === 'fulfilled' ? smsActRes.value?.data   : null) || [],
                utilityCommissions:  (utilCommRes.status === 'fulfilled' ? utilCommRes.value?.data : null) || [],
            },
        })
    } catch (err) {
        console.error('[ProfitLogs] API error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
