// app/api/shop/afa/charge/status/route.ts
//
// Status/polling counterpart to app/api/shop/afa/charge/route.ts, mirroring
// app/api/shop/charge/status/route.ts's structure. afa_orders rows only ever
// exist AFTER a successful payment (lib/shop-afa-order-processor.ts creates
// them) — so any row found by paystack_reference means the guest paid, and
// none of its statuses ('pending' = paid & awaiting manual processing,
// 'processing', 'completed', 'cancelled') represents an unpaid charge.
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

export async function GET(request: NextRequest) {
    try {
        cleanup()
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
        if (!bump(ipLimitCache, ip, 60)) {
            return NextResponse.json({ paid: false, pending: true, status: 'pending' }, { status: 429 })
        }
        const { searchParams } = new URL(request.url)
        const reference = searchParams.get('ref') || searchParams.get('reference')
        if (!reference || !/^SHOPAFA-[A-Za-z0-9-]{1,90}$/.test(reference)) {
            return NextResponse.json({ error: 'Invalid reference' }, { status: 400 })
        }
        if (!bump(refLimitCache, reference, 60)) {
            return NextResponse.json({ paid: false, pending: true, status: 'pending' }, { status: 429 })
        }

        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any

        // 1. DB authoritative — if processShopAfaOrder already ran (webhook or prior
        // poll), trust it. The row's mere existence means payment succeeded.
        const { data: order } = await db
            .from('afa_orders')
            .select('id, status')
            .eq('paystack_reference', reference)
            .maybeSingle()
        if (order) {
            return NextResponse.json({ paid: true, fulfilled: true, status: 'success' })
        }

        // 2. Ask Paystack for the LIVE charge status. /charge/:reference reflects a
        // Mobile Money approval immediately, whereas transaction/verify has a
        // read-after-write lag for MoMo.
        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) return NextResponse.json({ paid: false, pending: true, status: 'pending' })
        const auth = { headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` } }

        const chargeRes = await fetch(`https://api.paystack.co/charge/${encodeURIComponent(reference)}`, auth)
        const chargeData = await chargeRes.json().catch(() => null)
        const chargeStatus: string = chargeData?.data?.status || ''

        // 3. Success → fulfill via the shared idempotent processor (creates the row).
        if (chargeStatus === 'success') {
            let metadata = chargeData?.data?.metadata
            let amount = chargeData?.data?.amount
            if (!metadata?.shop_id || !amount) {
                const vRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, auth)
                const vData = await vRes.json().catch(() => null)
                if (vData?.data) {
                    metadata = vData.data.metadata || metadata
                    amount = vData.data.amount ?? amount
                }
            }
            if (!metadata?.shop_id) {
                // Paystack confirms payment but we can't fulfil yet (metadata absent) — the
                // charge.success webhook will create the order. Acknowledge payment WITHOUT
                // claiming delivery so the UI shows "received, processing" not a false success.
                return NextResponse.json({ paid: true, fulfilled: false, status: 'pending_fulfillment' })
            }
            const { processShopAfaOrder } = await import('@/lib/shop-afa-order-processor')
            const result = await processShopAfaOrder(reference, metadata as any, amount || 0, metadata.shop_slug)
            if (result.success) return NextResponse.json({ paid: true, fulfilled: true, status: 'success' })
            if (result.error === 'Payment amount mismatch') {
                return NextResponse.json({ paid: false, terminal: true, status: 'failed', display_text: 'Amount mismatch' })
            }
            return NextResponse.json({ paid: false, pending: true, status: 'pending' })
        }

        // 4. Terminal decline.
        if (TERMINAL.has(chargeStatus)) {
            return NextResponse.json({ paid: false, terminal: true, status: chargeStatus })
        }
        // 5. Still in flight (pay_offline / pending / send_otp / ongoing / timeout / unknown).
        return NextResponse.json({ paid: false, pending: true, status: chargeStatus || 'pending' })
    } catch (error) {
        console.error('[Shop AFA ChargeStatus] Unhandled error:', error)
        return NextResponse.json({ paid: false, pending: true, status: 'pending' })
    }
}
