/**
 * MTN AgentPortal whitelist-rejection fallback.
 *
 * When AgentPortal is the active MTN supplier and rejects a number because it isn't
 * whitelisted yet (the number comes back in AgentPortal's `rejected` array — auto-submitted
 * for enabling, ~24h turnaround, no automatic retry on their side), the admin can configure
 * ONE other supplier to automatically retry that specific order before it's left pending
 * for the full ~24h window.
 *
 * Scoped deliberately narrow, same philosophy as lib/mtn-codecraft-fallback.ts: MTN only,
 * whitelist-rejection only. Every other AgentPortal rejection (insufficient balance,
 * invalid size, network error, etc.), every other network, and every other supplier acting
 * as primary is completely unaffected.
 */

import { dispatchToSupplier, type FallbackDispatchResult, type AnySupplier } from '@/lib/mtn-fallback-dispatch'

export type AgentPortalFallbackSupplier = Exclude<AnySupplier, 'agentportal'>

/** Raw value stored in admin_settings.mtn_agentportal_fallback. */
export type MtnAgentPortalFallbackSetting = 'none' | AgentPortalFallbackSupplier

const VALID_FALLBACK_SUPPLIERS: ReadonlySet<string> = new Set(['datakazina', 'codecraft', 'xpress', 'ghdata', 'bundleportal', 'hendylinks'])

/**
 * True only when AgentPortal's response is a whitelist rejection on an MTN order — checked
 * structurally via the `rejected` array AgentPortal actually returns, not by parsing the
 * human-readable rejection reason string.
 */
export function isWhitelistRejection(network: string, apiResponse: unknown): boolean {
    if (network !== 'MTN') return false
    if (!apiResponse || typeof apiResponse !== 'object') return false
    const rejected = (apiResponse as Record<string, unknown>).rejected
    return Array.isArray(rejected) && rejected.length > 0
}

/**
 * Normalizes the raw admin_settings string value into a typed fallback supplier, or null
 * when there's no fallback configured (the 'none' default, a missing row, an unrecognized
 * value, or 'agentportal' itself — fails safe to "no fallback").
 */
export function resolveFallbackSupplier(rawValue: string | undefined | null): AgentPortalFallbackSupplier | null {
    if (!rawValue) return null
    if (rawValue === 'none') return null
    if (VALID_FALLBACK_SUPPLIERS.has(rawValue)) return rawValue as AgentPortalFallbackSupplier
    return null
}

/**
 * Dispatches ONE order to the given fallback supplier. Thin wrapper over the shared
 * dispatchToSupplier — kept here so call sites only need one import for the
 * AgentPortal-fallback flow, mirroring mtn-codecraft-fallback.ts's own shape.
 */
export async function dispatchFallbackSupplier(
    supplier: AgentPortalFallbackSupplier,
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
