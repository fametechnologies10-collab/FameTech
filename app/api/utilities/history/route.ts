import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { isUtilityBiller } from '@/lib/hubtel-utility/billers'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

// Duplicated from app/api/admin/utilities/route.ts's allowlists on purpose — this is a
// user-facing route and must not import from an admin route's internals (see this task's
// brief). Keep in sync by hand if the admin route's set of valid statuses/sources changes.
const VALID_STATUS = ['pending', 'processing', 'completed', 'failed', 'refunded']
const VALID_SOURCE = ['dashboard', 'storefront', 'api', 'ussd', 'ussd_shop']
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/

/**
 * GET /api/utilities/history — the dashboard's utility-bill order history.
 *
 * Uses the ROUTE client (RLS-scoped to the caller via utility_orders_owner_select) and an
 * EXPLICIT column allowlist — commission economics (commission_amount,
 * partner_commission_amount) and internal fulfillment/lookup blobs (fulfillment_metadata,
 * lookup_snapshot — which can carry provider raw rows) are never the buyer's business and
 * must never be selected here, even by a future '*' shortcut.
 *
 * Optional filters (?biller=&status=&source=&from=&to=) narrow this same RLS-scoped
 * (user_id = auth.uid()) window further — they never widen visibility beyond the
 * caller's own orders. `source` lets a user see their own orders placed from ANY
 * surface (dashboard, storefront, api, ussd, ussd_shop) in one place, including
 * API-purchased orders — there is no separate "API orders" tab.
 */
export async function GET(request: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const { searchParams } = new URL(request.url)
        const rawLimit = parseInt(searchParams.get('limit') || '', 10)
        const rawOffset = parseInt(searchParams.get('offset') || '', 10)
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT
        const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0

        const billerRaw = searchParams.get('biller')
        const statusRaw = searchParams.get('status')
        const sourceRaw = searchParams.get('source')
        const fromRaw = searchParams.get('from')
        const toRaw = searchParams.get('to')

        const biller = billerRaw && isUtilityBiller(billerRaw) ? billerRaw : null
        const status = statusRaw && VALID_STATUS.includes(statusRaw) ? statusRaw : null
        const source = sourceRaw && VALID_SOURCE.includes(sourceRaw) ? sourceRaw : null
        const from = fromRaw && ISO_DATE_RE.test(fromRaw) ? fromRaw : null
        const to = toRaw && ISO_DATE_RE.test(toRaw) ? toRaw : null

        let query = (supabase.from('utility_orders') as any)
            .select(
                'id, biller, account_number, account_name, amount, status, payment_status, payment_method, reference_code, created_at, updated_at',
                { count: 'exact' },
            )
            .eq('user_id', user.id)

        if (biller) query = query.eq('biller', biller)
        if (status) query = query.eq('status', status)
        if (source) query = query.eq('source', source)
        if (from) query = query.gte('created_at', from)
        if (to) query = query.lte('created_at', to)

        const { data: orders, error, count } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)

        if (error) {
            console.error('[Utilities History] Error:', error)
            return NextResponse.json({ success: false, error: 'Failed to load history' }, { status: 500 })
        }

        return NextResponse.json({ success: true, data: { orders: orders || [], total: count || 0 } })
    } catch (error) {
        console.error('[Utilities History] Unexpected error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
