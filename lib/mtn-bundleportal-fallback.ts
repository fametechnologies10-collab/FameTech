/**
 * MTN Bundle Portal not-allowlisted fallback.
 *
 * When Bundle Portal is the active MTN supplier and rejects an order because the number
 * isn't yet approved for MTN (`code: 'not_allowlisted'`, HTTP 403 — see
 * docs/reference/bundleportal-developer-api.md), the admin can configure ONE other supplier
 * to automatically retry that specific order before it's left pending.
 *
 * Scoped deliberately narrow, same philosophy as lib/mtn-codecraft-fallback.ts and
 * lib/mtn-agentportal-fallback.ts: MTN only, not_allowlisted only. Every other Bundle Portal
 * rejection (pending_order, network_locked, balance changed, etc.), every other network, and
 * every other supplier acting as primary is completely unaffected.
 */

import { dispatchToSupplier, type FallbackDispatchResult, type AnySupplier } from '@/lib/mtn-fallback-dispatch'

export type BundlePortalFallbackSupplier = Exclude<AnySupplier, 'bundleportal'>

/** Raw value stored in admin_settings.mtn_bundleportal_fallback. */
export type MtnBundlePortalFallbackSetting = 'none' | BundlePortalFallbackSupplier

const VALID_FALLBACK_SUPPLIERS: ReadonlySet<string> = new Set(['datakazina', 'codecraft', 'xpress', 'ghdata', 'agentportal', 'hendylinks'])

/**
 * True only when Bundle Portal's response is the specific not_allowlisted rejection on an
 * MTN order. Checked structurally via the `code` field Bundle Portal actually returns — not
 * by parsing the human-readable message.
 */
export function isNotAllowlistedRejection(network: string, apiResponse: unknown): boolean {
    if (network !== 'MTN') return false
    if (!apiResponse || typeof apiResponse !== 'object') return false
    const code = (apiResponse as Record<string, unknown>).code
    return code === 'not_allowlisted'
}

/**
 * Normalizes the raw admin_settings string value into a typed fallback supplier, or null when
 * there's no fallback configured (the 'none' default, a missing row, 'bundleportal' itself, or
 * an unrecognized value — fails safe to "no fallback").
 */
export function resolveFallbackSupplier(rawValue: string | undefined | null): BundlePortalFallbackSupplier | null {
    if (!rawValue) return null
    if (rawValue === 'none') return null
    if (VALID_FALLBACK_SUPPLIERS.has(rawValue)) return rawValue as BundlePortalFallbackSupplier
    return null
}

/**
 * Dispatches ONE order to the given fallback supplier. Thin wrapper over the shared
 * dispatchToSupplier — kept here so call sites only need one import for the Bundle-Portal-
 * fallback flow, mirroring mtn-agentportal-fallback.ts's own shape.
 */
export async function dispatchFallbackSupplier(
    supplier: BundlePortalFallbackSupplier,
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
