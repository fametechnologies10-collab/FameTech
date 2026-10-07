/**
 * MTN HendyLinks fallback.
 *
 * When HendyLinks is the active MTN supplier and rejects an order with either
 * HTTP 403 ("Recipient phone number is not a verified beneficiary in our system") or
 * HTTP 404 ("Plan not found"), the admin can configure ONE other supplier to automatically
 * retry that specific order before it's left pending.
 * See docs/superpowers/specs/2026-08-19-hendylinks-supplier-design.md.
 *
 * 403 is the direct analogue of CodeCraft's 422 "number not verified" and AgentPortal's
 * "not enabled on MTN yet" whitelist rejection — a per-recipient gate, not a problem with
 * the order itself, so routing it to a supplier that CAN reach that number is exactly the
 * point of this module. It was omitted from the original implementation because the design
 * spec was written before we had a live rejection to read the real status code off; the
 * spec's pre-launch verification item #3 explicitly flagged this as "confirm the real code
 * for an unverified/unregistered number". Confirmed 2026-08-20 from a live order:
 *   [HendyLinks] Order 1be9997a-... not fulfilled. HTTP 403 — Recipient phone number is
 *   not a verified beneficiary in our system and cannot receive an order.
 *
 * Deliberately narrow otherwise, same philosophy as lib/mtn-codecraft-fallback.ts,
 * lib/mtn-agentportal-fallback.ts, and lib/mtn-bundleportal-fallback.ts: MTN only, 403/404
 * only. A 402 (insufficient balance) does NOT trigger this fallback — per the user's
 * explicit decision, that case is left pending for the admin to top up HendyLinks' wallet
 * and let the re-fulfillment cron retry, rather than silently routing MTN volume elsewhere.
 * Every other network, every other HendyLinks rejection, and every other supplier acting as
 * primary is completely unaffected.
 */

import { dispatchToSupplier, type FallbackDispatchResult, type AnySupplier } from '@/lib/mtn-fallback-dispatch'

export type HendyLinksFallbackSupplier = Exclude<AnySupplier, 'hendylinks'>

/** Raw value stored in admin_settings.mtn_hendylinks_fallback. */
export type MtnHendyLinksFallbackSetting = 'none' | HendyLinksFallbackSupplier

const VALID_FALLBACK_SUPPLIERS: ReadonlySet<string> = new Set(['datakazina', 'codecraft', 'xpress', 'ghdata', 'agentportal', 'bundleportal'])

/**
 * True only when network is MTN and the HendyLinks response carried HTTP 403 (recipient not
 * a verified beneficiary) or HTTP 404 (plan not found). HendyLinks' error body has no `code`
 * field to key off (unlike Bundle Portal) — the HTTP status is attached onto apiResponse as
 * `_httpStatus` by lib/hendylinks-service.ts's fulfillOrder, and that's what this reads.
 * Never parses the human-readable `message` string.
 *
 * Note this deliberately reads only `_httpStatus`, which lib/hendylinks-service.ts attaches
 * ONLY on a definite rejection — never on an `ambiguous` outcome. That is what keeps an
 * order HendyLinks may already have charged from being routed to a second supplier and
 * delivered twice; do not widen this to read a status from anywhere else.
 */
const FALLBACK_WORTHY_HTTP_STATUSES: ReadonlySet<number> = new Set([403, 404])

export function isFallbackWorthyRejection(network: string, apiResponse: unknown): boolean {
    if (network !== 'MTN') return false
    if (!apiResponse || typeof apiResponse !== 'object') return false
    const httpStatus = (apiResponse as Record<string, unknown>)._httpStatus
    return typeof httpStatus === 'number' && FALLBACK_WORTHY_HTTP_STATUSES.has(httpStatus)
}

/**
 * Normalizes the raw admin_settings string value into a typed fallback supplier, or null
 * when there's no fallback configured (the 'none' default, a missing row, 'hendylinks'
 * itself, or an unrecognized value — fails safe to "no fallback").
 */
export function resolveFallbackSupplier(rawValue: string | undefined | null): HendyLinksFallbackSupplier | null {
    if (!rawValue) return null
    if (rawValue === 'none') return null
    if (VALID_FALLBACK_SUPPLIERS.has(rawValue)) return rawValue as HendyLinksFallbackSupplier
    return null
}

/**
 * Dispatches ONE order to the given fallback supplier. Thin wrapper over the shared
 * dispatchToSupplier — kept here so call sites only need one import for the
 * HendyLinks-fallback flow, mirroring the other fallback modules' shape.
 */
export async function dispatchFallbackSupplier(
    supplier: HendyLinksFallbackSupplier,
    network: string,
    phoneNumber: string,
    size: string,
    orderId: string,
    // orders.retry_count — forwarded so a DataKazina fallback target builds a retry-unique
    // incoming_api_ref instead of being rejected as a duplicate. Ignored by every other target.
    attemptNo: number = 0
): Promise<FallbackDispatchResult> {
    return dispatchToSupplier(supplier, network, phoneNumber, size, orderId, attemptNo)
}
