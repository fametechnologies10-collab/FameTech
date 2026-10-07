/**
 * MTN CodeCraft unverified-number fallback.
 *
 * When CodeCraft is the active MTN supplier and rejects an order with its
 * business code 422 ("number not verified" — see BUSINESS_REJECTION_CODES in
 * lib/codecraft-service.ts), the admin can configure ONE other supplier to
 * automatically retry that specific order before it's left pending.
 *
 * Scoped deliberately narrow: MTN only, code 422 only. Every other CodeCraft
 * rejection (low balance, out of stock, system error, etc.), every other
 * network, and every other supplier acting as primary is completely
 * unaffected. (See design rationale in docs/superpowers/specs/ if available —
 * that file is repo-local and may not exist in a fresh clone.)
 */

import type { AnySupplier } from '@/lib/mtn-fallback-dispatch'

// Derived from the shared AnySupplier union (Exclude, not a hand-listed union) so a future
// 8th supplier added to AnySupplier is automatically a valid CodeCraft fallback target without
// this file needing an edit — mirrors lib/mtn-agentportal-fallback.ts and
// lib/mtn-bundleportal-fallback.ts, which already do this. A hand-listed union here previously
// omitted 'hendylinks' after it was added to AnySupplier — VALID_FALLBACK_SUPPLIERS (the runtime
// check) had it, so nothing broke, but the static type was silently out of sync.
export type FallbackSupplier = Exclude<AnySupplier, 'codecraft'>

/** Raw value stored in admin_settings.mtn_codecraft_fallback. */
export type MtnCodecraftFallbackSetting = 'none' | FallbackSupplier

const VALID_FALLBACK_SUPPLIERS: ReadonlySet<string> = new Set(['datakazina', 'xpress', 'ghdata', 'agentportal', 'bundleportal', 'hendylinks'])

/**
 * True only when CodeCraft's response is the specific 422 "number not
 * verified" rejection on an MTN order. Checks the structured apiResponse.status
 * field CodeCraft actually returns — not a formatted display string — so it
 * can't be fooled by wording changes in the human-readable error message.
 */
export function isUnverifiedNumberRejection(network: string, apiResponse: unknown): boolean {
    if (network !== 'MTN') return false
    if (!apiResponse || typeof apiResponse !== 'object') return false
    const status = (apiResponse as Record<string, unknown>).status
    if (status === undefined || status === null) return false
    return Number(status) === 422
}

/**
 * Normalizes the raw admin_settings string value into a typed fallback
 * supplier, or null when there's no fallback configured (the 'none' default,
 * a missing row, or an unrecognized value — fails safe to "no fallback",
 * never assumes a supplier that wasn't explicitly configured).
 */
export function resolveFallbackSupplier(rawValue: string | undefined | null): FallbackSupplier | null {
    if (!rawValue) return null
    if (rawValue === 'none') return null
    if (VALID_FALLBACK_SUPPLIERS.has(rawValue)) return rawValue as FallbackSupplier
    return null
}

export { dispatchToSupplier as dispatchFallbackSupplier, type FallbackDispatchResult } from '@/lib/mtn-fallback-dispatch'
