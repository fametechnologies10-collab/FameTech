// lib/api-order-failure.ts
//
// Shared across airtime and utility bills: classifies a Hubtel failure signal
// into a small, stable, customer-safe reason code (never raw Hubtel text —
// see kingflexy-fulfillment skill checklist item 20: raw supplier text must
// never reach a customer-facing surface), and auto-refunds the buyer's
// wallet for DEVELOPER-API orders only when that failure is genuinely
// definitive.
//
// Deliberately narrow: only two categories today, because Hubtel's own
// failure response codes are documented in this codebase as "INDICATIVE —
// confirm" (docs/reference/hubtel-commission-services.md §6) rather than
// fully mapped. Splitting further later needs no API shape change — just a
// new ReasonCode member and REASON_MESSAGES entry.
import type { CommissionOutcome } from '@/lib/hubtel-utility/service'

export type ReasonCode = 'invalid_request' | 'provider_rejected'

export const REASON_MESSAGES: Record<ReasonCode, string> = {
    invalid_request: 'The request was rejected as invalid (e.g. unsupported destination or amount).',
    provider_rejected: 'The transaction could not be completed by the payment provider.',
}

/**
 * `trigger` is either a webhook CommissionOutcome (only 'permanent_failure' and
 * 'failed' are ever passed here -- every other outcome reverts to pending or
 * stays in-flight and never reaches this function, per the Global Constraints)
 * or the literal 'status_check_failed' for the airtime Status Check API's
 * definitive isFulfilled:false/'unpaid' verdict, which carries no response-code
 * breakdown of its own.
 */
export function categorizeFailure(trigger: CommissionOutcome | 'status_check_failed'): { code: ReasonCode; message: string } {
    const code: ReasonCode = trigger === 'permanent_failure' ? 'invalid_request' : 'provider_rejected'
    return { code, message: REASON_MESSAGES[code] }
}

/**
 * Auto-refund the buyer's wallet for a DEFINITIVELY-FAILED developer-API order.
 * No-ops instantly (returns { refunded: false }) for any non-'api' source --
 * web/shop/USSD order failures are completely untouched by this feature and
 * stay on the existing admin-manual-refund-only policy.
 *
 * Reuses the existing, already-idempotent refund_airtime_wallet /
 * refund_utility_wallet RPCs with p_actor_id = NULL (system-triggered, not an
 * admin action) -- no new RPC, no new concurrency surface: both RPCs already
 * lock the order row (FOR UPDATE) before checking/changing status, so a
 * concurrent admin-triggered refund and this auto-refund can never double-pay.
 */
export async function autoRefundApiOrderOnFailure(
    supabase: any,
    params: {
        product: 'airtime' | 'utilities'
        orderId: string
        source: string | null | undefined
        reasonCode: ReasonCode
        reasonMessage: string
    },
): Promise<{ refunded: boolean; amount?: number; newBalance?: number }> {
    if (params.source !== 'api') return { refunded: false }

    const rpcName = params.product === 'airtime' ? 'refund_airtime_wallet' : 'refund_utility_wallet'
    const idParamName = params.product === 'airtime' ? 'p_order_id' : 'p_utility_order_id'

    try {
        const { data, error } = await (supabase as any).rpc(rpcName, {
            [idParamName]: params.orderId,
            p_actor_id: null,
            p_reason: params.reasonMessage,
        })
        if (error) {
            console.error(`[ApiOrderAutoRefund] ${rpcName} failed:`, error.message, 'order:', params.orderId)
            return { refunded: false }
        }
        const ok = data?.ok === true || data?.success === true
        if (!ok) {
            // already_refunded / not_refundable / etc -- not an error, just nothing new happened.
            if (data?.already_refunded) return { refunded: false }
            console.error(`[ApiOrderAutoRefund] ${rpcName} declined:`, data, 'order:', params.orderId)
            return { refunded: false }
        }
        if (data?.already_refunded) return { refunded: false }
        return {
            refunded: true,
            amount: data?.amount !== undefined ? Number(data.amount) : undefined,
            newBalance: data?.new_balance !== undefined ? Number(data.new_balance) : undefined,
        }
    } catch (e) {
        console.error(`[ApiOrderAutoRefund] ${rpcName} threw:`, e, 'order:', params.orderId)
        return { refunded: false }
    }
}
