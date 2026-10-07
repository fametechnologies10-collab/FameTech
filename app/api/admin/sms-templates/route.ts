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

// ─── GET /api/admin/sms-templates — list all templates ───────────────────────
export async function GET() {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const supabase = createServerClient()
        const { data, error } = await (supabase as any)
            .from('sms_templates')
            .select('id, name, body, created_at, updated_at')
            .order('created_at', { ascending: true })

        if (error) throw error

        return NextResponse.json({ success: true, templates: data || [] })
    } catch (e: any) {
        console.error('[SMS Templates GET]', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}

// ─── POST /api/admin/sms-templates — create a new template ───────────────────
export async function POST(request: NextRequest) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const body = await request.json()
        const name: string = (body.name || '').trim()
        const bodyText: string = (body.body || '').trim()

        if (!name) return NextResponse.json({ error: 'Template name is required' }, { status: 400 })
        if (!bodyText) return NextResponse.json({ error: 'Template body is required' }, { status: 400 })
        if (name.length > 100) return NextResponse.json({ error: 'Name must be 100 chars or less' }, { status: 400 })
        if (bodyText.length > 480) return NextResponse.json({ error: 'Body must be 480 chars or less' }, { status: 400 })

        const supabase = createServerClient()
        const { data, error } = await (supabase as any)
            .from('sms_templates')
            .insert({ name, body: bodyText })
            .select()
            .single()

        if (error) throw error

        return NextResponse.json({ success: true, template: data }, { status: 201 })
    } catch (e: any) {
        console.error('[SMS Templates POST]', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}
