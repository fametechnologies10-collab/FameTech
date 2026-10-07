import { NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createServerClient } from '@/lib/supabase'

export async function GET() {
    const auth = await validateAdminAccess()
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

    const supabase = createServerClient()
    const { data, error } = await supabase
        .from('results_checker_inventory')
        .select('id, pin, serial_number, status, batch_id, created_at, type:results_checker_types(name)')
        .order('created_at', { ascending: false })
        .limit(100)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ inventory: data })
}

export async function DELETE(request: Request) {
    const auth = await validateAdminAccess()
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

    try {
        const { searchParams } = new URL(request.url)
        const id = searchParams.get('id')

        if (!id) {
            return NextResponse.json({ error: 'Inventory ID is required' }, { status: 400 })
        }

        const supabase = createServerClient()
        const db = supabase as any

        // Verify status before deleting (safety check)
        const { data: item } = await db
            .from('results_checker_inventory')
            .select('status')
            .eq('id', id)
            .single()

        if (!item) {
            return NextResponse.json({ error: 'Inventory item not found' }, { status: 404 })
        }

        if (item.status !== 'available' && item.status !== 'invalid') {
            return NextResponse.json({ error: `Cannot delete items with status: ${item.status}` }, { status: 400 })
        }

        const { error } = await db
            .from('results_checker_inventory')
            .delete()
            .eq('id', id)

        if (error) throw error

        return NextResponse.json({ success: true })
    } catch (err: any) {
        console.error('[RC Admin Inventory DELETE] Error:', err)
        return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 })
    }
}
