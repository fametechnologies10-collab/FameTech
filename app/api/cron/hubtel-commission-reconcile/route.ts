import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { validateCronAuth } from '@/lib/cron-utils'
import { createServerClient } from '@/lib/supabase'
import { dispatchAirtimeFulfillment } from '@/lib/airtime-fulfillment'
import { dispatchUtilityFulfillment } from '@/lib/utility-fulfillment'
import { checkCommissionStatus } from '@/lib/hubtel-commission-status'
import { settleReceivePaid } from '@/lib/hubtel-receive/settle'
import { categorizeFailure, autoRefundApiOrderOnFailure } from '@/lib/api-order-failure'
import { dispatchApiWebhook } from '@/lib/api-webhook'

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    const supabase = createServerClient()
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
    const autoStatusCheck = (process.env.HUBTEL_COMMISSION_STATUSCHECK_AUTO || '').toLowerCase() === 'true'

    // (a) processing but callback never arrived (>5min) → reconcile via the Hubtel Status Check API.
    // We RECORD the status-check result on every run, but only MOVE money state (complete/fail) when
    // HUBTEL_COMMISSION_STATUSCHECK_AUTO === 'true' (default off) — until the Commission Services
    // status-check contract is validated against a real transaction. We NEVER blind re-dispatch a
    // processing order (double-send risk).
    const { data: stuck } = await (supabase.from('airtime_orders') as any)
        .select('id, reference_code, fulfillment_request_id, fulfillment_metadata, user_id, source, api_key_id')
        .eq('fulfillment_service', 'hubtel-commission')
        .eq('status', 'processing')
        .lt('updated_at', fiveMinAgo)
        .limit(50)

    let statusChecked = 0, autoCompleted = 0, autoFailed = 0
    for (const o of (stuck || [])) {
        if (!o.reference_code) continue // need the ClientReference to status-check
        const result = await checkCommissionStatus(o.fulfillment_metadata?.client_reference || o.reference_code).catch(() => null)
        if (!result) continue
        if (!result.configured) break // not configured (no collection account) → leave the rest for manual review

        statusChecked++
        const meta: Record<string, unknown> = {
            ...(o.fulfillment_metadata || {}),
            status_check: { verdict: result.verdict, http_ok: result.httpOk, at: new Date().toISOString(), error: result.error, raw: result.raw },
        }

        if (autoStatusCheck && result.verdict === 'success') {
            // Commission is captured at dispatch/callback (Meta.Commission); the status-check response has none.
            const { data: done } = await (supabase.from('airtime_orders') as any)
                .update({ status: 'completed', fulfilled_at: new Date().toISOString(), fulfillment_metadata: meta, updated_at: new Date().toISOString() })
                .eq('id', o.id).eq('status', 'processing').select('id')
            if (done?.length) autoCompleted++
        } else if (autoStatusCheck && result.verdict === 'failed') {
            const { data: failed } = await (supabase.from('airtime_orders') as any)
                .update({ status: 'failed', fulfillment_metadata: meta, updated_at: new Date().toISOString() })
                .eq('id', o.id).eq('status', 'processing').select('id')
            if (failed?.length) {
                autoFailed++
                const { code: reasonCode, message: reasonMessage } = categorizeFailure('status_check_failed')
                const refund = await autoRefundApiOrderOnFailure(supabase, {
                    product: 'airtime', orderId: o.id, source: o.source, reasonCode, reasonMessage,
                })
                if (o.api_key_id) {
                    waitUntil(dispatchApiWebhook(supabase, {
                        apiKeyId: o.api_key_id, event: 'order.failed', product: 'airtime',
                        reference: (o.reference_code || '').replace(/^API-/, ''), status: refund.refunded ? 'refunded' : 'failed',
                        detail: {
                            reason_code: reasonCode, reason: reasonMessage,
                            ...(refund.refunded ? { refunded: true, refund_amount: refund.amount, new_balance: refund.newBalance } : {}),
                        },
                    }))
                }
            }
        } else {
            // auto off, or pending/unknown — record the status-check result, leave status untouched.
            await (supabase.from('airtime_orders') as any)
                .update({ fulfillment_metadata: meta, updated_at: new Date().toISOString() })
                .eq('id', o.id).eq('status', 'processing')
        }
    }

    const stuckRemaining = (stuck || []).length - autoCompleted - autoFailed
    if (stuckRemaining > 0) {
        console.warn(`[HubtelCommissionReconcile] ${stuckRemaining} processing order(s) stuck >5min (auto=${autoStatusCheck}) — review /admin/airtime`)
    }

    // (b) pending hubtel orders with attempts remaining → re-dispatch. dispatchAirtimeFulfillment runs the
    // priorAttemptVerdict() double-send guard before sending, so a unique-per-attempt reference stays safe.
    const { data: pending } = await (supabase.from('airtime_orders') as any)
        .select('id')
        .eq('fulfillment_service', 'hubtel-commission')
        .eq('status', 'pending')
        .lt('airtime_fulfillment_attempts', 5)
        .limit(50)

    let dispatched = 0
    for (const o of (pending || [])) {
        try { await dispatchAirtimeFulfillment(o.id); dispatched++ } catch { /* continue */ }
    }

    // ── Utility bills (Pass U-a + U-b) — same reconcile idioms, separate table/pipeline ────────

    // (U-a) processing but callback never arrived (>5min) → reconcile via the Hubtel Status Check
    // API. Same record-always / move-only-on-AUTO gating as the airtime pass above. We NEVER
    // blind re-dispatch a processing order here either — dispatchUtilityFulfillment is only
    // called from Pass U-b below, and only for 'pending' rows.
    const { data: stuckUtil } = await (supabase as any).from('utility_orders')
        .select('id, reference_code, fulfillment_attempts, fulfillment_request_id, fulfillment_metadata, user_id, biller, amount, source, api_key_id')
        .eq('status', 'processing')
        .lt('updated_at', fiveMinAgo)
        .order('updated_at', { ascending: true })
        .limit(50)

    let utilChecked = 0, utilCompleted = 0, utilFailed = 0, utilRecorded = 0
    for (const o of (stuckUtil || [])) {
        const attempts = o.fulfillment_attempts || 0
        if (attempts < 1) {
            // Defensive: a 'processing' row should never have 0 attempts (the atomic claim in
            // dispatchUtilityCore sets attempts alongside the pending→processing flip) — but if
            // it ever does, there is no ClientReference to status-check against.
            await (supabase as any).from('utility_orders')
                .update({
                    fulfillment_metadata: { ...(o.fulfillment_metadata || {}), status_check_skip: { note: 'processing with 0 fulfillment_attempts — no ClientReference to check', at: new Date().toISOString() } },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', o.id).eq('status', 'processing')
            continue
        }
        const clientRef = `${o.reference_code}-r${attempts}`
        const verdict = await checkCommissionStatus(clientRef).catch(() => null)
        if (!verdict) continue
        if (!verdict.configured) break // not configured (no collection account) → leave the rest for manual review

        utilChecked++
        const meta: Record<string, unknown> = {
            ...(o.fulfillment_metadata || {}),
            status_check: { verdict: verdict.verdict, http_ok: verdict.httpOk, found: verdict.found, at: new Date().toISOString(), error: verdict.error, raw: verdict.raw },
        }

        if (autoStatusCheck && verdict.verdict === 'success') {
            // Status-check payload occasionally carries the same Data.TransactionId shape as the
            // callback (samples contain leading spaces — trim like the webhook does); fall back to
            // whatever fulfillment_request_id the order already has when the status check has none.
            const rawTxnId = (verdict.raw as any)?.data?.TransactionId
            const trimmedTxnId = typeof rawTxnId === 'string' ? rawTxnId.trim() : rawTxnId
            const { data: done } = await (supabase as any).from('utility_orders')
                .update({
                    status: 'completed',
                    fulfillment_request_id: trimmedTxnId || o.fulfillment_request_id || null,
                    fulfillment_metadata: { ...meta, completed_via: 'status_check' },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', o.id).in('status', ['processing', 'pending']).select('id')
            if (done?.length) {
                utilCompleted++
                // Commission is unknown from a status check — the RPC no-ops safely while
                // commission_amount is NULL; a late callback still fills it in and credits then.
                // Non-blocking: a credit failure must never fail this cron run, so errors are
                // caught and logged rather than thrown.
                await (supabase as any).rpc('credit_utility_commission', { p_utility_order_id: o.id })
                    .then(({ data: creditResult, error: creditError }: any) => {
                        if (creditError) {
                            console.error('[Utility Commission] credit RPC failed:', creditError.message, 'order:', o.id)
                        } else if (creditResult?.message) {
                            // The RPC returns success:true with an explanatory message for every no-pay
                            // outcome (role ineligible, no partner, share rounds to zero, already
                            // credited). Log it — without this, a permanently-skipped commission is
                            // indistinguishable from a normal no-commission order when investigating a
                            // disputed payout.
                            console.log('[Utility Commission] no payout for order', o.id, '—', creditResult.message)
                        }
                    })
                    .catch((e: any) => console.error('[Utility Commission] credit RPC threw:', e))
                if (o.user_id) {
                    ;(supabase.from('notifications') as any).insert({
                        user_id: o.user_id,
                        title: 'Bill Payment Successful',
                        message: `Your ${o.biller} payment (${o.reference_code}) has been delivered.`,
                        type: 'order_update',
                        action_url: '/dashboard/utilities',
                    }).then(() => {}).catch(() => {})
                }
            }
        } else if (autoStatusCheck && verdict.verdict === 'failed') {
            const { data: failed } = await (supabase as any).from('utility_orders')
                .update({ status: 'failed', fulfillment_metadata: meta, updated_at: new Date().toISOString() })
                .eq('id', o.id).in('status', ['processing', 'pending']).select('id')
            if (failed?.length) {
                utilFailed++
                const { code: reasonCode, message: reasonMessage } = categorizeFailure('status_check_failed')
                const refund = await autoRefundApiOrderOnFailure(supabase, {
                    product: 'utilities', orderId: o.id, source: o.source, reasonCode, reasonMessage,
                })
                if (o.api_key_id) {
                    waitUntil(dispatchApiWebhook(supabase, {
                        apiKeyId: o.api_key_id, event: 'order.failed', product: 'utilities',
                        reference: (o.reference_code || '').replace(/^API-/, ''), status: refund.refunded ? 'refunded' : 'failed',
                        detail: {
                            biller: o.biller, amount: Number(o.amount),
                            reason_code: reasonCode, reason: reasonMessage,
                            ...(refund.refunded ? { refunded: true, refund_amount: refund.amount, new_balance: refund.newBalance } : {}),
                        },
                    }))
                }
            }
        } else {
            // auto off, or pending/unknown — record the status-check result, leave status untouched.
            await (supabase as any).from('utility_orders')
                .update({ fulfillment_metadata: meta, updated_at: new Date().toISOString() })
                .eq('id', o.id).eq('status', 'processing')
            utilRecorded++
        }
    }

    const utilStuckRemaining = (stuckUtil || []).length - utilCompleted - utilFailed
    if (utilStuckRemaining > 0) {
        console.warn(`[HubtelCommissionReconcile] ${utilStuckRemaining} utility order(s) stuck >5min (auto=${autoStatusCheck}) — review /admin/utilities`)
    }

    // (U-b) pending PAID utility orders with attempts remaining → re-dispatch. Unpaid storefront
    // checkout rows must never be selected here (payment_status='paid' is load-bearing).
    // dispatchUtilityFulfillment runs the prior-attempt double-send guard (incl. blocking on an
    // unverifiable/in-flight prior status check) before ever sending, so calling it unconditionally
    // for every eligible row is safe — the pipeline's internal guards do all the safety work.
    const { data: pendingUtil } = await (supabase as any).from('utility_orders')
        .select('id')
        .eq('status', 'pending')
        .eq('payment_status', 'paid')
        .lt('fulfillment_attempts', 5)
        .order('created_at', { ascending: true })
        .limit(50)

    let utilDispatched = 0
    for (const o of (pendingUtil || [])) {
        try { await dispatchUtilityFulfillment(o.id); utilDispatched++ } catch { /* continue */ }
    }

    // ── Hubtel Receive Money (Pass R-a) — payment-settle + confirmed-Unpaid expire ──────────

    // Pending Receive Money charges (>5min) whose callback never arrived → settle via
    // settleReceivePaid, which re-verifies live status through Hubtel's status-check endpoint
    // and only claims+dispatches when the charge is confirmed Paid. A charge is expired ONLY
    // when the SAME status check positively confirms Unpaid (r.statusChecked) past the ~10-min
    // abandonment window — never on a failed/erroring status check (see settleReceivePaid),
    // so a transient Hubtel/network hiccup can never silently expire an already-paid charge.
    const { data: pendingReceive } = await (supabase as any).from('hubtel_receive_charges')
        .select('reference_code, created_at')
        .eq('status', 'pending')
        .lt('created_at', fiveMinAgo)
        .order('created_at', { ascending: true })
        .limit(50)

    let receiveSettled = 0, receiveChecked = 0, receiveExpired = 0
    for (const c of (pendingReceive || [])) {
        receiveChecked++
        try {
            const r = await settleReceivePaid(supabase, c.reference_code)
            if (r.settled) { receiveSettled++; continue }
            // Expire ONLY when Hubtel POSITIVELY confirmed the charge Unpaid (status check succeeded)
            // AND it is past the ~10-min abandonment window (Hubtel's on-phone prompt dies ~5 min, so a
            // confirmed-Unpaid charge this old was never approved). A FAILED check (r.statusChecked false)
            // leaves the charge 'pending' — never silently expired — so a transient hiccup can't lose a
            // genuinely-paid charge. Targeted, status-guarded update: never touches a row a concurrent
            // settle already flipped to 'paid'.
            if (r.statusChecked && r.status === 'Unpaid' && c.created_at < tenMinAgo) {
                const { data: exp } = await (supabase as any).from('hubtel_receive_charges')
                    .update({ status: 'expired' })
                    .eq('reference_code', c.reference_code).eq('status', 'pending').select('id')
                if (exp?.length) receiveExpired++
            }
        } catch { /* continue — next run retries */ }
    }

    return NextResponse.json({
        success: true,
        dispatched,
        statusChecked,
        autoCompleted,
        autoFailed,
        stuckRemaining,
        utilities: {
            checked: utilChecked,
            completed: utilCompleted,
            failed: utilFailed,
            recorded: utilRecorded,
            redispatched: utilDispatched,
        },
        receiveMoney: {
            checked: receiveChecked,
            settled: receiveSettled,
            expired: receiveExpired,
        },
    })
}
