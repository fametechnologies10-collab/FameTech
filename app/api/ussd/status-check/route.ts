import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendHubtelCallback } from '@/lib/ussd/hubtel-callback'
import { expireOldPendingOrders } from '@/lib/ussd/session'
import { fulfillDataOrder, type DataOrderPayload } from '@/lib/ussd/fulfillment/data'
import { fulfillRCOrder, type RCOrderPayload } from '@/lib/ussd/fulfillment/results-checker'
import { fulfillAFAOrder, type AFAOrderPayload } from '@/lib/ussd/fulfillment/afa'
import { fulfillAirtimeUSSDOrder, type AirtimeOrderPayload } from '@/lib/ussd/fulfillment/airtime'
import { fulfillUtilityUSSDOrder, type UtilityOrderPayload } from '@/lib/ussd/fulfillment/utility'
import https from 'https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { validateCronAuth } from '@/lib/cron-utils'
import { sendAdminPushNotification } from '@/lib/push-service'
import { shouldEscalateCallbackRetry } from '@/lib/ussd/callback-retry-queue'

// =============================================================================
// GET /api/ussd/status-check — backup status-check cron (recovery path)
// TWO independent recovery jobs share this one cron run:
//   1. Polls Hubtel for paid transactions that did NOT receive an inbound fulfillment
//      callback (never fulfilled at all). Outbound polls go through HUBTEL_PROXY_URL so
//      Hubtel can whitelist our stable egress IP. Expire pending orders early (20 min,
//      see savePendingOrder) and poll only the still-pending 5-20 min window.
//   2. Drains ussd_callback_retry_queue: orders that WERE fulfilled but whose ack back to
//      Hubtel (sendHubtelCallback) failed — see drainCallbackRetryQueue below. Retried for
//      up to 24h before escalating to a one-time admin alert.
// Scheduled every 5 min via cronjob.org (external scheduler — NOT vercel.json; bumped
// from 15 min on 2026-09-11 now that DO tinyproxy has no per-request billing/quota, unlike
// Fixie — verify the actual live interval in the cron-job.org dashboard, not this comment).
// Safety invariant (job 1): expiry(20m) >= cron(5m) + 5m poll-threshold, so every
// still-pending order gets at least one recovery poll before it is expired.
// =============================================================================

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
)

const STATUS_API = 'https://api-txnstatus.hubtel.com/transactions'

/**
 * Drains ussd_callback_retry_queue: orders that were ALREADY fulfilled but whose Hubtel
 * ack (sendHubtelCallback) failed after its own 4-attempt retry (see
 * lib/ussd/hubtel-callback.ts). Distinct from the stale-pending loop above, which handles
 * orders never fulfilled at all. Runs every cron cycle (5 min); a row keeps getting
 * retried here until it succeeds or is escalated past 24h since its first failure.
 * Each row is claimed via the claim_ussd_callback_retry RPC before retrying — this is a
 * real CAS lock (mirrors ussd_pending_orders.claimed_at below), not just a status filter,
 * so two overlapping cron invocations can never both retry (and thus double-fire the
 * outbound Hubtel call for) the same row.
 */
async function drainCallbackRetryQueue(
    supabase: any,
    runStartedAt: number,
    timeBudgetMs: number,
): Promise<{ checked: number; resolved: number; stillFailing: number; escalated: number }> {
    let checked = 0, resolved = 0, stillFailing = 0, escalated = 0

    const { data: rows } = await (supabase.from('ussd_callback_retry_queue') as any)
        .select('*')
        .eq('resolved', false)
        .eq('escalated', false)
        .order('first_failed_at', { ascending: true })
        .limit(20)

    if (!rows || rows.length === 0) return { checked, resolved, stillFailing, escalated }

    const now = new Date()
    for (const row of rows as any[]) {
        if (Date.now() - runStartedAt > timeBudgetMs) break

        // Atomic claim (security review HIGH-2): prevents two overlapping cron runs from
        // both retrying the same row — a lost claim (another run already has it, or it
        // resolved/escalated between our SELECT and now) is skipped, not retried here.
        // Also atomically increments attempts (fixes MEDIUM-3: the app-layer upsert alone
        // never incremented past 1).
        const { data: claimed } = await supabase.rpc('claim_ussd_callback_retry', { p_id: row.id })
        if (!claimed) continue

        checked++
        const ok = await sendHubtelCallback(row.session_id, row.hubtel_order_id, row.service_status, row.metadata ?? null)
        if (ok) {
            resolved++ // sendHubtelCallback already marked the row resolved on success
            continue
        }
        stillFailing++
        if (shouldEscalateCallbackRetry(row.first_failed_at, now)) {
            // Only the invocation that actually wins this update sends the alert
            // (security review HIGH-1: the old code sent it unconditionally, so two
            // overlapping runs both escalating the same row would double-page).
            const { data: won } = await (supabase.from('ussd_callback_retry_queue') as any)
                .update({ escalated: true })
                .eq('id', row.id)
                .eq('escalated', false)
                .select('id')
                .maybeSingle()
            if (won) {
                escalated++
                await sendAdminPushNotification({
                    title: 'Hubtel callback permanently failed — manual check needed',
                    body: `Session ${row.session_id} (order ${row.hubtel_order_id}) has failed its ${row.service_status} ack to Hubtel for over 24h. Giving up automatic retries — investigate and resend manually.`,
                }).catch(() => {})
            }
        }
    }
    return { checked, resolved, stillFailing, escalated }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
    // Allow Vercel cron + internal calls only
    // SEC-012: fail-closed cron auth (constant-time, 500 if secret unset)
    const authError = validateCronAuth(request)
    if (authError) return authError

    const collectionAccount = process.env.HUBTEL_COLLECTION_ACCOUNT
    const apiId = process.env.HUBTEL_API_ID
    const apiKey = process.env.HUBTEL_API_KEY

    if (!collectionAccount || !apiId || !apiKey) {
        console.error('[USSD Status Check] Missing Hubtel credentials')
        return NextResponse.json({ error: 'Missing Hubtel credentials' }, { status: 500 })
    }

    const credentials = Buffer.from(`${apiId}:${apiKey}`).toString('base64')

    // Build proxy agent once per invocation (reused for every pending order)
    const proxyUrl = process.env.HUBTEL_PROXY_URL
    const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined

    const runStartedAt = Date.now()

    // P1-4: recover crashed in-flight claims. A claim (stamped hubtel_order_id)
    // older than 15 minutes is definitively dead — the Vercel function cap is
    // 60s (vercel.json maxDuration), so no live worker survives that long.
    // Staleness is measured from claimed_at (when the LOCK was taken), never
    // from created_at: a claim legitimately taken on an old row (late Hubtel
    // callback, resurrected expired order) is NOT crashed just because the
    // ORDER is old — reclaiming it re-fulfilled concurrently (duplicate order,
    // double shop credit). Legacy rows claimed before claimed_at existed fall
    // back to the old created_at heuristic.
    // 'expired' is included so a crashed RESURRECTION claim (fulfill route can
    // claim expired-unclaimed rows on a live paid callback) doesn't stay locked
    // forever — releasing it lets Hubtel's next callback retry resurrect it.
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    await supabase
        .from('ussd_pending_orders')
        .update({ hubtel_order_id: null, claimed_at: null })
        .in('status', ['pending', 'expired'])
        .not('hubtel_order_id', 'is', null)
        .lt('claimed_at', fifteenMinAgo)
    await supabase
        .from('ussd_pending_orders')
        .update({ hubtel_order_id: null })
        .eq('status', 'pending')
        .not('hubtel_order_id', 'is', null)
        .is('claimed_at', null)
        .lt('created_at', fifteenMinAgo)

    // POLL-THEN-EXPIRE. Never flip a row to 'expired' before Hubtel has been
    // asked about it at least once: the old expire-first order meant a single
    // late/failed cron run silently discarded paid-but-callback-missed orders
    // (money settled, no order, no refund record, no alert). Now a row is only
    // expired on a confirmed 'unpaid'/never-created verdict past its expires_at;
    // poll errors leave it pending for the next run, with a 48h hard backstop.
    // Cost stays bounded: an abandoned order is polled ~1-2 times before its
    // confirmed expiry, and the batch is capped + time-budgeted below.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    const { data: stalePending } = await supabase
        .from('ussd_pending_orders')
        .select('*')
        .eq('status', 'pending')
        .is('hubtel_order_id', null)
        .lt('created_at', fiveMinutesAgo)
        .order('created_at', { ascending: true })
        .limit(20)

    let fulfilled = 0
    let failed = 0
    let expired = 0
    let pollErrors = 0
    let checked = 0

    // Leave headroom inside the 60s function cap for the 48h backstop + callback-retry
    // drain + response. Both this loop and drainCallbackRetryQueue share this one budget
    // measured from the same runStartedAt (security review MEDIUM-4: under sustained
    // upstream slowness this loop could consume it all, starving the drain that run) —
    // accepted given the drain's 24h escalation window provides a wide safety margin
    // against a single starved cycle; revisit if starvation is ever observed in practice.
    const TIME_BUDGET_MS = 45_000

    if (stalePending && stalePending.length > 0) {
    for (const pending of stalePending as any[]) {
        if (Date.now() - runStartedAt > TIME_BUDGET_MS) break
        checked++
        try {
            // Query Hubtel transaction status using SessionId as clientReference
            const statusUrl = new URL(`${STATUS_API}/${collectionAccount}/status`)
            statusUrl.searchParams.set('clientReference', pending.session_id)

            const statusRes = await new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve, reject) => {
                const reqOptions: https.RequestOptions = {
                    hostname: statusUrl.hostname,
                    port: statusUrl.port || 443,
                    path: `${statusUrl.pathname}${statusUrl.search}`,
                    method: 'GET',
                    headers: { Authorization: `Basic ${credentials}` },
                    ...(proxyAgent ? { agent: proxyAgent } : {}),
                }
                const req = https.request(reqOptions, (res) => {
                    const chunks: Buffer[] = []
                    res.on('data', (c) => chunks.push(c))
                    res.on('end', () => {
                        const raw = Buffer.concat(chunks).toString()
                        resolve({
                            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
                            status: res.statusCode ?? 0,
                            json: () => Promise.resolve(JSON.parse(raw)),
                        })
                    })
                })
                req.on('error', reject)
                req.end()
            })

            if (!statusRes.ok) {
                if (statusRes.status === 404 && new Date(pending.expires_at) < new Date()) {
                    // Hubtel has no record of this clientReference: the MoMo
                    // charge was never created (AddToCart lost upstream). Past
                    // its window it can never pay — safe to expire, verified.
                    await supabase
                        .from('ussd_pending_orders')
                        .update({ status: 'expired' })
                        .eq('id', pending.id)
                        .eq('status', 'pending')
                        .is('hubtel_order_id', null)
                    expired++
                } else {
                    // Transient API failure — leave the row pending so the next
                    // run re-polls it (48h hard backstop below bounds retries).
                    console.warn(`[USSD Status Check] Status API ${statusRes.status} for ${pending.session_id}`)
                    pollErrors++
                }
                continue
            }

            const statusData = await statusRes.json() as any
            console.log(`[USSD Status Check] Hubtel response for ${pending.session_id}:`, JSON.stringify(statusData))
            const txStatus = (statusData?.data?.status as string | undefined)?.toLowerCase()

            if (txStatus === 'paid') {
                const orderId = (statusData.data.transactionId as string) ?? pending.session_id

                // P0-5: atomically claim before fulfilling so a concurrent Hubtel
                // fulfill callback cannot double-fulfill (double voucher assignment
                // for RC). Only the worker that flips a still-'pending', unclaimed
                // row proceeds; everyone else skips.
                const { data: claimed } = await supabase
                    .from('ussd_pending_orders')
                    .update({ hubtel_order_id: orderId, claimed_at: new Date().toISOString() })
                    .eq('id', pending.id)
                    .eq('status', 'pending')
                    .is('hubtel_order_id', null)
                    .select('id')
                    .maybeSingle()
                if (!claimed) continue   // lost the claim — another worker owns it

                // ── Defensive amount check (parity with the inbound callback path) ──────────
                // The recovery path previously fulfilled WITHOUT verifying the amount actually
                // paid, so an underpaid order (tampering / wires crossed) would be delivered in
                // full — a revenue leak. Mirror app/api/ussd/fulfill/route.ts: compare against
                // AmountAfterCharges (Hubtel's fee sits ON TOP of our price, so only an
                // UNDERPAYMENT is suspicious; an overage is just the fee). Fall back to the gross
                // amount when net is absent — gross ≥ net, so this can only UNDER-detect, never
                // false-flag a legitimate order. If neither is present, do not block.
                const expectedPrice = Number(pending.price)
                const afterCharges = statusData?.data?.amountAfterCharges
                const grossAmount = statusData?.data?.amount ?? statusData?.data?.amountPaid
                const netPaid = typeof afterCharges === 'number' ? afterCharges
                    : typeof grossAmount === 'number' ? grossAmount
                    : undefined
                if (typeof netPaid === 'number' && netPaid < expectedPrice - 0.01) {
                    console.error(
                        `[USSD Status Check] Underpayment for session ${pending.session_id}: net GHS ${netPaid}, expected GHS ${expectedPrice}`,
                    )
                    failed++
                    const { error: failUpdErr } = await supabase
                        .from('ussd_pending_orders')
                        .update({ status: 'failed' })
                        .eq('id', pending.id)
                    if (failUpdErr) {
                        // Non-fatal: the row stays 'pending' with hubtel_order_id set, so the CAS
                        // claim still blocks re-fulfilment and the refund upsert is idempotent —
                        // but surface it so a stuck underpaid order is not silently invisible.
                        console.error(`[USSD Status Check] failed-status write error for ${pending.session_id}:`, failUpdErr.message)
                    }
                    // Option B: don't deliver, still tell Hubtel 'success' (no app-download
                    // refund) and queue a team refund of what was ACTUALLY paid.
                    await sendHubtelCallback(pending.session_id, orderId, 'success')
                    const { error: rqErr } = await (supabase.from('ussd_refund_queue') as any).upsert(
                        {
                            session_id:      pending.session_id,
                            user_id:         pending.user_id,
                            mobile:          pending.mobile,
                            service_type:    pending.service_type,
                            amount:          netPaid,
                            payment_method:  'momo',
                            hubtel_order_id: orderId,
                            reason:          `underpayment: paid ${netPaid}, expected ${expectedPrice} (status-check recovery)`,
                            status:          'pending',
                        },
                        { onConflict: 'session_id,payment_method' },
                    )
                    if (rqErr) {
                        // A failed queue write strands the customer's refund with no
                        // durable record — escalate loudly, the push below is best-effort.
                        console.error(`[USSD Status Check] refund-queue write FAILED for ${pending.session_id}:`, rqErr.message)
                        await sendAdminPushNotification({
                            title: 'USSD refund-queue write FAILED',
                            body: `Could not record refund for session ${pending.session_id} (GHS ${netPaid}, ${pending.mobile}). Refund manually and investigate: ${rqErr.message}`,
                        }).catch(() => {})
                    }
                    await sendAdminPushNotification({
                        title: 'USSD underpayment — refund queued',
                        body: `Session ${pending.session_id}: paid GHS ${netPaid}, expected GHS ${expectedPrice} (status-check recovery). Not delivered; refund queued.`,
                    }).catch(() => {})
                    continue
                }

                // P2-1: use the persisted operator (legacy rows fall back to 'unknown')
                const operator = (pending.operator as string | null) ?? 'unknown'

                const fakeHubtelFulfillment = {
                    SessionId: pending.session_id,
                    OrderId: orderId,
                    ExtraData: {},
                    OrderInfo: {
                        CustomerMobileNumber: pending.mobile,
                        CustomerEmail: null,
                        CustomerName: '',
                        Status: 'Paid',
                        OrderDate: new Date().toISOString(),
                        Currency: 'GHS',
                        Subtotal: Number(pending.price),
                        Items: [{ ItemId: '', Name: '', Quantity: 1, UnitPrice: Number(pending.price) }],
                        Payment: {
                            PaymentType: 'mobilemoney',
                            AmountPaid: Number(pending.price),
                            AmountAfterCharges: Number(statusData.data.amountAfterCharges ?? pending.price),
                            PaymentDate: new Date().toISOString(),
                            PaymentDescription: 'Recovered via status check',
                            IsSuccessful: true,
                        },
                    },
                }

                let result: { success: boolean; error?: string }
                switch (pending.service_type) {
                    case 'data':
                        result = await fulfillDataOrder(
                            supabase, pending.id, pending.session_id, pending.mobile,
                            operator, pending.order_payload as unknown as DataOrderPayload,
                            pending.user_id, fakeHubtelFulfillment,
                        )
                        break
                    case 'results_checker':
                        result = await fulfillRCOrder(
                            supabase, pending.id, pending.session_id, pending.mobile,
                            operator, pending.order_payload as unknown as RCOrderPayload,
                            pending.user_id, fakeHubtelFulfillment,
                        )
                        break
                    case 'afa':
                        result = await fulfillAFAOrder(
                            supabase, pending.id, pending.session_id, pending.mobile,
                            operator, pending.order_payload as unknown as AFAOrderPayload,
                            pending.user_id, fakeHubtelFulfillment,
                        )
                        break
                    case 'airtime':
                    case 'mashup':
                        // Same fulfillment function for both — fulfillAirtimeUSSDOrder branches
                        // internally on orderPayload.orderType (mirrors app/api/ussd/fulfill/route.ts).
                        result = await fulfillAirtimeUSSDOrder(
                            supabase, pending.id, pending.session_id, pending.mobile,
                            operator, pending.order_payload as unknown as AirtimeOrderPayload,
                            pending.user_id, fakeHubtelFulfillment,
                        )
                        break
                    case 'utility':
                        result = await fulfillUtilityUSSDOrder(
                            supabase, pending.id, pending.session_id, pending.mobile,
                            operator, pending.order_payload as unknown as UtilityOrderPayload,
                            pending.user_id, fakeHubtelFulfillment,
                        )
                        break
                    default:
                        result = { success: false, error: 'unknown service type' }
                }

                // Option B: always 'success' to Hubtel; a failure goes to the team
                // refund queue (idempotent on session+method) instead of a Hubtel refund.
                await sendHubtelCallback(pending.session_id, orderId, 'success')
                if (result.success) {
                    fulfilled++
                } else {
                    failed++
                    await supabase
                        .from('ussd_pending_orders')
                        .update({ status: 'failed' })
                        .eq('id', pending.id)
                    const { error: failRqErr } = await (supabase.from('ussd_refund_queue') as any).upsert(
                        {
                            session_id:      pending.session_id,
                            user_id:         pending.user_id,
                            mobile:          pending.mobile,
                            service_type:    pending.service_type,
                            amount:          Number(pending.price),
                            payment_method:  'momo',
                            hubtel_order_id: orderId,
                            reason:          result.error ?? 'fulfillment failed (status-check recovery)',
                            status:          'pending',
                        },
                        { onConflict: 'session_id,payment_method' },
                    )
                    if (failRqErr) {
                        console.error(`[USSD Status Check] refund-queue write FAILED for ${pending.session_id}:`, failRqErr.message)
                        await sendAdminPushNotification({
                            title: 'USSD refund-queue write FAILED',
                            body: `Could not record refund for session ${pending.session_id} (GHS ${Number(pending.price)}, ${pending.mobile}). Refund manually and investigate: ${failRqErr.message}`,
                        }).catch(() => {})
                    }
                    await sendAdminPushNotification({
                        title: 'USSD order paid but not delivered',
                        body: `${pending.service_type} GHS ${Number(pending.price)} for ${pending.mobile} failed (status-check recovery) — refund needed. Session ${pending.session_id}.`,
                    }).catch(() => {})
                }
            } else if (
                (txStatus === 'unpaid' || txStatus === 'refunded') &&
                new Date(pending.expires_at) < new Date()
            ) {
                // VERIFIED terminal: Hubtel confirms no settled payment and the
                // MoMo window is over. This is the only routine expiry path —
                // a row is never expired without at least one Hubtel verdict.
                await supabase
                    .from('ussd_pending_orders')
                    .update({ status: 'expired' })
                    .eq('id', pending.id)
                    .eq('status', 'pending')
                    .is('hubtel_order_id', null)
                expired++
            } else if (txStatus !== 'paid' && txStatus !== 'unpaid' && txStatus !== 'refunded') {
                // Unknown/absent status — treat as a poll failure, retry next run.
                console.warn(`[USSD Status Check] Unrecognized Hubtel status '${txStatus}' for ${pending.session_id}`)
                pollErrors++
            }
        } catch (err) {
            console.error('[USSD Status Check] Error for session', pending.session_id, err)
            pollErrors++
        }
        }
    }

    // 48h backstop for rows whose polls kept erroring (unclaimed only).
    await expireOldPendingOrders(supabase)

    // Every poll in the run failed → the recovery rail itself is down
    // (proxy/DO droplet, Hubtel status API, or network). Without this alert that
    // failure mode is indistinguishable from "nothing to recover".
    if (checked > 0 && pollErrors === checked) {
        await sendAdminPushNotification({
            title: 'USSD status-check polls ALL failing',
            body: `${pollErrors}/${checked} Hubtel status polls failed this run — check the DigitalOcean proxy / Hubtel status API. Pending orders are NOT being recovered or expired.`,
        }).catch(() => {})
    }

    // ── Drain ussd_callback_retry_queue (unrelated to the stale-pending loop above —
    // these are orders that were ALREADY fulfilled, only their Hubtel ack failed).
    // Reuses whatever time budget is left in this same cron run. Wrapped so an
    // unexpected throw here can't turn job 1's already-committed results into an opaque
    // 500 — the response always reflects what job 1 actually did.
    let callbackRetryResult: { checked: number; resolved: number; stillFailing: number; escalated: number } | null = null
    let callbackRetryError: string | undefined
    try {
        callbackRetryResult = await drainCallbackRetryQueue(supabase, runStartedAt, TIME_BUDGET_MS)
    } catch (err) {
        console.error('[USSD Status Check] Callback-retry drain threw:', err)
        callbackRetryError = (err as any)?.message || 'unknown error'
    }

    return NextResponse.json({
        checked, of: stalePending?.length ?? 0, fulfilled, failed, expired, pollErrors,
        callbackRetries: callbackRetryResult,
        ...(callbackRetryError ? { callbackRetryError } : {}),
    })
}
