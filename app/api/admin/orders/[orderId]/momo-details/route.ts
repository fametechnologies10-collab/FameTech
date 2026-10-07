import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { Redis } from '@upstash/redis'
import { isMomoLookupEligible, resolveMomoPayerDetails, requiresExternalLookup, type ShopOrderMomoRow } from '@/lib/momo-payer-resolver'
import { logAdminAction } from '@/lib/admin-audit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null
const DAILY_LOOKUP_CAP = 60

export async function GET(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const { orderId } = await params
    if (!UUID_RE.test(orderId)) {
        return NextResponse.json({ success: false, error: 'Invalid order id' }, { status: 400 })
    }

    // 1. Admin auth check — same pattern as app/api/admin/assign-agent
    const supabaseUserClient = await createRouteClient()
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    const { data: adminData } = await supabaseUserClient.from('users').select('role').eq('id', authUser.id).single()
    if (adminData?.role !== 'admin') {
        return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }

    const admin = createServerClient()

    // 2. Resolve orders row -> shop_order_id, using the `orders` table's own
    //    status as the source of truth (mirrors effectiveStatus() used on the
    //    shop order history page — a retried order's mirror row is authoritative).
    const { data: ordersRow, error: ordersErr } = await (admin as any)
        .from('orders')
        .select('id, shop_order_id, status')
        .eq('id', orderId)
        .maybeSingle()

    if (ordersErr || !ordersRow) {
        return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 })
    }
    if (!ordersRow.shop_order_id) {
        return NextResponse.json({ success: false, error: 'Not a shop order' }, { status: 400 })
    }

    const { data: shopOrderRow, error: shopOrderErr } = await (admin as any)
        .from('shop_orders')
        .select('id, shop_id, source, guest_phone, network, selling_price, paystack_reference, status, payer_momo_number, payer_momo_name, payer_momo_network, payer_momo_resolved_at')
        .eq('id', ordersRow.shop_order_id)
        .maybeSingle()

    if (shopOrderErr || !shopOrderRow) {
        return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 })
    }

    // The audit row is keyed to the SHOP OWNER, not orders.user_id: shop orders
    // placed by guests (all USSD sales, and storefront guest checkouts) have
    // orders.user_id = NULL, and admin_audit_log.target_user_id is NOT NULL —
    // so keying on the buyer would make logAdminAction's insert fail silently
    // for the majority of exactly the orders this feature is for, leaving no
    // audit trail. The shop owner is also the accountable party for the
    // customer PII being disclosed. Verified: shop_profiles.owner_id is
    // non-null for every currently-eligible shop order.
    const { data: shopProfile } = await (admin as any)
        .from('shop_profiles')
        .select('owner_id')
        .eq('id', shopOrderRow.shop_id)
        .maybeSingle()

    // Attributable audit trail for the attempt itself — fires unconditionally,
    // BEFORE the eligibility gate and before resolving, so an admin's lookup is
    // traceable even when rejected as ineligible (probing ineligible orders is
    // exactly the kind of thing an audit log exists to catch — it used to leave
    // no trace at all when the 403 below fired first) or when the resolver
    // subsequently fails or throws. An audit gap must never be silent.
    console.info('[momo-details][admin][audit]', JSON.stringify({
        adminId: authUser.id,
        orderId,
        shopOwnerId: shopProfile?.owner_id ?? null,
        at: new Date().toISOString(),
    }))

    // orders.status is authoritative over shop_orders.status (see comment above).
    const typedRow: ShopOrderMomoRow = { ...(shopOrderRow as ShopOrderMomoRow), status: ordersRow.status }

    if (!isMomoLookupEligible(typedRow)) {
        // A rejected probe must be traceable too — same DB audit trail as a
        // successful/failed lookup, with a distinct outcome so it's never
        // confused with an actual disclosure.
        if (shopProfile?.owner_id) {
            logAdminAction(admin, {
                adminId: authUser.id,
                action: 'view_momo_details',
                targetUserId: shopProfile.owner_id,
                newValue: { order_id: orderId, shop_order_id: shopOrderRow.id, outcome: 'ineligible' },
            })
        }
        return NextResponse.json({ success: false, error: 'Not eligible' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
    }

    // Only spend rate-limit quota when a lookup will actually reach an external
    // provider — a cached row or a row that's guaranteed to short-circuit to
    // "unavailable" (no captured USSD payer, or no paystack_reference to verify)
    // costs the caller nothing extra to view again.
    if (requiresExternalLookup(typedRow) && redis) {
        try {
            const capKey = `momo-details:admin:${authUser.id}`
            const [count] = (await redis.pipeline().incr(capKey).expire(capKey, 86400).exec()) as [number, number]
            if (count > DAILY_LOOKUP_CAP) {
                return NextResponse.json(
                    { success: false, error: 'Too many MoMo lookups today. Please try again tomorrow.' },
                    { status: 429, headers: { 'Cache-Control': 'no-store' } }
                )
            }
        } catch (e) {
            console.error('[momo-details][admin] rate limit check failed, proceeding:', e)
        }
    }

    const result = await resolveMomoPayerDetails(typedRow)

    // Fire-and-forget DB audit — logged for every attempt, not only
    // successful disclosures, with an outcome discriminator so a row never
    // falsely implies a disclosure that didn't happen. Never blocks the
    // response. Keyed on shopProfile.owner_id (see note above); falls back
    // to a console.error when that can't be resolved so the gap is visible.
    if (shopProfile?.owner_id) {
        logAdminAction(admin, {
            adminId: authUser.id,
            action: 'view_momo_details',
            targetUserId: shopProfile.owner_id,
            newValue: { order_id: orderId, shop_order_id: shopOrderRow.id, outcome: result.ok ? 'disclosed' : 'unavailable' },
        })
    } else {
        console.error('[momo-details][admin] could not resolve shop owner for audit', { orderId })
    }

    if (!result.ok) {
        return NextResponse.json({ success: false, error: result.error }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
    }

    return NextResponse.json({ success: true, data: result.data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error: any) {
    console.error('[momo-details][admin API]', error)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
