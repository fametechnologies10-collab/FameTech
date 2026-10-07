import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { isUtilityBiller } from '@/lib/hubtel-utility/billers'

const VALID_STATUS = ['pending', 'processing', 'completed', 'failed', 'refunded']

// GET /api/shop/utility-orders?status=&biller=&source=&from=&search=&limit=&offset=
// Server-side read of the caller's OWN shop's utility_orders — utility_orders carries no
// browser-readable RLS surface for shops (owner-only policy, and storefront orders have no
// user_id), so this route exists specifically to give the shop-orders page a working read
// path via the service-role client, scoped to the caller's shop_id resolved via the RLS
// client first. Mirrors app/api/shop/profit-logs/route.ts's auth/shop-resolution shape.
export async function GET(request: NextRequest) {
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
            return NextResponse.json({
                success: true,
                data: { orders: [], total: 0, stats: { total: 0, pending: 0, queued: 0, processing: 0, completed: 0, refunded: 0, revenue: 0, profit: 0 } },
            })
        }
        const shopId = (shopData as any).id

        const sp = request.nextUrl.searchParams
        const status = sp.get('status')
        const biller = sp.get('biller')
        const source = sp.get('source') // 'storefront' | 'ussd' | null
        const from = sp.get('from')
        const search = sp.get('search')
        let limit = parseInt(sp.get('limit') || '25', 10)
        if (!Number.isFinite(limit) || limit <= 0) limit = 25
        limit = Math.min(limit, 100)
        let offset = parseInt(sp.get('offset') || '0', 10)
        if (!Number.isFinite(offset) || offset < 0) offset = 0

        const admin = createServerClient() as any

        // Shared filter application — used identically for both the paginated list and
        // the stats aggregation, so stats always reflect exactly what the table shows
        // (fixes the "stats ignore filters" defect from the review).
        //
        // 'failed' rows where payment_status !== 'paid' are abandoned/incomplete checkout
        // attempts — no money ever moved, so they aren't a real order and showing a red
        // "Failed" badge for them just confuses shop owners relaying status to customers.
        // A genuine post-payment fulfillment failure (payment_status === 'paid') still
        // shows as 'failed' — that IS real and the shop owner needs to see it for refunds.
        // This filter is unconditional (not just the default view) so an explicit
        // ?status=failed query still only returns paid-but-failed orders, never unpaid ones.
        function applyFilters(q: any) {
            let query = q.eq('shop_id', shopId)
            if (status && VALID_STATUS.includes(status)) query = query.eq('status', status)
            if (biller && isUtilityBiller(biller)) query = query.eq('biller', biller)
            if (from) query = query.gte('created_at', from)
            if (search) {
                const safe = search.replace(/[^a-zA-Z0-9 +\-.@_]/g, '').slice(0, 100)
                if (safe) query = query.or(`account_number.ilike.%${safe}%,destination_phone.ilike.%${safe}%`)
            }
            if (source === 'storefront') query = query.eq('source', 'storefront')
            else if (source === 'ussd') query = query.in('source', ['ussd', 'ussd_shop'])
            query = query.or('payment_status.eq.paid,status.neq.failed')
            return query
        }

        const listQuery = applyFilters(
            admin.from('utility_orders')
                .select('id, biller, account_number, account_name, destination_phone, amount, status, payment_status, source, created_at, partner_commission_amount', { count: 'exact' })
        ).order('created_at', { ascending: false }).range(offset, offset + limit - 1)

        const { data: orders, error: listError, count } = await listQuery
        if (listError) {
            console.error('[Shop Utility Orders] list error:', listError)
            return NextResponse.json({ success: false, error: 'Failed to load utility orders' }, { status: 500 })
        }

        const statsQuery = applyFilters(
            admin.from('utility_orders').select('status, payment_status, amount, partner_commission_amount')
        )
        const { data: statsRows, error: statsError } = await statsQuery
        if (statsError) {
            console.error('[Shop Utility Orders] stats error:', statsError)
            return NextResponse.json({ success: false, error: 'Failed to load utility stats' }, { status: 500 })
        }

        const stats = { total: 0, pending: 0, queued: 0, processing: 0, completed: 0, refunded: 0, revenue: 0, profit: 0 }
        for (const r of (statsRows || [])) {
            stats.total++
            stats.revenue += Number(r.amount) || 0
            stats.profit += Number(r.partner_commission_amount) || 0
            switch (r.status) {
                case 'pending': stats.pending++; break
                case 'processing': stats.processing++; break
                case 'completed': stats.completed++; break
                case 'refunded': stats.refunded++; break
                default: break
            }
        }

        return NextResponse.json({ success: true, data: { orders: orders || [], total: count || 0, stats } })
    } catch (error) {
        console.error('[Shop Utility Orders] Unexpected error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
