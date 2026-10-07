import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { timingSafeEqual, createHmac } from 'crypto'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'

// GhData retired status-polling entirely (confirmed live: /orders?id= now returns
// "This status-polling endpoint has been disabled") — this webhook is the only way
// GhData order status reaches us. Registered at their Agent Portal → API Configuration
// → Webhooks, destination https://www.kingflexygh.com/api/webhooks/ghdata.

const GHDATA_WEBHOOK_SECRET = process.env.GHDATA_WEBHOOK_SECRET || ''

// Service-role client — webhooks run outside user sessions
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

// ─── Signature Verification ────────────────────────────────────────────────────
// GhData signs `${t}.${rawBody}` with HMAC-SHA256 and sends the result as
// X-EazyGH-Signature: t=<unix_seconds>,v1=<hex> — same scheme as Stripe. Mirrors
// GhData's own reference verifier exactly (their docs use Node's crypto.timingSafeEqual).
const MAX_SIGNATURE_AGE_SECONDS = 300 // 5 min replay window

function verifySignature(rawBody: string, signatureHeader: string): boolean {
    try {
        const parts: Record<string, string> = {}
        for (const kv of signatureHeader.split(',')) {
            const [k, v] = kv.split('=')
            if (k && v) parts[k] = v
        }
        const t = parts.t
        const v1 = parts.v1
        if (!t || !v1) return false

        const ageSeconds = Math.abs(Date.now() / 1000 - Number(t))
        if (!Number.isFinite(ageSeconds) || ageSeconds > MAX_SIGNATURE_AGE_SECONDS) return false

        const expected = createHmac('sha256', GHDATA_WEBHOOK_SECRET)
            .update(`${t}.${rawBody}`)
            .digest('hex')

        const expectedBuf = Buffer.from(expected)
        const providedBuf = Buffer.from(v1)
        return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)
    } catch {
        return false
    }
}

// ─── Event Mapping ──────────────────────────────────────────────────────────────
// Only two event types exist on GhData's side (confirmed via their docs): order.success
// and order.failed. There is no refund event, and this route deliberately issues no refund
// of its own either — see the NO AUTO-REFUND note in the failed branch below.
function mapEventType(type: string): 'completed' | 'failed' | null {
    if (type === 'order.success') return 'completed'
    if (type === 'order.failed') return 'failed'
    return null
}

export async function POST(request: NextRequest) {
    try {
        const rawBody = await request.text()

        // Fail CLOSED — never process a webhook without a configured secret.
        if (!GHDATA_WEBHOOK_SECRET) {
            console.error('[GhDataWebhook] Rejected: GHDATA_WEBHOOK_SECRET not configured')
            return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
        }

        const signatureHeader = request.headers.get('x-eazygh-signature') || ''
        if (!signatureHeader || !verifySignature(rawBody, signatureHeader)) {
            console.warn('[GhDataWebhook] Rejected: missing or invalid X-EazyGH-Signature')
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        let payload: any
        try {
            payload = JSON.parse(rawBody)
        } catch {
            // Signature already verified — GhData is the sender. An invalid JSON body is
            // unrecoverable on their side too; return 200 so GhData doesn't retry forever.
            console.warn('[GhDataWebhook] Signature valid but body is not JSON — acking to suppress retries')
            return NextResponse.json({ success: true })
        }

        const { type, data } = payload
        const ghdataOrderId: string | undefined = data?.id
        console.log(`[GhDataWebhook] Event: ${type} | GhData order: ${ghdataOrderId}`)

        const newStatus = mapEventType(type)
        if (!newStatus || !ghdataOrderId) {
            // Unknown event type or malformed payload — acknowledge so GhData doesn't retry forever.
            return NextResponse.json({ success: true })
        }

        // Single atomic conditional update — no separate read-then-write step, so there's no
        // race window between checking eligibility and applying it. Scoped to pending/processing
        // so a duplicate/late webhook for an already-resolved order (completed/failed/refunded)
        // is a safe no-op, same pattern every other supplier sync route in this codebase uses.
        //
        // fulfillment_method='ghdata' is also required — without it, a late/delayed delivery
        // for an order that has SINCE been retried onto a different supplier (fulfillment_method
        // changed, but this ghdata_order_id column wasn't always cleared on revert — see
        // lib/refulfillment-service.ts / lib/fulfillment-trigger.ts) could still match this
        // order purely by ghdata_order_id and flip its status out from under the new supplier.
        // Mirrors the guard lib/agentportal-apply-outcome.ts already uses for AgentPortal.
        const { data: updatedRows, error: updateError } = await supabaseAdmin
            .from('orders')
            .update({ status: newStatus, updated_at: new Date().toISOString() })
            .eq('ghdata_order_id', ghdataOrderId)
            .eq('fulfillment_method', 'ghdata')
            .in('status', ['pending', 'processing'])
            .select('id')

        if (updateError) {
            console.error(`[GhDataWebhook] DB update failed for ghdata_order_id=${ghdataOrderId}:`, updateError.message)
            // Ack anyway — retrying a DB-level failure won't fix it, and GhData retries on non-2xx.
            return NextResponse.json({ success: true })
        }

        if (!updatedRows || updatedRows.length === 0) {
            console.log(`[GhDataWebhook] No matching pending/processing order for ghdata_order_id=${ghdataOrderId}`)
            return NextResponse.json({ success: true })
        }

        for (const row of updatedRows) {
            const internalOrderId: string = (row as any).id

            await syncShopOrderStatus(internalOrderId, newStatus).catch(err =>
                console.error(`[GhDataWebhook] syncShopOrderStatus failed for ${internalOrderId}:`, err)
            )

            // NO AUTO-REFUND. This used to call refund_order_wallet here, which credits
            // orders.price — the RETAIL/selling price — with no shop-order branch. On a shop
            // order the owner is only owed cost_price (the profit is already sitting in their
            // shop wallet, and out of the two they repay the guest the full selling price), so
            // refunding retail over-credited by exactly the profit: GHS 10.89 leaked across 6
            // orders, 5 of them from this very route, before it was caught. Shop-aware refund
            // routing lives in lib/refund-service.ts and is reached only from the admin refund
            // path. Per the owner's instruction, a supplier failure now alerts and nothing else
            // ("We should never auto refund for every supplier update, I will check and
            // manually refund those orders").
            if (newStatus === 'failed') {
                try {
                    const { sendAdminNewOrderAlert } = await import('@/lib/email-service')
                    const { data: orderRow } = await supabaseAdmin
                        .from('orders')
                        .select('reference_code, phone_number, network, size, price')
                        .eq('id', internalOrderId)
                        .maybeSingle()
                    const humanReference = (orderRow as any)?.reference_code || internalOrderId
                    // Dedup key distinct from the order's own reference_code, which other alert
                    // call sites for this same order already use.
                    await sendAdminNewOrderAlert({
                        referenceCode: `GHD-SUPPLIER-FAILED-${internalOrderId}`,
                        phoneNumber: (orderRow as any)?.phone_number || 'N/A',
                        network: (orderRow as any)?.network || 'unknown',
                        size: (orderRow as any)?.size || 'unknown',
                        price: (orderRow as any)?.price ?? 0,
                        customerName: 'N/A',
                        customerEmail: 'N/A',
                        source: 'main_site',
                        shopName: 'GhData',
                        reason: `⚠️ GhData reported order.failed for ${humanReference} (id ${internalOrderId}). Marked failed but NOT refunded — refund it from the admin orders page so the shop-aware path (cost price only) is used.`,
                    }).catch((e: any) => console.error(`[GhDataWebhook] Admin alert send failed for ${internalOrderId}:`, e))
                } catch (e) {
                    console.error(`[GhDataWebhook] Failed to raise supplier-failure alert for ${internalOrderId}:`, e)
                }
            }

            try {
                const { sendOrderCompletedPushNotification, sendOrderFailedPushNotification } = await import('@/lib/push-service')
                const sendPush = newStatus === 'completed' ? sendOrderCompletedPushNotification : sendOrderFailedPushNotification
                sendPush(internalOrderId).catch(e => console.error('[GhDataWebhook] Push error:', e))
            } catch (err) {
                console.error('[GhDataWebhook] Failed to import push service:', err)
            }

            // waitUntil so a lambda freeze right after this route's response cannot
            // drop the developer webhook — internalOrderId only reaches this loop
            // after the atomic update above's own CAS (.in('status', [pending,
            // processing]).select('id')) proved a real transition just happened.
            waitUntil(notifyDataOrderWebhook(
                supabaseAdmin, internalOrderId,
                newStatus === 'completed' ? 'order.completed' : 'order.failed',
            ))
        }

        return NextResponse.json({ success: true })

    } catch (error: any) {
        console.error('[GhDataWebhook] Unhandled exception:', error)
        // Return 200 to prevent GhData from endlessly retrying an unrecoverable error.
        return NextResponse.json({ success: true }, { status: 200 })
    }
}
