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

// ─── PATCH /api/admin/sms-templates/[id] — update template ───────────────────
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const { id } = await params
        const body = await request.json()
        const name: string     = (body.name || '').trim()
        const bodyText: string = (body.body || '').trim()

        if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
        if (!bodyText) return NextResponse.json({ error: 'Body is required' }, { status: 400 })
        if (name.length > 100) return NextResponse.json({ error: 'Name max 100 chars' }, { status: 400 })
        if (bodyText.length > 480) return NextResponse.json({ error: 'Body max 480 chars' }, { status: 400 })

        const supabase = createServerClient()
        const { data, error } = await (supabase as any)
            .from('sms_templates')
            .update({ name, body: bodyText, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select()
            .single()

        if (error) throw error

        return NextResponse.json({ success: true, template: data })
    } catch (e: any) {
        console.error('[SMS Template PATCH]', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}

// ─── DELETE /api/admin/sms-templates/[id] ────────────────────────────────────
export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const { id } = await params
        const supabase = createServerClient()

        const { error } = await (supabase as any)
            .from('sms_templates')
            .delete()
            .eq('id', id)

        if (error) throw error

        return NextResponse.json({ success: true })
    } catch (e: any) {
        console.error('[SMS Template DELETE]', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}
