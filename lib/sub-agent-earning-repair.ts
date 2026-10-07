// lib/sub-agent-earning-repair.ts
// =============================================================================
// Extracted from lib/shop-order-processor.ts (was a private, unexported
// function there) so it can also be called from lib/shop-service.ts's
// syncShopOrderStatus — the shared choke point EVERY path that marks a shop
// order 'completed' goes through (the Paystack/MoMo webhook via
// processShopOrder, AND any admin/manual/cron status change via
// app/api/admin/orders/update-status). Kept here rather than in
// shop-order-processor.ts to avoid a circular import (shop-order-processor.ts
// already imports FROM shop-service.ts for creditShopProfit/
// creditShopOrderProfits).
//
// Bug this closes (found live, 2026-09-15): a sub-agent storefront order that
// gets held 'queued' (the MTN number-registration gate,
// lib/number-registration.ts's resolveOrderQueueing) and later released/
// completed by an admin, or otherwise transitioned to 'completed' by anything
// OTHER than a fresh processShopOrder insert, NEVER got a
// sub_agent_order_earnings pending row written at all — recordPendingSubAgentEarning
// only ever ran inside processShopOrder's `!existingOrder` insert branch. The
// DB trigger (20260907e) only ever PROMOTES an existing 'pending' row to
// 'credited' on a status->'completed' transition; it does not create one from
// nothing. So the recruiter was silently never paid, confirmed live via two
// separate test orders — one that sat pending long enough to be resolved by
// something other than a repeat processShopOrder call, and one an admin
// completed directly through app/api/admin/orders/update-status, which never
// touched the sub-agent earning system at all.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentDataCost } from '@/lib/sub-agent-data-pricing'
import { recordPendingSubAgentEarning } from '@/lib/sub-agent-earnings'

/**
 * Ensures a sub-agent storefront order's recruiter-earning row exists as 'pending'
 * BEFORE the caller flips the order's status to 'completed' — callers MUST call this
 * before that status write, not after, since the DB trigger that promotes pending ->
 * credited fires on the status UPDATE itself and needs the row to already be there.
 *
 * Safe to call for every shop order unconditionally, not just sub-agent ones:
 * resolveSubAgentContext returns isSub:false for a normal shop instantly (one query),
 * and recordPendingSubAgentEarning is naturally idempotent (23505 on a re-run is
 * treated as already-recorded, not a failure). Never throws.
 */
export async function repairSubAgentEarning(
    db: SupabaseClient,
    orderId: string,
    reference: string,
    metadata: { shop_id: string; package_id: string | null },
): Promise<void> {
    try {
        if (!metadata.package_id) return // airtime/mashup/utility carry no package_id — never sub-agent-markup-eligible

        const { data: shopProfile } = await (db as any)
            .from('shop_profiles').select('owner_id').eq('id', metadata.shop_id).maybeSingle()
        if (!shopProfile?.owner_id) return

        const subCtx = await resolveSubAgentContext(db, shopProfile.owner_id)
        if (!subCtx.isSub || !subCtx.effectiveActive) return

        const { data: pkg } = await (db as any)
            .from('data_packages').select('price, agent_price, dealer_price, cost_price')
            .eq('id', metadata.package_id).maybeSingle()
        if (!pkg) return

        const resolved = await resolveSubAgentDataCost(db, shopProfile.owner_id, metadata.package_id, pkg, 'data')
        if (!resolved.ok || resolved.recruiterEarns <= 0 || !resolved.recruiterId) return

        const result = await recordPendingSubAgentEarning(db, {
            orderReference: reference,
            orderTable: 'shop_orders',
            recruiterId: resolved.recruiterId,
            subUserId: shopProfile.owner_id,
            amount: resolved.recruiterEarns,
        })
        if (!result.success) {
            console.error(`[SubAgentEarningRepair] FAILED for ${reference}: ${result.message}`)
            const { sendAdminPushNotification } = await import('@/lib/push-service')
            await sendAdminPushNotification({
                title: 'Sub-agent earning repair FAILED',
                body: `Order ${orderId} (ref ${reference}) — recruiter margin could not be recorded. Investigate and credit manually if needed.`,
            }).catch(() => {})
        }
    } catch (e) {
        console.error(`[SubAgentEarningRepair] threw for ${reference}:`, e)
    }
}
