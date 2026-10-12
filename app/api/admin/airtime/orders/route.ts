import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { applyAdminAirtimeStatus } from '@/lib/airtime-fulfillment'
import { isAdminTargetStatus } from '@/lib/airtime-transitions'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PAGE_SIZE = 200
const MAX_METADATA_BYTES = 8 * 1024

async function verifyAdmin(supabaseUserClient: any) {
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    const role = (user as any)?.role
    if (!['admin', 'sub-admin'].includes(role)) return null
    return { userId: authUser.id, role }
}

/** parseInt that cannot return NaN / negatives / absurd sizes (used for page + page size). */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
    const n = parseInt(raw || '', 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
}

// GET — list all airtime orders (admin)
export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const supabase = createServerClient()
        const { searchParams } = new URL(request.url)
        const status  = searchParams.get('status')
        const network = searchParams.get('network')
        const type    = searchParams.get('type')   // 'airtime' | 'mashup'
        // The term is interpolated into a PostgREST `.or()` filter string, where `,` `(` `)` start
        // new conditions. Keep only characters a reference or phone number can contain.
        const search  = (searchParams.get('search') || '').replace(/[^A-Za-z0-9 _@.+-]/g, '').trim().slice(0, 40)
        const page    = clampInt(searchParams.get('page'), 1, 1, 100000)
        const limit   = clampInt(searchParams.get('limit'), 30, 1, MAX_PAGE_SIZE)
        const offset  = (page - 1) * limit

        let query = (supabase.from('airtime_orders') as any)
            .select(`
                *,
                users!airtime_orders_user_id_fkey(first_name, last_name, email, phone_number),
                fulfilled_by_user:users!airtime_orders_fulfilled_by_fkey(first_name, last_name)
            `, { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)

        if (status  && status  !== 'all') query = query.eq('status',  status)
        if (network && network !== 'all') query = query.eq('network', network)
        if (type    && type    !== 'all') query = query.eq('type',    type)
        if (search) {
            query = query.or(`reference_code.ilike.%${search}%,beneficiary_phone.ilike.%${search}%`)
        }

        const { data: orders, error, count } = await query

        if (error) {
            console.error('[Admin Airtime] List error:', error)
            return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 })
        }

        return NextResponse.json({
            orders: orders || [],
            total: count || 0,
            page,
            limit,
            totalPages: Math.ceil((count || 0) / limit)
        })
    } catch (error) {
        console.error('[Admin Airtime] Unexpected error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// PATCH — update order status (admin)
export async function PATCH(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let body: any
        try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

        const {
            orderId,
            status,
            fulfillmentNote,
            fulfillmentService,
            fulfillmentRequestId,
            fulfillmentMetadata,
        } = body || {}

        if (!orderId || !status) return NextResponse.json({ error: 'orderId and status are required' }, { status: 400 })
        if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) {
            return NextResponse.json({ error: 'Invalid orderId' }, { status: 400 })
        }
        if (!isAdminTargetStatus(status)) {
            return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
        }
        if (status === 'failed' && !fulfillmentNote) {
            return NextResponse.json({ error: 'A reason note is required when marking as failed' }, { status: 400 })
        }
        for (const [label, v, max] of [
            ['fulfillmentNote', fulfillmentNote, 500],
            ['fulfillmentService', fulfillmentService, 100],
            ['fulfillmentRequestId', fulfillmentRequestId, 200],
        ] as const) {
            if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > max)) {
                return NextResponse.json({ error: `${label} must be a string of at most ${max} characters` }, { status: 400 })
            }
        }
        if (fulfillmentMetadata !== undefined && fulfillmentMetadata !== null) {
            const isObject = typeof fulfillmentMetadata === 'object' && !Array.isArray(fulfillmentMetadata)
            if (!isObject || JSON.stringify(fulfillmentMetadata).length > MAX_METADATA_BYTES) {
                return NextResponse.json({ error: 'fulfillmentMetadata must be a small JSON object' }, { status: 400 })
            }
        }

        const result = await applyAdminAirtimeStatus(orderId, {
            to: status,
            adminUserId: admin.userId,
            note: fulfillmentNote || null,
            service: fulfillmentService || null,
            requestId: fulfillmentRequestId || null,
            metadata: fulfillmentMetadata || null,
        })

        if (!result.ok) {
            const httpStatus = result.code === 'not_found' ? 404 : result.code === 'conflict' ? 409 : 500
            return NextResponse.json({ error: result.message }, { status: httpStatus })
        }
        return NextResponse.json({ success: true, status: result.status })
    } catch (error) {
        console.error('[Admin Airtime] Unexpected PATCH error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
