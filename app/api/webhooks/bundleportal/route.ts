// app/api/webhooks/bundleportal/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { sanitizeForStorage } from '@/lib/sanitize-for-storage'
import { verifyBundlePortalSignature } from '@/lib/bundleportal-webhook'
import {
    applyBundlePortalOutcome,
    resolveBundlePortalOrderId,
    BUNDLEPORTAL_EVENTS,
    type BundlePortalEvent,
} from '@/lib/bundleportal-apply-outcome'

const BUNDLEPORTAL_WEBHOOK_SECRET = process.env.BUNDLEPORTAL_WEBHOOK_SECRET || ''

// Derived from lib/bundleportal-apply-outcome.ts's BUNDLEPORTAL_EVENTS so the two can't drift.
const KNOWN_EVENTS: ReadonlySet<string> = new Set(BUNDLEPORTAL_EVENTS)

export async function POST(request: NextRequest) {
    try {
        const rawBody = await request.text()

        // Fail CLOSED — never process a webhook without a configured secret.
        if (!BUNDLEPORTAL_WEBHOOK_SECRET) {
            console.error('[BundlePortalWebhook] Rejected: BUNDLEPORTAL_WEBHOOK_SECRET not configured')
            return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
        }

        const signatureHeader = request.headers.get('x-bundleportal-signature') || ''
        if (!signatureHeader || !verifyBundlePortalSignature(rawBody, signatureHeader, BUNDLEPORTAL_WEBHOOK_SECRET)) {
            console.warn('[BundlePortalWebhook] Rejected: missing or invalid X-BundlePortal-Signature')
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        let payload: any
        try {
            payload = JSON.parse(rawBody)
        } catch {
            console.warn('[BundlePortalWebhook] Signature valid but body is not JSON — acking to suppress any retry')
            return NextResponse.json({ success: true })
        }

        if (typeof payload.event !== 'string' || !KNOWN_EVENTS.has(payload.event)) {
            // Unknown event type — ack so Bundle Portal doesn't treat this as a failed delivery
            // (they don't retry regardless, but there's no reason to report failure for a
            // payload shape we simply don't act on yet).
            console.log(`[BundlePortalWebhook] Ignoring unrecognized event: ${sanitizeForStorage(payload.event, 100)}`)
            return NextResponse.json({ success: true })
        }

        const rawOrderId: string = typeof payload.order_id === 'string' ? payload.order_id : ''
        if (!rawOrderId) {
            console.warn('[BundlePortalWebhook] Payload missing order_id — cannot resolve, acking')
            return NextResponse.json({ success: true })
        }
        const reference: string | undefined = typeof payload.reference === 'string' && payload.reference ? payload.reference : undefined
        const safeRawOrderIdForLogs = sanitizeForStorage(rawOrderId, 200)
        const failureReason = typeof payload.failure_reason === 'string' ? payload.failure_reason : null

        // rawOrderId may be a plain orders.id UUID, OR a composite "<sourceOrderId>:<attemptNo>"
        // retry dispatch key (lib/retry-service.ts's dispatchKey) — resolve it to a real orders.id
        // before ever using it in a DB lookup. Never throws; returns null if nothing resolves.
        const resolvedOrderId = await resolveBundlePortalOrderId(rawOrderId, reference)
        if (!resolvedOrderId) {
            console.warn(`[BundlePortalWebhook] Could not resolve order_id=${safeRawOrderIdForLogs} (reference=${sanitizeForStorage(reference || '', 200)}) to any order — acking, no further action possible`)
            return NextResponse.json({ success: true })
        }

        // Bundle Portal NEVER retries a delivery (5s timeout, no retry — per their docs). A
        // transient DB error here is therefore NOT worth signaling via a 5xx: no redelivery
        // will come either way, and a 5xx only risks confusing Bundle Portal's own delivery
        // bookkeeping. Log loudly (this is the only recovery signal now that the polling cron
        // is gone) and still ack 200.
        const result = await applyBundlePortalOutcome(resolvedOrderId, payload.event as BundlePortalEvent, failureReason)

        if (result.retryable) {
            console.error(`[BundlePortalWebhook] Transient error applying outcome for order_id=${sanitizeForStorage(resolvedOrderId, 200)} (raw=${safeRawOrderIdForLogs}) — no redelivery will come from Bundle Portal; this needs manual follow-up.`)
        }

        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('[BundlePortalWebhook] Unhandled exception:', error)
        return NextResponse.json({ success: true }, { status: 200 })
    }
}
