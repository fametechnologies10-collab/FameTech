import { cookies } from 'next/headers'
import { createRouteClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'
import { sendAdminNewComplaintAlert } from '@/lib/email-service'
import { z } from 'zod'
import { shortTextSchema, longTextSchema } from '@/lib/validation'

export async function POST(request: Request) {
    try {
        const body = await request.json()
        
        const complaintSchema = z.object({
            title: shortTextSchema,
            description: longTextSchema,
            order_id: z.string(),
            priority: z.string().optional()
        })

        const validation = complaintSchema.safeParse(body)
        if (!validation.success) {
            const errorDetails = validation.error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
            return NextResponse.json({ error: 'Invalid input', details: errorDetails }, { status: 400 })
        }

        const { order_id, title, description, priority = 'medium' } = validation.data

        const supabase = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json(
                { error: 'Unauthorized' },
                { status: 401 }
            )
        }

        const user = authUser

        // Validate order_id format and confirm the authenticated user OWNS this order
        // BEFORE accepting a complaint against it. Without this, a caller could file a
        // complaint referencing another user's order_id (cross-tenant forging) and the
        // admin alert below could echo that order's reference_code.
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        if (!UUID_RE.test(order_id)) {
            return NextResponse.json({ error: 'Invalid order_id' }, { status: 400 })
        }
        const { data: ownedOrder } = await supabase
            .from('orders')
            .select('reference_code')
            .eq('id', order_id)
            .eq('user_id', user.id)
            .maybeSingle()
        if (!ownedOrder) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 })
        }

        // Constrain priority to a known set (the DB column is otherwise free-text).
        const ALLOWED_PRIORITY = ['low', 'medium', 'high']
        const safePriority = ALLOWED_PRIORITY.includes(priority) ? priority : 'medium'

        // 1. Insert Complaint (ownership verified above)
        const { data: complaint, error: insertError } = await (supabase
            .from('complaints') as any)
            .insert({
                user_id: user.id,
                order_id,
                title,
                description,
                status: 'pending',
                priority: safePriority,
            })
            .select()
            .single()

        if (insertError) throw insertError

        // 2. User details for the admin email (order ref already fetched + ownership-checked above)
        const orderData = ownedOrder as { reference_code: string }
        const { data: userData } = await (supabase
            .from('users') as any)
            .select('email, first_name, last_name')
            .eq('id', user.id)
            .single()

        // 3. Send Email Alert to Admin
        if (orderData && userData) {
            try {
                await sendAdminNewComplaintAlert({
                    userEmail: userData.email,
                    userName: `${userData.first_name || ''} ${userData.last_name || ''}`.trim() || 'User',
                    orderRef: orderData.reference_code,
                    title,
                    description,
                    priority: safePriority
                })
            } catch (emailError) {
                console.error('Failed to send admin alert:', emailError)
                // Don't fail the request
            }
        }

        return NextResponse.json({ success: true, complaint })

    } catch (error: any) {
        console.error('Error submitting complaint:', error)
        return NextResponse.json(
            { error: error?.message || 'Failed to submit complaint' },
            { status: 500 }
        )
    }
}
