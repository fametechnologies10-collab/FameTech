import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

async function requireAdmin() {
    const client = await createRouteClient()
    const { data: { user }, error } = await client.auth.getUser()
    if (error || !user) return { error: 'Unauthorized', status: 401 }
    const { data } = await client.from('users').select('role').eq('id', user.id).single()
    if (data?.role !== 'admin') return { error: 'Forbidden - Admin only', status: 403 }
    return { user }
}

// ─── GET /api/admin/sms-groups/[id] — get group with contacts ─────────────────
export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const { id } = await params
        const supabase = createServerClient()

        const { data: group, error: gErr } = await (supabase as any)
            .from('sms_groups')
            .select('id, name, description, created_at')
            .eq('id', id)
            .single()

        if (gErr || !group) return NextResponse.json({ error: 'Group not found' }, { status: 404 })

        const { data: contacts, error: cErr } = await (supabase as any)
            .from('sms_contacts')
            .select('id, first_name, last_name, phone_number, created_at')
            .eq('group_id', id)
            .order('created_at', { ascending: true })

        if (cErr) throw cErr

        return NextResponse.json({ success: true, group, contacts: contacts || [] })
    } catch (e: any) {
        console.error('[SMS Group GET]', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}

// ─── PATCH /api/admin/sms-groups/[id] — rename / edit group ──────────────────
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const { id } = await params
        const body = await request.json()
        const name: string = (body.name || '').trim()
        const description: string = (body.description ?? '').trim()

        if (!name) return NextResponse.json({ error: 'Group name is required' }, { status: 400 })
        if (name.length > 80) return NextResponse.json({ error: 'Name max 80 chars' }, { status: 400 })

        const supabase = createServerClient()
        const { data, error } = await (supabase as any)
            .from('sms_groups')
            .update({ name, description, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select()
            .single()

        if (error) throw error

        return NextResponse.json({ success: true, group: data })
    } catch (e: any) {
        console.error('[SMS Group PATCH]', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}

// ─── DELETE /api/admin/sms-groups/[id] — delete group + cascade contacts ─────
export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const { id } = await params
        const supabase = createServerClient()

        const { error } = await (supabase as any)
            .from('sms_groups')
            .delete()
            .eq('id', id)

        if (error) throw error

        return NextResponse.json({ success: true })
    } catch (e: any) {
        console.error('[SMS Group DELETE]', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}
