import { NextRequest, NextResponse } from 'next/server'
import { getClientIp } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { settleReceivePaid } from '@/lib/hubtel-receive/settle'

export const dynamic = 'force-dynamic'

const refLimitCache = new Map<string, { count: number; resetAt: number }>()
function bumpRef(reference: string, limit: number): boolean {
    const now = Date.now()
    const e = refLimitCache.get(reference) || { count: 0, resetAt: now + 60_000 }
    if (e.resetAt < now) { e.count = 0; e.resetAt = now + 60_000 }
    e.count++; refLimitCache.set(reference, e)
    return e.count <= limit
}
function cleanup() {
    const now = Date.now()
    for (const [k, v] of refLimitCache.entries()) if (v.resetAt < now) refLimitCache.delete(k)
}

// Genuine terminal declines on the Paystack branch. Everything else non-success is recoverable.
const TERMINAL = new Set(['failed', 'abandoned', 'reversed'])

/**
 * GET /api/shop/utility/charge/status?ref=UTIL-...  (Hubtel)  or  ?ref=UTLP-...  (Paystack)
 *
 * Poll a storefront utility charge — dual-rail, branched by reference prefix (the prefix
 * ITSELF encodes which provider handled the charge; no extra DB read needed to decide).
 * Response shape is flat ({ paid, fulfilled, status, terminal? }) to match
 * useChargePolling's contract (app/shop/[shopSlug]/components/useChargePolling.ts) — the
 * same shape every sibling status route (data/RC/AFA) already returns.
 *
 * UTIL- (Hubtel): delegates to settleReceivePaid (lib/hubtel-receive/settle.ts) — the single
 * convergence point every settle path (webhook callback, this poll, cron) funnels through,
 * so a charge is credited exactly once regardless of which caller wins the race.
 *
 * UTLP- (Paystack): mirrors app/api/shop/results-checker/charge/status/route.ts — DB-
 * authoritative first, else live Paystack /charge/:reference (faster than transaction/verify
 * for MoMo), then processUtilityShopOrder (lib/utility-fulfillment.ts) on a confirmed success.
 */
export async function GET(request: NextRequest) {
    try {
        cleanup()
        const ip = getClientIp(request) || 'unknown'
        const rl = consumeRateLimit(`util-sf-status:${ip}`, 30, 60_000)
        if (!rl.allowed) {
            return NextResponse.json({ paid: false, pending: true, status: 'pending' }, { status: 429 })
        }

        const { searchParams } = new URL(request.url)
        const reference = searchParams.get('ref') || searchParams.get('reference')
        if (!reference || !/^(UTIL|UTLP)-[A-Za-z0-9-]{1,90}$/.test(reference)) {
            return NextResponse.json({ error: 'Invalid reference' }, { status: 400 })
        }
        if (!bumpRef(reference, 60)) {
            return NextResponse.json({ paid: false, pending: true, status: 'pending' }, { status: 429 })
        }

        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any

        const { data: order, error: orderError } = await db
            .from('utility_orders')
            .select('id, status, payment_status')
            .eq('reference_code', reference)
            .maybeSingle()
        if (orderError || !order) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 })
        }

        // ── UTIL- (Hubtel Direct Receive Money) ─────────────────────────────────────
        if (reference.startsWith('UTIL-')) {
            if (order.payment_status === 'paid') {
                return NextResponse.json({ paid: true, status: order.status, fulfilled: order.status === 'completed' })
            }
            await settleReceivePaid(db, reference)
            const { data: refreshed } = await db
                .from('utility_orders')
                .select('status, payment_status')
                .eq('reference_code', reference)
                .maybeSingle()
            const status = refreshed?.status ?? order.status
            const paymentStatus = refreshed?.payment_status ?? order.payment_status
            return NextResponse.json({ paid: paymentStatus === 'paid', status, fulfilled: status === 'completed' })
        }

        // ── UTLP- (Paystack) ─────────────────────────────────────────────────────────
        // 1. DB-authoritative first — if a prior poll/webhook already settled this charge.
        if (order.payment_status === 'paid') {
            return NextResponse.json({ paid: true, fulfilled: order.status === 'completed', status: order.status === 'completed' ? 'success' : 'pending_fulfillment' })
        }
        if (order.status === 'failed') {
            return NextResponse.json({ paid: false, terminal: true, status: 'failed' })
        }

        // 2. Live Paystack charge status — reflects a MoMo approval faster than transaction/verify.
        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) return NextResponse.json({ paid: false, pending: true, status: 'pending' })
        const auth = { headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` } }

        const chargeRes = await fetch(`https://api.paystack.co/charge/${encodeURIComponent(reference)}`, auth)
        const chargeData = await chargeRes.json().catch(() => null)
        const chargeStatus: string = chargeData?.data?.status || ''

        // 3. Success → settle via the idempotent processor (amount-verified against the
        //    order's OWN stored price, never Paystack's metadata — see processUtilityShopOrder).
        if (chargeStatus === 'success') {
            const paidAmountKobo = chargeData?.data?.amount ?? 0
            const { processUtilityShopOrder } = await import('@/lib/utility-fulfillment')
            const result = await processUtilityShopOrder(reference, chargeData?.data?.metadata || {}, paidAmountKobo)
            if (result.error === 'AMOUNT_MISMATCH') {
                return NextResponse.json({ paid: false, terminal: true, status: 'failed', display_text: 'Amount mismatch' })
            }
            // Re-read the order to report AUTHORITATIVELY (never trust the processor's boolean —
            // a paid-but-not-yet-fulfilled order must show "received, delivery pending", not a
            // false success).
            const { data: o2 } = await db
                .from('utility_orders')
                .select('status, payment_status')
                .eq('reference_code', reference)
                .maybeSingle()
            if (o2?.status === 'completed') return NextResponse.json({ paid: true, fulfilled: true, status: 'success' })
            if (o2?.payment_status === 'paid') return NextResponse.json({ paid: true, fulfilled: false, status: 'pending_fulfillment' })
            // Paystack confirms payment but our own settle attempt didn't land yet (e.g. order not
            // found — should not happen since the charge route always inserts first) — acknowledge
            // payment without claiming delivery.
            return NextResponse.json({ paid: true, fulfilled: false, status: 'pending_fulfillment' })
        }

        // 4. Terminal decline.
        if (TERMINAL.has(chargeStatus)) {
            return NextResponse.json({ paid: false, terminal: true, status: chargeStatus })
        }
        // 5. Still in flight (pay_offline / pending / send_otp / ongoing / timeout / unknown).
        return NextResponse.json({ paid: false, pending: true, status: chargeStatus || 'pending' })
    } catch (error) {
        console.error('[Shop Utility Status] Unhandled error:', error)
        return NextResponse.json({ paid: false, pending: true, status: 'pending' })
    }
}
