import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'

// Service-role client — admin-RLS tables; guarded by explicit admin check below.
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
        .from('users').select('role, first_name').eq('id', authUser.id).single()
    const role = (userData as any)?.role
    if (role !== 'admin' && role !== 'sub-admin') return { ok: false as const, status: 403, error: 'Forbidden' }
    return { ok: true as const, authUser, adminName: (userData as any)?.first_name?.trim() || 'Admin' }
}

/**
 * POST /api/admin/number-registration/download
 * Bundle the current 'new' (unregistered) numbers into a submission batch:
 *   - creates a number_registration_batches row (idempotent via idempotencyKey)
 *   - flips those numbers 'new' → 'submitted', linked to the batch
 *   - returns the phone list so the client generates the .xlsx for the supplier
 *
 * Body: { idempotencyKey?: string, phones?: string[] }  (phones optional — omit to bundle ALL 'new')
 */
export async function POST(request: NextRequest) {
    const auth = await requireAdmin()
    if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

    try {
        const db = supabaseAdmin as any
        const body = await request.json().catch(() => ({}))
        const idempotencyKey: string | undefined = body?.idempotencyKey
        const requestedPhones: string[] | undefined = Array.isArray(body?.phones) ? body.phones : undefined

        if (idempotencyKey && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 128)) {
            return NextResponse.json({ success: false, error: 'Invalid idempotencyKey' }, { status: 400 })
        }

        // Idempotency: return the existing batch if this key was already used.
        if (idempotencyKey) {
            const { data: existing } = await db
                .from('number_registration_batches')
                .select('id, filename, number_count')
                .eq('idempotency_key', idempotencyKey)
                .maybeSingle()
            if (existing) {
                // Return the numbers already attached to that batch so re-download works.
                const { data: rows } = await db
                    .from('number_registrations')
                    .select('phone_number, network')
                    .eq('batch_id', (existing as any).id)
                    .order('phone_number', { ascending: true })
                return NextResponse.json({
                    success: true,
                    isDuplicate: true,
                    batchId: (existing as any).id,
                    filename: (existing as any).filename,
                    numbers: rows || [],
                })
            }
        }

        // Select the 'new' numbers to submit (optionally a specific subset).
        let query = db.from('number_registrations').select('id, phone_number, network').eq('status', 'new')
        if (requestedPhones && requestedPhones.length > 0) query = query.in('phone_number', requestedPhones)
        const { data: newRows, error: selErr } = await query.order('phone_number', { ascending: true }).limit(20000)
        if (selErr) throw selErr

        if (!newRows || newRows.length === 0) {
            return NextResponse.json({ success: false, error: 'No new numbers to submit' }, { status: 400 })
        }

        const ids = (newRows as any[]).map(r => r.id)
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
        const filename = `mtn-registration_${auth.adminName}_${timestamp}.xlsx`

        // 1. Create the batch.
        const { data: batch, error: batchErr } = await db
            .from('number_registration_batches')
            .insert({
                filename,
                network: 'MTN',
                number_count: newRows.length,
                idempotency_key: idempotencyKey ?? null,
                created_by: auth.authUser.id,
            })
            .select('id, filename')
            .single()
        if (batchErr) throw batchErr

        // 2. Attach the numbers + flip 'new' → 'submitted'. The status='new' guard
        //    makes this a no-op for any number another admin grabbed concurrently.
        // Chunked: a single .in('id', ids) inlines every UUID into the request
        // URL. Once the backlog grows into the thousands that URL exceeds
        // Supabase's gateway limit, which rejects it with a bare 400 "Bad
        // Request" before the query ever runs (root cause of the 2026-09-29
        // "Bad Request" report — worked fine at 1,000 ids, failed at 5,000+).
        const UPDATE_CHUNK_SIZE = 500
        for (let i = 0; i < ids.length; i += UPDATE_CHUNK_SIZE) {
            const chunk = ids.slice(i, i + UPDATE_CHUNK_SIZE)
            const { error: updErr } = await db
                .from('number_registrations')
                .update({ status: 'submitted', batch_id: (batch as any).id, submitted_at: new Date().toISOString() })
                .in('id', chunk)
                .eq('status', 'new')
            if (updErr) throw updErr
        }

        return NextResponse.json({
            success: true,
            batchId: (batch as any).id,
            filename: (batch as any).filename,
            numbers: (newRows as any[]).map(r => ({ phone_number: r.phone_number, network: r.network })),
        })
    } catch (error: any) {
        console.error('[NumberRegistration download] error:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal server error' }, { status: 500 })
    }
}
