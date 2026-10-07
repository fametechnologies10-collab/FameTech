import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { adminLongTextSchema } from '@/lib/validation'
import { createServerClient } from '@/lib/supabase'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
        if (user?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

        const { data: complaints, error } = await supabase
            .from('results_checker_complaints')
            .select(`
                *,
                order:results_checker_orders (
                    id, reference_code, type_name, quantity, total_paid, status, created_at, customer_phone, customer_email,
                    inventory_ids
                ),
                user:users ( first_name, last_name, phone_number ),
                shop:shop_profiles ( shop_name )
            `)
            .order('created_at', { ascending: false })

        if (error) throw error

        return NextResponse.json({ complaints })
    } catch (error) {
        console.error('[Admin RC Complaints API] GET Error:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}

export async function PATCH(req: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
        if (user?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

        const { id, status, admin_note } = await req.json()

        if (!id) {
            return NextResponse.json({ error: 'Complaint ID is required' }, { status: 400 })
        }

        if (!UUID_REGEX.test(id)) {
            return NextResponse.json({ error: 'Invalid complaint ID format' }, { status: 400 })
        }

        if (status && !['open', 'resolved'].includes(status)) {
            return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
        }

        let noteValidation: any
        if (admin_note !== undefined) {
            noteValidation = adminLongTextSchema.safeParse(admin_note)
            if (!noteValidation.success) {
                const details = noteValidation.error.errors.map((e: any) => e.message)
                return NextResponse.json({ error: 'Invalid admin note', details }, { status: 400 })
            }
        }

        const updates: any = { updated_at: new Date().toISOString() }
        if (status) updates.status = status
        if (admin_note !== undefined) updates.admin_note = noteValidation.data
        if (status === 'resolved') updates.resolved_at = new Date().toISOString()

        const adminClient = createServerClient()
        const { data: complaint, error } = await (adminClient as any)
            .from('results_checker_complaints')
            .update(updates)
            .eq('id', id)
            .select()
            .single()

        if (error) throw error

        return NextResponse.json({ success: true, complaint })
    } catch (error) {
        console.error('[Admin RC Complaints API] PATCH Error:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
