import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { Redis } from '@upstash/redis'
import { isMomoLookupEligible, requiresNameResolution, resolveUtilityMomoPayerDetails, type UtilityOrderMomoRow } from '@/lib/utility-momo-resolver'
import { logAdminAction } from '@/lib/admin-audit'

// GET /api/admin/utility-orders/[id]/momo-details — admin-only payer MoMo
// lookup for utility_orders, mirroring app/api/admin/orders/[orderId]/momo-details
// for shop data orders (same auth/eligibility/audit/rate-limit shape). See
// lib/utility-momo-resolver.ts's header for why this is simpler than the shop
// version: the payer's number/network are already persisted at charge time,
// so only the name resolution step ever reaches an external provider.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null
const DAILY_LOOKUP_CAP = 60

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id: orderId } = await params
        if (!UUID_RE.test(orderId)) {
            return NextResponse.json({ success: false, error: 'Invalid order id' }, { status: 400 })
        }

        // 1. Admin auth check — same pattern as the shop-orders momo-details route.
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

        const { data: orderRow, error: orderErr } = await (admin as any)
            .from('utility_orders')
            .select('id, shop_id, user_id, status, amount, payer_momo_number, payer_momo_name, payer_momo_network, payer_momo_resolved_at')
            .eq('id', orderId)
            .maybeSingle()

        if (orderErr || !orderRow) {
            return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 })
        }

        // Accountable party for the audit trail: the shop owner for shop-attributed
        // orders (shop_id set — storefront/ussd_shop), else the buyer themselves for a
        // direct/dashboard/api order (user_id set). A guest USSD order with neither
        // falls through to the console-only fallback below, same as the shop route's
        // "could not resolve shop owner" branch — an audit gap must never be silent.
        let auditTargetUserId: string | null = null
        if (orderRow.shop_id) {
            const { data: shopProfile } = await (admin as any)
                .from('shop_profiles')
                .select('owner_id')
                .eq('id', orderRow.shop_id)
                .maybeSingle()
            auditTargetUserId = shopProfile?.owner_id ?? null
        } else if (orderRow.user_id) {
            auditTargetUserId = orderRow.user_id
        }

        console.info('[momo-details][admin-utility][audit]', JSON.stringify({
            adminId: authUser.id,
            orderId,
            auditTargetUserId,
            at: new Date().toISOString(),
        }))

        const typedRow: UtilityOrderMomoRow = orderRow as UtilityOrderMomoRow

        if (!isMomoLookupEligible(typedRow)) {
            if (auditTargetUserId) {
                logAdminAction(admin, {
                    adminId: authUser.id,
                    action: 'view_momo_details',
                    targetUserId: auditTargetUserId,
                    newValue: { order_id: orderId, outcome: 'ineligible' },
                })
            }
            return NextResponse.json({ success: false, error: 'Not eligible' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
        }

        // Only spend rate-limit quota when a lookup will actually reach the
        // name-resolution provider — a fully-cached row or a legacy order with no
        // captured payer costs the caller nothing extra to view again.
        if (requiresNameResolution(typedRow) && redis) {
            try {
                const capKey = `momo-details:admin-utility:${authUser.id}`
                const [count] = (await redis.pipeline().incr(capKey).expire(capKey, 86400).exec()) as [number, number]
                if (count > DAILY_LOOKUP_CAP) {
                    return NextResponse.json(
                        { success: false, error: 'Too many MoMo lookups today. Please try again tomorrow.' },
                        { status: 429, headers: { 'Cache-Control': 'no-store' } }
                    )
                }
            } catch (e) {
                console.error('[momo-details][admin-utility] rate limit check failed, proceeding:', e)
            }
        }

        const result = await resolveUtilityMomoPayerDetails(typedRow)

        if (auditTargetUserId) {
            logAdminAction(admin, {
                adminId: authUser.id,
                action: 'view_momo_details',
                targetUserId: auditTargetUserId,
                newValue: { order_id: orderId, outcome: result.ok ? 'disclosed' : 'unavailable' },
            })
        } else {
            console.error('[momo-details][admin-utility] could not resolve an audit target', { orderId })
        }

        if (!result.ok) {
            return NextResponse.json({ success: false, error: result.error }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
        }

        return NextResponse.json({ success: true, data: result.data }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error: any) {
        console.error('[momo-details][admin-utility API]', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
