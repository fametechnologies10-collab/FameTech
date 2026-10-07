import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { Redis } from '@upstash/redis'
import { isMomoLookupEligible, resolveMomoPayerDetails, requiresExternalLookup, type ShopOrderMomoRow } from '@/lib/momo-payer-resolver'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null
const DAILY_LOOKUP_CAP = 30

export async function GET(request: NextRequest, { params }: { params: Promise<{ shopOrderId: string }> }) {
  try {
    const { shopOrderId } = await params
    if (!UUID_RE.test(shopOrderId)) {
        return NextResponse.json({ success: false, error: 'Invalid order id' }, { status: 400 })
    }

    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    // RLS-scoped read — a shopOrderId that isn't visible to this caller under
    // RLS resolves to zero rows here. This is a first filter only, not the
    // security boundary: see the explicit ownership check right below for why.
    const { data: row, error } = await (supabase as any)
        .from('shop_orders')
        .select('id, shop_id, source, guest_phone, network, selling_price, paystack_reference, status, payer_momo_number, payer_momo_name, payer_momo_network, payer_momo_resolved_at')
        .eq('id', shopOrderId)
        .maybeSingle()

    if (error || !row) {
        return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 })
    }

    // Explicit ownership check — do NOT rely on RLS alone for this PII endpoint.
    // `shop_orders_select_combined` also grants ANY admin/sub-admin SELECT on
    // every shop's orders, and `shop_orders_parent_read` grants a parent/dealer
    // shop read access to a CHILD shop's orders. Both are legitimate for other
    // read paths, but left unchecked here they would turn this route into an
    // unaudited side door around app/api/admin/orders/[orderId]/momo-details —
    // an admin (or a parent shop) could call THIS route instead and receive the
    // same customer PII with no admin_audit_log row, defeating the audit
    // guarantee the whole feature is built around. Admins must always go
    // through the audited admin route. The 404 below is deliberately identical
    // (status + body) to the missing-row path above, so this endpoint never
    // confirms an order exists to anyone who isn't its owner.
    const admin = createServerClient()
    const { data: shopProfile } = await (admin as any)
        .from('shop_profiles')
        .select('owner_id')
        .eq('id', row.shop_id)
        .maybeSingle()

    if (!shopProfile || shopProfile.owner_id !== user.id) {
        return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 })
    }

    // Resolve the authoritative status the way the admin route (and the shop
    // order history page's effectiveStatus()) do: shop_orders.status only
    // tracks the ORIGINAL orders row and goes stale forever once a
    // refunded/failed order is retried — the retry creates a NEW orders row
    // (retry_of_order_id pointing back at the original) that is never re-linked
    // into shop_orders (see app/dashboard/shop/orders/page.tsx's retry-descendant
    // comment, ~L208-235). Without this, a since-delivered retry would keep
    // returning the payer's number/amount here forever, inviting a second
    // unowed refund. Falls back to shop_orders.status only when no mirror
    // `orders` row exists at all (voucher/RC-style shop_orders rows have none).
    // Uses the admin client deliberately: the RLS SELECT policy on `orders` is
    // `user_id = auth.uid()`, which a shop OWNER never satisfies for a
    // guest-placed order (the vast majority of shop orders), so the RLS client
    // would see nothing here. Ownership of the shop_orders row was already
    // established above, independent of RLS, so bypassing RLS for this
    // read-only linkage lookup is safe.
    let authoritativeStatus: string | null = row.status
    const { data: mirrorOrder } = await (admin as any)
        .from('orders')
        .select('id, status')
        .eq('shop_order_id', shopOrderId)
        .maybeSingle()

    if (mirrorOrder) {
        authoritativeStatus = mirrorOrder.status
        const { data: retryDescendants } = await (admin as any)
            .from('orders')
            .select('id, status, created_at')
            .eq('retry_of_order_id', mirrorOrder.id)
            .order('created_at', { ascending: false })
            .limit(1)
        if (retryDescendants && retryDescendants.length > 0) {
            authoritativeStatus = retryDescendants[0].status
        }
    }

    const typedRow: ShopOrderMomoRow = { ...(row as ShopOrderMomoRow), status: authoritativeStatus }

    // Attributable audit trail for the raw lookup attempt (mirrors
    // validate-account's masked audit log) — fires unconditionally, before the
    // eligibility gate, so any abuse pattern (including probing an ineligible
    // order) is traceable to a specific account even though this path isn't
    // logged to admin_audit_log (that table is admin-actions-on-others only).
    console.info('[momo-details][shop][audit]', JSON.stringify({
        userId: user.id,
        shopOrderId,
        at: new Date().toISOString(),
    }))

    if (!isMomoLookupEligible(typedRow)) {
        // A rejected probe must be traceable too, even though there's no DB
        // audit table for this owner-on-own-shop path — a distinct, low-noise
        // console line keeps gate rejections separate from the unconditional
        // attempt line above.
        console.info('[momo-details][shop][audit][rejected]', JSON.stringify({
            userId: user.id,
            shopOrderId,
            reason: 'ineligible_status',
            at: new Date().toISOString(),
        }))
        return NextResponse.json({ success: false, error: 'Not eligible' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
    }

    // Only rate-limit fresh external lookups — a cached row or a row that's
    // guaranteed to short-circuit to "unavailable" (no captured USSD payer, or
    // no paystack_reference to verify) never touches a provider, so it costs
    // the caller nothing extra to view again.
    // Best-effort: fails open on a Redis outage since this is an abuse
    // control, not a money gate (mirrors validate-account's A8 comment).
    if (requiresExternalLookup(typedRow) && redis) {
        try {
            const capKey = `momo-details:shop:${user.id}`
            const [count] = (await redis.pipeline().incr(capKey).expire(capKey, 86400).exec()) as [number, number]
            if (count > DAILY_LOOKUP_CAP) {
                return NextResponse.json(
                    { success: false, error: 'Too many MoMo lookups today. Please try again tomorrow.' },
                    { status: 429, headers: { 'Cache-Control': 'no-store' } }
                )
            }
        } catch (e) {
            console.error('[momo-details][shop] rate limit check failed, proceeding:', e)
        }
    }

    const result = await resolveMomoPayerDetails(typedRow)

    if (!result.ok) {
        return NextResponse.json({ success: false, error: result.error }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
    }

    return NextResponse.json({ success: true, data: result.data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error: any) {
    console.error('[momo-details][shop API]', error)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
