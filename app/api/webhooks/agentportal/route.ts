import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual, createHmac } from 'crypto'
import { sanitizeForStorage } from '@/lib/sanitize-for-storage'
import { resolveAgentPortalOrderItems } from '@/lib/agentportal-status'
import { applyAgentPortalOutcome } from '@/lib/agentportal-apply-outcome'

const AGENTPORTAL_WEBHOOK_SECRET = process.env.AGENTPORTAL_WEBHOOK_SECRET || ''

// ─── Signature Verification ────────────────────────────────────────────────────
// AgentPortal signs the raw request body with HMAC-SHA256 and sends the result as
// X-Webhook-Signature: sha256=<hex> — no timestamp, unlike GhData's Stripe-style scheme.
function verifySignature(rawBody: string, signatureHeader: string): boolean {
    try {
        const provided = signatureHeader.replace(/^sha256=/, '')
        const expected = createHmac('sha256', AGENTPORTAL_WEBHOOK_SECRET).update(rawBody).digest('hex')

        const expectedBuf = Buffer.from(expected)
        const providedBuf = Buffer.from(provided)
        return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)
    } catch {
        return false
    }
}

interface AgentPortalWebhookItem {
    order_item_id: string
    batch_id: string
    msisdn: string
    data_mb: number
    status: 'success' | 'failed'
    reference: string
    failed_reason: string | null
    refunded_at: string | null
    created_at: string
}

export async function POST(request: NextRequest) {
    try {
        const rawBody = await request.text()

        // Fail CLOSED — never process a webhook without a configured secret.
        if (!AGENTPORTAL_WEBHOOK_SECRET) {
            console.error('[AgentPortalWebhook] Rejected: AGENTPORTAL_WEBHOOK_SECRET not configured')
            return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
        }

        const signatureHeader = request.headers.get('x-webhook-signature') || ''
        if (!signatureHeader || !verifySignature(rawBody, signatureHeader)) {
            console.warn('[AgentPortalWebhook] Rejected: missing or invalid X-Webhook-Signature')
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        let payload: any
        try {
            payload = JSON.parse(rawBody)
        } catch {
            console.warn('[AgentPortalWebhook] Signature valid but body is not JSON — acking to suppress retries')
            return NextResponse.json({ success: true })
        }

        // Minor: AgentPortal caps items[] at 500 entries per delivery; our own bulk submissions
        // chunk at exactly 500, so we sit right at that boundary. A truncated batch would
        // silently never receive a terminal update for the missing items. AgentPortal's docs
        // name the documented recovery path (GET /api/beneficiaries/orders/{order_id}/items) —
        // we don't build the fallback fetch here (out of scope), but log it loudly, with the
        // real order_id interpolated, so whoever reads this knows exactly what to call.
        if (payload.items_truncated === true) {
            // MEDIUM-2 (security audit): order_id/group_name are supplier-controlled and were
            // previously interpolated into this log line unsanitized — an embedded newline could
            // forge a fake log entry. Sanitize before logging (bounded length, no control chars).
            const safeOrderId = sanitizeForStorage(payload.order_id, 200)
            const safeGroupName = sanitizeForStorage(payload.group_name, 200)
            console.error(`[AgentPortalWebhook] items_truncated=true for order_id=${safeOrderId} (group_name=${safeGroupName}) — some items received no terminal update. Recover via GET /api/beneficiaries/orders/${safeOrderId}/items`)
        }

        // Minor: we don't branch on payload version (an unknown item `status` already fails
        // safe by being skipped), but flag anything newer than what this handler was written
        // against so a payload-shape change doesn't go unnoticed.
        if (payload.version !== undefined && payload.version !== null && Number(payload.version) > 2) {
            // MEDIUM-2: sanitize before logging — same log-line-forgery concern as above.
            console.warn(`[AgentPortalWebhook] Unexpected payload version=${sanitizeForStorage(payload.version, 50)} (handler written for version 2) — payload shape may have changed`)
        }

        if (payload.event !== 'order.completed' || !Array.isArray(payload.items)) {
            // Unknown event type or malformed payload — acknowledge so AgentPortal doesn't retry forever.
            return NextResponse.json({ success: true })
        }

        // Diagnostics only — payload.items[].reference is NOT the join key (see below), it
        // is null on every real delivery per AgentPortal's own docs (webhook deliveries are
        // order-summary only). Kept typed/read here purely so log lines can report itemsCount.
        const itemsForDiagnostics: AgentPortalWebhookItem[] = payload.items

        const orderId: string = typeof payload.order_id === 'string' ? payload.order_id : ''
        if (!orderId) {
            console.warn(`[AgentPortalWebhook] Payload missing order_id (itemsCount=${itemsForDiagnostics.length}) — cannot resolve, acking to suppress retries`)
            return NextResponse.json({ success: true })
        }
        const safeOrderIdForLogs = sanitizeForStorage(orderId, 200)

        // Important: a transient failure here (DB error applying an outcome, OR a network/API
        // failure fetching the items endpoint below) is retryable — unlike malformed input, it
        // is NOT safe to ack with 200, because this webhook (plus the reconcile poller) is the
        // only terminal-state path for AgentPortal orders. Acking a dropped resolution would
        // strand the order with the customer's money held and no way to ever resolve it. Track
        // it and return 500 so AgentPortal redelivers. Safe because applyAgentPortalOutcome's
        // update is idempotent and scoped to pending/processing: outcomes already applied in an
        // earlier pass match zero rows on redelivery — no double refund, no double-complete.
        let hadRetryableError = false

        // ROOT CAUSE FIX: AgentPortal's webhook deliveries are order-summary only — per-item
        // `reference` is deliberately not carried in real deliveries (their docs' §9 example
        // payload is misleading; items[].reference is null in practice, confirmed against a
        // live delivery). The documented recovery path is GET
        // /api/beneficiaries/orders/{order_id}/items, which DOES echo our reference correctly.
        // lib/agentportal-status.ts owns that fetch + the batch_id/msisdn sibling-matching
        // algorithm, shared with the reconcile poller so the two paths can never disagree.
        const itemsResult = await resolveAgentPortalOrderItems(orderId)

        if (itemsResult.error) {
            console.error(`[AgentPortalWebhook] Failed to fetch items for order_id=${safeOrderIdForLogs}: ${itemsResult.error} — marking retryable so AgentPortal redelivers`)
            hadRetryableError = true
        }

        if (itemsResult.ambiguous.length > 0) {
            // Never guessed — reported instead. See matchItemsToOutcomes in lib/agentportal-status.ts.
            console.error(`[AgentPortalWebhook] AMBIGUOUS resolution for order_id=${safeOrderIdForLogs} — order id(s) with more than one terminal sibling in the same batch, skipped (needs manual review): ${itemsResult.ambiguous.map(id => sanitizeForStorage(id, 100)).join(', ')}`)
        }

        const resolvedEntries = Array.from(itemsResult.resolved.entries())

        // This is precisely the class of bug this fix addresses: a delivery that silently
        // resolves nothing. Before this fix it happened on EVERY delivery (item.reference was
        // always null) and returned 200 with zero visible symptom — real customers were
        // charged, delivered, and left stuck in 'processing' forever. Log loudly so this class
        // of silent no-op can never happen unnoticed again. Not logged when itemsResult.error is
        // set — that case already logs its own (retryable) error above.
        //
        // ONE benign cause of zero-resolved exists and is expected: a delivery for a RETRY order
        // (group_name …-R1-/-R2-). Retry rows carry AgentPortal's own numeric reference, not our
        // uuid, and the row that does carry our uuid lives in the ORIGINAL order — so a
        // single-order fetch structurally cannot match it here. Those are resolved by the
        // reconcile cron's global batch_id sweep (lib/agentportal-reconcile.ts), which is why the
        // order is left `processing` rather than touched. Do not "fix" this by guessing.
        if (resolvedEntries.length === 0 && !itemsResult.error) {
            console.warn(`[AgentPortalWebhook] Delivery for order_id=${safeOrderIdForLogs} resolved ZERO orders (itemsCount=${itemsForDiagnostics.length}, ambiguousCount=${itemsResult.ambiguous.length}) — no terminal outcome could be matched to any of our orders via the items endpoint. If this order is a retry (…-R1-), that is expected; the reconcile cron will resolve it.`)
        }

        // AgentPortal's own webhook docs: "Respond with any 2xx within 15s, or it counts as a
        // failure and is retried up to 3 times." AgentPortal caps items[] at 500 and our own
        // bulk submissions chunk at exactly 500, so a single delivery can legitimately resolve
        // up to 500 orders. Processing them strictly sequentially risks exceeding the 15s budget
        // well before order 500, causing AgentPortal to redeliver mid-processing.
        //
        // Fix: bound the work with concurrency, same pattern as
        // lib/refulfillment-service.ts (SYNC_CONCURRENCY = 10) and
        // app/api/admin/fulfillment/sync-ghdata/route.ts (CONCURRENCY = 5) — slice into chunks
        // and Promise.allSettled each slice so one order's rejection can't skip its siblings.
        //
        // Those two call external supplier HTTP APIs per item, hence their lower concurrency.
        // Per order here applyAgentPortalOutcome only does internal Supabase calls (on success:
        // one conditional UPDATE plus one syncShopOrderStatus; on failure: one order-row read
        // plus one awaited admin alert, and nothing else — no status change and no refund, see
        // that file's header); there is no outbound HTTP call to a third party in that hot path
        // (the ONE extra HTTP call — the items fetch above — already happened once per delivery,
        // not once per order). ITEM_CONCURRENCY = 25 gives 20 slices for a full 500-order batch.
        // Even at a pessimistic ~500ms for the slow (alert) path per order, 20 slices × 500ms =
        // 10s — comfortably inside the 15s budget with margin. The success case is ~7-8 DB
        // round-trips per order, not 1-2 — the conditional UPDATE plus syncShopOrderStatus alone
        // issues up to 6 (see lib/shop-service.ts). The conclusion still holds (25 gives ~2x
        // margin; 10 would have given ~17.5s = OVER budget), but do NOT lower ITEM_CONCURRENCY on
        // the assumption that each order is cheap — that would silently reintroduce the 15s
        // webhook timeout.
        const ITEM_CONCURRENCY = 25

        for (let i = 0; i < resolvedEntries.length; i += ITEM_CONCURRENCY) {
            const slice = resolvedEntries.slice(i, i + ITEM_CONCURRENCY)
            const results = await Promise.allSettled(
                slice.map(([resolvedOrderId, outcome]) =>
                    applyAgentPortalOutcome(resolvedOrderId, outcome.outcome, outcome.failedReason, 'AgentPortal Webhook')
                )
            )
            // Defensive net: applyAgentPortalOutcome's own internal try/catches mean it should
            // never throw, but if something unexpected does slip through, Promise.allSettled
            // still lets the rest of the slice finish. Treat an unhandled rejection as retryable
            // too — safer to ask AgentPortal to redeliver than to silently drop a resolution.
            for (const r of results) {
                if (r.status === 'rejected') {
                    console.error('[AgentPortalWebhook] Unhandled exception applying resolved outcome:', r.reason)
                    hadRetryableError = true
                } else if (r.value.retryable) {
                    hadRetryableError = true
                }
            }
        }

        if (hadRetryableError) {
            console.error('[AgentPortalWebhook] One or more orders hit a transient error — returning 500 so AgentPortal redelivers')
            return NextResponse.json({ error: 'Transient error — please retry' }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('[AgentPortalWebhook] Unhandled exception:', error)
        // Return 200 to prevent AgentPortal from endlessly retrying an unrecoverable error.
        return NextResponse.json({ success: true }, { status: 200 })
    }
}
