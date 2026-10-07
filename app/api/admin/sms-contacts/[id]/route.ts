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

// ─── DELETE /api/admin/sms-contacts/[id] ─────────────────────────────────────
export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const { id } = await params
        const supabase = createServerClient()

        const { error } = await (supabase as any)
            .from('sms_contacts')
            .delete()
            .eq('id', id)

        if (error) throw error

        return NextResponse.json({ success: true })
    } catch (e: any) {
        console.error('[SMS Contact DELETE]', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}
