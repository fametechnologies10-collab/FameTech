/**
 * Hubtel Receive Money — re-verify-before-credit settlement core.
 *
 * The single choke point every settle path (webhook callback, status-poll route,
 * cron — see the Receive Money rail plan) funnels through to turn a confirmed
 * CUSTOMER PAYMENT into a fulfilled order. This is UPSTREAM of
 * app/api/webhooks/hubtel-commission/route.ts, which handles the bill-PAYOUT
 * result and is not touched here.
 *
 * Money-safety invariants:
 *  - Re-verify before credit: NEVER settle off a caller's say-so (a webhook body,
 *    a poll request, a cron tick) — always re-checks the charge's live status via
 *    `checkStatus` and proceeds only when it reports a confirmed paid charge.
 *  - Converge-once: `claim_hubtel_receive_paid` (Task 1, SECURITY DEFINER,
 *    service_role-only) atomically flips `hubtel_receive_charges` pending->paid
 *    exactly once. Every caller of this function — webhook, poll, cron — funnels
 *    through the SAME claim, so fulfillment dispatch fires on a fresh claim only,
 *    never on a duplicate/racing call.
 */
import { waitUntil } from '@vercel/functions'
import { dispatchUtilityFulfillment } from '@/lib/utility-fulfillment'
import { checkReceiveMoneyStatus } from '@/lib/hubtel-receive-money'

export type CheckStatusFn = (reference: string) => Promise<{ ok: boolean; paid: boolean; status?: string }>

export interface SettleReceivePaidResult {
    settled: boolean
    serviceType?: string
    orderId?: string
    reason?: string
    statusChecked?: boolean
    status?: string
}

/**
 * Settle a Hubtel Receive Money charge by `reference` (= hubtel_receive_charges
 * .reference_code = the service order's reference_code).
 *
 * `db` is a service-role Supabase client (createServerClient()) — accepted as
 * `any` so a stub can be injected in pure-logic tests. `checkStatus` defaults to
 * the real `checkReceiveMoneyStatus` but is injectable for the same reason.
 *
 * Steps:
 *  1. Re-verify live status. Anything short of a confirmed paid charge
 *     (`ok && paid`) bails WITHOUT touching the claim RPC — a not-yet-paid or
 *     query-failed status must never be treated as a duplicate/settled charge.
 *  2. Atomic claim via `claim_hubtel_receive_paid`. A claim miss (already paid/
 *     failed/expired/refunded, or not_found) is an idempotent no-op — the
 *     charge was already settled by a racing caller, or doesn't exist.
 *  3. On a fresh claim, dispatch fulfillment for the claimed `service_type`.
 *     Only 'utility' is wired in this plan; 'airtime'/'rc' are follow-on work
 *     (those charges cannot exist yet — their Receive Money toggles are OFF).
 */
export async function settleReceivePaid(
    db: any,
    reference: string,
    checkStatus: CheckStatusFn = checkReceiveMoneyStatus,
): Promise<SettleReceivePaidResult> {
    const v = await checkStatus(reference)
    if (!v.ok || !v.paid) {
        // v.ok distinguishes a POSITIVELY-CONFIRMED status (e.g. Unpaid) from a
        // check that simply FAILED (network error/timeout/missing env — v.ok=false).
        // Callers (the reconcile cron) must never expire-by-age on a failed check —
        // only on a confirmed-Unpaid status — so both are surfaced here.
        return { settled: false, reason: 'not_paid', statusChecked: v.ok, status: v.status }
    }

    const claim = await db.rpc('claim_hubtel_receive_paid', { p_reference: reference })
    const claimData = claim?.data
    if (!claimData?.claimed) {
        // Idempotent no-op for a duplicate settle attempt (already paid/failed/etc.)
        // or an unrecognized reference — never dispatch on a claim miss.
        return { settled: false, reason: claimData?.already || claimData?.error || 'not_claimed', statusChecked: true }
    }

    const serviceType: string | undefined = claimData.service_type
    const orderId: string | undefined = claimData.order_id

    switch (serviceType) {
        case 'utility': {
            // Guarded flip mirroring app/api/shop/utility/charge/status/route.ts's idiom.
            // The claim above already guarantees this branch runs at most once, so the
            // flip is best-effort: dispatch fires regardless of whether it matched a row
            // (e.g. a charge whose order was already flipped paid by another path).
            await db.from('utility_orders')
                .update({ payment_status: 'paid' })
                .eq('id', orderId)
                .eq('payment_status', 'unpaid')
                .select('id')

            // Fire-and-forget: never let a fulfillment-side failure block or delay the
            // settle response. Wrapped in its own try/catch so a rejection can never
            // surface as an unhandled promise rejection.
            waitUntil((async () => {
                try {
                    await dispatchUtilityFulfillment(orderId as string)
                } catch (e) {
                    console.error('[HubtelReceive] settle: utility dispatch failed:', e, 'orderId:', orderId)
                }
            })())
            break
        }
        case 'airtime':
        case 'rc':
            // Not wired in this plan — these Receive Money charges cannot exist yet
            // (their toggles are seeded OFF). Follow-on plans add their branches here.
            console.warn(`[HubtelReceive] settle: service_type ${serviceType} not yet wired (follow-on plan)`)
            break
        default:
            console.error(`[HubtelReceive] settle: unknown service_type "${serviceType}" for reference ${reference} — no dispatch`)
            break
    }

    return { settled: true, serviceType, orderId, statusChecked: true, status: v.status }
}
