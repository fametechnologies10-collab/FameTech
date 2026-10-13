import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { applyAdminAirtimeStatus } from '@/lib/airtime-fulfillment'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BATCH_SIZE = 200
const CONCURRENCY = 5

async function verifyAdmin(supabaseUserClient: any) {
    const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
    if (error || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    if (!['admin', 'sub-admin'].includes((user as any)?.role)) return null
    return { userId: authUser.id }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
    const n = parseInt(raw || '', 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
}

function uuidList(raw: unknown): string[] | null {
    if (!Array.isArray(raw)) return null
    if (!raw.every(id => typeof id === 'string' && UUID_RE.test(id))) return null
    return Array.from(new Set(raw as string[]))
}

// GET — list fulfillment batches
export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { searchParams } = new URL(request.url)
        const limit  = clampInt(searchParams.get('limit'), 30, 1, 200)
        const offset = clampInt(searchParams.get('offset'), 0, 0, 1_000_000)
        const status = searchParams.get('status')

        const supabase = createServerClient()
        let query = (supabase
            .from('airtime_fulfillment_batches') as any)
            .select(`*, created_by_user:users!airtime_fulfillment_batches_created_by_fkey(first_name, last_name)`, { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)

        if (status && status !== 'all') query = query.eq('status', status)

        const { data: batches, error, count } = await query
        if (error) {
            console.error('[Airtime Batches] GET query error:', error)
            return NextResponse.json({ error: 'Failed to load batches' }, { status: 500 })
        }

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

        const { batchName, fulfillmentService } = body || {}
        const orderIds = uuidList(body?.orderIds)
        if (!orderIds || orderIds.length === 0) {
            return NextResponse.json({ error: 'orderIds must be a non-empty array of order ids' }, { status: 400 })
        }
        if (orderIds.length > MAX_BATCH_SIZE) {
            return NextResponse.json({ error: `A batch can hold at most ${MAX_BATCH_SIZE} orders` }, { status: 400 })
        }
        for (const [label, v] of [['batchName', batchName], ['fulfillmentService', fulfillmentService]] as const) {
            if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 100)) {
                return NextResponse.json({ error: `${label} must be a string of at most 100 characters` }, { status: 400 })
            }
        }

        const supabase = createServerClient()
        const name = batchName || `Batch ${new Date().toLocaleString('en-GH', { timeZone: 'Africa/Accra' })}`

        // Claim first, record second: only orders that THIS update actually moved pending→processing
        // belong in the batch. Recording the requested ids instead let the auto-dispatcher (or another
        // admin) already hold some of them — completing the batch later then marked orders "completed"
        // that nobody on this batch had sent.
        const { data: claimed, error: claimError } = await (supabase.from('airtime_orders') as any)
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .in('id', orderIds)
            .eq('status', 'pending')
            .select('id')
        if (claimError) {
            console.error('[Airtime Batches] Claim error:', claimError)
            return NextResponse.json({ error: 'Failed to create batch' }, { status: 500 })
        }
        const claimedIds: string[] = (claimed || []).map((r: any) => r.id)
        if (claimedIds.length === 0) {
            return NextResponse.json({ error: 'None of the selected orders are pending any more' }, { status: 409 })
        }

        const { data: batch, error: createError } = await (supabase
            .from('airtime_fulfillment_batches') as any)
            .insert({
                created_by: admin.userId,
                batch_name: name,
                status: 'pending',
                order_ids: claimedIds,
                order_count: claimedIds.length,
                fulfillment_service: fulfillmentService || null,
            })
            .select()
            .single()

        if (createError) {
            console.error('[Airtime Batches] Create error:', createError)
            // Put the orders back so they are not stranded in 'processing' with no batch to resolve them.
            await (supabase.from('airtime_orders') as any)
                .update({ status: 'pending', updated_at: new Date().toISOString() })
                .in('id', claimedIds).eq('status', 'processing')
            return NextResponse.json({ error: 'Failed to create batch' }, { status: 500 })
        }

        return NextResponse.json({ success: true, batch, skipped: orderIds.length - claimedIds.length })
    } catch (err) {
        console.error('[Airtime Batches] POST error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// PATCH — resolve a batch: complete every order in it, except the ones named in failedOrderIds
export async function PATCH(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let body: any
        try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

        const { batchId, status, fulfillmentService, fulfillmentNote } = body || {}
        if (!batchId || !status) return NextResponse.json({ error: 'batchId and status required' }, { status: 400 })
        if (typeof batchId !== 'string' || !UUID_RE.test(batchId)) {
            return NextResponse.json({ error: 'Invalid batchId' }, { status: 400 })
        }
        if (!['processing', 'completed', 'failed', 'partial'].includes(status)) {
            return NextResponse.json({ error: 'Invalid batch status' }, { status: 400 })
        }
        for (const [label, v, max] of [['fulfillmentService', fulfillmentService, 100], ['fulfillmentNote', fulfillmentNote, 500]] as const) {
            if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > max)) {
                return NextResponse.json({ error: `${label} must be a string of at most ${max} characters` }, { status: 400 })
            }
        }

        const supabase = createServerClient()

        const { data: batch, error: fetchErr } = await (supabase
            .from('airtime_fulfillment_batches') as any)
            .select('*').eq('id', batchId).single()

        if (fetchErr || !batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
        // A resolved batch must not be replayed: re-running it would re-fire notifications/SMS and
        // overwrite whatever happened to those orders since.
        if (['completed', 'failed', 'partial'].includes(batch.status)) {
            return NextResponse.json({ error: `Batch is already ${batch.status}` }, { status: 409 })
        }

        const allOrderIds: string[] = batch.order_ids || []
        const failedIds = body?.failedOrderIds === undefined ? [] : uuidList(body.failedOrderIds)
        if (!failedIds) return NextResponse.json({ error: 'failedOrderIds must be an array of order ids' }, { status: 400 })
        // failedOrderIds used to be passed straight into `.in('id', …)` — any order id, in or out of
        // this batch, could be forced to 'failed'.
        const members = new Set(allOrderIds)
        if (failedIds.some(id => !members.has(id))) {
            return NextResponse.json({ error: 'failedOrderIds must all belong to this batch' }, { status: 400 })
        }
        const failedSet = new Set(failedIds)
        const succeededIds = allOrderIds.filter(id => !failedSet.has(id))

        const jobs: Array<{ id: string; to: 'completed' | 'failed' }> = [
            ...succeededIds.map(id => ({ id, to: 'completed' as const })),
            ...failedIds.map(id => ({ id, to: 'failed' as const })),
        ]

        let completedCount = 0
        let failedCount = 0
        const skipped: Array<{ orderId: string; reason: string }> = []

        for (let i = 0; i < jobs.length; i += CONCURRENCY) {
            const results = await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async job => ({
                job,
                result: await applyAdminAirtimeStatus(job.id, {
                    to: job.to,
                    adminUserId: admin.userId,
                    service: fulfillmentService || batch.fulfillment_service || null,
                    note: fulfillmentNote || (job.to === 'failed' ? 'Marked failed in fulfillment batch' : null),
                    onlyFrom: ['pending', 'processing'],
                }),
            })))
            for (const { job, result } of results) {
                if (!result.ok) { skipped.push({ orderId: job.id, reason: result.message }); continue }
                if (job.to === 'completed') completedCount++
                else failedCount++
            }
        }

        if (completedCount + failedCount === 0) {
            return NextResponse.json({ error: 'No order in this batch could be updated', skipped }, { status: 409 })
        }

        const resolvedStatus = failedCount === 0 ? 'completed'
            : completedCount === 0 ? 'failed'
            : 'partial'

        await (supabase.from('airtime_fulfillment_batches') as any)
            .update({
                status: resolvedStatus,
                completed_count: completedCount,
                failed_count: failedCount,
                updated_at: new Date().toISOString(),
            })
            .eq('id', batchId)
            .in('status', ['pending', 'processing'])

        return NextResponse.json({
            success: true,
            status: resolvedStatus,
            completedCount,
            failedCount,
            skipped,
        })
    } catch (err) {
        console.error('[Airtime Batches] PATCH error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
