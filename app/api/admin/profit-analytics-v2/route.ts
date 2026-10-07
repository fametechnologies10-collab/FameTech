import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

const VALID_PRODUCT_TYPES = ['data', 'airtime', 'utility', 'afa', 'results_checker', 'subscriptions', 'sms', 'ussd_activation']

export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin' && userData?.role !== 'sub-admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const { searchParams } = new URL(request.url)
        const startDateParam = searchParams.get('startDate')
        const endDateParam = searchParams.get('endDate')

        const now = new Date()
        const startDate = startDateParam ? new Date(startDateParam) : new Date(now.setUTCHours(0, 0, 0, 0))
        const endDate = endDateParam ? new Date(endDateParam) : new Date(now.setUTCHours(23, 59, 59, 999))

        const diffTime = Math.abs(endDate.getTime() - startDate.getTime())
        const prevEndDate = new Date(startDate.getTime() - 1)
        const prevStartDate = new Date(prevEndDate.getTime() - diffTime)

        // Product-type filter: comma-separated, validated against the known set —
        // an unrecognized value is dropped rather than passed through to SQL, since
        // the RPC treats an unmatched array value as simply "excludes everything"
        // for that (nonexistent) type, which would silently under-report instead
        // of erroring.
        const productTypesParam = searchParams.get('productTypes')
        const productTypes = productTypesParam
            ? productTypesParam.split(',').map(s => s.trim()).filter(s => VALID_PRODUCT_TYPES.includes(s))
            : null

        const network = searchParams.get('network')
        const networkFilter = network && network !== 'all' ? network : null

        const supabase = createServerClient()
        const db = supabase as any

        const [
            { data: summaryData, error: summaryError },
            { data: timeseriesData, error: timeseriesError },
            { data: shopOwnersData, error: shopOwnersError },
            { data: walletData, error: walletError },
        ] = await Promise.all([
            db.rpc('get_profit_summary_v2', {
                p_start_date: startDate.toISOString(),
                p_end_date: endDate.toISOString(),
                p_prev_start_date: prevStartDate.toISOString(),
                p_prev_end_date: prevEndDate.toISOString(),
                p_product_types: productTypes && productTypes.length > 0 ? productTypes : null,
                p_network: networkFilter,
            }),
            db.rpc('get_profit_timeseries_v2', {
                p_start_date: startDate.toISOString(),
                p_end_date: endDate.toISOString(),
                p_product_types: productTypes && productTypes.length > 0 ? productTypes : null,
                p_network: networkFilter,
            }),
            db.rpc('get_shop_owner_stats'),
            db.rpc('get_wallet_overview_v2'),
        ])

        if (summaryError) console.error('[ProfitAnalyticsV2] Summary Error:', summaryError)
        if (timeseriesError) console.error('[ProfitAnalyticsV2] Timeseries Error:', timeseriesError)
        if (shopOwnersError) console.error('[ProfitAnalyticsV2] Shop Owners Error:', shopOwnersError)
        if (walletError) console.error('[ProfitAnalyticsV2] Wallet Error:', walletError)

        if (summaryError || timeseriesError || shopOwnersError || walletError) {
            throw new Error('Failed to compute analytics from database')
        }

        return NextResponse.json({
            ...summaryData,
            charts_data: { daily: timeseriesData || [] },
            shop_owner_stats: shopOwnersData || [],
            wallet_stats: walletData || {
                total_user_balance: 0, user_count: 0,
                total_shop_owner_balance: 0, shop_owner_count: 0,
                total_commission_balance: 0, commission_count: 0,
            },
        })
    } catch (error: any) {
        console.error('Profit Analytics V2 API Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
