// lib/mtn-whitelist-gate.ts
// -----------------------------------------------------------------------------
// MTN AgentPortal whitelist purchase gate.
//
// Manually-toggled gate. It is ON when at least one whitelist server is active
// (mtn_agentportal_whitelist_gate_enabled = Server 1, mtn_bundleportal_whitelist_gate_enabled
// = Server 2; both OFF by default). When on, MTN data-bundle purchases are checked against the
// active server(s) before the buyer is charged: a number registered on ANY active server
// passes, and one that no active server has registered is blocked — the servers auto-submit
// it for registration (no fixed turnaround). See lib/mtn-whitelist-merge.ts for the rule.
//
// Design invariants (mirrors lib/number-registration.ts):
//   * MTN only, non-mashup — every other network/category is always a no-op.
//   * FAIL OPEN — any supplier/DB error never blocks a sale.
//   * PERMANENT allow-cache, kept PER SERVER (lib/mtn-whitelist-server-check.ts) — once a
//     number is confirmed allowed on a server it is never re-checked there, and a number
//     allowed on one server can never satisfy the gate for another. A blocked result is never
//     cached — always re-checked live, since the supplier may register the number at any time.
//   * Independent of number_registration_gate_enabled — this is a separate system.
// -----------------------------------------------------------------------------
import { canonicalizePhone } from '@/lib/number-registration'
import { isMashupCategory } from '@/lib/mashup'
import { normalizeMtnMsisdn } from '@/lib/agentportal-whitelist'
import { getEnabledWhitelistServers, verifyMtnWhitelistMerged } from '@/lib/mtn-whitelist-merge'

export const MTN_WHITELIST_BLOCKED_MESSAGE =
    "This number isn't registered to receive MTN data yet. We've submitted it for registration — please try again soon."

/** True when this order should even be evaluated against the whitelist gate. */
export function shouldEvaluateWhitelistGate(
    network: string | null | undefined,
    category?: string | null,
): boolean {
    if ((network || '').trim().toUpperCase() !== 'MTN') return false
    if (isMashupCategory(category)) return false
    return true
}

/** True when at least one whitelist server is active (60s cache, defaults to OFF if the toggles can't be read). */
export async function isWhitelistGateEnabled(): Promise<boolean> {
    return (await getEnabledWhitelistServers()).length > 0
}

export interface GateResult {
    /** True → block the purchase, do not charge / do not create the order. */
    blocked: boolean
    reason?: string
}

/**
 * Re-canonicalizes ONE AgentPortal result row to our `0XXXXXXXXX` form, so it can be
 * matched against `item.canonicalPhone` (always our canonical form) regardless of
 * whatever format AgentPortal actually echoes back.
 *
 * lib/agentportal-whitelist.ts's `normalized` field is documented as "AgentPortal's own
 * normalized form (falls back to ours when absent)" — i.e. NOT guaranteed to already be
 * our canonical format. Trusting it directly as a map key made the batch gate silently
 * fail-open for every item whenever AgentPortal's echo format differs from ours (see
 * final-review finding). Tries `normalized` first, then falls back to `input`.
 */
export function canonicalKeyFor(result: { normalized: string; input: string }): string | null {
    const fromNormalized = normalizeMtnMsisdn(result.normalized)
    if (fromNormalized.ok) return fromNormalized.msisdn
    const fromInput = normalizeMtnMsisdn(result.input)
    return fromInput.ok ? fromInput.msisdn : null
}

/**
 * Single-number gate check. Safe to call for any order — always returns
 * {blocked:false} for non-MTN/mashup/toggle-off/error. Never throws.
 */
export async function checkMtnWhitelistGate(
    rawPhone: string | null | undefined,
    network: string | null | undefined,
    category?: string | null,
): Promise<GateResult> {
    try {
        if (!shouldEvaluateWhitelistGate(network, category)) return { blocked: false }
        if (!(await isWhitelistGateEnabled())) return { blocked: false }

        const canonicalPhone = canonicalizePhone(rawPhone)
        if (!canonicalPhone) return { blocked: false }
        const norm = normalizeMtnMsisdn(canonicalPhone)
        if (!norm.ok) return { blocked: false }

        const verification = await verifyMtnWhitelistMerged([norm.msisdn])
        if (verification.error || verification.results.length === 0) {
            // Fail open — a supplier/transport hiccup must never block a sale.
            return { blocked: false }
        }

        return verification.results[0].allowed ? { blocked: false } : { blocked: true, reason: MTN_WHITELIST_BLOCKED_MESSAGE }
    } catch (e) {
        console.error('[mtn-whitelist-gate] gate error (failing open):', e)
        return { blocked: false }
    }
}

/**
 * Batch gate check for bulk purchase flows. Returns a Map keyed by the RAW
 * phoneNumber string each item was called with (not the canonical form), so
 * callers can filter their original order list directly by that same key.
 */
export async function checkMtnWhitelistGateBatch(
    items: Array<{ phoneNumber: string; network: string; category?: string | null }>,
): Promise<Map<string, GateResult>> {
    const results = new Map<string, GateResult>()
    if (items.length === 0) return results

    // Entire body — including the item-filtering loop below — is wrapped in a
    // single try/catch. That loop touches per-item order data
    // (item.network/item.category/item.phoneNumber) with no runtime shape
    // guarantee beyond the TypeScript annotation, so a malformed item must
    // never be able to throw uncaught and take down the whole batch.
    try {
        const gateOn = await isWhitelistGateEnabled().catch(() => false)

        // Items that don't even need evaluating short-circuit without touching the
        // DB/AgentPortal at all.
        const toCheck: Array<{ phoneNumber: string; canonicalPhone: string }> = []
        for (const item of items) {
            if (!gateOn || !shouldEvaluateWhitelistGate(item.network, item.category)) {
                results.set(item.phoneNumber, { blocked: false })
                continue
            }
            const canonicalPhone = canonicalizePhone(item.phoneNumber)
            const norm = canonicalPhone ? normalizeMtnMsisdn(canonicalPhone) : { ok: false as const }
            if (!norm.ok) {
                results.set(item.phoneNumber, { blocked: false })
                continue
            }
            toCheck.push({ phoneNumber: item.phoneNumber, canonicalPhone: norm.msisdn })
        }

        if (toCheck.length === 0) return results

        // Allow-caching happens per server inside the verifier, so numbers already confirmed
        // on an active server skip the supplier entirely.
        const uncached = toCheck
        const numbers = [...new Set(uncached.map(i => i.canonicalPhone))]
        const verification = await verifyMtnWhitelistMerged(numbers)

        if (verification.error) {
            // Fail open for every item.
            for (const item of uncached) results.set(item.phoneNumber, { blocked: false })
            return results
        }

        // Keyed by OUR re-canonicalized form of each result row (see canonicalKeyFor), and
        // every lookup below uses `item.canonicalPhone`, which always is in our `0XXXXXXXXX`
        // form. Rows in an unrecognizable format are dropped (null key) rather than mis-keyed.
        const byNormalized = new Map<string, boolean>()
        for (const r of verification.results) {
            const key = canonicalKeyFor(r)
            if (key === null) continue
            byNormalized.set(key, r.allowed)
        }

        for (const item of uncached) {
            if (!byNormalized.has(item.canonicalPhone)) {
                // Fail open — a supplier omitted this number from the response, never
                // trust a missing entry as "blocked".
                console.error(`[mtn-whitelist-gate] no verdict for ${item.canonicalPhone} — failing open`)
                results.set(item.phoneNumber, { blocked: false })
                continue
            }
            const allowed = byNormalized.get(item.canonicalPhone) === true
            results.set(item.phoneNumber, allowed ? { blocked: false } : { blocked: true, reason: MTN_WHITELIST_BLOCKED_MESSAGE })
        }

        return results
    } catch (e) {
        console.error('[mtn-whitelist-gate] batch gate error (failing open):', e)
        // Iterate the ORIGINAL items array, not `toCheck` — a throw can occur
        // before `toCheck` is fully built (or before it exists at all), so
        // `results` may be missing entries for items that never got evaluated.
        for (const item of items) if (!results.has(item.phoneNumber)) results.set(item.phoneNumber, { blocked: false })
        return results
    }
}

