import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { longTextSchema } from '@/lib/validation'
import { createServerClient } from '@/lib/supabase'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { orderId, description } = await req.json()

        if (!orderId || !description) {
            return NextResponse.json({ error: 'Order ID and description are required' }, { status: 400 })
        }

        // UUID format validation
        if (!UUID_REGEX.test(orderId)) {
            return NextResponse.json({ error: 'Invalid order ID format' }, { status: 400 })
        }

        // Description validation using existing schema
        const descValidation = longTextSchema.safeParse(description.trim())
        if (!descValidation.success) {
            const details = descValidation.error.errors.map(e => e.message)
            return NextResponse.json({ error: 'Invalid description', details }, { status: 400 })
        }

        const { data: order } = await supabase
            .from('results_checker_orders')
            .select('id, user_id, shop_id')
            .eq('id', orderId)
            .single()

        if (!order) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 })
        }

        if (order.user_id !== authUser.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
        }

        const shopId = order.shop_id || null

        // SECURITY (FINDING-3 FIX): Check for an existing ACTIVE complaint to prevent
        // duplicate filings. Uses NOT IN ('resolved','rejected') instead of = 'open'
        // so that any future intermediate status (e.g. 'in_review', 'escalated') is
        // automatically treated as active and blocks a duplicate complaint.
        // Deny-by-default: new statuses never silently allow duplicates.
        const { data: existingComplaint } = await supabase
            .from('results_checker_complaints')
            .select('id, status')
            .eq('order_id', orderId)
            .eq('user_id', authUser.id)
            .not('status', 'in', '("resolved","rejected")')
            .maybeSingle()

        if (existingComplaint) {
            return NextResponse.json({
                error: 'You already have an active complaint for this order. Please wait for our team to review it.',
            }, { status: 409 })
        }

        // Use service role client for the INSERT to bypass the missing INSERT RLS policy.
        // Auth & ownership validation above already ensures only legitimate users reach this point.
        const adminDb = createServerClient() as any
        const { data, error } = await adminDb
            .from('results_checker_complaints')
            .insert({
                order_id:    orderId,
                user_id:     authUser.id,
                shop_id:     shopId,
                description: descValidation.data,
                status:      'open',
            })
            .select()
            .single()

        if (error) {
            console.error('[RC Complaint API] DB Error:', error)
            return NextResponse.json({ error: 'Failed to file complaint' }, { status: 500 })
        }

        return NextResponse.json({ success: true, complaint: data })
    } catch (err) {
        console.error('[RC Complaint API] Error:', err)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
