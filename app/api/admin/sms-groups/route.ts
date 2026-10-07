import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// ─── Auth Helper ──────────────────────────────────────────────────────────────
async function requireAdmin() {
    const client = await createRouteClient()
    const { data: { user }, error } = await client.auth.getUser()
    if (error || !user) return { error: 'Unauthorized', status: 401 }
    const { data } = await client.from('users').select('role').eq('id', user.id).single()
    if (data?.role !== 'admin') return { error: 'Forbidden - Admin only', status: 403 }
    return { user }
}

// ─── GET /api/admin/sms-groups — list all groups with contact count ────────────
export async function GET() {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const supabase = createServerClient()
        const { data: groups, error } = await (supabase as any)
            .from('sms_groups')
            .select('id, name, description, created_at, sms_contacts(count)')
            .order('created_at', { ascending: false })

        if (error) throw error

        // Flatten the contact count
        const result = (groups || []).map((g: any) => ({
            id:           g.id,
            name:         g.name,
            description:  g.description,
            created_at:   g.created_at,
            contact_count: g.sms_contacts?.[0]?.count ?? 0,
        }))

        return NextResponse.json({ success: true, groups: result })
    } catch (e: any) {
        console.error('[SMS Groups GET]', e)
        return NextResponse.json({ error: e.message || 'Internal server error' }, { status: 500 })
    }
}

// ─── POST /api/admin/sms-groups — create a new group ─────────────────────────
export async function POST(request: NextRequest) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const body = await request.json()
        const name: string = (body.name || '').trim()
        const description: string = (body.description || '').trim()

        if (!name) return NextResponse.json({ error: 'Group name is required' }, { status: 400 })
        if (name.length > 80) return NextResponse.json({ error: 'Name must be 80 characters or less' }, { status: 400 })

        const supabase = createServerClient()
        const { data, error } = await (supabase as any)
            .from('sms_groups')
            .insert({ name, description })
            .select()
            .single()

        if (error) throw error

        return NextResponse.json({ success: true, group: data }, { status: 201 })
    } catch (e: any) {
        console.error('[SMS Groups POST]', e)
        return NextResponse.json({ error: e.message || 'Internal server error' }, { status: 500 })
    }
}
