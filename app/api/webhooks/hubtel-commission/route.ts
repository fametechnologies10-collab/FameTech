import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual, createHmac } from 'crypto'
import { waitUntil } from '@vercel/functions'
import { createServerClient } from '@/lib/supabase'
import { parseCommission } from '@/lib/hubtel-commission-service'
import { isUtilityReference, UTILITY_BILLERS, type UtilityBiller } from '@/lib/hubtel-utility/billers'
import { classifyResponseCode, CommissionOutcome } from '@/lib/hubtel-utility/service'
import { syncAirtimeShopMirror } from '@/lib/airtime-fulfillment'
import { categorizeFailure, autoRefundApiOrderOnFailure } from '@/lib/api-order-failure'

// Strip a "-r{n}" retry suffix to recover the base reference_code.
function baseRef(clientReference: unknown): string {
    return String(clientReference || '').replace(/-r\d+$/, '')
}

export async function POST(request: NextRequest) {
    // Fail-closed auth. Hubtel sends NO signature/secret header, so we authenticate via a
    // per-request HMAC carried in the CallbackUrl we issued (?ref&ts&sig) — the secret is NEVER
    // transmitted, so a logged URL can't forge other orders or replay after the window. A static
    // x-hubtel-commission-secret header is also accepted if Hubtel ever supports one. See ref doc §6.
    const expectedSecret = process.env.HUBTEL_COMMISSION_WEBHOOK_SECRET || ''
    if (!expectedSecret) {
        console.error('[HubtelCommission] Rejected: HUBTEL_COMMISSION_WEBHOOK_SECRET not configured')
        return NextResponse.json({ success: false, error: 'Webhook not configured' }, { status: 503 })
    }

    const tsEq = (a: string, b: string) => {
        const ab = Buffer.from(a), bb = Buffer.from(b)
        return ab.length === bb.length && timingSafeEqual(ab, bb)
    }

    // Per-request HMAC carried in the CallbackUrl we issued (?ref&ts&sig). The secret is never
    // transmitted; the sig is order-bound and time-bounded. No static-header path: Hubtel sends
    // none, and a static secret would be a weaker, replayable, non-order-bound credential.
    const sp = request.nextUrl.searchParams
    const urlRef = sp.get('ref') || ''
    const urlTs = sp.get('ts') || ''
    const urlSig = sp.get('sig') || ''

    let authedRef: string | null = null
    // Attempt number this specific callback was issued for, recovered from the HMAC-verified raw
    // urlRef BEFORE baseRef() strips the "-r{n}" suffix. Used only by the utility branch's
    // stale-failure-callback guard below (see handleUtilityCallback); null for legacy/unsuffixed refs.
    let callbackAttempt: number | null = null
    if (urlRef && /^\d+$/.test(urlTs) && urlSig) {
        const age = Date.now() - Number(urlTs)
        if (age >= -60_000 && age < 24 * 60 * 60 * 1000) { // ≤1min future skew, <24h old
            const expectedSig = createHmac('sha256', expectedSecret).update(`${urlRef}.${urlTs}`).digest('hex')
            // baseRef strips a -r{n} suffix; called AFTER HMAC verify (HMAC is over the raw urlRef) — keep this order.
            if (tsEq(urlSig, expectedSig)) {
                authedRef = baseRef(urlRef)
                const attemptMatch = urlRef.match(/-r(\d+)$/)
                callbackAttempt = attemptMatch ? parseInt(attemptMatch[1], 10) : null
            }
        }
    }
    if (!authedRef) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    let payload: any
    try { payload = await request.json() } catch {
        return NextResponse.json({ success: false, error: 'Invalid payload' }, { status: 400 })
    }

    try {
        const data = payload?.Data || {}
        const rc = String(payload?.ResponseCode ?? '')
        // Action is bound to the HMAC-authenticated ref from the URL, NOT the (unauthenticated) body —
        // so a captured valid token for one order can't finalize a different order via a forged body.
        const ref = authedRef
        if (!ref) return NextResponse.json({ success: true }, { status: 200 })

        const supabase = createServerClient()

        // Single source of truth for Hubtel response-code semantics — shared by both the
        // utility branch below and the (re-routed) airtime branch further down.
        const outcome = classifyResponseCode(payload?.ResponseCode, data?.Description ?? payload?.Message)

        // ── Utility bills (UTIL-<biller>-<hex>) — routed separately from airtime ────────
        if (isUtilityReference(ref)) {
            // `await` is load-bearing: a bare `return <promise>` would escape this try/catch on a
            // later rejection inside the handler (e.g. a supabase call rejecting), breaking the
            // always-200 guarantee to Hubtel for utility callbacks specifically.
            return await handleUtilityCallback(supabase, ref, rc, data, outcome, callbackAttempt)
        }

        const { data: order } = await (supabase.from('airtime_orders') as any)
            .select('id, status, fulfillment_metadata, user_id, reference_code, source, api_key_id')
            .eq('reference_code', ref).maybeSingle()
        if (!order) return NextResponse.json({ success: true }, { status: 200 })

        const meta = { ...(order.fulfillment_metadata || {}) }

        if (outcome === 'completed') {
            const commission = parseCommission(data?.Meta)
            // Atomic finalize: only transition a processing order. Callback Meta.Commission
            // is canonical -- always write it when present (mirrors handleUtilityCallback).
            const { data: updated } = await (supabase.from('airtime_orders') as any)
                .update({
                    status: 'completed',
                    fulfilled_at: new Date().toISOString(),
                    ...(data?.TransactionId ? { fulfillment_request_id: data.TransactionId } : {}),
                    fulfillment_metadata: { ...meta, response_code: '0000', ...(commission !== undefined ? { commission } : {}), callback: data },
                    ...(commission !== undefined ? { commission_amount: commission } : {}),
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id).in('status', ['processing', 'pending']).select('id')

            if (!updated || updated.length === 0) {
                // Zero rows matched either because this order was already 'completed'
                // (harmless, existing behavior) OR because it's now 'refunded' — a very
                // late success callback arriving after this order was already auto-refunded
                // on an earlier definitive-failure signal. The second case needs a human,
                // not silence: the buyer may now have BOTH their money back AND (per this
                // callback) a delivered top-up.
                const { data: freshRow } = await (supabase.from('airtime_orders') as any)
                    .select('status').eq('id', order.id).maybeSingle()
                if (freshRow?.status === 'refunded') {
                    try {
                        const { sendAdminPushNotification } = await import('@/lib/push-service')
                        await sendAdminPushNotification({
                            title: 'Hubtel reported success on an already-refunded airtime order',
                            body: `Order ${ref} was auto-refunded on an earlier failure signal, but Hubtel's callback now reports delivery — reconcile manually.`,
                            url: '/admin/airtime',
                        })
                    } catch (e) { console.error('[HubtelCommission] airtime late-success-after-refund push failed:', e) }
                }
            }

            // Late canonical-commission fill: the finalize above matched 0 rows when the order
            // was already 'completed' (e.g. a sync-dispatch beat this callback to it) -- this
            // callback may be the first arrival of the real commission value. Never overwrites
            // an existing commission_amount, never changes status. Mirrors handleUtilityCallback.
            if ((!updated || updated.length === 0) && commission !== undefined) {
                await (supabase.from('airtime_orders') as any)
                    .update({
                        commission_amount: commission,
                        fulfillment_metadata: { ...meta, callback: data, commission_filled_via: 'late_callback' },
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', order.id).eq('status', 'completed').is('commission_amount', null)
            }

            // Fire-safe, idempotent, unconditional: no-ops instantly for non-'api' sources and
            // for orders with no commission_amount yet (the late-fill branch above may need to
            // land first, on a subsequent callback, before this can credit anything).
            try {
                const { error: creditError } = await (supabase as any).rpc('credit_airtime_commission', { p_airtime_order_id: order.id })
                if (creditError) console.error('[HubtelCommission] airtime credit_airtime_commission failed:', creditError.message, 'order:', order.id)
            } catch (e) { console.error('[HubtelCommission] airtime credit_airtime_commission failed:', e) }

            if (updated && updated.length > 0) {
                // Shop sync for shop-attributed refs: same syncAirtimeShopMirror() used
                // by the failure branches below (and by dispatchAirtimeFulfillment for
                // the synchronous-completion path) — it updates BOTH the `orders` mirror
                // row AND `shop_orders`. This branch used to call syncShopOrderStatus()
                // instead, which only updates `shop_orders`/`airtime_orders` and never
                // writes back to `orders.status` — leaving the `orders` ledger row (read
                // by the admin fulfillment center, the registered-user dashboard, and the
                // developer API) stuck on 'pending' forever even though the shop owner's
                // own view correctly showed 'completed'. Found live 2026-09-25: 53 shop
                // airtime orders stuck this way since 2026-09-16.
                if (ref.startsWith('SHOP-') || ref.startsWith('USSD-AIR-')) {
                    syncAirtimeShopMirror(supabase, ref, 'completed').catch(() => {})
                }
                // User notification (skip for guest USSD orders with no account)
                if (order.user_id) {
                    ;(supabase.from('notifications') as any).insert({
                        user_id: order.user_id,
                        title: 'Airtime Delivered',
                        message: `Your airtime order ${ref} has been delivered.`,
                        type: 'order_update',
                        action_url: '/dashboard/airtime',
                    }).then(() => {}).catch(() => {})
                }
            }
            return NextResponse.json({ success: true }, { status: 200 })
        }

        // Non-success callback: NO refund. Classify by response-code outcome (authoritative
        // table in lib/hubtel-utility/service.ts — shared with the utility branch above).
        // A 'pending' outcome (rc 0001) is not a final state — leave the order processing and await the final callback.
        if (outcome === 'pending') {
            return NextResponse.json({ success: true }, { status: 200 })
        }
        // 'unknown' (rc 0005 — state UNKNOWN): NEVER terminal-fail. Leave the order in-flight,
        // merge a metadata note, and alert admins — replaces the old behavior where 0005 fell
        // through to the terminal-failed branch below and was misreported as a definitive failure.
        if (outcome === 'unknown') {
            await (supabase.from('airtime_orders') as any)
                .update({
                    fulfillment_metadata: { ...meta, response_code: rc, unknown_state: true, callback: data },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id).neq('status', 'completed')
            if (!meta.manual) {
                try {
                    const { sendAdminPushNotification } = await import('@/lib/push-service')
                    await sendAdminPushNotification({
                        title: 'Airtime order unknown state',
                        body: `Order ${ref}: Hubtel 0005 unknown state — status check will resolve; contact RSE if it persists.`,
                        url: '/admin/airtime',
                    })
                } catch { /* best-effort */ }
            }
            return NextResponse.json({ success: true }, { status: 200 })
        }
        if (outcome === 'insufficient_float') {
            // Retryable (insufficient-float / transient). The retry uses a fresh unique ClientReference and is
            // gated by the priorAttemptVerdict() double-send guard in lib/airtime-fulfillment.ts.
            await (supabase.from('airtime_orders') as any)
                .update({
                    status: 'pending',
                    fulfillment_metadata: { ...meta, response_code: rc, callback: data },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id).eq('status', 'processing')
            // Insufficient prepaid balance — pause auto-fulfillment so we stop burning attempts +
            // alerts until an admin tops up the float and resumes.
            await (supabase.from('admin_settings') as any).upsert({ key: 'hubtel_commission_paused', value: 'true' }, { onConflict: 'key' })
        } else if (outcome === 'config_error') {
            // 4101/4103 — credentials/permission problem, NOT float. Same revert+pause DB shape as
            // insufficient_float above, but the wording below is credentials-specific (previously
            // lumped into the generic 4xxx=float bucket, misreporting the real cause to admins).
            await (supabase.from('airtime_orders') as any)
                .update({
                    status: 'pending',
                    fulfillment_metadata: { ...meta, response_code: rc, callback: data },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id).eq('status', 'processing')
            await (supabase.from('admin_settings') as any).upsert({ key: 'hubtel_commission_paused', value: 'true' }, { onConflict: 'key' })
        } else if (outcome === 'permanent_failure' || outcome === 'failed') {
            // Definitive failure (permanent_failure / failed) — terminal, do NOT loop.
            const { data: updated } = await (supabase.from('airtime_orders') as any)
                .update({
                    status: 'failed',
                    fulfillment_metadata: { ...meta, response_code: rc, callback: data },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id).eq('status', 'processing').select('id')
            if (ref.startsWith('SHOP-') || ref.startsWith('USSD-AIR-')) {
                syncAirtimeShopMirror(supabase, ref, 'failed').catch(() => {})
            }
            if (updated && updated.length > 0) {
                const { code: reasonCode, message: reasonMessage } = categorizeFailure(outcome)
                const refund = await autoRefundApiOrderOnFailure(supabase, {
                    product: 'airtime', orderId: order.id, source: order.source, reasonCode, reasonMessage,
                })
                if (order.api_key_id) {
                    const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                    waitUntil(dispatchApiWebhook(supabase, {
                        apiKeyId: order.api_key_id, event: 'order.failed', product: 'airtime',
                        reference: ref.replace(/^API-/, ''), status: refund.refunded ? 'refunded' : 'failed',
                        detail: {
                            reason_code: reasonCode, reason: reasonMessage,
                            ...(refund.refunded ? { refunded: true, refund_amount: refund.amount, new_balance: refund.newBalance } : {}),
                        },
                    }))
                }
            }
        } else {
            // Genuinely UNRECOGNIZED outcome — a future CommissionOutcome member with no explicit
            // branch above. This is now a money path's fallback, so it must NOT silently
            // auto-refund: log loudly instead, and still finalize the order as 'failed' (today's
            // pre-auto-refund behavior for an unmapped outcome) so nothing about order
            // finalization regresses — only the refund/webhook-detail extension is skipped for a
            // code path nobody has vetted yet.
            console.error('[HubtelCommission] unhandled outcome reached default case, no refund triggered:', outcome, 'order:', order.id)
            await (supabase.from('airtime_orders') as any)
                .update({
                    status: 'failed',
                    fulfillment_metadata: { ...meta, response_code: rc, callback: data },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id).eq('status', 'processing')
            if (ref.startsWith('SHOP-') || ref.startsWith('USSD-AIR-')) {
                syncAirtimeShopMirror(supabase, ref, 'failed').catch(() => {})
            }
        }

        // Auto-fulfilled order failed to deliver → web-push the admins (skip manual refulfills — admin is watching).
        if (!meta.manual) {
            try {
                const { sendAdminPushNotification } = await import('@/lib/push-service')
                await sendAdminPushNotification({
                    title: outcome === 'config_error' ? 'Airtime credentials error' : 'Airtime auto-fulfillment failed',
                    body: outcome === 'config_error'
                        ? `Hubtel credentials/permission error (${rc}) on order ${ref} — check API keys. Paused.`
                        : `Order ${ref} did not deliver: ${data?.Description || `ResponseCode ${rc}`}.`,
                    url: '/admin/airtime',
                })
            } catch { /* best-effort */ }
        }
        return NextResponse.json({ success: true }, { status: 200 })
    } catch (error: any) {
        console.error('[HubtelCommission] Unhandled:', error?.message || error, 'rc:', payload?.ResponseCode, 'ref:', payload?.Data?.ClientReference, 'txn:', payload?.Data?.TransactionId)
        return NextResponse.json({ success: true }, { status: 200 })
    }
}

// ── Utility bills callback handler ──────────────────────────────────────────
// Routed from POST above when the HMAC-authenticated ref starts with 'UTIL-'. Mirrors the
// airtime branch's shape (atomic finalize, guarded reverts, MERGE-only metadata writes,
// always-200 to the caller) but targets utility_orders and drives entirely off the shared
// classifyResponseCode() outcome table instead of raw ResponseCode string checks.
async function handleUtilityCallback(
    supabase: ReturnType<typeof createServerClient>,
    ref: string,
    rc: string,
    data: any,
    outcome: CommissionOutcome,
    callbackAttempt: number | null,
): Promise<NextResponse> {
    const { data: order } = await (supabase as any).from('utility_orders')
        .select('id, status, user_id, biller, account_number, amount, fulfillment_metadata, reference_code, destination_phone, fulfillment_attempts, shop_id, source, api_key_id')
        .eq('reference_code', ref).maybeSingle()
    if (!order) return NextResponse.json({ success: true }, { status: 200 })

    const meta = { ...(order.fulfillment_metadata || {}) }

    switch (outcome) {
        case 'completed': {
            const rawTxnId = data?.TransactionId
            const trimmedTxnId = typeof rawTxnId === 'string' ? rawTxnId.trim() : rawTxnId
            const callbackCommission = parseCommission(data?.Meta)
            // Atomic finalize: only transitions an in-flight row — idempotent vs duplicate callbacks.
            const { data: updated } = await (supabase as any).from('utility_orders')
                .update({
                    status: 'completed',
                    // Callback Meta.Commission is CANONICAL — always write it (?? null forces the key
                    // onto the wire so a callback with no Meta never silently preserves a stale
                    // provisional commission_amount from an earlier sync response).
                    commission_amount: callbackCommission ?? null,
                    ...(trimmedTxnId ? { fulfillment_request_id: trimmedTxnId } : {}),
                    fulfillment_metadata: { ...meta, response_code: rc, callback: data, completed_via: 'callback' },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id).in('status', ['processing', 'pending']).select('id')

            if (!updated || updated.length === 0) {
                const { data: freshRow } = await (supabase as any).from('utility_orders')
                    .select('status').eq('id', order.id).maybeSingle()
                if (freshRow?.status === 'refunded') {
                    try {
                        const { sendAdminPushNotification } = await import('@/lib/push-service')
                        await sendAdminPushNotification({
                            title: 'Hubtel reported success on an already-refunded utility order',
                            body: `Order ${ref} was auto-refunded on an earlier failure signal, but Hubtel's callback now reports delivery — reconcile manually.`,
                            url: '/admin/utilities',
                        })
                    } catch (e) { console.error('[HubtelCommission] utility late-success-after-refund push failed:', e) }
                }
            }

            // Late canonical-commission fill: when the finalize above matched 0 rows, the order was
            // already 'completed' — usually by a sync-dispatch whose POST response may have carried
            // NO Meta.Commission, leaving commission_amount NULL and the credit RPC no-oping ever
            // since. This callback is then the FIRST arrival of the canonical value. Strictly
            // narrower than the finalize: never changes status, never overwrites an existing
            // commission (`.is('commission_amount', null)`), and only attempted when this callback
            // actually carries a parseable commission. Duplicate callbacks match 0 rows here too
            // (commission no longer NULL) — harmless.
            if ((!updated || updated.length === 0) && callbackCommission !== undefined) {
                await (supabase as any).from('utility_orders')
                    .update({
                        commission_amount: callbackCommission,
                        fulfillment_metadata: { ...meta, callback: data, commission_filled_via: 'late_callback' },
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', order.id).eq('status', 'completed').is('commission_amount', null)
            }

            // Fire-safe: credit_utility_commission is idempotent (atomic claim keyed on
            // commission_credited_at IS NULL). Call unconditionally — even when the update above
            // didn't match because a sync-dispatch already completed this order — so a late or
            // duplicate callback can never double-credit but also never gets silently dropped.
            // Composes with the late fill above: the RPC's claim also requires commission_amount
            // NOT NULL, so it no-ops until the fill lands, then credits exactly once.
            try {
                const { data: creditResult, error: creditError } = await (supabase as any)
                    .rpc('credit_utility_commission', { p_utility_order_id: order.id })
                if (creditError) {
                    console.error('[HubtelCommission] utility credit_utility_commission failed:', creditError.message, 'order:', order.id)
                } else if (creditResult?.message) {
                    // The RPC returns success:true with an explanatory message for every no-pay
                    // outcome (role ineligible, no partner, share rounds to zero, already
                    // credited). Log it — without this, a permanently-skipped commission is
                    // indistinguishable from a normal no-commission order when investigating a
                    // disputed payout.
                    console.log('[HubtelCommission] no payout for order', order.id, '—', creditResult.message)
                }
            } catch (e) { console.error('[HubtelCommission] utility credit_utility_commission failed:', e) }

            // Notification + SMS receipt only on the callback that actually finalized the row
            // (mirrors the airtime branch's `if (updated && updated.length > 0)` gate above) —
            // otherwise a retried/duplicate Hubtel callback would spam the user with repeat
            // "delivered" pushes, and the late-commission-fill branch above (which matches 0
            // rows here) must never re-fire either.
            if (updated && updated.length > 0) {
                if (order.user_id) {
                    ;(supabase.from('notifications') as any).insert({
                        user_id: order.user_id,
                        title: 'Bill Payment Successful',
                        message: `Your ${order.biller} payment (${order.reference_code}) has been delivered.`,
                        type: 'order_update',
                        action_url: '/dashboard/utilities',
                    }).then(() => {}).catch(() => {})
                }
                // Task B6: SMS receipt. Fully fire-and-forget (never awaited) — the always-200
                // response to Hubtel must never wait on or fail from SMS delivery.
                // sendUtilityCompletionSMS never throws on its own, but the .catch here is a
                // second, independent guarantee, matching this file's other fire-and-forget calls.
                sendUtilityCompletionSMS(supabase, order)
                    .catch((err) => console.error('[HubtelCommission] utility completion SMS dispatch failed:', err))
            }
            break
        }
        case 'pending':
            break // not a final state — await the final callback
        case 'unknown': {
            // 0005 state UNKNOWN — never terminal-fail. No status change; merge metadata + alert
            // admins. Guarded against an already-completed row so a stray/late 0005 can never
            // clobber a finalized order's metadata.
            await (supabase as any).from('utility_orders')
                .update({
                    fulfillment_metadata: { ...meta, unknown_state: true, last_unknown_at: new Date().toISOString(), callback: data },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id).neq('status', 'completed')
            try {
                const { sendAdminPushNotification } = await import('@/lib/push-service')
                await sendAdminPushNotification({
                    title: 'Utility order unknown state',
                    body: `Utility ${ref}: Hubtel 0005 unknown state — status check will resolve; contact RSE if it persists.`,
                    url: '/admin/utilities',
                })
            } catch (e) { console.error('[HubtelCommission] utility unknown-state push failed:', e) }
            break
        }
        case 'insufficient_float': {
            await (supabase as any).from('utility_orders')
                .update({
                    status: 'pending',
                    fulfillment_metadata: { ...meta, response_code: rc, callback: data },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id).eq('status', 'processing')
            // Insufficient prepaid balance — pause auto-fulfillment (shared flag with airtime)
            // until an admin tops up the float and resumes.
            await (supabase.from('admin_settings') as any).upsert({ key: 'hubtel_commission_paused', value: 'true' }, { onConflict: 'key' })
            try {
                const { sendAdminPushNotification } = await import('@/lib/push-service')
                await sendAdminPushNotification({
                    title: 'Utility auto-fulfillment paused',
                    body: `Hubtel Disbursement float exhausted — utility ${ref} reverted to pending. Top up float.`,
                    url: '/admin/utilities',
                })
            } catch (e) { console.error('[HubtelCommission] utility float-pause push failed:', e) }
            break
        }
        case 'config_error': {
            // 4101/4103 — credentials/permission problem, NOT float. Same revert+pause DB shape as
            // insufficient_float above, but distinctly-worded so admins don't chase a float top-up
            // for what is actually a broken API credential.
            await (supabase as any).from('utility_orders')
                .update({
                    status: 'pending',
                    fulfillment_metadata: { ...meta, response_code: rc, callback: data },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id).eq('status', 'processing')
            await (supabase.from('admin_settings') as any).upsert({ key: 'hubtel_commission_paused', value: 'true' }, { onConflict: 'key' })
            try {
                const { sendAdminPushNotification } = await import('@/lib/push-service')
                await sendAdminPushNotification({
                    title: 'Utility credentials error',
                    body: `Hubtel credentials/permission error (${rc}) on utility ${ref} — check API keys. Paused.`,
                    url: '/admin/utilities',
                })
            } catch (e) { console.error('[HubtelCommission] utility config-error push failed:', e) }
            break
        }
        case 'permanent_failure':
        case 'failed': {
            // Stale-callback guard: this failure callback was issued for an EARLIER attempt than
            // the order's current fulfillment_attempts — a later attempt is (or was) already
            // dispatched/in-flight. Terminal-failing here would race that later attempt: if it
            // later delivers, its 'completed' finalize (`.in('status', ['processing','pending'])`)
            // would match 0 rows against an already-'failed' order, silently losing the delivery in
            // a refundable 'failed' state. Only merge a metadata note and bail — the reconcile cron
            // (or the later attempt's own callback) resolves the live attempt. Only applies when
            // callbackAttempt is known (a "-r{n}"-suffixed ref); a null callbackAttempt (legacy/
            // unsuffixed ref) or a match falls through to the guarded terminal-fail below unchanged.
            if (callbackAttempt !== null && order.fulfillment_attempts !== callbackAttempt) {
                await (supabase as any).from('utility_orders')
                    .update({
                        fulfillment_metadata: {
                            ...meta,
                            stale_failure_callback: {
                                attempt: callbackAttempt,
                                current_attempts: order.fulfillment_attempts,
                                at: new Date().toISOString(),
                            },
                        },
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', order.id).neq('status', 'completed')
                break
            }
            // Terminal failure — persist Data.Description verbatim (alongside the raw callback
            // snapshot, already captured by `callback: data` below) for support/audit visibility.
            const { data: updated } = await (supabase as any).from('utility_orders')
                .update({
                    status: 'failed',
                    fulfillment_metadata: { ...meta, response_code: rc, description: data?.Description ?? null, callback: data },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id).in('status', ['processing', 'pending']).select('id')
            if (updated && updated.length > 0) {
                const { code: reasonCode, message: reasonMessage } = categorizeFailure(outcome)
                const refund = await autoRefundApiOrderOnFailure(supabase, {
                    product: 'utilities', orderId: order.id, source: order.source, reasonCode, reasonMessage,
                })
                if (order.api_key_id) {
                    const { dispatchApiWebhook } = await import('@/lib/api-webhook')
                    waitUntil(dispatchApiWebhook(supabase, {
                        apiKeyId: order.api_key_id, event: 'order.failed', product: 'utilities',
                        reference: ref.replace(/^API-/, ''), status: refund.refunded ? 'refunded' : 'failed',
                        detail: {
                            biller: order.biller, amount: Number(order.amount),
                            reason_code: reasonCode, reason: reasonMessage,
                            ...(refund.refunded ? { refunded: true, refund_amount: refund.amount, new_balance: refund.newBalance } : {}),
                        },
                    }))
                }
            }
            try {
                const { sendAdminPushNotification } = await import('@/lib/push-service')
                await sendAdminPushNotification({
                    title: 'Utility payment failed',
                    body: `Utility ${ref} did not deliver: ${data?.Description || `ResponseCode ${rc}`}.`,
                    url: '/admin/utilities',
                })
            } catch (e) { console.error('[HubtelCommission] utility failure push failed:', e) }
            break
        }
        default: {
            // Genuinely UNRECOGNIZED outcome — a future CommissionOutcome member added to
            // lib/hubtel-utility/service.ts without its own explicit case above. This is now a
            // money path's fallback, so it must NOT silently auto-refund: log loudly instead, and
            // still finalize the order as 'failed' (today's pre-auto-refund behavior for an
            // unmapped outcome) so nothing about order finalization regresses — only the
            // refund/webhook-detail extension is skipped for a code path nobody has vetted yet.
            console.error('[HubtelCommission] unhandled outcome reached default case, no refund triggered:', outcome, 'order:', order.id)

            // Same stale-callback guard as the recognized-failure case above.
            if (callbackAttempt !== null && order.fulfillment_attempts !== callbackAttempt) {
                await (supabase as any).from('utility_orders')
                    .update({
                        fulfillment_metadata: {
                            ...meta,
                            stale_failure_callback: {
                                attempt: callbackAttempt,
                                current_attempts: order.fulfillment_attempts,
                                at: new Date().toISOString(),
                            },
                        },
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', order.id).neq('status', 'completed')
                break
            }
            // Terminal failure — persist, but deliberately no categorizeFailure/autoRefundApiOrderOnFailure
            // call and no refund-flavored webhook detail for an outcome we don't recognize.
            await (supabase as any).from('utility_orders')
                .update({
                    status: 'failed',
                    fulfillment_metadata: { ...meta, response_code: rc, description: data?.Description ?? null, callback: data },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', order.id).in('status', ['processing', 'pending'])
            try {
                const { sendAdminPushNotification } = await import('@/lib/push-service')
                await sendAdminPushNotification({
                    title: 'Utility payment failed (unrecognized outcome)',
                    body: `Utility ${ref} did not deliver: ${data?.Description || `ResponseCode ${rc}`}. Outcome '${outcome}' is unrecognized — no auto-refund was triggered, review manually.`,
                    url: '/admin/utilities',
                })
            } catch (e) { console.error('[HubtelCommission] utility failure push failed:', e) }
            break
        }
    }

    return NextResponse.json({ success: true }, { status: 200 })
}

// ── Task B6: SMS receipt on completed utility payments ─────────────────────
// Called fire-and-forget (never awaited) from the 'completed' case's finalize-matched
// branch above (`updated.length > 0` only) — never on duplicate callbacks, never on the
// late-commission-fill path. NEVER throws — any failure is logged and swallowed so the
// webhook's always-200 contract to Hubtel is unaffected.
//
// Branches by order source/attribution — this used to send one platform-generic SMS
// unconditionally, which was wrong for two of these three cases:
//   - source='api' (a Commission Services developer's own customer): send NOTHING. The
//     developer already gets their own notification via dispatchApiWebhook's
//     'order.completed' event (see the two call sites above and in lib/utility-fulfillment.ts)
//     — that IS their real notification channel. A platform-branded "KFT:" SMS to the
//     developer's own customer is both redundant and leaks the underlying platform's
//     identity into a white-label integration.
//   - shop_id set (a storefront/USSD-shop sale): the SHOP's own sender + SMS credits,
//     via sendShopUtilityConfirmationSMS — same credit-metered, suppress-until-sender,
//     toggle-gated contract every other shop confirmation already uses
//     (lib/sms-confirmation-sender.ts). Never the free platform sender for shop traffic.
//   - everything else (source='dashboard' — a customer paying their own bill directly):
//     unchanged — the original platform-sender SMS via sendSMS.
async function sendUtilityCompletionSMS(
    supabase: ReturnType<typeof createServerClient>,
    order: {
        user_id: string | null
        biller: string
        account_number: string
        amount: number
        reference_code: string
        destination_phone?: string | null
        shop_id?: string | null
        source?: string | null
    },
): Promise<void> {
    try {
        if (order.source === 'api') return // developer's own webhook is the real notification channel

        // Recipient resolution chain (brief order): destination_phone (ecg/ghana_water
        // always carry it) → else the buyer's own phone_number via user_id → else skip
        // silently (e.g. a guest TV purchase with no phone on file — not an error).
        let phone: string | null = order.destination_phone || null
        if (!phone && order.user_id) {
            const { data: buyer } = await (supabase as any).from('users')
                .select('phone_number')
                .eq('id', order.user_id).maybeSingle()
            phone = buyer?.phone_number || null
        }
        if (!phone) return

        const billerLabel = UTILITY_BILLERS[order.biller as UtilityBiller]?.label || order.biller
        const amountStr = Number(order.amount).toFixed(2)
        let message = `KFT: GHS ${amountStr} ${billerLabel} payment for ${order.account_number} successful. Ref: ${order.reference_code}`
        if (order.biller === 'ecg') message += ' Token arrives by SMS from ECG.'

        if (order.shop_id) {
            const { sendShopUtilityConfirmationSMS } = await import('@/lib/sms-confirmation-sender')
            await sendShopUtilityConfirmationSMS(supabase, order.shop_id, phone, message)
            return
        }

        const { sendSMS } = await import('@/lib/sms-service')
        const result = await sendSMS({ recipient: phone, message })
        if (!result.success) {
            console.error('[HubtelCommission] utility completion SMS send failed:', result.error, 'ref:', order.reference_code)
        }
    } catch (err) {
        console.error('[HubtelCommission] utility completion SMS unexpected error (suppressed):', err)
    }
}
