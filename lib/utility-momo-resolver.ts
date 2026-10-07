// lib/utility-momo-resolver.ts
//
// Payer MoMo details for utility_orders — the utility-bill counterpart to
// lib/momo-payer-resolver.ts (shop_orders). Deliberately simpler: BOTH utility
// charge rails (app/api/shop/utility/charge/route.ts's Paystack branch and
// lib/hubtel-checkout.ts's Hubtel branch) already collect the payer's MoMo
// number + network as first-class request input and persist them directly on
// insert — see the payer_momo_number/payer_momo_network columns added by
// supabase/migrations/20260908_utility_orders_momo_payer_cache.sql. Unlike
// shop_orders, there is no Paystack-transaction-verify reconstruction step:
// only the payer's NAME needs on-demand resolution (same provider lookup
// shop_orders uses), cached back onto the row once resolved.
import { normalizeGhanaPhone } from '@/lib/sms-service'
import { resolveNameSingle } from '@/lib/momo-verify'
import { isMomoLookupEligible } from '@/lib/momo-eligibility'

// Re-exported so server-side importers can pull both the eligibility check and
// the resolver from one module — mirrors momo-payer-resolver.ts's own re-export.
export { isMomoLookupEligible }

export interface UtilityOrderMomoRow {
    id: string
    status: string | null
    amount: number
    payer_momo_number: string | null
    payer_momo_name: string | null
    payer_momo_network: string | null
    payer_momo_resolved_at: string | null
}

export type UtilityMomoResult =
    | { ok: true; data: { name: string | null; number: string; network: string; amountPaid: number; source: 'website' } }
    | { ok: false; error: string }

/**
 * True when resolveUtilityMomoPayerDetails will actually need to call the
 * name-resolution provider. False for an ineligible order, a fully-cached row,
 * or a row with no payer_momo_number at all (a legacy order that predates this
 * feature — nothing to resolve). Callers should only spend rate-limit quota
 * when this returns true.
 */
export function requiresNameResolution(order: UtilityOrderMomoRow): boolean {
    if (!isMomoLookupEligible(order)) return false
    if (order.payer_momo_resolved_at && order.payer_momo_name) return false
    return !!order.payer_momo_number
}

export interface UtilityMomoResolverDeps {
    resolveName: (normalizedPhone: string) => Promise<string | null>
    persistCache: (orderId: string, name: string) => Promise<void>
}

async function persistCacheLive(orderId: string, name: string): Promise<void> {
    // Lazy import — same reasoning as momo-payer-resolver.ts's persistCacheLive:
    // keeps this module importable from a pure-logic `npx tsx` test without env vars.
    const { createServerClient } = await import('@/lib/supabase')
    const admin = createServerClient()
    await (admin.from('utility_orders') as any)
        .update({ payer_momo_name: name, payer_momo_resolved_at: new Date().toISOString() })
        .eq('id', orderId)
}

export const defaultUtilityMomoResolverDeps: UtilityMomoResolverDeps = {
    resolveName: async (phone) => (await resolveNameSingle(phone))?.fullName ?? null,
    persistCache: persistCacheLive,
}

export async function resolveUtilityMomoPayerDetails(
    order: UtilityOrderMomoRow,
    deps: UtilityMomoResolverDeps = defaultUtilityMomoResolverDeps
): Promise<UtilityMomoResult> {
    if (!isMomoLookupEligible(order)) {
        return { ok: false, error: 'Not eligible' }
    }
    if (!order.payer_momo_number) {
        // Legacy order predating payer capture — nothing was ever recorded for it.
        return { ok: false, error: 'MoMo details unavailable for this order' }
    }
    if (order.payer_momo_resolved_at && order.payer_momo_name) {
        return {
            ok: true,
            data: {
                name: order.payer_momo_name,
                number: order.payer_momo_number,
                network: order.payer_momo_network || '',
                amountPaid: order.amount,
                source: 'website',
            },
        }
    }

    const normalized = normalizeGhanaPhone(order.payer_momo_number)
    const name = normalized ? await deps.resolveName(normalized) : null

    if (name) {
        try {
            await deps.persistCache(order.id, name)
        } catch (e) {
            console.error('[utility-momo-resolver] cache persist failed (non-fatal)', e)
        }
    }

    return {
        ok: true,
        data: { name, number: order.payer_momo_number, network: order.payer_momo_network || '', amountPaid: order.amount, source: 'website' },
    }
}
