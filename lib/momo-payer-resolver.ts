// lib/momo-payer-resolver.ts
import { normalizeGhanaPhone } from '@/lib/sms-service'
import { resolveNameSingle, getNetworkMeta } from '@/lib/momo-verify'
import { normalizePhone as normalizeToLocalGhanaPhone } from '@/lib/ussd/utils'
import { isMomoLookupEligible } from '@/lib/momo-eligibility'

// Re-exported so existing server-side importers keep working unchanged.
// Client pages should import directly from '@/lib/momo-eligibility' instead —
// see that file's header for why (this module is NOT safe to import from a
// 'use client' component).
export { isMomoLookupEligible }

export type MomoLookupSource = 'ussd' | 'website'

export interface ShopOrderMomoRow {
    id: string
    source: string | null
    guest_phone: string | null
    network: string | null
    selling_price: number
    paystack_reference: string | null
    status: string | null
    payer_momo_number: string | null
    payer_momo_name: string | null
    payer_momo_network: string | null
    payer_momo_resolved_at: string | null
}

export type MomoPayerResult =
    | { ok: true; data: { name: string | null; number: string; network: string; amountPaid: number; source: MomoLookupSource } }
    | { ok: false; error: string }

/**
 * True when resolveMomoPayerDetails will actually need to hit an external
 * provider (a Paystack verify call and/or a name-resolution provider call)
 * to answer this lookup. False for:
 *   - an ineligible order (blocked before any I/O)
 *   - a fully-cached row (payer_momo_resolved_at + payer_momo_number both set)
 *   - a row that will short-circuit straight to "unavailable" with NO I/O at
 *     all: a USSD order whose payer was never captured, or a website order
 *     with no paystack_reference to verify
 * Callers should only spend rate-limit quota when this returns true — a
 * lookup that was always going to answer "unavailable" without touching a
 * provider shouldn't count against the caller's daily cap.
 */
export function requiresExternalLookup(order: ShopOrderMomoRow): boolean {
    if (!isMomoLookupEligible(order)) return false
    if (order.payer_momo_resolved_at && order.payer_momo_number) return false // fully cached
    if (order.payer_momo_number) return true // number known — still needs a name-resolution call
    const source: MomoLookupSource = order.source === 'ussd' ? 'ussd' : 'website'
    if (source === 'ussd') return false // no payer captured — resolver short-circuits, no I/O
    return !!order.paystack_reference // website: a verify call only happens if there's a reference to check
}

export interface MomoResolverDeps {
    verifyPaystackTransaction: (reference: string) => Promise<{ mobileMoneyNumber: string; network: string } | null>
    resolveName: (normalizedPhone: string) => Promise<string | null>
    persistCache: (orderId: string, cache: { number: string; name: string | null; network: string }) => Promise<void>
}

async function verifyPaystackTransactionLive(reference: string): Promise<{ mobileMoneyNumber: string; network: string } | null> {
    const key = process.env.PAYSTACK_SECRET_KEY
    if (!key) return null
    try {
        const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
            headers: { Authorization: `Bearer ${key}`, 'Cache-Control': 'no-store' },
        })
        const json: any = await res.json().catch(() => ({}))
        const auth = json?.data?.authorization
        if (!auth || auth.channel !== 'mobile_money' || !auth.mobile_money_number) return null
        return { mobileMoneyNumber: String(auth.mobile_money_number), network: String(auth.bank || '') }
    } catch {
        return null
    }
}

/**
 * Pure — builds the update payload for the payer cache. Split out from
 * persistCacheLive so it's testable without a DB/env (the function below is
 * lazy-imported specifically to stay out of pure-logic `npx tsx` tests).
 *
 * `payer_momo_resolved_at` is stamped ONLY when a name was actually resolved.
 * A transient provider outage (Moolre/Paystack blip) resolves `name: null` —
 * stamping resolved_at anyway would permanently freeze "MoMo Name:
 * Unavailable" on that order, since the cached-row branch above short-circuits
 * on `payer_momo_resolved_at && payer_momo_number` forever after. Leaving
 * resolved_at unset lets the next lookup retry the name resolution while
 * still caching the number/network unconditionally — the number is free to
 * cache and is the field that actually matters for a refund.
 */
export function buildPersistedCachePayload(cache: { number: string; name: string | null; network: string }): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        payer_momo_number: cache.number,
        payer_momo_name: cache.name,
        payer_momo_network: cache.network,
    }
    if (cache.name) {
        payload.payer_momo_resolved_at = new Date().toISOString()
    }
    return payload
}

async function persistCacheLive(orderId: string, cache: { number: string; name: string | null; network: string }): Promise<void> {
    // Lazy import: @/lib/supabase builds a browser client at module scope and
    // throws on import without env vars, which would make this module
    // impossible to import from a pure-logic `npx tsx` test.
    const { createServerClient } = await import('@/lib/supabase')
    const admin = createServerClient()
    await (admin.from('shop_orders') as any)
        .update(buildPersistedCachePayload(cache))
        .eq('id', orderId)
}

export const defaultMomoResolverDeps: MomoResolverDeps = {
    verifyPaystackTransaction: verifyPaystackTransactionLive,
    resolveName: async (phone) => (await resolveNameSingle(phone))?.fullName ?? null,
    persistCache: persistCacheLive,
}

export async function resolveMomoPayerDetails(
    order: ShopOrderMomoRow,
    deps: MomoResolverDeps = defaultMomoResolverDeps
): Promise<MomoPayerResult> {
    if (!isMomoLookupEligible(order)) {
        return { ok: false, error: 'Not eligible' }
    }

    const source: MomoLookupSource = order.source === 'ussd' ? 'ussd' : 'website'

    if (order.payer_momo_resolved_at && order.payer_momo_number) {
        return {
            ok: true,
            data: {
                name: order.payer_momo_name,
                number: order.payer_momo_number,
                network: order.payer_momo_network || order.network || '',
                amountPaid: order.selling_price,
                source,
            },
        }
    }

    let number: string
    let network: string

    if (order.payer_momo_number) {
        // Captured at USSD order creation, or written by the backfill migration,
        // or cached by a previous Paystack resolution. Always authoritative.
        number = order.payer_momo_number
        network = order.payer_momo_network || ''
    } else if (source === 'website') {
        if (!order.paystack_reference) return { ok: false, error: 'MoMo details unavailable for this order' }
        const verified = await deps.verifyPaystackTransaction(order.paystack_reference)
        if (!verified) return { ok: false, error: 'MoMo details unavailable for this order' }
        // Paystack returns the payer's number in whatever form the customer's
        // MoMo authorization carries (commonly `+233…`/`233…`) — the USSD
        // capture path and the backfill migration both write the local
        // `0XXXXXXXXX` form, so normalise here too. One documented format for
        // the whole column, reusing the existing USSD phone helper rather
        // than adding a second normaliser.
        number = normalizeToLocalGhanaPhone(verified.mobileMoneyNumber)
        network = verified.network
    } else {
        // USSD order whose payer was never captured (pre-fix order the backfill
        // could not disambiguate). guest_phone is the BENEFICIARY, not the payer —
        // returning it would send the refund to the wrong person, so refuse.
        return { ok: false, error: 'MoMo details unavailable for this order' }
    }

    const normalized = normalizeGhanaPhone(number)
    // Derive the network from the PAYER's own prefix. order.network is the
    // beneficiary's network and is frequently a different operator.
    if (!network && normalized) {
        network = getNetworkMeta(normalized)?.label || ''
    }
    const name = normalized ? await deps.resolveName(normalized) : null

    try {
        await deps.persistCache(order.id, { number, name, network })
    } catch (e) {
        console.error('[momo-payer-resolver] cache persist failed (non-fatal)', e)
    }

    return { ok: true, data: { name, number, network, amountPaid: order.selling_price, source } }
}
