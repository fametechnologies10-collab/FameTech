import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { adminUpdateSchema } from '@/lib/website-request-validation'

export const dynamic = 'force-dynamic'

async function requireAdmin() {
    const supabaseUserClient = await createRouteClient()
    const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
    if (error || !authUser) return { ok: false as const, status: 401, error: 'Unauthorized' }
    const { data: userData } = await supabaseUserClient
        .from('users').select('role').eq('id', authUser.id).single()
    const role = (userData as any)?.role
    if (role !== 'admin' && role !== 'sub-admin') return { ok: false as const, status: 403, error: 'Forbidden' }
    return { ok: true as const }
}

// PATCH /api/admin/website-requests/[id]
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await requireAdmin()
    if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

    const { id } = await params
    const body = await request.json().catch(() => null)
    const validation = adminUpdateSchema.safeParse(body)
    if (!validation.success) {
        const details = validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
        return NextResponse.json({ success: false, error: 'Invalid input', details }, { status: 400 })
    }
    const { status, closed_outcome, admin_notes } = validation.data

    const patch: Record<string, unknown> = {}
    if (status !== undefined) {
        patch.status = status
        if (status === 'contacted') patch.contacted_at = new Date().toISOString()
        if (status === 'closed') patch.closed_at = new Date().toISOString()
    }
    if (closed_outcome !== undefined) patch.closed_outcome = closed_outcome
    if (admin_notes !== undefined) patch.admin_notes = admin_notes.trim()

    const adminDb = createAdminClient() as any
    const { data, error } = await adminDb
        .from('website_requests')
        .update(patch)
        .eq('id', id)
        .select('*, users:user_id(first_name, last_name, email)')
        .single()

    if (error) {
        console.error('[AdminWebsiteRequests] Error updating request:', error)
        return NextResponse.json({ success: false, error: 'Failed to update request' }, { status: 500 })
    }

    return NextResponse.json({ success: true, data })
}
