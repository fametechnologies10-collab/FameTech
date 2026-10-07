import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'

const XPRESS_WEBHOOK_SECRET = process.env.XPRESS_WEBHOOK_SECRET || ''

// Service-role client — webhooks run outside user sessions
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

// ─── HMAC-SHA256 Signature Verification ───────────────────────────────────────
// Xpress signs the raw request body with your signing secret.
// They send the result in the X-Xpress-Signature header as "sha256=<hex>".
async function verifySignature(rawBody: string, signatureHeader: string): Promise<boolean> {
    try {
        const encoder = new TextEncoder()
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(XPRESS_WEBHOOK_SECRET),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        )
        const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
        const computed = Array.from(new Uint8Array(sigBytes))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')

        // Accept both "sha256=<hex>" and plain "<hex>"
        const provided = Buffer.from(signatureHeader.replace(/^sha256=/, ''), 'utf8')
        const expected = Buffer.from(computed, 'utf8')
        // Constant-time compare. The length test short-circuits first on purpose:
        // timingSafeEqual throws on unequal lengths, and the expected length (64 hex
        // chars) is public anyway.
        return provided.length === expected.length && timingSafeEqual(provided, expected)
    } catch {
        return false
    }
}

// ─── Item Status Mapping ──────────────────────────────────────────────────────
// completed  → mark order completed
// failed     → mark order failed
// refunded   → mark order failed (Xpress auto-refunds wallet; we just close the order)
// pending    → no update (order not yet processed by supplier)
// processing → no update (Xpress is still working on it)
function mapItemStatus(xpressStatus: string): 'completed' | 'failed' | null {
    const s = (xpressStatus || '').toLowerCase()
    if (s === 'completed' || s === 'success') return 'completed'
    if (s === 'failed' || s === 'refunded') return 'failed'
    return null // pending / processing — leave untouched
}

export async function POST(request: NextRequest) {
    try {
        // ── Read raw body first (needed for HMAC verification) ─────────────────
        const rawBody = await request.text()

        // ── SEC-003: fail CLOSED — never process a webhook without a configured
        //    secret. (Was previously skipped entirely when the secret was unset,
        //    letting forged payloads flip orders via the service-role client.)
        if (!XPRESS_WEBHOOK_SECRET) {
            console.error('[XpressWebhook] Rejected: XPRESS_WEBHOOK_SECRET not configured')
            return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
        }

        // ── HMAC signature verification (always enforced) ──────────────────────
        // Xpress sends: X-Xpress-Signature: sha256=<hmac_hex>. (SEC-017: the
        // previous "dump all headers" debug log is removed — it leaked the
        // signature header to logs.)
        const signatureHeader = request.headers.get('x-xpress-signature') || ''
        if (!signatureHeader) {
            console.warn('[XpressWebhook] Rejected: missing X-Xpress-Signature header')
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const valid = await verifySignature(rawBody, signatureHeader)
        if (!valid) {
            console.warn('[XpressWebhook] Rejected: signature mismatch')
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // ── Parse payload ──────────────────────────────────────────────────────
        let payload: any
        try {
            payload = JSON.parse(rawBody)
        } catch {
            return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
        }

        const { event, order_id, items } = payload
        console.log(`[XpressWebhook] Event: ${event} | Xpress order: ${order_id} | Items: ${items?.length ?? 0}`)

        // Acknowledge events with no items immediately
        if (!Array.isArray(items) || items.length === 0) {
            return NextResponse.json({ success: true })
        }

        // ── Process each item ──────────────────────────────────────────────────
        // item.reference = our internal order UUID (we set this when placing the order)
        for (const item of items) {
            const internalOrderId: string = item.reference
            const xpressItemStatus: string = item.status

            if (!internalOrderId) {
                console.warn('[XpressWebhook] Item missing reference field:', JSON.stringify(item))
                continue
            }

            const newStatus = mapItemStatus(xpressItemStatus)
            if (!newStatus) {
                // pending / processing — system handles these, we don't touch them
                console.log(`[XpressWebhook] Order ${internalOrderId} item "${xpressItemStatus}" — no action`)
                continue
            }

            console.log(`[XpressWebhook] Updating order ${internalOrderId} → ${newStatus} (item was: ${xpressItemStatus})`)

            // Update internal order — only touch processing/pending to avoid overwriting
            // an already-completed order if Xpress sends a duplicate event.
            //
            // fulfillment_method='xpress' is also required — without it, a late/delayed
            // delivery for an order that has SINCE been retried onto a different supplier
            // could still match by id alone and flip its status out from under the new
            // supplier. Mirrors the guard lib/agentportal-apply-outcome.ts uses for AgentPortal.
            const { data: updatedRows, error: updateError } = await supabaseAdmin
                .from('orders')
                .update({ status: newStatus, updated_at: new Date().toISOString() })
                .eq('id', internalOrderId)
                .eq('fulfillment_method', 'xpress')
                .in('status', ['processing', 'pending'])
                .select('id')

            if (updateError) {
                console.error(`[XpressWebhook] DB update failed for ${internalOrderId}:`, updateError.message)
                continue // don't abort — keep processing remaining items
            }

            if (!updatedRows || updatedRows.length === 0) {
                // No matching pending/processing xpress order — either a duplicate event for an
                // already-resolved order, or (the guard this fix added) an order that's since
                // been retried onto a different supplier. Either way, don't sync the shop mirror
                // or notify — that would flip the storefront/customer view out from under the
                // order's real current supplier.
                console.log(`[XpressWebhook] No matching pending/processing xpress order for ${internalOrderId}`)
                continue
            }

            // Sync shop storefront order
            await syncShopOrderStatus(internalOrderId, newStatus).catch(err =>
                console.error(`[XpressWebhook] syncShopOrderStatus failed for ${internalOrderId}:`, err)
            )

            // Push notification on delivery
            if (newStatus === 'completed') {
                try {
                    const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                    sendOrderCompletedPushNotification(internalOrderId).catch(e =>
                        console.error('[XpressWebhook] Push notification error:', e)
                    )
                } catch {
                    // Non-fatal — notification failure must not affect the 2xx response
                }
            }

            // waitUntil so a lambda freeze right after this route's response cannot
            // drop the developer webhook — internalOrderId only reaches here after the
            // CAS-guarded UPDATE above (.in('status',[processing,pending]).select('id'))
            // proved a real transition just happened.
            waitUntil(notifyDataOrderWebhook(
                supabaseAdmin, internalOrderId,
                newStatus === 'completed' ? 'order.completed' : 'order.failed',
            ))
        }

        // Always return 2xx — Xpress retries on failure with exponential backoff (up to 5x)
        return NextResponse.json({ success: true })

    } catch (error: any) {
        console.error('[XpressWebhook] Unhandled exception:', error)
        // Return 200 to prevent Xpress from endlessly retrying an unrecoverable error
        return NextResponse.json({ success: true }, { status: 200 })
    }
}
