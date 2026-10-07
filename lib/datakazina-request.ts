// ── DataKazina request-body builder + express routing (pure, dependency-free) ──
// Kept in its own module — NO Supabase / I/O imports — so the buy-data-package
// payload logic is unit-testable in plain Node (see scripts/test-mtn-express.ts)
// and reusable from lib/fulfillment-service.ts without circular/side-effect risk.

// DataKazina models "same telco, different product line" as distinct network_id
// values (e.g. AT-iShare=1, AT-BigTime=4). MTN Express is its own product line:
// network_id 6 (volumes 1–50GB, package ids 50–64), separate from normal MTN
// (network_id 3). "Express delivery using package id 6" = route via network_id 6.
// Confirmed against the live package catalog + supplier (2026-06-22). NOTE: the
// supplier silently IGNORES an unknown package_id body field, so express MUST be
// triggered by switching network_id — not by adding a field.
export const MTN_EXPRESS_NETWORK_ID = 6

/**
 * Resolve the effective DataKazina network_id for a fulfillment.
 * MTN-only: when express is enabled, MTN routes via the express product line
 * (network_id 6); every other network and the OFF state keep the normal id.
 */
export function resolveDataKazinaNetworkId(
    networkName: string,
    normalNetworkId: number,
    expressEnabled: boolean,
): number {
    return networkName === 'MTN' && expressEnabled ? MTN_EXPRESS_NETWORK_ID : normalNetworkId
}

/**
 * True when DataKazina rejected a placement because `incoming_api_ref` is a DUPLICATE —
 * i.e. they already hold an order under this reference. Lives in this dependency-free module
 * (rather than lib/fulfillment-service.ts, which imports Supabase at module load) so the rule
 * is unit-testable in plain Node — see scripts/test-datakazina-duplicate-reference.ts.
 *
 * Observed live response (2026-08-20):
 *   HTTP 422 {"message":"Duplicate order reference detected.",
 *             "errors":{"incoming_api_ref":["Duplicate order reference detected."]}}
 *
 * Because buildDataPackageRequestBody above always sends the PLAIN order id as
 * incoming_api_ref, this rejection proves THIS order was already submitted to DataKazina —
 * and may already have been delivered and charged.
 *
 * Primary check is the STRUCTURED field-level error keyed on `incoming_api_ref` — the same
 * "read structured fields, never the human-readable message" discipline the supplier
 * classifiers elsewhere in this codebase follow. A narrowly-scoped message check is kept as a
 * secondary net, gated on 422, because the two failure modes here are wildly asymmetric:
 *   - MISSING a duplicate (false negative) → order reverts to pending, is re-dispatched
 *     forever, and can be routed to another supplier and DELIVERED TWICE. Real money lost.
 *   - Over-matching (false positive) → order parks in 'processing' with an admin alert for a
 *     human to look at. Mildly annoying, zero money at risk.
 * Given that asymmetry, erring slightly broad is the correct trade.
 */
export function isDuplicateReferenceRejection(httpStatus: number, data: any): boolean {
    if (httpStatus !== 422) return false
    if (!data || typeof data !== 'object') return false

    // Structured (preferred): Laravel-style field errors naming our idempotency field.
    const fieldErrors = (data as Record<string, any>).errors
    if (fieldErrors && typeof fieldErrors === 'object' && 'incoming_api_ref' in fieldErrors) {
        return true
    }

    // Secondary net: top-level message explicitly naming a duplicate.
    const message = (data as Record<string, any>).message
    return typeof message === 'string' && message.toLowerCase().includes('duplicate')
}

export interface BuildDataPackageBodyArgs {
    normalizedPhone: string
    networkId: number
    volumeNumber: number
    orderId: string
    // Accepted for call-site parity with the other supplier services but intentionally
    // unused here — see the `incoming_api_ref` comment below for why.
    dispatchKey?: string
    // orders.retry_count at dispatch time. See buildIncomingApiRef below. Defaults to 0,
    // which reproduces the pre-2026-08-20 reference byte-for-byte, so any call site that
    // does not pass it degrades to exactly the old behaviour rather than to something worse.
    attemptNo?: number
}

/**
 * Builds the `incoming_api_ref` DataKazina dedupes on.
 *
 * DataKazina permanently records this value and rejects any resubmission of it with
 * HTTP 422 "Duplicate order reference detected" — even when their own earlier attempt
 * FAILED (confirmed 2026-08-20 against their dashboard: two failed orders on record for
 * the same recipient, and a third submission blocked). Because the reference used to be
 * the bare order id, an admin retry of a failed order resubmitted the identical reference
 * and was rejected forever — the order could never be fulfilled by DataKazina again.
 *
 * Keying the suffix on `orders.retry_count` is what makes this correct, because that column
 * is written EXCLUSIVELY by the claim_order_retry RPC (verified across the codebase — every
 * other retry_count write targets mtn_fulfillment_tracking, a different table). That gives
 * both behaviours we need from one value:
 *
 *   - The re-fulfillment cron re-dispatching a still-pending order does NOT touch
 *     retry_count, so it keeps sending the SAME reference and DataKazina's duplicate guard
 *     still protects us from the cron creating a new supplier order every couple of minutes.
 *   - A deliberate admin/user retry DOES increment retry_count, so it sends a NEW reference
 *     and is accepted.
 *
 * Deliberate retries cannot be spammed into duplicates: claim_order_retry takes a row lock
 * (SELECT ... FOR UPDATE), only accepts orders in 'failed'/'refunded', flips the order to
 * 'pending' on success (making it immediately non-retryable), and order_retry_attempts
 * carries UNIQUE (source_order_id, attempt_no). retry_count therefore increments at most
 * once per genuine retry — which scripts/test-retry-concurrency.ts already asserts.
 *
 * attemptNo 0 returns the bare order id, identical to the original implementation, so no
 * previously-dispatched order changes shape.
 */
export function buildIncomingApiRef(orderId: string, attemptNo?: number): string {
    const n = Number(attemptNo)
    if (!Number.isFinite(n) || n <= 0) return orderId
    return `${orderId}-r${Math.floor(n)}`
}

/**
 * Build the /buy-data-package request body. The express vs normal choice is made
 * upstream by selecting networkId (3 normal / 6 express) — the body shape itself
 * is identical: recipient + network_id + shared_bundle (volume) + ref. No package_id.
 */
export function buildDataPackageRequestBody(args: BuildDataPackageBodyArgs): Record<string, any> {
    return {
        recipient_msisdn: args.normalizedPhone,
        network_id: args.networkId,
        shared_bundle: args.volumeNumber,
        // NEVER dispatchKey — DataKazina echoes this field back verbatim and the webhook
        // resolves the order from it, so it must stay derivable back to the order id.
        // buildIncomingApiRef keeps the order id as a whole, dash-delimited prefix precisely
        // so app/api/webhooks/dakazina/route.ts can still recover it (see
        // extractOrderIdCandidates there).
        incoming_api_ref: buildIncomingApiRef(args.orderId, args.attemptNo),
    }
}
