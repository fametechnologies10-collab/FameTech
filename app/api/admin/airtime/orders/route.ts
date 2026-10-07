import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { sendAirtimeCompletedSMS, sendMashupCompletedSMS } from '@/lib/sms-service'
import { resolveOwnConfirmationSender } from '@/lib/sms-confirmation-sender'
import { syncAirtimeShopMirror } from '@/lib/airtime-fulfillment'

async function verifyAdmin(supabaseUserClient: any) {
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    const role = (user as any)?.role
    if (!['admin', 'sub-admin'].includes(role)) return null
    return { userId: authUser.id, role }
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
        const search  = searchParams.get('search')
        const page    = parseInt(searchParams.get('page')  || '1')
        const limit   = parseInt(searchParams.get('limit') || '30')
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
            return NextResponse.json({ error: error.message }, { status: 500 })
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

        const supabase = createServerClient()
        let body: any
        try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

        const {
            orderId,
            status,
            fulfillmentNote,
            fulfillmentService,
            fulfillmentRequestId,
            fulfillmentMetadata,
        } = body

        if (!orderId || !status) return NextResponse.json({ error: 'orderId and status are required' }, { status: 400 })
        if (!['processing', 'completed', 'failed'].includes(status)) {
            return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
        }
        if (status === 'failed' && !fulfillmentNote) {
            return NextResponse.json({ error: 'A reason note is required when marking as failed' }, { status: 400 })
        }

        // Fetch existing order
        const { data: existing, error: fetchError } = await (supabase.from('airtime_orders') as any)
            .select('*').eq('id', orderId).single()

        if (fetchError || !existing) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

        const updatePayload: any = {
            status,
            fulfilled_by: admin.userId,
            fulfilled_at: new Date().toISOString(),
            updated_at:   new Date().toISOString(),
        }
        if (fulfillmentNote)      updatePayload.fulfillment_note       = fulfillmentNote
        if (fulfillmentService)   updatePayload.fulfillment_service    = fulfillmentService
        if (fulfillmentRequestId) updatePayload.fulfillment_request_id = fulfillmentRequestId
        if (fulfillmentMetadata)  updatePayload.fulfillment_metadata   = fulfillmentMetadata

        const { error: updateError } = await (supabase.from('airtime_orders') as any)
            .update(updatePayload).eq('id', orderId)

        if (updateError) {
            console.error('[Admin Airtime] Update error:', updateError)
            return NextResponse.json({ error: updateError.message }, { status: 500 })
        }

        // SYNC: If this is a shop order, sync the status downward (shared with the other
        // airtime finalize paths — see lib/airtime-fulfillment.ts).
        await syncAirtimeShopMirror(supabase, existing.reference_code, status)

        // In-app notification
        const orderTypeLabel = existing.type === 'mashup' ? 'Mashup Bundle' : 'Airtime'
        ;(supabase.from('notifications') as any).insert({
            user_id: existing.user_id,
            title: status === 'completed' ? `${orderTypeLabel} Sent ✅` : `${orderTypeLabel} Order Failed`,
            message: status === 'completed'
                ? `GHS ${existing.airtime_amount.toFixed(2)} ${orderTypeLabel.toLowerCase()} for ${existing.beneficiary_phone} has been sent successfully. Ref: ${existing.reference_code}`
                : `Your ${orderTypeLabel.toLowerCase()} order ${existing.reference_code} could not be completed. Please contact support.`,
            type: 'order_update',
            action_url: '/dashboard/airtime',
        }).then(() => {}).catch((e: any) => console.error('[Admin Airtime] Notification error:', e))

        // Completed SMS
        if (status === 'completed') {
            const smsFn = existing.type === 'mashup' ? sendMashupCompletedSMS : sendAirtimeCompletedSMS
            // KFT SMS v2: resolve the order owner's OWN approved sender for THEIR OWN
            // completion confirmation. USSD and shop-customer confirmations stay on
            // the platform sender — out of scope here (resolution never throws).
            resolveOwnConfirmationSender(supabase, existing.user_id)
                .then((ownSender) =>
                    smsFn(existing.beneficiary_phone, { amount: existing.airtime_amount, sender: ownSender ?? undefined })
                )
                .catch((err: any) => console.error('[Admin Airtime] Completed SMS failed:', err))
        }

        return NextResponse.json({ success: true, status })
    } catch (error) {
        console.error('[Admin Airtime] Unexpected PATCH error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
