/**
 * Send a service fulfillment callback to Hubtel after delivering the service.
 * Must be sent within 1 hour of receiving the fulfillment payload.
 * Outbound requests are routed through HUBTEL_PROXY_URL (currently a self-hosted
 * tinyproxy static IP on DigitalOcean, see docs/reference/hubtel-programmable-services-api.md)
 * so Hubtel can whitelist our stable egress IP.
 * If this still fails after retrying below, the failure is queued in
 * ussd_callback_retry_queue and automatically retried by the status-check cron for up
 * to 24h (see drainCallbackRetryQueue in app/api/ussd/status-check/route.ts) — this is
 * NOT a one-shot, human-only failure anymore.
 */
import https from 'https'
import { createClient } from '@supabase/supabase-js'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { sendAdminPushNotification } from '@/lib/push-service'
import { shouldSendImmediateCallbackAlert } from '@/lib/ussd/callback-retry-queue'

const CALLBACK_URL = 'https://gs-callback.hubtel.com:9055/callback'

/**
 * Best-effort: on final give-up, upsert a row into ussd_callback_retry_queue so the
 * existing status-check cron (currently every 5 min — verify in the cron-job.org
 * dashboard, not this comment) can keep retrying without a human. Never
 * throws — a failure to enqueue must not mask the underlying callback failure itself.
 * Also resolves any existing row for this session on success, so a caller that
 * eventually succeeds (e.g. the cron itself, or a manual resend) clears the queue.
 *
 * Known accepted race (security review MEDIUM-6): the SELECT-then-upsert here isn't
 * atomic, so two near-simultaneous failures for the same already-resolved session (e.g. a
 * fast re-fulfillment retriggering the ack) could both read `resolved: true` and both send
 * an immediate admin push. Worst case is a duplicate low-stakes notification, never lost
 * state — first_failed_at/resolved settle correctly regardless of ordering. Not worth the
 * added complexity of a fully atomic claim for a notification-only race; the row-level
 * retry/escalation path (drainCallbackRetryQueue) IS properly claimed via the
 * claim_ussd_callback_retry RPC, which is the path that actually matters for correctness.
 */
async function upsertCallbackRetryQueue(args: {
    sessionId: string
    orderId: string
    serviceStatus: 'success' | 'failed'
    metadata: Record<string, unknown> | null
}): Promise<boolean> {
    const adminDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    try {
        const { data: existing } = await adminDb
            .from('ussd_callback_retry_queue')
            .select('resolved, escalated')
            .eq('session_id', args.sessionId)
            .maybeSingle()

        const alertImmediately = shouldSendImmediateCallbackAlert(existing as { resolved: boolean; escalated: boolean } | null)

        // A previously resolved/escalated row failing again is a fresh incident —
        // reset first_failed_at/attempts/resolved/escalated for it, same as a brand new row.
        const isFreshIncident = !existing || existing.resolved
        const upsertPayload: Record<string, unknown> = {
            session_id: args.sessionId,
            hubtel_order_id: args.orderId,
            service_status: args.serviceStatus,
            metadata: args.metadata,
            last_attempt_at: new Date().toISOString(),
        }
        if (isFreshIncident) {
            upsertPayload.first_failed_at = new Date().toISOString()
            upsertPayload.attempts = 1
            upsertPayload.resolved = false
            upsertPayload.resolved_at = null
            upsertPayload.escalated = false
        }
        await (adminDb.from('ussd_callback_retry_queue') as any).upsert(upsertPayload, { onConflict: 'session_id' })
        return alertImmediately
    } catch (err) {
        console.error('[USSD Callback] Failed to enqueue callback retry:', err)
        return true // fail open on alerting — better a duplicate push than a silently dropped incident
    }
}

async function resolveCallbackRetryQueue(sessionId: string): Promise<void> {
    const adminDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    try {
        await (adminDb.from('ussd_callback_retry_queue') as any)
            .update({ resolved: true, resolved_at: new Date().toISOString() })
            .eq('session_id', sessionId)
            .eq('resolved', false)
    } catch (err) {
        console.error('[USSD Callback] Failed to resolve callback retry queue row:', err)
    }
}

/**
 * Returns true when Hubtel acknowledged the callback. An unACKed callback on a
 * settled order is dangerous — Hubtel treats the service as unresponsive and
 * can auto-refund a DELIVERED order and strike the service's reliability — so
 * final failure pages the admins instead of dying in the logs.
 */
export async function sendHubtelCallback(
    sessionId: string,
    orderId: string,
    serviceStatus: 'success' | 'failed',
    metadata: Record<string, unknown> | null = null,
): Promise<boolean> {
    const apiId = process.env.HUBTEL_API_ID
    const apiKey = process.env.HUBTEL_API_KEY

    if (!apiId || !apiKey) {
        console.error('[USSD Callback] HUBTEL_API_ID / HUBTEL_API_KEY not configured')
        await sendAdminPushNotification({
            title: 'Hubtel callback NOT sent — credentials missing',
            body: `HUBTEL_API_ID/KEY unset; ${serviceStatus} callback for session ${sessionId} was never sent. Hubtel may auto-refund the customer.`,
        }).catch(() => {})
        return false
    }

    const credentials = Buffer.from(`${apiId}:${apiKey}`).toString('base64')

    const bodyStr = JSON.stringify({
        SessionId: sessionId,
        OrderId: orderId,
        ServiceStatus: serviceStatus,
        MetaData: metadata,
    })

    const proxyUrl = process.env.HUBTEL_PROXY_URL
    const url = new URL(CALLBACK_URL)

    const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Basic ${credentials}`,
            'Cache-Control': 'no-cache',
            'Content-Length': Buffer.byteLength(bodyStr),
        },
        ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
    }

    const attempt = (): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
            const req = https.request(options, (res) => {
                const chunks: Buffer[] = []
                res.on('data', (chunk) => chunks.push(chunk))
                res.on('end', () => {
                    const status = res.statusCode ?? 0
                    if (status >= 200 && status < 300) {
                        console.log(`[USSD Callback] Sent ${serviceStatus} for session ${sessionId}`)
                        resolve(true)
                    } else {
                        console.error(`[USSD Callback] Hubtel returned ${status} for session ${sessionId}:`, Buffer.concat(chunks).toString())
                        resolve(false)
                    }
                })
            })
            req.on('error', (err) => {
                console.error('[USSD Callback] Network error sending to Hubtel:', err)
                resolve(false)
            })
            // Security review MEDIUM-5: without this, a hung proxy/Hubtel connection blocks
            // indefinitely (only Vercel's 60s function cap would eventually kill it), and
            // drainCallbackRetryQueue now calls this sequentially per queued row.
            req.setTimeout(15_000, () => {
                req.destroy()
                resolve(false)
            })
            req.write(bodyStr)
            req.end()
        })

    // P2-5: a missed callback leaves a settled order unacknowledged by Hubtel.
    // Retry up to 4 attempts with short backoff before giving up.
    for (let i = 0; i < 4; i++) {
        if (await attempt()) {
            await resolveCallbackRetryQueue(sessionId)
            return true
        }
        if (i < 3) await new Promise((r) => setTimeout(r, 700 * (i + 1)))
    }
    console.error(`[USSD Callback] Giving up after 4 attempts for session ${sessionId} (${serviceStatus})`)
    // Enqueue for the status-check cron to keep retrying automatically (up to 24h)
    // instead of this being a one-shot failure that only a human notices.
    const alertImmediately = await upsertCallbackRetryQueue({ sessionId, orderId, serviceStatus, metadata })
    if (alertImmediately) {
        await sendAdminPushNotification({
            title: 'Hubtel callback FAILED after retries',
            body: `Could not deliver ${serviceStatus} callback for session ${sessionId} (order ${orderId}). Queued for automatic retry over the next 24h — no action needed unless it's still failing after that window.`,
        }).catch(() => {})
    }
    return false
}
