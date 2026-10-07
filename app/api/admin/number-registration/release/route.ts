import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'

// Service-role client — the release/register RPCs are service_role-only (money-
// adjacent: they flip held orders back into the fulfillment pipeline). Guarded by
// an explicit admin role check on the caller's RLS session below.
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

async function requireAdmin() {
    const supabaseUserClient = await createRouteClient()
    const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
    if (error || !authUser) return { ok: false as const, status: 401, error: 'Unauthorized' }
    const { data: userData } = await supabaseUserClient
        .from('users').select('role').eq('id', authUser.id).single()
    const role = (userData as any)?.role
    if (role !== 'admin' && role !== 'sub-admin') return { ok: false as const, status: 403, error: 'Forbidden' }
    return { ok: true as const, authUser }
}

/**
 * POST /api/admin/number-registration/release
 * Two modes:
 *   { batchId }  — mark a submitted batch REGISTERED: its numbers → 'registered' and
 *                  all their still-'queued' orders → 'pending' (auto-fulfill picks them up).
 *   { phones: [] } — ad-hoc register specific numbers (supplier registered them outside a batch).
 *
 * CRITICAL: the underlying RPCs only flip orders whose status is currently 'queued'.
 * A queued order the customer already refunded is 'refunded' and is therefore NEVER
 * re-activated — the refund stands and it is never re-fulfilled.
 */
export async function POST(request: NextRequest) {
    const auth = await requireAdmin()
    if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

    try {
        const db = supabaseAdmin as any
        const body = await request.json().catch(() => ({}))
        const batchId: string | undefined = body?.batchId
        const phones: string[] | undefined = Array.isArray(body?.phones) ? body.phones : undefined

        if (batchId) {
            const { data, error } = await db.rpc('release_registration_batch', {
                p_batch_id: batchId,
                p_actor_id: auth.authUser.id,
            })
            if (error) throw error
            if (!(data as any)?.ok) {
                return NextResponse.json({ success: false, error: (data as any)?.error || 'Release failed' }, { status: 400 })
            }
            return NextResponse.json({ success: true, data })
        }

        if (phones && phones.length > 0) {
            if (phones.length > 5000) {
                return NextResponse.json({ success: false, error: 'Too many numbers in one request (max 5000)' }, { status: 400 })
            }
            if (phones.some((p: any) => typeof p !== 'string' || p.length > 20)) {
                return NextResponse.json({ success: false, error: 'Invalid phone entry' }, { status: 400 })
            }
            const { data, error } = await db.rpc('register_numbers_manual', {
                p_phones: phones,
                p_actor_id: auth.authUser.id,
            })
            if (error) throw error
            if (!(data as any)?.ok) {
                return NextResponse.json({ success: false, error: (data as any)?.error || 'Registration failed' }, { status: 400 })
            }
            return NextResponse.json({ success: true, data })
        }

        return NextResponse.json({ success: false, error: 'Provide batchId or phones[]' }, { status: 400 })
    } catch (error: any) {
        console.error('[NumberRegistration release] error:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal server error' }, { status: 500 })
    }
}
