import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

async function verifyAdmin(supabaseUserClient: any) {
    const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
    if (error || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    if (!['admin', 'sub-admin'].includes((user as any)?.role)) return null
    return { userId: authUser.id }
}

// GET — list fulfillment batches
export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { searchParams } = new URL(request.url)
        const limit  = parseInt(searchParams.get('limit')  || '30')
        const offset = parseInt(searchParams.get('offset') || '0')
        const status = searchParams.get('status')

        const supabase = createServerClient()
        let query = (supabase
            .from('airtime_fulfillment_batches') as any)
            .select(`*, created_by_user:users!airtime_fulfillment_batches_created_by_fkey(first_name, last_name)`, { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)

        if (status && status !== 'all') query = query.eq('status', status)

        const { data: batches, error, count } = await query
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        return NextResponse.json({ batches: batches || [], total: count || 0 })
    } catch (err) {
        console.error('[Airtime Batches] GET error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// POST — create a new batch from selected order IDs
export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let body: any
        try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

        const { orderIds, batchName, fulfillmentService } = body
        if (!Array.isArray(orderIds) || orderIds.length === 0) {
            return NextResponse.json({ error: 'orderIds array is required' }, { status: 400 })
        }

        const supabase = createServerClient()
        const name = batchName || `Batch ${new Date().toLocaleString('en-GH', { timeZone: 'Africa/Accra' })}`

        const { data: batch, error: createError } = await (supabase
            .from('airtime_fulfillment_batches') as any)
            .insert({
                created_by: admin.userId,
                batch_name: name,
                status: 'pending',
                order_ids: orderIds,
                order_count: orderIds.length,
                fulfillment_service: fulfillmentService || null,
            })
            .select()
            .single()

        if (createError) {
            console.error('[Airtime Batches] Create error:', createError)
            return NextResponse.json({ error: createError.message }, { status: 500 })
        }

        // Mark all included orders as 'processing'
        await (supabase.from('airtime_orders') as any)
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .in('id', orderIds)
            .eq('status', 'pending')

        return NextResponse.json({ success: true, batch })
    } catch (err) {
        console.error('[Airtime Batches] POST error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// PATCH — bulk update all orders in a batch to completed or failed
export async function PATCH(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let body: any
        try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

        const { batchId, status, failedOrderIds, fulfillmentService, fulfillmentNote } = body
        if (!batchId || !status) return NextResponse.json({ error: 'batchId and status required' }, { status: 400 })
        if (!['processing', 'completed', 'failed', 'partial'].includes(status)) {
            return NextResponse.json({ error: 'Invalid batch status' }, { status: 400 })
        }

        const supabase = createServerClient()

        const { data: batch, error: fetchErr } = await (supabase
            .from('airtime_fulfillment_batches') as any)
            .select('*').eq('id', batchId).single()

        if (fetchErr || !batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 })

        const allOrderIds: string[] = batch.order_ids || []
        const failedIds: string[]   = Array.isArray(failedOrderIds) ? failedOrderIds : []
        const succeededIds          = allOrderIds.filter((id: string) => !failedIds.includes(id))

        const now = new Date().toISOString()
        const updateBase: any = { fulfilled_by: admin.userId, fulfilled_at: now, updated_at: now }
        if (fulfillmentService) updateBase.fulfillment_service = fulfillmentService
        if (fulfillmentNote)    updateBase.fulfillment_note    = fulfillmentNote

        if (succeededIds.length > 0) {
            await (supabase.from('airtime_orders') as any)
                .update({ ...updateBase, status: 'completed' })
                .in('id', succeededIds)
        }
        if (failedIds.length > 0) {
            await (supabase.from('airtime_orders') as any)
                .update({ ...updateBase, status: 'failed' })
                .in('id', failedIds)
        }

        const resolvedStatus = failedIds.length === 0 ? 'completed'
            : succeededIds.length === 0 ? 'failed'
            : 'partial'

        await (supabase.from('airtime_fulfillment_batches') as any)
            .update({
                status: resolvedStatus,
                completed_count: succeededIds.length,
                failed_count: failedIds.length,
                updated_at: now,
            })
            .eq('id', batchId)

        return NextResponse.json({
            success: true,
            status: resolvedStatus,
            completedCount: succeededIds.length,
            failedCount: failedIds.length,
        })
    } catch (err) {
        console.error('[Airtime Batches] PATCH error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
