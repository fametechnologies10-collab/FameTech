import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { isUtilityBiller } from '@/lib/hubtel-utility/billers'
import { manualRefulfillUtility, manualStatusSyncUtility, manualRefundUtility } from '@/lib/utility-fulfillment'

/**
 * Admin Utilities — order list+stats (GET) and manual actions (PATCH).
 * Mirrors app/api/admin/airtime/orders/route.ts + app/api/admin/airtime/bulk/route.ts's
 * gating/client conventions (see the settings route in this same folder for the note on
 * why a local `verifyAdmin()` is used instead of `validateAdminAccess`).
 *
 * Response envelope for THIS file uses the project-standard `{ success, data | error }`
 * shape (per CLAUDE.md's API conventions and this task's brief, which explicitly spells
 * out `{ success, data | error }` for the PATCH actions) rather than airtime orders'
 * ad hoc `{orders,total,...}` / `{error}` shapes — applied consistently to GET too so
 * both methods in this file share one envelope.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const VALID_STATUS = ['pending', 'processing', 'completed', 'failed', 'refunded']
const VALID_SOURCE = ['dashboard', 'storefront', 'api', 'ussd', 'ussd_shop']
const VALID_PAYMENT = ['paid', 'unpaid']
const VALID_ACTIONS = ['refulfill', 'status_sync', 'refund']
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/

// All utility_orders columns EXCEPT `lookup_snapshot` (may contain Ghana Water session
// rows — never leaves the server). `fulfillment_metadata` IS included: this is the admin
// debugging surface and the detail-drawer's source for it (per this task's brief).
//
// users/shop_profiles are embedded (not previously fetched at all) so the admin orders
// list can show WHO placed an order — mirrors app/api/admin/fulfillment/route.ts's
// `users!orders_user_id_fkey(...)` pattern. utility_orders has no denormalized shop_name
// column of its own (unlike `orders`), so shop_profiles is a genuine join here, not a
// flat column — flattened back to `shop_name` server-side below so the frontend's Order
// type stays identical in shape to the fulfillment page's.
const ORDER_COLUMNS = [
    'id', 'user_id', 'shop_id', 'api_key_id', 'source', 'biller', 'account_number', 'account_name',
    'destination_phone', 'customer_email', 'amount', 'payment_method', 'payment_reference',
    'payment_status', 'status', 'reference_code', 'fulfillment_attempts', 'fulfillment_request_id',
    'commission_amount', 'partner_commission_amount', 'commission_credited_at',
    'fulfillment_metadata', 'created_at', 'updated_at',
    'users!utility_orders_user_id_fkey(first_name,last_name)',
    'shop_profiles!utility_orders_shop_id_fkey(shop_name)',
].join(', ')

async function verifyAdmin(supabaseUserClient: any): Promise<{ userId: string; role: string } | null> {
    const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
    if (error || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    const role = (user as any)?.role
    return ['admin', 'sub-admin'].includes(role) ? { userId: authUser.id, role } : null
}

interface OrderFilters {
    status: string | null
    biller: string | null
    source: string | null
    payment: string | null
    search: string | null
    from: string | null
    to: string | null
    includeAbandoned: boolean
}

function parseFilters(sp: URLSearchParams): OrderFilters {
    const statusRaw = sp.get('status')
    const billerRaw = sp.get('biller')
    const sourceRaw = sp.get('source')
    const paymentRaw = sp.get('payment')
    const searchRaw = sp.get('search')
    const fromRaw = sp.get('from')
    const toRaw = sp.get('to')
    return {
        status: statusRaw && VALID_STATUS.includes(statusRaw) ? statusRaw : null,
        biller: billerRaw && isUtilityBiller(billerRaw) ? billerRaw : null,
        source: sourceRaw && VALID_SOURCE.includes(sourceRaw) ? sourceRaw : null,
        payment: paymentRaw && VALID_PAYMENT.includes(paymentRaw) ? paymentRaw : null,
        search: searchRaw && searchRaw.trim().length > 0 ? searchRaw.trim().slice(0, 100) : null,
        from: fromRaw && ISO_DATE_RE.test(fromRaw) ? fromRaw : null,
        to: toRaw && ISO_DATE_RE.test(toRaw) ? toRaw : null,
        includeAbandoned: sp.get('include_abandoned') === 'true',
    }
}

function applyFilters(query: any, f: OrderFilters): any {
    let q = query
    if (f.status) q = q.eq('status', f.status)
    if (f.biller) q = q.eq('biller', f.biller)
    if (f.source) q = q.eq('source', f.source)
    if (f.payment) q = q.eq('payment_status', f.payment)
    // utility_orders rows are inserted BEFORE payment is confirmed (insert-before-init —
    // see lib/hubtel-checkout.ts), unlike `orders` (data/airtime), which is only ever
    // inserted from the webhook AFTER payment succeeds and so never has an unpaid row at
    // all. Without this, every abandoned/declined checkout permanently clutters the admin
    // feed as if it were a real order needing attention. Default view hides bare unpaid
    // rows; an explicit `payment` filter (incl. `payment=unpaid`) or `include_abandoned=true`
    // opts back in — refunded orders (payment_status='refunded') are never hidden by this,
    // only the untouched 'unpaid' abandoned-checkout state.
    if (!f.payment && !f.includeAbandoned) q = q.neq('payment_status', 'unpaid')
    if (f.from) q = q.gte('created_at', f.from)
    if (f.to) q = q.lte('created_at', f.to)
    if (f.search) {
        // Allowlist rather than denylist: only characters that can legitimately
        // appear in a reference code, account number, or account name survive —
        // everything else (including PostgREST .or()-syntax metacharacters like
        // `,()` and any wildcard/injection payload) is stripped outright, cheap
        // and does not change behavior for legitimate search terms.
        const safe = f.search.replace(/[^a-zA-Z0-9 +\-.@_]/g, '').slice(0, 100)
        if (safe.length > 0) {
            q = q.or(`reference_code.ilike.%${safe}%,account_number.ilike.%${safe}%,account_name.ilike.%${safe}%`)
        }
    }
    return q
}

// GET ?status=&biller=&source=&search=&from=&to=&limit=&offset= — order list + stats
// (same filtered window), computed in-route (no dedicated stats RPC exists for
// utility_orders, unlike airtime's admin_airtime_stats — per this task's brief, the
// simple in-route version is used here).
export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const supabase = createServerClient()
        const sp = request.nextUrl.searchParams
        const filters = parseFilters(sp)

        let limit = parseInt(sp.get('limit') || '25', 10)
        if (!Number.isFinite(limit) || limit <= 0) limit = 25
        limit = Math.min(limit, 100)
        let offset = parseInt(sp.get('offset') || '0', 10)
        if (!Number.isFinite(offset) || offset < 0) offset = 0

        let listQuery = (supabase as any).from('utility_orders')
            .select(ORDER_COLUMNS, { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)
        listQuery = applyFilters(listQuery, filters)

        const { data: orders, error: listError, count } = await listQuery
        if (listError) {
            console.error('[Admin Utilities] List error:', listError)
            return NextResponse.json({ success: false, error: listError.message }, { status: 500 })
        }

        // Flatten the shop_profiles join to a plain `shop_name` field (utility_orders has
        // no denormalized column of its own, unlike `orders` — see ORDER_COLUMNS' comment)
        // so the frontend's Order type matches the fulfillment page's shape exactly.
        const flatOrders = (orders || []).map((o: any) => {
            const { shop_profiles, ...rest } = o
            return { ...rest, shop_name: shop_profiles?.shop_name ?? null }
        })

        let statsQuery = (supabase as any).from('utility_orders')
            .select('status, amount, commission_amount, partner_commission_amount')
        statsQuery = applyFilters(statsQuery, filters)

        const { data: statsRows, error: statsError } = await statsQuery
        if (statsError) {
            console.error('[Admin Utilities] Stats error:', statsError)
            return NextResponse.json({ success: false, error: statsError.message }, { status: 500 })
        }

        const stats = {
            total_orders: statsRows?.length || 0,
            total_amount: 0,
            completed: 0,
            pending: 0,
            processing: 0,
            failed: 0,
            refunded: 0,
            total_commission: 0,
            total_partner_commission: 0,
        }
        for (const row of (statsRows || [])) {
            stats.total_amount += Number(row.amount) || 0
            stats.total_commission += Number(row.commission_amount) || 0
            stats.total_partner_commission += Number(row.partner_commission_amount) || 0
            switch (row.status) {
                case 'completed': stats.completed++; break
                case 'pending': stats.pending++; break
                case 'processing': stats.processing++; break
                case 'failed': stats.failed++; break
                case 'refunded': stats.refunded++; break
                default: break
            }
        }

        return NextResponse.json({
            success: true,
            data: { orders: flatOrders, stats, total: count || 0, limit, offset },
        })
    } catch (error) {
        console.error('[Admin Utilities] Unexpected GET error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// PATCH { action: 'refulfill' | 'status_sync' | 'refund', order_id: uuid } — manual
// money/state action on a single utility order. Calls ONLY the shipped manual tools
// from lib/utility-fulfillment.ts — never touches wallets/orders directly here.
export async function PATCH(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        let body: any
        try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 }) }

        const action = body?.action
        if (!VALID_ACTIONS.includes(action)) {
            return NextResponse.json({ success: false, error: "action must be 'refulfill', 'status_sync' or 'refund'" }, { status: 400 })
        }

        const orderId = body?.order_id
        if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) {
            return NextResponse.json({ success: false, error: 'order_id must be a valid UUID' }, { status: 400 })
        }

        // Refunds move money — strictly admin-only (sub-admin excluded), mirroring
        // app/api/admin/airtime/bulk/route.ts's identical restriction and comment.
        if (action === 'refund' && admin.role !== 'admin') {
            return NextResponse.json({ success: false, error: 'Forbidden — refunds are admin only' }, { status: 403 })
        }

        if (action === 'refulfill') {
            const r = await manualRefulfillUtility(orderId, admin.userId)
            return NextResponse.json(
                r.success ? { success: true, data: { action, order_id: orderId } } : { success: false, error: r.error },
                { status: r.success ? 200 : 409 },
            )
        }

        if (action === 'status_sync') {
            const r = await manualStatusSyncUtility(orderId, admin.userId)
            return NextResponse.json(
                r.success ? { success: true, data: { action, order_id: orderId, state: r.state } } : { success: false, error: r.error },
                { status: 200 }, // verdict/message in body — mirrors airtime's status-sync route
            )
        }

        // action === 'refund'. manualRefundUtility's contract is `.success` (never `.ok`) —
        // its `error` is already the friendly, RPC-derived reason (see the switch in
        // lib/utility-fulfillment.ts), passed through verbatim.
        const r = await manualRefundUtility(orderId, admin.userId)
        return NextResponse.json(
            r.success ? { success: true, data: { action, order_id: orderId, queued: r.queued === true } } : { success: false, error: r.error },
            { status: r.success ? 200 : 409 },
        )
    } catch (error) {
        console.error('[Admin Utilities] Unexpected PATCH error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
