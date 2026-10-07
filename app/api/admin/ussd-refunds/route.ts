import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// =============================================================================
// Admin USSD refund queue (P0-6)
//
// Under Option B we always tell Hubtel 'success' (no auto-refund), so failed-but-
// paid USSD orders land in public.ussd_refund_queue for the team to refund:
//   - GET  : list pending refunds
//   - POST : resolve one — MoMo = "mark refunded" (team paid out externally);
//            wallet = one-click credit-to-wallet (idempotent) + mark refunded.
// Admin/sub-admin only.
// =============================================================================

async function requireAdmin() {
    const supabaseUserClient = await createRouteClient()
    const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
    if (error || !authUser) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    const { data: adminUser } = await supabaseUserClient
        .from('users')
        .select('role')
        .eq('id', authUser.id)
        .single()
    const role = (adminUser as any)?.role
    if (role !== 'admin' && role !== 'sub_admin' && role !== 'sub-admin') {
        return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
    }
    return { authUser }
}

export async function GET() {
    const auth = await requireAdmin()
    if (auth.error) return auth.error

    const supabase = createServerClient() as any
    const { data, error } = await supabase
        .from('ussd_refund_queue')
        .select('id, session_id, mobile, service_type, amount, payment_method, hubtel_order_id, wallet_debit_reference, user_id, reason, status, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(500)

    if (error) {
        console.error('[USSD Refunds] list failed:', error)
        return NextResponse.json({ error: 'Failed to load refunds' }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: data ?? [] })
}

export async function POST(request: NextRequest) {
    const auth = await requireAdmin()
    if (auth.error) return auth.error

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
    const id: string | undefined = body?.id
    if (!id || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
        return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    }

    const supabase = createServerClient() as any

    // Load the pending row.
    const { data: row, error: rowError } = await supabase
        .from('ussd_refund_queue')
        .select('*')
        .eq('id', id)
        .maybeSingle()
    if (rowError) return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (row.status !== 'pending') {
        return NextResponse.json({ error: 'Already resolved', status: row.status }, { status: 409 })
    }

    const stamp = {
        refunded_by: auth.authUser!.id,
        refunded_at: new Date().toISOString(),
    }

    // ── MoMo: team refunds out-of-band; just record it. ───────────────────────
    if (row.payment_method === 'momo') {
        const { data: done, error: updErr } = await supabase
            .from('ussd_refund_queue')
            .update({ ...stamp, status: 'refunded', refund_reference: row.hubtel_order_id ?? null })
            .eq('id', id)
            .eq('status', 'pending')
            .select('id')
            .maybeSingle()
        if (updErr || !done) return NextResponse.json({ error: 'Already resolved' }, { status: 409 })
        return NextResponse.json({ success: true, method: 'momo' })
    }

    // ── Wallet: one-click credit-to-wallet via the atomic, idempotent RPC. ────
    if (row.payment_method === 'wallet') {
        if (!row.user_id) return NextResponse.json({ error: 'Wallet refund has no user_id' }, { status: 400 })
        const refundRef = `USSD-REFUND-WALLET-${row.session_id}`

        // Win the lock so the row can't be actioned twice and the UI clears. The
        // credit itself is idempotent inside refund_ussd_wallet (wallet row lock +
        // reference check + ledger insert + balance update in ONE transaction), so
        // double-click / concurrency / retry can never double-credit.
        const { data: locked, error: lockErr } = await supabase
            .from('ussd_refund_queue')
            .update({ ...stamp, status: 'refunded', refund_reference: refundRef })
            .eq('id', id)
            .eq('status', 'pending')
            .select('id')
            .maybeSingle()
        if (lockErr || !locked) return NextResponse.json({ error: 'Already resolved' }, { status: 409 })

        const { error: refundErr } = await supabase.rpc('refund_ussd_wallet', {
            p_user_id: row.user_id,
            p_amount: Number(row.amount),
            p_reference: refundRef,
            p_description: `USSD refund — ${row.service_type} (session ${row.session_id})`,
        })
        if (refundErr) {
            // Real failure (e.g. WALLET_NOT_FOUND). The RPC is atomic so nothing was
            // committed; revert the queue row so the team can retry safely (a later
            // retry credits exactly once thanks to the RPC's reference idempotency).
            await supabase.from('ussd_refund_queue')
                .update({ status: 'pending', refunded_by: null, refunded_at: null, refund_reference: null })
                .eq('id', id)
            console.error('[USSD Refunds] refund_ussd_wallet failed:', refundErr)
            return NextResponse.json({ error: 'Refund failed — retry' }, { status: 500 })
        }

        return NextResponse.json({ success: true, method: 'wallet' })
    }

    return NextResponse.json({ error: 'Unknown payment method' }, { status: 400 })
}
