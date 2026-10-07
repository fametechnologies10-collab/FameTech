// lib/afa-purge-classify.ts
//
// Pure classification logic for app/api/cron/purge-afa-staging/route.ts's phase 1
// (expire abandoned shop_afa_pending_orders rows). Extracted so it can be
// unit-invoked directly with synthetic Paystack responses, rather than only
// exercisable by making real Paystack calls.
//
// The question this answers: given a GET /transaction/verify/{reference}
// response from Paystack, should the staged row be EXPIRED (payment
// definitively did not happen — safe to blank the KYC payload), TOLERATED
// (leave the row untouched — the answer is inconclusive, or Paystack's call
// itself failed), or is the payment SUCCESSFUL (paid but never registered —
// leave untouched AND flag for reconciliation)?
export type AfaVerifyClassification = 'expire' | 'tolerate' | 'success'

/**
 * Classify a Paystack `GET /transaction/verify/{reference}` response.
 *
 * `status` is the HTTP status code. `body` is the parsed JSON response body
 * (or `null` if the body could not be parsed / was empty).
 */
export function classifyAfaVerifyResponse(status: number, body: any | null): AfaVerifyClassification {
    // 5xx — Paystack/infra is having a bad time. Not an answer about the
    // reference at all.
    if (status >= 500) return 'tolerate'

    // 401 (bad/rotated/wrong-mode API key), 403 (permission/blocked), and 429
    // (rate limited — likelier the more rows a single run verifies) are all
    // Paystack telling us the CALL failed, not that the reference doesn't
    // exist. Expiring on these would blank up to MAX_VERIFY_PER_RUN staged
    // KYC payloads because of a misconfigured key or a moment of rate
    // limiting — exactly the harm this cron exists to prevent, through a
    // different door. Deliberately NOT expiry conditions — do not
    // "simplify" this back to a blanket 4xx-expires rule.
    if (status === 401 || status === 403 || status === 429) return 'tolerate'

    // 404 — Paystack has no such transaction. A genuine, unambiguous
    // "reference not found" answer.
    if (status === 404) return 'expire'

    if (status === 400) {
        // Paystack's 400 for an unknown reference carries a message saying so
        // (e.g. "Transaction reference not found"). Read it rather than
        // assuming every 400 means "not found" — an ambiguous 400 (bad
        // request shape, etc.) is tolerated instead, not expired.
        const msg = String(body?.message ?? '').toLowerCase()
        const looksLikeNotFound =
            msg.includes('not found') ||
            msg.includes("doesn't exist") ||
            msg.includes('does not exist') ||
            msg.includes('invalid transaction reference') ||
            msg.includes('reference not found')
        return looksLikeNotFound ? 'expire' : 'tolerate'
    }

    if (status >= 200 && status < 300) {
        if (body?.data?.status === 'success') return 'success'
        // A conclusive 2xx answer that isn't 'success' (e.g. 'failed',
        // 'abandoned') — safe to expire.
        return 'expire'
    }

    // Any other/unexpected status (3xx, other 4xx like 402/422) — an
    // inconclusive answer. Safer default is to tolerate than to risk
    // blanking recoverable KYC on a status we don't understand.
    return 'tolerate'
}
