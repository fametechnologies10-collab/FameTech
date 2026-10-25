import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createServerClient } from '@/lib/supabase'
import { checkBundleOrder, getBundleCatalog } from '@/lib/kingflexy-bundles-service'
import { finalizeBundle, type BundleOrderRow } from '@/lib/standard-bundles-finalize'
import { dispatchBundleFulfillment } from '@/lib/standard-bundles-fulfillment'
import { applyDiscount, decideAdminRefundGate, parseDiscountSetting } from '@/lib/standard-bundles-logic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PAGE_SIZE = 200
const MAX_METADATA_BYTES = 4 * 1024
const LOG = '[Admin StandardBundles]'
const CATALOG_NETWORKS = ['MTN', 'Telecel', 'AT'] as const
const STATUSES = ['pending', 'processing', 'completed', 'failed', 'refunded']
const NETWORKS = ['MTN', 'Telecel', 'AT', 'TelecelBroadband']

// Admin only. Sub-admins are intentionally excluded: this route can refund wallets and re-send orders.
// The role check runs (server-side) before any other work.
async function requireAdmin() {
    const access = await validateAdminAccess(false)
    if (access.error !== null) {
        return { admin: null, response: NextResponse.json({ success: false, error: access.error }, { status: access.status }) }
    }
    return { admin: { userId: access.user.id }, response: null }
}

function fail(error: string, status: number) {
    return NextResponse.json({ success: false, error }, { status })
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
    const n = parseInt(raw || '', 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
}

// Keep the admin list light: drop supplier raw payloads, and collapse anything still too big.
function trimMetadata(meta: unknown): Record<string, unknown> {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {}
    const m = { ...(meta as Record<string, any>) }
    if (m.kf_event && typeof m.kf_event === 'object') {
        const { raw: _raw, ...rest } = m.kf_event
        void _raw
        m.kf_event = rest
    }
    if (JSON.stringify(m).length > MAX_METADATA_BYTES) {
        return { truncated: true, exhausted_at: m.exhausted_at ?? null, last_dispatch: m.last_dispatch ?? null }
    }
    return m
}

async function readDiscount(supabase: any, network: string): Promise<number> {
    const { data } = await supabase.from('admin_settings').select('value').eq('key', `std_bundles_discount_${network.toLowerCase()}`).maybeSingle()
    return parseDiscountSetting(data?.value)
}

// GET: list orders, or `?catalog=MTN|Telecel|AT` for the live catalog preview.
export async function GET(request: NextRequest) {
    try {
        const { admin, response } = await requireAdmin()
        if (!admin) return response!

        const supabase = createServerClient() as any
        const { searchParams } = new URL(request.url)

        const catalog = searchParams.get('catalog')
        if (catalog) {
            const net = CATALOG_NETWORKS.find((n) => n === catalog)
            if (!net) return fail('Invalid network', 400)
            const [result, discount] = await Promise.all([getBundleCatalog(net), readDiscount(supabase, net)])
            if (!result.ok || !result.data) return fail('The bundle catalog is unavailable right now', 502)
            return NextResponse.json({
                success: true,
                data: {
                    network: net,
                    stale: result.stale,
                    enabled: result.data.enabled,
                    discountPct: discount,
                    bundles: result.data.bundles.map((b) => ({
                        value: b.value,
                        pack_id: b.pack_id,
                        size: b.size,
                        family_label: b.family_label,
                        catalogPrice: b.price,
                        customerPrice: applyDiscount(b.price, discount, b.pack_id ? 'special' : 'standard'),
                        kind: b.pack_id ? 'special' : 'standard',
                    })),
                    broadband: net === 'Telecel' ? result.data.broadband : null,
                },
            })
        }

        const status = searchParams.get('status')
        const network = searchParams.get('network')
        // Interpolated into a PostgREST `.or()` filter, where `,` `(` `)` start new conditions.
        const search = (searchParams.get('search') || '').replace(/[^A-Za-z0-9 _@.+-]/g, '').trim().slice(0, 40)
        const page = clampInt(searchParams.get('page'), 1, 1, 100000)
        const limit = clampInt(searchParams.get('limit'), 30, 1, MAX_PAGE_SIZE)
        const offset = (page - 1) * limit

        let query = supabase
            .from('standard_bundle_orders')
            .select(
                `id, reference_code, status, network, kind, bundle_label, beneficiary_phone, catalog_price, discount_pct,
                 total_paid, kf_order_ref, commission_amount, fulfillment_attempts, fulfillment_metadata, user_role, source,
                 created_at, updated_at, completed_at,
                 users!standard_bundle_orders_user_id_fkey(first_name, last_name, email, phone_number)`,
                { count: 'exact' },
            )
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)

        if (status && status !== 'all') {
            if (!STATUSES.includes(status)) return fail('Invalid status', 400)
            query = query.eq('status', status)
        }
        if (network && network !== 'all') {
            if (!NETWORKS.includes(network)) return fail('Invalid network', 400)
            query = query.eq('network', network)
        }
        if (search) query = query.or(`reference_code.ilike.%${search}%,beneficiary_phone.ilike.%${search}%`)

        const { data: orders, error, count } = await query
        if (error) {
            console.error(LOG, 'List error:', error.message)
            return fail('Failed to load orders', 500)
        }

        return NextResponse.json({
            success: true,
            data: {
                orders: (orders || []).map((o: any) => ({ ...o, fulfillment_metadata: trimMetadata(o.fulfillment_metadata) })),
                total: count || 0,
                page,
                limit,
                totalPages: Math.ceil((count || 0) / limit),
            },
        })
    } catch (error) {
        console.error(LOG, 'Unexpected GET error:', error instanceof Error ? error.message : error)
        return fail('Internal server error', 500)
    }
}

const SELECT_ORDER =
    'id, reference_code, user_id, network, kind, bundle_label, beneficiary_phone, total_paid, status, fulfillment_attempts, fulfillment_metadata, updated_at'

type Supplier = Awaited<ReturnType<typeof checkBundleOrder>>

async function markCompleted(supabase: any, order: any, supplier: Supplier) {
    return finalizeBundle(supabase, order as BundleOrderRow, { state: 'completed', commission: supplier.commission ?? null })
}

// POST: { orderId, action: 'sync' | 'retry' | 'refund' }
export async function POST(request: NextRequest) {
    try {
        const { admin, response } = await requireAdmin()
        if (!admin) return response!

        let body: any
        try { body = await request.json() } catch { return fail('Invalid body', 400) }
        const orderId = body?.orderId
        const action = body?.action
        if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) return fail('Invalid orderId', 400)
        if (action !== 'sync' && action !== 'retry' && action !== 'refund') return fail('Invalid action', 400)

        const supabase = createServerClient() as any
        const { data: order, error: loadErr } = await supabase
            .from('standard_bundle_orders')
            .select(SELECT_ORDER)
            .eq('id', orderId)
            .maybeSingle()
        if (loadErr) {
            console.error(LOG, 'Order load error:', loadErr.message)
            return fail('Failed to load the order', 500)
        }
        if (!order) return fail('Order not found', 404)

        // sync
        if (action === 'sync') {
            const supplier = await checkBundleOrder(order.reference_code)
            if (!supplier.configured) return fail('The supplier is not configured', 503)
            if (!supplier.httpOk) return fail("Can't reach the supplier right now. Try again shortly.", 502)
            if (!supplier.found) {
                return NextResponse.json({ success: true, data: { outcome: 'not_found', message: 'The supplier has no record of this order.' } })
            }
            if (supplier.state === 'completed') {
                const r = await markCompleted(supabase, order, supplier)
                return NextResponse.json({
                    success: true,
                    data: {
                        outcome: 'completed',
                        transitioned: r.transitioned,
                        message: r.transitioned
                            ? 'Supplier confirmed delivery. Order marked completed.'
                            : `Supplier reports delivery, but the order is already ${order.status}. No change made.`,
                    },
                })
            }
            if (supplier.state === 'failed') {
                const r = await finalizeBundle(supabase, order as BundleOrderRow, { state: 'failed', reason: supplier.reason })
                return NextResponse.json({
                    success: true,
                    data: {
                        outcome: 'failed',
                        transitioned: r.transitioned,
                        message: r.transitioned
                            ? 'Supplier reports the order failed. Order marked failed and the customer refund was attempted.'
                            : `Supplier reports failure, but the order is already ${order.status}. No change made.`,
                    },
                })
            }
            return NextResponse.json({
                success: true,
                data: { outcome: supplier.state, message: `Still ${supplier.state} at the supplier.` },
            })
        }

        // refund / retry: both need the supplier's verdict first
        if (action === 'refund') {
            if (order.status === 'refunded') {
                return NextResponse.json({ success: true, data: { refunded: false, message: 'This order was already refunded. Nothing to do.' } })
            }
            if (!['pending', 'processing', 'failed'].includes(order.status)) {
                return fail(`A ${order.status} order cannot be refunded`, 409)
            }
        } else if (order.status === 'failed') {
            // 'failed' means a refund is still owed; a re-dispatch here would race the refund (bundle AND refund).
            return fail('This order failed and is waiting for a refund. Use Refund instead.', 409)
        } else if (order.status !== 'pending') {
            return fail(order.status === 'refunded' ? 'A refunded order cannot be retried' : `A ${order.status} order cannot be retried`, 409)
        }

        const supplier = await checkBundleOrder(order.reference_code)
        const gate = decideAdminRefundGate({
            ...supplier,
            orderStatus: order.status,
            updatedAtMs: Date.parse(order.updated_at),
            fulfillmentAttempts: Number(order.fulfillment_attempts) || 0,
            nowMs: Date.now(),
        })
        if (gate === 'block_too_recent') {
            return fail('This order is too recent to verify with the supplier. Wait about 10 minutes, then sync and try again.', 409)
        }
        if (gate === 'block_unverifiable') return fail("Can't verify with the supplier right now. Try again.", 502)
        if (gate === 'mark_completed') {
            await markCompleted(supabase, order, supplier)
            return fail(
                action === 'refund' ? 'Already delivered. Marked completed, no refund.' : 'Already delivered. Marked completed, not re-sent.',
                409,
            )
        }
        if (gate === 'block_in_flight') return fail('In flight at the supplier. Wait or sync first.', 409)

        if (action === 'refund') {
            const { data: refund, error: rpcErr } = await supabase.rpc('refund_standard_bundle_wallet', {
                p_order_id: orderId,
                p_actor_id: admin.userId,
                p_expected_updated_at: order.updated_at,
            })
            if (rpcErr) {
                console.error(LOG, 'refund RPC error:', rpcErr.message, 'order:', orderId)
                return fail('The refund could not be completed. Please try again.', 500)
            }
            if (refund?.reason === 'changed') {
                return fail('The order changed while we were checking. Sync it and try again.', 409)
            }
            const refunded = refund?.refunded === true
            return NextResponse.json({
                success: true,
                data: {
                    refunded,
                    amount: refunded ? Number(refund?.amount) || 0 : 0,
                    message: refunded ? 'Customer refunded to their wallet.' : 'Nothing was refunded (already refunded or not refundable).',
                },
            })
        }

        // retry: guarded so only a pending order is reset, never a failed/refunded/processing one.
        const { exhausted_at: _exhausted, ...keep } = (order.fulfillment_metadata || {}) as Record<string, unknown>
        void _exhausted
        const now = new Date().toISOString()
        const { data: reset, error: resetErr } = await supabase
            .from('standard_bundle_orders')
            .update({
                status: 'pending',
                fulfillment_attempts: 0,
                fulfillment_metadata: { ...keep, admin_retry: { by: admin.userId, at: now } },
                updated_at: now,
            })
            .eq('id', orderId)
            .eq('status', 'pending')
            .select('id')
        if (resetErr) {
            console.error(LOG, 'retry reset error:', resetErr.message, 'order:', orderId)
            return fail('Failed to queue the retry', 500)
        }
        if (!reset || reset.length === 0) return fail('The order changed while retrying. Refresh and check its status.', 409)

        waitUntil(dispatchBundleFulfillment(orderId))
        return NextResponse.json({ success: true, data: { message: 'Retry queued. The order is being re-sent to the supplier.' } })
    } catch (error) {
        console.error(LOG, 'Unexpected POST error:', error instanceof Error ? error.message : error)
        return fail('Internal server error', 500)
    }
}
