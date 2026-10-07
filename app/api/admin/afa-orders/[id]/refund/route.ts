import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { buildAfaGuestRefundMessage } from '@/lib/sms-service'

// ============================================================================
// POST /api/admin/afa-orders/[id]/refund
//
// Three-way branch by payment rail (see docs/superpowers/specs/2026-09-04-
// admin-afa-orders-upgrade-design.md):
//   1. shop_id set              -> settle_afa_refund_to_owner (owner-wallet;
//                                   profit stays credited; guest SMS'd to
//                                   chase the seller)
//   2. no shop_id, wallet-paid  -> refund_afa_order_wallet (credit the
//                                   original applicant's own wallet)
//   3. no shop_id, momo-paid    -> unsupported; no rail to reverse a guest
//                                   USSD Hubtel MoMo payment exists in this
//                                   codebase. Returns a clear 400, not a
//                                   silent no-op.
//
// The mechanism is NEVER client-supplied — resolved here from the order's
// own shop_id/payment_method, same discipline as the orders/refund route's
// server-side idempotency and status checks.
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function verifyAdmin(supabaseUserClient: any) {
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    // Strictly 'admin' — matches orders/refund's strictness, stricter than the
    // afa-orders status route which also allows 'sub-admin'. Refunds move money.
    if ((user as any)?.role !== 'admin') return null
    return { userId: authUser.id }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params
        if (!UUID_RE.test(id)) {
            return NextResponse.json({ success: false, error: 'Invalid order id' }, { status: 400 })
        }

        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`admin-afa-refund:${admin.userId}`, 20, 60_000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many refund attempts. Please wait.' }, { status: 429 })
        }

        let body: any = {}
        try { body = await request.json() } catch { /* empty body is fine, all fields optional */ }
        const reason: string | undefined = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : undefined
        const confirmProcessing = body?.confirmProcessing === true

        const supabase = createServerClient()
        const { data: order, error: fetchError } = await (supabase.from('afa_orders') as any)
            .select('id, shop_id, user_id, guest_phone, status, payment_method')
            .eq('id', id)
            .maybeSingle()

        if (fetchError || !order) {
            return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 })
        }

        if (order.status === 'refunded') {
            return NextResponse.json({ success: true, data: { outcome: 'already_refunded', amount: 0, message: 'Already refunded' } })
        }
        if (order.status === 'processing' && !confirmProcessing) {
            return NextResponse.json(
                { success: false, error: 'needs_confirmation', message: 'This order is currently processing. Confirm to refund anyway.' },
                { status: 400 }
            )
        }
        if (!['pending', 'processing', 'completed'].includes(order.status)) {
            return NextResponse.json({ success: false, error: `Cannot refund an order with status "${order.status}"` }, { status: 400 })
        }

        // ── Branch 1: shop-linked ──────────────────────────────────────────
        if (order.shop_id) {
            const { data: result, error: rpcError } = await (supabase as any).rpc('settle_afa_refund_to_owner', {
                p_afa_order_id: id,
                p_actor_id: admin.userId,
                p_reason: reason ?? null,
            })
            if (rpcError || result?.ok === false) {
                const reason2 = rpcError?.message ?? result?.error
                console.error('[Admin AFA Refund] settle_afa_refund_to_owner failed:', reason2)
                await logRefundFailure(supabase, id, order.shop_id, reason2)
                return NextResponse.json({ success: false, error: 'Refund failed', detail: reason2 }, { status: 500 })
            }

            // Guest SMS — non-fatal to the refund itself (money already moved).
            if (order.guest_phone) {
                try {
                    const { data: shop } = await (supabase.from('shop_profiles') as any)
                        .select('owner_phone').eq('id', order.shop_id).maybeSingle()
                    if (shop?.owner_phone) {
                        const smsResult = await import('@/lib/sms-service').then(m =>
                            m.sendSMS({ recipient: order.guest_phone, message: buildAfaGuestRefundMessage({ ownerPhone: shop.owner_phone }) })
                        )
                        if (smsResult && smsResult.success === false) {
                            console.error('[Admin AFA Refund] Guest SMS not delivered (non-fatal):', smsResult.error)
                        }
                    }
                } catch (smsErr) {
                    console.error('[Admin AFA Refund] Guest SMS failed (non-fatal):', smsErr)
                }
            }

            return NextResponse.json({
                success: true,
                data: { outcome: result.already_refunded ? 'already_refunded' : 'refund_settled', amount: result.amount ?? 0, message: 'Refunded to shop owner' },
            })
        }

        // ── Branch 2/3: no shop — resolve by payment_method ─────────────────
        if ((order.payment_method ?? 'momo') !== 'wallet') {
            // Branch 3 — no rail exists to reverse this payment.
            return NextResponse.json(
                { success: false, error: 'not_refundable_rail', message: 'This was a guest MoMo payment with no wallet or Paystack transaction to reverse. Refund manually via Hubtel.' },
                { status: 400 }
            )
        }

        const { data: result, error: rpcError } = await (supabase as any).rpc('refund_afa_order_wallet', {
            p_afa_order_id: id,
            p_actor_id: admin.userId,
            p_reason: reason ?? null,
        })
        if (rpcError || result?.ok === false) {
            const reason2 = rpcError?.message ?? result?.error
            console.error('[Admin AFA Refund] refund_afa_order_wallet failed:', reason2)
            await logRefundFailure(supabase, id, null, reason2)
            return NextResponse.json({ success: false, error: 'Refund failed', detail: reason2 }, { status: 500 })
        }

        return NextResponse.json({
            success: true,
            data: { outcome: result.already_refunded ? 'already_refunded' : 'refunded', amount: result.amount ?? 0, message: 'Refunded to wallet' },
        })
    } catch (error) {
        console.error('[Admin AFA Refund] Unexpected error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

async function logRefundFailure(supabase: any, afaOrderId: string, shopId: string | null, message: string | undefined) {
    const { error } = await supabase.from('security_events').insert({
        event_type: 'afa_refund_failed',
        reference: afaOrderId,
        shop_id: shopId,
        order_type: 'afa',
        // No KYC — only the order id and the RPC's own message.
        detail: { order_id: afaOrderId, rpc_message: message ?? null },
    })
    if (error) console.error('[Admin AFA Refund] security_events insert failed:', error)
}
