// lib/ussd/shop-resolver.ts
import type { SupabaseClient } from '@supabase/supabase-js'

export interface ShopUSSDContext {
    id: string
    shopName: string
    ownerPhone: string
    rcMarkup: number
}

/** Look up an active shop by its 4-character USSD code. Returns null if not found or inactive. */
export async function resolveShopByCode(
    supabase: SupabaseClient,
    code: string,
): Promise<ShopUSSDContext | null> {
    const { data } = await supabase
        .from('shop_profiles')
        .select('id, owner_id, shop_name, owner_phone, results_checker_markup_customer')
        .eq('ussd_code', code.toUpperCase().trim())
        .eq('ussd_active', true)
        .maybeSingle()

    if (!data) return null

    // Sub-agent shops ARE now available over USSD (Task 3, Plan "subagent-retry-ussd-afa-
    // wallet-fixes"): the USSD price path now computes the sub/recruiter split for every
    // product (data/RC/AFA via resolveSubAgentDataCost/RcCost/AfaCost + recordPendingSubAgentEarning;
    // airtime/mashup/utility are role-blind and need no split at all) — see
    // lib/ussd/fulfillment/data.ts, lib/ussd/price-resolver.ts's resolveRCPrice, and
    // lib/ussd/fulfillment/afa.ts. A sub-agent's shop is therefore a normal, resolvable
    // ShopUSSDContext exactly like any other shop.

    return {
        id:         (data as any).id as string,
        shopName:   (data as any).shop_name as string,
        ownerPhone: (data as any).owner_phone as string,
        rcMarkup:   Number((data as any).results_checker_markup_customer ?? 0),
    }
}

/**
 * Credit a shop's wallet for a Results Checker USSD sale.
 * Uses the credit_shop_ussd_profit RPC (idempotent via ussd_ref).
 * Never blocks the USSD flow — but a real failure means the owner was NOT
 * paid for a delivered sale and nothing retries, so admins are paged.
 */
export async function creditShopUSSDProfit(
    supabase: SupabaseClient,
    shopId: string,
    profit: number,
    ussdRef: string,
    description: string,
): Promise<void> {
    if (profit <= 0) return

    const alertCreditFailure = async (detail: string) => {
        console.error(`[USSD Shop] CREDIT FAILED (${ussdRef}): ${detail}`)
        const { sendAdminPushNotification } = await import('@/lib/push-service')
        await sendAdminPushNotification({
            title: 'Shop USSD profit credit FAILED',
            body: `credit_shop_ussd_profit failed for shop ${shopId} (${description}, GHS ${profit.toFixed(2)}, ref ${ussdRef}) — credit the shop manually and investigate. ${detail}`,
        }).catch(() => {})
    }

    try {
        const { data, error } = await (supabase as any).rpc('credit_shop_ussd_profit', {
            p_shop_id:     shopId,
            p_profit:      profit,
            p_ussd_ref:    ussdRef,
            p_description: description,
        })
        if (error) {
            await alertCreditFailure(`RPC error: ${error.message ?? error}`)
            return
        }
        // The RPC traps SQL errors and reports them as {success:false} — an
        // 'Already credited' replay and a zero-profit skip are benign,
        // everything else is a real miss. (The RPC currently returns
        // success:true for replays; matching on the message too keeps a future
        // RPC change from paging admins on every idempotent retry.)
        const failMessage = String((data as any)?.message ?? '')
        if (
            data && (data as any).success === false &&
            !failMessage.includes('No profit to credit') &&
            !failMessage.includes('Already credited')
        ) {
            await alertCreditFailure(failMessage || 'unknown failure')
        }
    } catch (err) {
        await alertCreditFailure(String(err))
    }
}
