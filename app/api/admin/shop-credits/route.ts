import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
    // ── Auth gate: admin only ───────────────────────────────────────────────
    const supa = await createRouteClient()
    const { data: { user } } = await supa.auth.getUser()
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const { data: dbUser } = await supa
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single()

    if (!dbUser || dbUser.role !== 'admin') {
        return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }

    // ── Query params ────────────────────────────────────────────────────────
    const url = new URL(req.url)
    const risk = url.searchParams.get('risk') || 'all'
    const shopOwnerId = url.searchParams.get('shopOwnerId') || 'all'
    const search = (url.searchParams.get('search') || '').trim()
    // Sanitize search — copy of the exact pattern used in app/api/admin/withdrawals/route.ts
    const safeSearch = search.replace(/[%_,().'";]/g, '').trim()
    const rawPage = parseInt(url.searchParams.get('page') || '1', 10)
    const rawPageSize = parseInt(url.searchParams.get('pageSize') || '25', 10)
    const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage)
    const pageSize = Math.min(100, Math.max(1, isNaN(rawPageSize) ? 25 : rawPageSize))
    const from = (page - 1) * pageSize

    // ── Input validation ────────────────────────────────────────────────────
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (shopOwnerId !== 'all' && !UUID_RE.test(shopOwnerId)) {
        return NextResponse.json({ success: false, error: 'Invalid shopOwnerId' }, { status: 400 })
    }

    const VALID_RISKS = ['all', 'green', 'amber', 'red']
    if (!VALID_RISKS.includes(risk)) {
        return NextResponse.json({ success: false, error: 'Invalid risk value' }, { status: 400 })
    }

    const db = createServerClient() as ReturnType<typeof createServerClient>

    // ── Query 1: paginated rows from the reconciliation VIEW ───────────────
    // Classification (risk_status, risk_reasons) is server-computed in the VIEW;
    // the route never classifies client-side.
    let q = (db as any)
        .from('v_shop_profit_credit_reconciliation')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1)

    if (risk !== 'all') q = q.eq('risk_status', risk)
    if (shopOwnerId !== 'all') q = q.eq('owner_id', shopOwnerId)
    if (safeSearch) {
        q = q.or(
            `shop_name.ilike.%${safeSearch}%,order_ref.ilike.%${safeSearch}%,guest_phone.ilike.%${safeSearch}%`
        )
    }

    const { data: rows, error, count } = await q
    if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    // ── Query 2: rollups via aggregate RPC ─────────────────────────────────
    // Rollups always reflect the full green/amber/red split for the given
    // owner scope (independent of the `risk` filter), computed server-side.
    const { data: rollupData, error: rollupErr } = await (db as any).rpc('get_shop_credit_rollups', {
        p_owner_id: shopOwnerId !== 'all' ? shopOwnerId : null,
    })
    if (rollupErr) console.error('[shop-credits] rollup RPC error:', rollupErr.message)
    const rollups = rollupData || { green_total: 0, amber_total: 0, red_total: 0, red_count: 0 }

    return NextResponse.json({
        success: true,
        data: {
            rows: rows || [],
            total: count ?? 0,
            rollups,
        },
    })
}
