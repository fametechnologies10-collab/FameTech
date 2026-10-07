import { NextRequest, NextResponse } from 'next/server'

const refLimitCache = new Map<string, { count: number; resetAt: number }>()
const ipLimitCache = new Map<string, { count: number; resetAt: number }>()
function bump(map: Map<string, { count: number; resetAt: number }>, key: string, limit: number): boolean {
    const now = Date.now()
    const e = map.get(key) || { count: 0, resetAt: now + 60_000 }
    if (e.resetAt < now) { e.count = 0; e.resetAt = now + 60_000 }
    e.count++; map.set(key, e)
    return e.count <= limit
}
function cleanup() {
    const now = Date.now()
    for (const [k, v] of refLimitCache.entries()) if (v.resetAt < now) refLimitCache.delete(k)
    for (const [k, v] of ipLimitCache.entries()) if (v.resetAt < now) ipLimitCache.delete(k)
}
// Genuine terminal declines. Everything else non-success is recoverable.
const TERMINAL = new Set(['failed', 'abandoned', 'reversed'])

/**
 * GET /api/shop/results-checker/charge/status?ref=RC-...
 *
 * Poll an in-app RC MoMo charge. DB-authoritative first (results_checker_orders),
 * then live Paystack /charge/:ref, fulfilling on success via the idempotent
 * processRCShopOrder. Mirrors /api/shop/charge/status for shop orders.
 */
export async function GET(request: NextRequest) {
    try {
        cleanup()
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
        if (!bump(ipLimitCache, ip, 60)) return NextResponse.json({ paid: false, pending: true, status: 'pending' }, { status: 429 })

        const { searchParams } = new URL(request.url)
        const reference = searchParams.get('ref') || searchParams.get('reference')
        if (!reference || !/^RC-[A-Za-z0-9-]{1,90}$/.test(reference)) return NextResponse.json({ error: 'Invalid reference' }, { status: 400 })
        if (!bump(refLimitCache, reference, 60)) return NextResponse.json({ paid: false, pending: true, status: 'pending' }, { status: 429 })

        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any

        // 1. DB authoritative — if the webhook or a prior poll already ran processRCShopOrder, trust it.
        //    fulfilled=true ONLY when vouchers are actually assigned (status='completed'). A paid-but-
        //    pending order (backorder / mid-fulfilment) is paid:true, fulfilled:false → the UI shows a
        //    "payment received, PINs being prepared" screen instead of revealing vouchers that don't exist.
        const { data: order } = await db
            .from('results_checker_orders')
            .select('id, status, payment_status')
            .eq('reference_code', reference)
            .maybeSingle()
        if (order && order.status === 'completed') return NextResponse.json({ paid: true, fulfilled: true, status: 'success' })
        if (order && order.status === 'failed') return NextResponse.json({ paid: false, terminal: true, status: 'failed' })
        if (order && order.payment_status === 'completed') return NextResponse.json({ paid: true, fulfilled: false, status: 'pending_fulfillment' })

        // 2. Live Paystack charge status — reflects a MoMo approval faster than transaction/verify.
        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) return NextResponse.json({ paid: false, pending: true, status: 'pending' })
        const auth = { headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` } }

        const chargeRes = await fetch(`https://api.paystack.co/charge/${encodeURIComponent(reference)}`, auth)
        const chargeData = await chargeRes.json().catch(() => null)
        const chargeStatus: string = chargeData?.data?.status || ''

        // 3. Success → fulfill via the shared idempotent processor (amount-verified + dedupe).
        if (chargeStatus === 'success') {
            let metadata = chargeData?.data?.metadata
            let amount = chargeData?.data?.amount
            // The charge endpoint may omit metadata; fall back to the transaction record.
            if (!metadata?.rc_order_id || !amount) {
                const vRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, auth)
                const vData = await vRes.json().catch(() => null)
                if (vData?.data) { metadata = vData.data.metadata || metadata; amount = vData.data.amount ?? amount }
            }
            const { processRCShopOrder } = await import('@/lib/results-checker-service')
            const result = await processRCShopOrder(reference, (metadata || {}) as any, amount || 0)
            if (result.error === 'AMOUNT_MISMATCH') return NextResponse.json({ paid: false, terminal: true, status: 'failed', display_text: 'Amount mismatch' })
            // Re-read the order to report fulfilment AUTHORITATIVELY. processRCShopOrder returns
            // success for BOTH a fulfilled order and a paid-but-backordered one, so trusting its
            // boolean would re-introduce the fail-open (UI revealing vouchers that aren't assigned).
            const { data: o2 } = await db
                .from('results_checker_orders')
                .select('status, payment_status')
                .eq('reference_code', reference)
                .maybeSingle()
            if (o2?.status === 'completed') return NextResponse.json({ paid: true, fulfilled: true, status: 'success' })
            if (o2?.payment_status === 'completed') return NextResponse.json({ paid: true, fulfilled: false, status: 'pending_fulfillment' })
            // Paystack says paid but no order row reflects it yet (e.g. missing metadata) — the
            // charge.success webhook will reconcile. Acknowledge payment WITHOUT claiming delivery.
            return NextResponse.json({ paid: true, fulfilled: false, status: 'pending_fulfillment' })
        }

        // 4. Terminal decline.
        if (TERMINAL.has(chargeStatus)) return NextResponse.json({ paid: false, terminal: true, status: chargeStatus })
        // 5. Still in flight (pay_offline / pending / send_otp / ongoing / timeout / unknown).
        return NextResponse.json({ paid: false, pending: true, status: chargeStatus || 'pending' })
    } catch (error) {
        console.error('[RC ChargeStatus] Unhandled error:', error)
        return NextResponse.json({ paid: false, pending: true, status: 'pending' })
    }
}
