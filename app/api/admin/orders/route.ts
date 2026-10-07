import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { cookies } from 'next/headers'
import { validateAdminAccess } from '@/lib/auth-utils'

export async function GET(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(true, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }
        const { supabase: supabaseUserClient, user: sessionUser } = authResult

        const { searchParams } = new URL(request.url)
        const available = searchParams.get('available') === 'true'
        const batchId = searchParams.get('batchId')
        const batchIds = searchParams.get('batchIds')
        const limit = parseInt(searchParams.get('limit') || '50')
        const offset = parseInt(searchParams.get('offset') || '0')

        // Service role client to bypass RLS
        const supabase = createServerClient()

        const SELECT = `
                *,
                users!orders_user_id_fkey (
                    first_name,
                    last_name,
                    email
                ),
                shop_orders (
                    cost_price,
                    admin_cost_at_time,
                    refund_method
                )
            `

        // Rebuild the base query each call so we can page over it (a query builder
        // is single-use once awaited).
        const buildQuery = (opts?: { count: 'exact' }) => {
            let q = supabase.from('orders').select(SELECT, opts)
            if (batchIds) {
                q = q.in('download_batch_id', batchIds.split(','))
            } else if (batchId) {
                q = q.eq('download_batch_id', batchId)
            } else if (available) {
                // Whitelist only genuine data-bundle orders. category='mtn_mashup' (Special MTN Mashup,
                // fulfilled on /admin/mtn-mashup) — and any future non-data category — is excluded here.
                q = q.is('download_batch_id', null).eq('status', 'pending').eq('category', 'data')
            }
            return q
        }

        // The "available" queue and batch-content reads must return EVERY matching
        // row (the admin downloads the whole set as Excel). Supabase caps a single
        // request at ~1000 rows, so page through the full result. Bounded/paginated
        // list views still use offset+limit.
        const fetchWholeSet = available || !!batchId || !!batchIds

        let orders: any[] = []
        let count = 0
        if (fetchWholeSet) {
            const PAGE = 1000
            const MAX_ROWS = 20000 // hard safety ceiling
            for (let from = 0; from < MAX_ROWS; from += PAGE) {
                const { data, error } = await buildQuery()
                    .order('created_at', { ascending: false })
                    .range(from, from + PAGE - 1)
                if (error) {
                    console.error('[AdminOrdersFetch] Error:', error)
                    throw error
                }
                orders.push(...(data || []))
                if (!data || data.length < PAGE) break
            }
            count = orders.length
        } else {
            const { data, count: c, error: fetchError } = await buildQuery({ count: 'exact' })
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1)
            if (fetchError) {
                console.error('[AdminOrdersFetch] Error:', fetchError)
                throw fetchError
            }
            orders = data || []
            count = c || 0
        }

        // We remove the expensive server-side O(N^2) loop that was matching packages to orders.
        // This significantly reduces Fluid Active CPU usage.
        
        // Robust Conditional Mapping for Admin True Costs
        const mappedOrders = (orders || []).map((order: any) => {
            const isShopOrder = order.shop_order_id && order.shop_orders
            
            const adminRevenue = isShopOrder 
                ? order.shop_orders.cost_price         // What the shop owner paid the admin
                : order.price                          // What the direct customer paid the admin

            const adminTrueCost = isShopOrder
                ? order.shop_orders.admin_cost_at_time // Admin's supplier cost for the shop order
                : order.cost_price_at_time             // Admin's supplier cost for the direct order

            return {
                ...order,
                original_shop_price: order.price,      // Retain original frontend price if needed
                price: adminRevenue,                   // Override so frontend uses this for Revenue / "Cost" displays
                cost_price: adminTrueCost              // Override so frontend uses this for Base Cost
            }
        })

        // Airtime & "Mashup Bundle" (airtime-style) orders get mirrored into the orders table by
        // shop-storefront purchases, but they are fulfilled on /admin/airtime — never via the data
        // Excel export. The mirror row carries no category/type marker, so identify it by the presence
        // of a matching airtime_orders row (joined on reference_code) and drop it from the queue.
        // Only the "available" tab is filtered; downloaded batches never contain airtime/mashup orders.
        let visibleOrders = mappedOrders
        if (available && mappedOrders.length > 0) {
            const refs = mappedOrders.map((o: any) => o.reference_code).filter(Boolean)
            if (refs.length > 0) {
                // Chunk the .in() lookup so a large pending queue (now uncapped) can't
                // blow past PostgREST's filter-length limits.
                const mirrorRefs = new Set<string>()
                const CHUNK = 500
                for (let i = 0; i < refs.length; i += CHUNK) {
                    const chunk = refs.slice(i, i + CHUNK)
                    const { data: airtimeMirrors, error: mirrorError } = await supabase
                        .from('airtime_orders')
                        .select('reference_code')
                        .in('reference_code', chunk)
                    if (mirrorError) {
                        // Fail closed: if we can't verify which rows are airtime/mashup mirrors, do NOT
                        // serve a partially-filtered list — that could re-expose airtime orders into the
                        // data queue and risk double-fulfillment. Surface a retryable error instead
                        // (the page auto-refreshes on focus/realtime, so this self-heals).
                        console.error('[AdminOrdersFetch] airtime mirror lookup error:', mirrorError)
                        return NextResponse.json(
                            { error: 'Could not verify order queue — please retry' },
                            { status: 500 }
                        )
                    }
                    for (const r of (airtimeMirrors || [])) mirrorRefs.add((r as any).reference_code)
                }
                visibleOrders = mappedOrders.filter((o: any) => !mirrorRefs.has(o.reference_code))
            }
        }

        return NextResponse.json({
            orders: visibleOrders,
            totalCount: available ? visibleOrders.length : (count || 0)
        })
    } catch (error: any) {
        console.error('Admin Orders Fetch Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
