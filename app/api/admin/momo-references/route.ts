import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { createRouteClient } from '@/lib/supabase-server'

// ── Admin role verification (admin + sub-admin can read) ─────
async function verifyAdmin() {
    const supabaseRoute = await createRouteClient()
    const { data: { user } } = await supabaseRoute.auth.getUser()
    if (!user) return false

    const supabaseServer = createServerClient()
    const { data: userData } = await supabaseServer
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single()

    return ['admin', 'sub-admin'].includes((userData as any)?.role)
}

// ── Full admin role (admin only — can mutate) ─────────────────
async function verifyFullAdmin() {
    const supabaseRoute = await createRouteClient()
    const { data: { user } } = await supabaseRoute.auth.getUser()
    if (!user) return false

    const supabaseServer = createServerClient()
    const { data: userData } = await supabaseServer
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single()

    return (userData as any)?.role === 'admin'
}

// ── GET: List all user references with user details ──────────
export async function GET(request: NextRequest) {
    try {
        if (!(await verifyAdmin())) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabase = createServerClient()

        // Fetch all references joined with user name and phone
        const { data, error } = await (supabase
            .from('user_payment_references') as any)
            .select(`
                id,
                reference_code,
                is_active,
                created_at,
                updated_at,
                users:user_id (
                    id,
                    first_name,
                    last_name,
                    phone_number,
                    email,
                    role
                )
            `)
            .order('created_at', { ascending: false })

        if (error) {
            console.error('[AdminRefs GET] DB error:', error.message)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, references: data || [] })
    } catch (error: any) {
        console.error('[AdminRefs GET] Exception:', error.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// ── PATCH: Enable or disable a user reference ─────────────────
// Body: { id: string, is_active: boolean }
export async function PATCH(request: NextRequest) {
    try {
        if (!(await verifyFullAdmin())) {
            return NextResponse.json({ error: 'Only admins can modify references' }, { status: 403 })
        }

        const body = await request.json()
        const { id, is_active } = body

        if (!id || typeof is_active !== 'boolean') {
            return NextResponse.json({ error: 'Invalid parameters. Provide id and is_active (boolean).' }, { status: 400 })
        }

        const supabase = createServerClient()

        const { error } = await (supabase
            .from('user_payment_references') as any)
            .update({ is_active, updated_at: new Date().toISOString() })
            .eq('id', id)

        if (error) {
            console.error('[AdminRefs PATCH] DB error:', error.message)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        console.log(`[AdminRefs PATCH] Reference ${id} set is_active=${is_active}`)
        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('[AdminRefs PATCH] Exception:', error.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// ── DELETE: Permanently delete a user reference ───────────────
// Body: { id: string }
// This forces the user to generate a brand new code from their wallet page.
export async function DELETE(request: NextRequest) {
    try {
        if (!(await verifyFullAdmin())) {
            return NextResponse.json({ error: 'Only admins can delete references' }, { status: 403 })
        }

        const body = await request.json()
        const { id } = body

        if (!id) {
            return NextResponse.json({ error: 'Reference ID is required.' }, { status: 400 })
        }

        const supabase = createServerClient()

        const { error } = await (supabase
            .from('user_payment_references') as any)
            .delete()
            .eq('id', id)

        if (error) {
            console.error('[AdminRefs DELETE] DB error:', error.message)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        console.log(`[AdminRefs DELETE] Reference ${id} permanently deleted`)
        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('[AdminRefs DELETE] Exception:', error.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
