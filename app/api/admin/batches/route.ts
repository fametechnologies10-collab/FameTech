import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteClient } from '@/lib/supabase-server'

export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Check if user is admin
        const { data: userData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin' && userData?.role !== 'sub-admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const { searchParams } = new URL(request.url)
        const limit = parseInt(searchParams.get('limit') || '50')
        const offset = parseInt(searchParams.get('offset') || '0')
        const network = searchParams.get('network')
        const startDate = searchParams.get('startDate') // ISO string
        const endDate = searchParams.get('endDate') // ISO string
        const search = searchParams.get('search')

        // Service role client to bypass RLS
        const supabase = createServerClient()

        // Deep Search: If search term provided, find batches containing matching orders
        let batchIdsFromSearch: string[] = []
        if (search) {
            const { data: matchingOrders } = await supabase
                .from('orders')
                .select('download_batch_id')
                .or(`phone_number.ilike.%${search}%,reference_code.ilike.%${search}%`)
                .not('download_batch_id', 'is', null)
                .limit(100)

            if (matchingOrders && (matchingOrders as any[]).length > 0) {
                batchIdsFromSearch = [...new Set((matchingOrders as any[]).map((o: any) => o.download_batch_id as string))]
            } else {
                // If search yields no orders, return empty result immediately
                return NextResponse.json({ batches: [], totalCount: 0 })
            }
        }

        let query = supabase
            .from('download_batches')
            .select('*', { count: 'exact' })
            // Show batches with orders OR legacy rows whose order_count was never
            // backfilled (null) — previously these were silently hidden.
            .or('order_count.gt.0,order_count.is.null')

        if (batchIdsFromSearch.length > 0) {
            query = query.in('id', batchIdsFromSearch)
        }

        if (network && network !== 'all') {
            query = query.eq('network', network)
        }

        if (startDate) {
            query = query.gte('created_at', startDate)
        }
        if (endDate) {
            query = query.lte('created_at', endDate)
        }

        const { data: batches, count, error: fetchError } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)

        if (fetchError) {
            console.error('[AdminBatchesFetch] Error:', fetchError)
            throw fetchError
        }

        return NextResponse.json({
            batches: batches || [],
            totalCount: count || 0
        })
    } catch (error: any) {
        console.error('Admin Batches Fetch Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
