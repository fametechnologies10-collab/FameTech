import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAllowedHubtelIP } from '@/lib/ussd/ip-guard'
import { hasValidUssdCallbackSecret } from '@/lib/ussd/callback-auth'
import { sendHubtelCallback } from '@/lib/ussd/hubtel-callback'
import { completeSession } from '@/lib/ussd/session'
import { fulfillDataOrder, type DataOrderPayload } from '@/lib/ussd/fulfillment/data'
import { fulfillRCOrder, type RCOrderPayload } from '@/lib/ussd/fulfillment/results-checker'
import { fulfillAFAOrder, type AFAOrderPayload } from '@/lib/ussd/fulfillment/afa'
import { fulfillAirtimeUSSDOrder, type AirtimeOrderPayload } from '@/lib/ussd/fulfillment/airtime'
import { fulfillUtilityUSSDOrder, type UtilityOrderPayload } from '@/lib/ussd/fulfillment/utility'
import { sendAdminPushNotification } from '@/lib/push-service'
import type { HubtelFulfillment } from '@/lib/ussd/types'

// =============================================================================
// POST /api/ussd/fulfill — Hubtel Service Fulfillment URL
// Called by Hubtel after the customer pays via MoMo successfully.
// We have 1 hour to process and send the callback.
// =============================================================================

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
)

export async function POST(request: NextRequest): Promise<NextResponse> {
    // ── IP Guard ───────────────────────────────────────────────────────────────
    if (!isAllowedHubtelIP(request)) {
        console.warn('[USSD Fulfill] Rejected from non-Hubtel IP')
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // ── Optional shared-secret second factor (B1) — no-op until env is set ──────
    if (!hasValidUssdCallbackSecret(request)) {
        console.warn('[USSD Fulfill] Rejected: invalid/missing callback secret')
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // ── Parse body ─────────────────────────────────────────────────────────────
    let body: HubtelFulfillment
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    if (!body.SessionId || !body.OrderId) {
        return NextResponse.json({ error: 'Missing SessionId or OrderId' }, { status: 400 })
    }

    // Acknowledge immediately (Hubtel expects fast response)
    // Actual fulfillment happens synchronously since we must send callback within 1h
    console.log('[USSD Fulfill] Received fulfillment for session:', body.SessionId)

    // ── Verify payment succeeded ───────────────────────────────────────────────
    if (!body.OrderInfo?.Payment?.IsSuccessful) {
        console.warn('[USSD Fulfill] Payment not successful for session:', body.SessionId)
        await sendHubtelCallback(body.SessionId, body.OrderId, 'failed')
        return NextResponse.json({ received: true })
    }

    // ── Atomically claim the pending order ─────────────────────────────────────
    // Stamping hubtel_order_id under a conditional WHERE is the idempotency guard:
    // only ONE concurrent Hubtel fulfillment call can claim a still-unclaimed
    // ('pending' + hubtel_order_id IS NULL) order and get the row back. The value
    // we stamp is the same Hubtel OrderId the fulfillment handlers persist, so this
    // is semantically a no-op beyond the lock — no new status / no schema change.
    // orders.reference_code is NOT unique, so without this a duplicate call would
    // create a second order (double supplier charge + double shop credit). A crashed
    // claim stays 'pending' and is reclaimed by the existing pending-order expiry.
    // Claimable states: 'pending' (normal) and 'expired'-but-unclaimed. A live
    // Hubtel callback carrying a successful payment PROVES the money settled,
    // so an expired-unclaimed row must be resurrected and fulfilled — answering
    // 'failed' (the old behaviour) discarded settled money with no order, no
    // shop credit and no refund record. Costs nothing: no polling involved.
    const { data: pendingOrder, error: claimError } = await supabase
        .from('ussd_pending_orders')
        .update({ hubtel_order_id: body.OrderId, claimed_at: new Date().toISOString() })
        .eq('session_id', body.SessionId)
        .in('status', ['pending', 'expired'])
        .is('hubtel_order_id', null)
        // Hubtel callbacks land within ~1h of payment and payment within ~20min
        // of order creation — a callback for a >24h-old row is not a plausible
        // live settlement. Caps how far back a stray/replayed callback can
        // resurrect an expired order. (Security review M-1.)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .select('*')
        .maybeSingle()

    if (claimError) {
        console.error('[USSD Fulfill] Claim query failed:', claimError)
        await sendHubtelCallback(body.SessionId, body.OrderId, 'failed')
        return NextResponse.json({ received: true })
    }

    if (!pendingOrder) {
        // We did not win the claim. Re-read to respond correctly without
        // re-running fulfillment (the winner owns the order).
        const { data: existing } = await supabase
            .from('ussd_pending_orders')
            .select('status, hubtel_order_id')
            .eq('session_id', body.SessionId)
            .maybeSingle()

        const status = (existing as any)?.status as string | undefined
        const claimedBy = (existing as any)?.hubtel_order_id as string | null | undefined
        if (!existing) {
            console.error('[USSD Fulfill] Pending order not found for session:', body.SessionId)
            await sendHubtelCallback(body.SessionId, body.OrderId, 'failed')
        } else if (status === 'fulfilled') {
            console.log('[USSD Fulfill] Already fulfilled (idempotent replay):', body.SessionId)
            await sendHubtelCallback(body.SessionId, body.OrderId, 'success')
        } else if (status === 'failed') {
            console.log('[USSD Fulfill] Already terminal (failed):', body.SessionId)
            await sendHubtelCallback(body.SessionId, body.OrderId, 'failed')
        } else if (status === 'expired' && !claimedBy) {
            // Unreachable in practice (an unclaimed expired row is claimable
            // above); losing the claim race here means another worker took it
            // between our UPDATE and this re-read. Acknowledge only.
            console.log('[USSD Fulfill] Expired row claimed by another worker mid-race:', body.SessionId)
        } else {
            // Claimed and in-flight ('pending' or resurrected 'expired') →
            // another worker owns it and sends the definitive callback.
            console.log('[USSD Fulfill] In-flight on another worker, skipping:', body.SessionId)
        }
        return NextResponse.json({ received: true })
    }

    // ── Defensive amount check ─────────────────────────────────────────────────
    // Hubtel adds its MoMo transaction charge ON TOP of our item price:
    //   AmountPaid         = price + Hubtel charge   (what the customer paid)
    //   AmountAfterCharges = price                   (what we set / receive)
    // So compare against AmountAfterCharges. Only a genuine UNDERPAYMENT is
    // suspicious (tampering / wires crossed); an overage is just Hubtel's fee and
    // must NEVER fail a legitimate order (the original bug compared AmountPaid and
    // failed every charged order). If neither field is present, do not block.
    const expectedPrice = Number((pendingOrder as any).price)
    const afterCharges = body.OrderInfo?.Payment?.AmountAfterCharges
    const amountPaid = body.OrderInfo?.Payment?.AmountPaid
    const netPaid = typeof afterCharges === 'number' ? afterCharges : amountPaid
    if (typeof netPaid === 'number' && netPaid < expectedPrice - 0.01) {
        console.error(
            `[USSD Fulfill] Underpayment for session ${body.SessionId}: net GHS ${netPaid}, expected GHS ${expectedPrice}`,
        )
        await supabase
            .from('ussd_pending_orders')
            .update({ status: 'failed' })
            .eq('session_id', body.SessionId)
        // Option B: don't deliver an underpaid order, but still tell Hubtel 'success'
        // (no app-download Hubtel refund) and queue a team refund of what was actually
        // paid — keeping ALL refunds team-controlled, consistent with the rest of B.
        await sendHubtelCallback(body.SessionId, body.OrderId, 'success')
        const { error: rqErr } = await (supabase.from('ussd_refund_queue') as any).upsert(
            {
                session_id:      body.SessionId,
                user_id:         (pendingOrder as any).user_id,
                mobile:          (pendingOrder as any).mobile,
                service_type:    (pendingOrder as any).service_type,
                amount:          netPaid,
                payment_method:  'momo',
                hubtel_order_id: body.OrderId,
                reason:          `underpayment: paid ${netPaid}, expected ${expectedPrice}`,
                status:          'pending',
            },
            { onConflict: 'session_id,payment_method' },
        )
        if (rqErr) {
            // A failed queue write strands the customer's refund with no durable
            // record — escalate loudly; the underpayment push below still fires.
            console.error(`[USSD Fulfill] refund-queue write FAILED for ${body.SessionId}:`, rqErr.message)
            await sendAdminPushNotification({
                title: 'USSD refund-queue write FAILED',
                body: `Could not record underpayment refund for session ${body.SessionId} (GHS ${netPaid}). Refund manually and investigate: ${rqErr.message}`,
            }).catch(() => {})
        }
        await sendAdminPushNotification({
            title: 'USSD underpayment — refund queued',
            body: `Session ${body.SessionId}: paid GHS ${netPaid}, expected GHS ${expectedPrice}. Not delivered; refund queued.`,
        }).catch(() => {})
        return NextResponse.json({ received: true })
    }

    // ── Dispatch to correct fulfillment handler ────────────────────────────────
    const serviceType = (pendingOrder as any).service_type as string
    const orderPayload = (pendingOrder as any).order_payload as Record<string, unknown>
    const userId = (pendingOrder as any).user_id as string | null
    const mobile = (pendingOrder as any).mobile as string
    // P2-1: operator is now persisted on the pending order; fall back to 'unknown'
    // only for legacy rows saved before the column existed.
    const operator = ((pendingOrder as any).operator as string | null) ?? 'unknown'

    let result: { success: boolean; orderId?: string; error?: string }

    try {
        switch (serviceType) {
            case 'data':
                result = await fulfillDataOrder(
                    supabase,
                    (pendingOrder as any).id,
                    body.SessionId,
                    mobile,
                    operator,
                    orderPayload as unknown as DataOrderPayload,
                    userId,
                    body,
                )
                break

            case 'results_checker':
                result = await fulfillRCOrder(
                    supabase,
                    (pendingOrder as any).id,
                    body.SessionId,
                    mobile,
                    operator,
                    orderPayload as unknown as RCOrderPayload,
                    userId,
                    body,
                )
                break

            case 'afa':
                result = await fulfillAFAOrder(
                    supabase,
                    (pendingOrder as any).id,
                    body.SessionId,
                    mobile,
                    operator,
                    orderPayload as unknown as AFAOrderPayload,
                    userId,
                    body,
                )
                break

            case 'airtime':
            case 'mashup':
                // Same fulfillment function for both — fulfillAirtimeUSSDOrder branches
                // internally on orderPayload.orderType (set by mashup.ts's buildMashupPayload)
                // and never auto-dispatches a mashup order to Hubtel (see Task 3).
                result = await fulfillAirtimeUSSDOrder(
                    supabase,
                    (pendingOrder as any).id,
                    body.SessionId,
                    mobile,
                    operator,
                    orderPayload as unknown as AirtimeOrderPayload,
                    userId,
                    body,
                )
                break

            case 'utility':
                result = await fulfillUtilityUSSDOrder(
                    supabase,
                    (pendingOrder as any).id,
                    body.SessionId,
                    mobile,
                    operator,
                    orderPayload as unknown as UtilityOrderPayload,
                    userId,
                    body,
                )
                break

            default:
                console.error('[USSD Fulfill] Unknown service type:', serviceType)
                result = { success: false, error: 'Unknown service type' }
        }
    } catch (err) {
        console.error('[USSD Fulfill] Handler threw:', err)
        result = { success: false, error: String(err) }
    }

    // ── Send Hubtel callback (mandatory within 1 hour) ─────────────────────────
    // Option B: ALWAYS report 'success' so Hubtel never auto-refunds. Hubtel's
    // refund forces customers to install the Hubtel app to withdraw — bad UX for
    // USSD users — so failed-but-paid orders go to OUR refund queue and the team
    // refunds them. (The only 'failed' we ever send is the underpayment reject
    // above.) ⚠️ Requires Hubtel RSE sign-off before enabling in production.
    await sendHubtelCallback(body.SessionId, body.OrderId, 'success')

    // ── Mark session complete / queue refund ───────────────────────────────────
    if (result.success) {
        await completeSession(supabase, body.SessionId, serviceType)
    } else {
        console.error('[USSD Fulfill] Fulfillment failed:', result.error)
        await supabase
            .from('ussd_pending_orders')
            .update({ status: 'failed' })
            .eq('session_id', body.SessionId)
        // Paid but undelivered → team refund queue (idempotent on session+method).
        const { error: failRqErr } = await (supabase.from('ussd_refund_queue') as any).upsert(
            {
                session_id:      body.SessionId,
                order_id:        result.orderId ?? null,
                user_id:         userId,
                mobile,
                service_type:    serviceType,
                amount:          Number((pendingOrder as any).price),
                payment_method:  'momo',
                hubtel_order_id: body.OrderId,
                reason:          result.error ?? 'fulfillment failed',
                status:          'pending',
            },
            { onConflict: 'session_id,payment_method' },
        )
        if (failRqErr) {
            console.error(`[USSD Fulfill] refund-queue write FAILED for ${body.SessionId}:`, failRqErr.message)
            await sendAdminPushNotification({
                title: 'USSD refund-queue write FAILED',
                body: `Could not record refund for session ${body.SessionId} (${serviceType} GHS ${Number((pendingOrder as any).price)}, ${mobile}). Refund manually and investigate: ${failRqErr.message}`,
            }).catch(() => {})
        }
        await sendAdminPushNotification({
            title: 'USSD order paid but not delivered',
            body: `${serviceType} GHS ${Number((pendingOrder as any).price)} for ${mobile} failed after MoMo payment — refund needed. Session ${body.SessionId}.`,
        }).catch(() => {})
    }

    return NextResponse.json({ received: true })
}
