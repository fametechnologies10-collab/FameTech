export type AnySupplier = 'datakazina' | 'codecraft' | 'xpress' | 'ghdata' | 'agentportal' | 'bundleportal' | 'hendylinks'

export interface FallbackDispatchResult {
    success: boolean
    error?: string
    apiResponse?: unknown
    reference?: string
    transactionId?: string
    ghdataOrderId?: string
    ghdataShortId?: string
    isRateLimited?: boolean
    // DataKazina only — their own order code, and the exact incoming_api_ref we sent. Both
    // are persisted by the caller so the DataKazina webhook can match on either identifier.
    supplierOrderCode?: string
    sentApiRef?: string
    // Only lib/hendylinks-service.ts ever sets this (the one supplier with no idempotency key
    // on placement) — it means the order may already have been accepted and CHARGED even though
    // success is false. It must survive the trip through this wrapper, otherwise a fallback
    // dispatch to HendyLinks looks like an ordinary definite failure to the caller, which
    // reverts the order to 'pending' and lets the cron re-dispatch into a second charge.
    ambiguous?: boolean
}

/**
 * Dispatches ONE order to the given supplier, reusing that supplier's own existing
 * fulfillOrder() — the exact same function already used when it's the primary supplier for
 * a network. Shared by lib/mtn-codecraft-fallback.ts (422 fallback) and
 * lib/mtn-agentportal-fallback.ts (whitelist-rejection fallback) so the "call fulfillOrder
 * on one of these suppliers" switch exists exactly once. Always single-hop: the target's
 * plain fulfillOrder() is called directly, never its own fallback logic — callers can't
 * chain into a loop.
 */
export async function dispatchToSupplier(
    supplier: AnySupplier,
    network: string,
    phoneNumber: string,
    size: string,
    orderId: string,
    // orders.retry_count — only DataKazina uses it (to build a retry-unique incoming_api_ref
    // so an admin-retried order isn't rejected as a duplicate). Optional; 0 = original shape.
    attemptNo: number = 0
): Promise<FallbackDispatchResult> {
    if (supplier === 'datakazina') {
        const { fulfillOrder } = await import('@/lib/fulfillment-service')
        const r = await fulfillOrder(network, phoneNumber, size, orderId, orderId, attemptNo)
        // `ambiguous` MUST be forwarded here too: DataKazina sets it on a duplicate-reference
        // rejection, and this wrapper is exactly the path a fallback dispatch takes. Dropping
        // it would make "we already submitted this order to DataKazina" look like an ordinary
        // definite failure to the caller, which reverts the order to 'pending' for the cron to
        // re-dispatch — the double-delivery this flag exists to prevent.
        return { success: r.success, error: r.error, apiResponse: r.apiResponse, reference: r.reference, transactionId: r.transactionId, isRateLimited: r.isRateLimited, ambiguous: r.ambiguous, supplierOrderCode: r.supplierOrderCode, sentApiRef: r.sentApiRef }
    }
    if (supplier === 'codecraft') {
        const { fulfillOrder } = await import('@/lib/codecraft-service')
        const r = await fulfillOrder(network, phoneNumber, size, orderId)
        return { success: r.success, error: r.error, apiResponse: r.apiResponse, reference: r.reference, transactionId: r.transactionId, isRateLimited: r.isRateLimited }
    }
    if (supplier === 'xpress') {
        const { fulfillOrder } = await import('@/lib/xpress-service')
        const r = await fulfillOrder(network, phoneNumber, size, orderId)
        return { success: r.success, error: r.error, apiResponse: r.apiResponse, reference: r.reference, transactionId: r.transactionId, isRateLimited: r.isRateLimited }
    }
    if (supplier === 'ghdata') {
        const { fulfillGhDataOrder } = await import('@/lib/ghdata-service')
        const r = await fulfillGhDataOrder(network, phoneNumber, size, orderId)
        return { success: r.success, error: r.error, apiResponse: r.apiResponse, ghdataOrderId: r.ghdataOrderId, ghdataShortId: r.ghdataShortId, isRateLimited: r.isRateLimited }
    }
    if (supplier === 'agentportal') {
        const { fulfillOrder } = await import('@/lib/agentportal-service')
        const r = await fulfillOrder(network, phoneNumber, size, orderId)
        return { success: r.success, error: r.error, apiResponse: r.apiResponse }
    }
    if (supplier === 'bundleportal') {
        const { fulfillOrder } = await import('@/lib/bundleportal-service')
        const r = await fulfillOrder(network, phoneNumber, size, orderId)
        return { success: r.success, error: r.error, apiResponse: r.apiResponse, reference: r.reference, transactionId: r.transactionId, isRateLimited: r.isRateLimited }
    }
    if (supplier === 'hendylinks') {
        const { fulfillOrder } = await import('@/lib/hendylinks-service')
        const r = await fulfillOrder(network, phoneNumber, size, orderId)
        return { success: r.success, error: r.error, apiResponse: r.apiResponse, reference: r.reference, transactionId: r.transactionId, isRateLimited: r.isRateLimited, ambiguous: r.ambiguous }
    }
    throw new Error(`Unknown fallback supplier: ${supplier}`)
}
