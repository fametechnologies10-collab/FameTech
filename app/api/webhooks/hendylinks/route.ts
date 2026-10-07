import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sanitizeForStorage } from '@/lib/sanitize-for-storage'
import { verifyHendyLinksSignature } from '@/lib/hendylinks-webhook-signature'
import { parseHendyLinksTimestamp } from '@/lib/hendylinks-service'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'

// HendyLinks signs the webhook payload with HMAC-SHA256 using the API token as the secret
// (per their docs' Node.js example: crypto.createHmac('sha256', 'YOUR_API_TOKEN')), sent as
// X-Webhook-Signature: sha256=<hex>. HENDYLINKS_WEBHOOK_SECRET is defined separately in case
// HendyLinks ever issues a distinct webhook secret, but falls back to the API key today.
// The comparison itself lives in lib/hendylinks-webhook-signature.ts so it can be unit-tested
// (a route.ts may only export handlers/route config).
const HENDYLINKS_WEBHOOK_SECRET = process.env.HENDYLINKS_WEBHOOK_SECRET || process.env.HENDYLINKS_API_KEY || ''

// How recent an unmatched event must be before we ask HendyLinks to redeliver rather than
// acking it away. Long enough to cover a slow dispatch-then-write, short enough that a
// genuinely stray delivery stops being retried quickly. See the "No order found" branch.
const RETRY_UNMATCHED_WINDOW_MS = 15 * 60 * 1000

export async function POST(request: NextRequest) {
    try {
        const rawBody = await request.text()

        // Fail CLOSED — never process a webhook without a configured secret.
        if (!HENDYLINKS_WEBHOOK_SECRET) {
            console.error('[HendyLinksWebhook] Rejected: HENDYLINKS_WEBHOOK_SECRET/HENDYLINKS_API_KEY not configured')
            return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
        }

        const signatureHeader = request.headers.get('x-webhook-signature') || ''
        if (!verifyHendyLinksSignature(rawBody, signatureHeader, HENDYLINKS_WEBHOOK_SECRET)) {
            console.warn('[HendyLinksWebhook] Rejected: missing or invalid X-Webhook-Signature')
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        let payload: any
        try {
            payload = JSON.parse(rawBody)
        } catch {
            console.warn('[HendyLinksWebhook] Signature valid but body is not JSON — acking to suppress retries')
            return NextResponse.json({ success: true })
        }

        if (payload.event !== 'order.status_changed' || !payload.order) {
            // Unknown event type or malformed payload — acknowledge so HendyLinks doesn't retry forever.
            return NextResponse.json({ success: true })
        }

        const hlOrderId = payload.order.id
        const newStatus = payload.order.status as string | undefined
        // HendyLinks explains WHY an order failed in order.message (their docs' sample shows
        // "Order processed successfully" on the happy path). We previously read only id+status
        // and discarded this, so a failed order showed up in our admin with a blank reason and
        // the only way to find out was to open HendyLinks' own dashboard — which is exactly
        // what happened on the first live failure (2026-08-20, orders 1633052/1633056).
        // Supplier-controlled string, so bounded/stripped like every other supplier value.
        const hlMessage = typeof payload.order.message === 'string' && payload.order.message.trim()
            ? sanitizeForStorage(payload.order.message, 500)
            : null
        if (hlOrderId === undefined || hlOrderId === null) {
            console.warn('[HendyLinksWebhook] Payload missing order.id — cannot resolve, acking to suppress retries')
            return NextResponse.json({ success: true })
        }
        const safeHlOrderId = sanitizeForStorage(String(hlOrderId), 200)

        const supabase = createServerClient()

        // Scoped to fulfillment_method='hendylinks' (mirrors lib/agentportal-apply-outcome.ts).
        // hendylinks_order_id is never cleared, so an order HendyLinks failed that an admin then
        // retried onto a DIFFERENT supplier still carries the stale id — without this gate a late
        // HendyLinks delivery would resolve it under the wrong supplier's outcome. Safe because
        // every path that writes hendylinks_order_id also stamps fulfillment_method='hendylinks'.
        //
        // Plain select, NOT .maybeSingle(): maybeSingle ERRORS when 2+ rows match, which this
        // handler mapped to a 500 — so a duplicate id made HendyLinks redeliver forever and
        // neither order ever resolved. Multiplicity is now handled explicitly below.
        const { data: matchingOrders, error: findError } = await (supabase
            .from('orders') as any)
            .select('id, status')
            .eq('hendylinks_order_id', String(hlOrderId))
            .eq('fulfillment_method', 'hendylinks')
            .limit(10)

        if (findError) {
            // A genuine transient DB error — still retryable, still a 500.
            console.error(`[HendyLinksWebhook] Order lookup failed for hendylinks_order_id=${safeHlOrderId}: ${findError.message} — returning 500 so HendyLinks redelivers`)
            return NextResponse.json({ error: 'Transient error — please retry' }, { status: 500 })
        }

        const orders = (matchingOrders || []) as Array<{ id: string; status: string }>

        if (orders.length === 0) {
            // Two very different situations look identical here:
            //   (a) a genuine stray — a test delivery, or an order since retried onto another
            //       supplier (its hendylinks_order_id was cleared). Nothing will ever match;
            //       acking is correct, and a 500 would make HendyLinks redeliver forever.
            //   (b) a RACE — HendyLinks fires this webhook within a second of accepting the
            //       order, which can beat our own write of hendylinks_order_id. Acking here
            //       discards the outcome permanently and strands the order in 'processing'.
            //       Measured live 2026-08-20: the webhook for order 1633587 arrived 44s before
            //       we stored its id (since narrowed by the early write in step 8b of
            //       lib/refulfillment-service.ts, but a slow DB write can still lose the race).
            //
            // The event's own timestamp separates them. A very recent event is far more likely
            // to be (b), so return 500 and let HendyLinks redeliver once the id has landed. An
            // older event is (a) — ack it and stop. Bounded, so neither case can loop forever.
            // payload.timestamp per their documented envelope ("timestamp": "2024-01-15T10:30:00Z").
            // parseHendyLinksTimestamp (not Date.parse) so a zone-less value is read as UTC
            // rather than against this process's timezone — same trap as their history rows.
            const eventMs = parseHendyLinksTimestamp(payload.timestamp)
            if (!Number.isFinite(eventMs)) {
                // Log rather than fail silently: without a usable timestamp this whole
                // redeliver-on-race branch can never engage, and the 44-second window it exists
                // to cover would go back to losing outcomes with nothing to show why.
                console.error(`[HendyLinksWebhook] Event for hendylinks_order_id=${safeHlOrderId} has no parseable 'timestamp' (got ${JSON.stringify(payload.timestamp)}) — cannot tell a race from a stray, so acking. If this recurs, the redeliver-on-race guard is effectively disabled.`)
            }
            const eventIsRecent = Number.isFinite(eventMs) && (Date.now() - eventMs) < RETRY_UNMATCHED_WINDOW_MS
            if (eventIsRecent) {
                console.warn(`[HendyLinksWebhook] No order found for hendylinks_order_id=${safeHlOrderId} YET, but the event is <${RETRY_UNMATCHED_WINDOW_MS / 60000}min old — likely racing our own id write. Returning 500 so HendyLinks redelivers.`)
                return NextResponse.json({ error: 'Order not yet resolvable — please retry' }, { status: 500 })
            }
            console.warn(`[HendyLinksWebhook] No order found for hendylinks_order_id=${safeHlOrderId} — acking (nothing to do; may be a stray/test delivery, or an order since retried onto another supplier)`)
            return NextResponse.json({ success: true })
        }

        if (orders.length > 1) {
            // Two local rows sharing one supplier id — we cannot know which order this outcome
            // belongs to, and applying it would force BOTH to one external order's result. Apply
            // NOTHING and ack 200: a 500 here would just make HendyLinks redeliver forever
            // without either order ever resolving. This needs a human.
            console.error(`[HendyLinksWebhook] DUPLICATE-SUPPLIER-ID: ${orders.length} orders share hendylinks_order_id=${safeHlOrderId} (${orders.map(o => o.id).join(', ')}) — cannot attribute this outcome to one of them. NO status applied, acking 200. MANUAL RECONCILIATION REQUIRED.`)
            return NextResponse.json({ success: true })
        }

        const order = orders[0]

        if (newStatus !== 'completed' && newStatus !== 'failed') {
            // 'pending', 'processing', or an unrecognized status — no-op, left for the next
            // delivery or the reconciliation sweep (app/api/cron/sync-hendylinks-status).
            return NextResponse.json({ success: true })
        }

        // Guarded UPDATE — only applies if still processing AND still attributed to HendyLinks,
        // avoiding a race with the claim/dispatch path or a duplicate webhook delivery
        // re-applying the same outcome. The fulfillment_method repeat-check here (already
        // applied in the lookup above) closes a narrow but real window: lib/fulfillment-trigger.ts
        // and lib/refulfillment-service.ts's HendyLinks-404 fallback can re-stamp
        // fulfillment_method to a DIFFERENT supplier via claimFallbackDispatch() while status
        // stays 'processing' the whole time — if that reassignment lands between this handler's
        // lookup and this UPDATE, a status-only guard would still match and let a stale
        // HendyLinks outcome overwrite an order now legitimately owned by another supplier.
        // .select('id') makes the guard OBSERVABLE (same pattern as lib/fulfillment-trigger.ts's
        // atomic claim UPDATE): without it the handler ran its side effects unconditionally, so a
        // duplicate/late delivery re-notified the customer, and syncShopOrderStatus — which
        // writes shop_orders.status unconditionally — could flip a manually-refunded shop order
        // back to 'completed', masking the refund.
        // NOTE: deliberately does NOT write orders.error_message. That column is CUSTOMER-
        // FACING — components/dashboard/RecentOrdersWidget.tsx renders it to the buyer under
        // a "Failure Reason" heading — so a raw supplier string like "API request failed",
        // or anything naming HendyLinks or their upstream provider, must never land there.
        // The reason is recorded in mtn_fulfillment_tracking below, which is admin-only.
        const { data: updatedRows, error: updateError } = await (supabase
            .from('orders') as any)
            .update({
                status: newStatus,
                updated_at: new Date().toISOString(),
            })
            .eq('id', order.id)
            .eq('status', 'processing')
            .eq('fulfillment_method', 'hendylinks')
            .select('id')

        if (updateError) {
            console.error(`[HendyLinksWebhook] DB update failed for order ${order.id}: ${updateError.message} — returning 500 so HendyLinks redelivers`)
            return NextResponse.json({ error: 'Transient error — please retry' }, { status: 500 })
        }

        if (!updatedRows || updatedRows.length === 0) {
            console.log(`[HendyLinksWebhook] Order ${order.id} was not 'processing' — outcome '${newStatus}' already applied, or the order has moved on (e.g. refunded). No status change, no shop sync, no push. Acking.`)
            return NextResponse.json({ success: true })
        }

        console.log(`[HendyLinksWebhook] Order ${order.id} → ${newStatus} (hendylinks_order_id=${safeHlOrderId})${newStatus === 'failed' && hlMessage ? ` — reason: ${hlMessage}` : ''}`)

        // Record the supplier's own reason where ADMINS can see it. mtn_fulfillment_tracking is
        // internal-only (the Admin Fulfillment Center reads it); orders.error_message is not,
        // which is why the reason is kept out of the orders row above.
        if (newStatus === 'failed') {
            const { error: trackingError } = await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                order_id: order.id,
                status: 'failed',
                api_response: {
                    supplier: 'hendylinks',
                    source: 'webhook',
                    hendylinks_order_id: safeHlOrderId,
                    message: hlMessage,
                },
            })
            if (trackingError) console.error(`[HendyLinksWebhook] Tracking insert failed for ${order.id}:`, trackingError.message)
        }

        const { syncShopOrderStatus } = await import('@/lib/shop-service')
        await syncShopOrderStatus(order.id, newStatus).catch(err =>
            console.error(`[HendyLinksWebhook] syncShopOrderStatus failed for ${order.id}:`, err)
        )

        if (newStatus === 'completed') {
            try {
                const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                sendOrderCompletedPushNotification(order.id).catch(e =>
                    console.error('[HendyLinksWebhook] Push error:', e)
                )
            } catch {
                // Non-fatal
            }
        }

        // NOTE: if newStatus === 'failed' and HendyLinks does NOT auto-reverse the wallet
        // charge (pre-launch verification item #4 in the design spec — unresolved as of this
        // implementation), a refund step belongs here. Deliberately not built in this pass —
        // flagged so it isn't silently forgotten once that verification item is answered.

        // waitUntil so a lambda freeze right after this route's response cannot drop
        // the developer webhook — order.id only reaches here after the CAS-guarded
        // UPDATE above (.eq('status','processing').select('id')) proved a real
        // transition just happened, matching the discipline already used above for
        // shop sync and push.
        waitUntil(notifyDataOrderWebhook(
            supabase, order.id,
            newStatus === 'completed' ? 'order.completed' : 'order.failed',
        ))

        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('[HendyLinksWebhook] Unhandled exception:', error)
        // Return 200 to prevent HendyLinks from endlessly retrying an unrecoverable error.
        return NextResponse.json({ success: true }, { status: 200 })
    }
}
