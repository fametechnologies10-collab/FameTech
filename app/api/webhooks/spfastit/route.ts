import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { createServerClient } from '@/lib/supabase'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'
import { mapSpfastitStatus, extractOrderIdFromReference } from '@/lib/spfastit-service'

/**
 * SPFastIT signs nothing natively — the shared secret travels as a query param on the
 * webhook_url WE register on every Place Order call (lib/spfastit-service.ts's
 * buildWebhookUrl), mirroring the fix already applied to the DataKazina webhook. Fails
 * closed (503) if SPFASTIT_WEBHOOK_SECRET is unset — without this, any unauthenticated POST
 * could flip an order to completed with no real delivery.
 */
export async function POST(request: NextRequest) {
    const expectedSecret = process.env.SPFASTIT_WEBHOOK_SECRET || ''
    if (!expectedSecret) {
        console.error('[SpfastitWebhook] Rejected: SPFASTIT_WEBHOOK_SECRET not configured')
        return NextResponse.json({ success: false, error: 'Webhook not configured' }, { status: 503 })
    }

    const provided = request.nextUrl.searchParams.get('secret') || ''
    const expBuf = Buffer.from(expectedSecret)
    const provBuf = Buffer.from(provided)
    const authorized = provided.length > 0 && provBuf.length === expBuf.length && timingSafeEqual(provBuf, expBuf)
    if (!authorized) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    let payload: any
    try {
        payload = await request.json()
    } catch (err) {
        console.error('[SpfastitWebhook] Failed to parse payload:', err)
        return NextResponse.json({ success: false, error: 'Invalid payload' }, { status: 400 })
    }

    try {
        const { reference, status } = payload || {}
        if (!reference || typeof reference !== 'string') {
            console.warn('[SpfastitWebhook] Payload has no usable reference; payload:', JSON.stringify(payload))
            return NextResponse.json({ success: true }, { status: 200 })
        }

        const newStatus = mapSpfastitStatus(status)
        if (newStatus === 'processing') {
            // Not yet terminal ("Not Served" / "WIP N" / docs' "initiated", or unrecognized) —
            // no-op, left for the next delivery or the cron sweep (Task 9) to resolve.
            return NextResponse.json({ success: true }, { status: 200 })
        }

        const orderId = extractOrderIdFromReference(reference)

        const supabase = createServerClient()

        // Guarded on fulfillment_method='spfastit' in addition to matching by reference/id
        // and status='processing' — without this, a late event for an order that has SINCE
        // been retried onto a different supplier could still match by reference alone and
        // overwrite that new supplier's outcome (checklist item 5).
        let query: any = supabase
            .from('orders')
            .update({ status: newStatus, updated_at: new Date().toISOString() })
            .eq('spfastit_reference', reference)
            .eq('fulfillment_method', 'spfastit')
            .eq('status', 'processing')

        const { data: byRefRows, error: byRefError } = await query.select('id')
        if (byRefError) {
            console.error('[SpfastitWebhook] update-by-reference failed:', byRefError.message)
            return NextResponse.json({ success: false, error: byRefError.message }, { status: 500 })
        }

        let updatedIds = (byRefRows || []).map((r: any) => r.id)

        // Fallback: match by the order id recovered from our own reference format, in case
        // spfastit_reference wasn't persisted yet when this event arrived (a race with the
        // dispatch write — the cron sweep in Task 9 is the primary safety net for this, this
        // is defense in depth) OR the order is an ambiguous-dispatch order whose reference was
        // only ever recorded via the ambiguous-branch bookkeeping.
        //
        // Guarded on spfastit_reference IS NULL: without it, a late/redelivered webhook event
        // for an OLD attempt's reference (e.g. `-r0`, which found 0 rows by-reference because
        // an admin retry has since created a NEW attempt `-r1` — now `processing` with
        // spfastit_reference set to the `-r1` reference) would fall through to this by-id
        // match and apply the stale `-r0` outcome onto the current `-r1` attempt. The only
        // legitimate case for by-id matching is when the order has NO reference on file yet
        // (spfastit_reference IS NULL) — a real, different attempt already in flight (a
        // non-null, different reference) means this event belongs to a superseded attempt and
        // must be ignored here, not applied.
        if (updatedIds.length === 0 && orderId) {
            const { data: byIdRows, error: byIdError } = await supabase
                .from('orders')
                .update({ status: newStatus, updated_at: new Date().toISOString(), spfastit_reference: reference })
                .eq('id', orderId)
                .eq('fulfillment_method', 'spfastit')
                .eq('status', 'processing')
                .is('spfastit_reference', null)
                .select('id')
            if (byIdError) {
                console.error('[SpfastitWebhook] update-by-id failed:', byIdError.message)
                return NextResponse.json({ success: false, error: byIdError.message }, { status: 500 })
            }
            updatedIds = (byIdRows || []).map((r: any) => r.id)
        }

        for (const id of updatedIds) {
            console.log(`[SpfastitWebhook] orders.${id} → ${newStatus} (ref=${reference})`)

            try {
                const { syncShopOrderStatus } = await import('@/lib/shop-service')
                // Awaited, not fire-and-forget — a Vercel lambda freeze right after the HTTP
                // response can silently drop an un-awaited promise, leaving orders and
                // shop_orders permanently disagreeing (the cron only re-polls 'processing'
                // orders rows, not this specific divergence). Matches how HendyLinks'/GhData's
                // webhooks and this branch's own cron route (sync-spfastit-status) already
                // await this same call.
                await syncShopOrderStatus(id, newStatus).catch(e =>
                    console.error(`[SpfastitWebhook] syncShopOrderStatus failed for ${id}:`, e)
                )
            } catch (e) {
                console.error('[SpfastitWebhook] shop-service import failed:', e)
            }

            if (newStatus === 'completed') {
                try {
                    const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                    sendOrderCompletedPushNotification(id).catch(e =>
                        console.error(`[SpfastitWebhook] push notification failed for ${id}:`, e)
                    )
                } catch (e) {
                    console.error('[SpfastitWebhook] push-service import failed:', e)
                }
            } else {
                // Failed — never write raw supplier text to orders.error_message, that
                // column is CUSTOMER-FACING. Internal reason goes to the tracking table only.
                const { error: trackingError } = await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                    order_id: id,
                    status: 'failed',
                    api_response: { supplier: 'spfastit', source: 'webhook', spfastit_status: status, reference },
                })
                if (trackingError) console.error(`[SpfastitWebhook] Tracking insert failed for ${id}:`, trackingError.message)
            }

            waitUntil(notifyDataOrderWebhook(supabase, id, newStatus === 'completed' ? 'order.completed' : 'order.failed'))
        }

        return NextResponse.json({ success: true, updated_orders: updatedIds.length }, { status: 200 })
    } catch (error: any) {
        console.error('[SpfastitWebhook] Unhandled exception:', error?.message || error)
        return NextResponse.json({ success: true }, { status: 200 })
    }
}
