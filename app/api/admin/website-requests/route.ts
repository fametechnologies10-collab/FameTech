import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'

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

// GET /api/admin/website-requests?status=new&category=ecommerce
export async function GET(request: NextRequest) {
    const auth = await requireAdmin()
    if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const category = searchParams.get('category')

    const adminDb = createAdminClient() as any
    let query = adminDb
        .from('website_requests')
        .select('*, users:user_id(first_name, last_name, email)')
        .order('created_at', { ascending: false })

    if (status) query = query.eq('status', status)
    if (category) query = query.eq('category', category)

    const { data, error } = await query
    if (error) {
        console.error('[AdminWebsiteRequests] Error listing requests:', error)
        return NextResponse.json({ success: false, error: 'Failed to load requests' }, { status: 500 })
    }

    return NextResponse.json({ success: true, data: data ?? [] })
}
