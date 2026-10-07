import type { SupabaseClient } from '@supabase/supabase-js'
import type { HubtelFulfillment } from '../types'
import { toMsisdn233 } from '@/lib/hubtel-commission-service'
import { isUtilityBiller, type UtilityBiller } from '@/lib/hubtel-utility/billers'
import { trackUSSDCustomer } from '../guest-tracker'
import { dispatchUtilityFulfillment } from '@/lib/utility-fulfillment'

// =============================================================================
// USSD Utility Bills fulfillment — runs after Hubtel MoMo payment (or wallet
// debit). Records the sale in the SAME utility_orders ledger the
// dashboard/storefront use, then hands the order to the existing
// dispatchUtilityFulfillment() pipeline (Hubtel Commission Services). Delivery
// correctness (callback finalize, retry, refulfill) is owned by that pipeline
// + the admin utility-bills tools — exactly like storefront/dashboard utility
// sales and USSD airtime (lib/ussd/fulfillment/airtime.ts, this file's
// structural template).
//
// NO shop_orders/orders mirror (UNLIKE airtime): utilities are a commission
// split, not a markup sale. Attribution is utility_orders.shop_id alone;
// credit_utility_commission (supabase/migrations/20260709b_utility_rpcs.sql)
// resolves the shop owner FROM shop_id directly on completion and credits
// their shop_wallets balance — no syncable mirror row is needed or wanted.
//
// Reference prefix is LOAD-BEARING: the shared Hubtel Commission webhook
// (app/api/webhooks/hubtel-commission/route.ts) routes a callback to the
// utility branch via `isUtilityReference(ref)`, which is `ref.startsWith
// ('UTIL-')` (lib/hubtel-utility/billers.ts). A `USSD-UTIL-...` reference
// would NOT match that prefix and would fall through to the airtime branch,
// silently stranding the callback (order never finalizes, commission never
// credits). So both variants below start with 'UTIL-':
//   MoMo:   UTIL-USSD-<SESSIONID>
//   Wallet: UTIL-USSDW-<SESSIONID>
// (Distinct from the WALLET TRANSACTION reference 'USSD-WALLET-UTIL-<session>'
// used by processWalletPayment in lib/ussd/handlers/utility.ts — that ref is
// wallet-ledger-only and is never checked by isUtilityReference.)
// =============================================================================

/**
 * Pinned contract with Task F-flow (lib/ussd/handlers/utility.ts's buildUtilityPayload) —
 * do not rename/add/remove fields without updating that call site.
 */
export interface UtilityOrderPayload {
    biller: UtilityBiller
    account: string
    phone: string               // 233..., customer MSISDN or entered
    accountName: string | null
    amountGhs: number
    shopId: string | null
    shopName: string | null
}

export async function fulfillUtilityUSSDOrder(
    supabase: SupabaseClient,
    pendingOrderId: string,
    sessionId: string,
    mobile: string,
    operator: string,
    payload: UtilityOrderPayload,
    userId: string | null,
    fulfillment: HubtelFulfillment | null,
    paymentMethod: 'momo' | 'wallet' = 'momo',
): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
        // 1. Parse/validate — malformed payload fails closed; the route sends it
        //    to the refund queue exactly like a malformed airtime payload would.
        const biller = payload.biller
        if (!isUtilityBiller(biller)) {
            return { success: false, error: `Invalid biller: ${String(biller)}` }
        }
        const amountGhs = Number(payload.amountGhs)
        if (!Number.isFinite(amountGhs) || amountGhs <= 0) {
            return { success: false, error: `Invalid amount: ${String(payload.amountGhs)}` }
        }
        const account = String(payload.account ?? '').trim()
        if (!account) {
            return { success: false, error: 'Missing account number' }
        }
        const phone = toMsisdn233(String(payload.phone ?? ''))
        const shopId = payload.shopId ?? null

        // 2. Reference — see the load-bearing module note above.
        const referenceCode = paymentMethod === 'wallet'
            ? `UTIL-USSDW-${sessionId.toUpperCase()}`
            : `UTIL-USSD-${sessionId.toUpperCase()}`

        // 3. Idempotency + REPLAY SELF-HEAL: utility_orders.reference_code is
        //    UNIQUE. A replay (status-check race / duplicate Hubtel fulfill
        //    callback) must not re-insert or re-dispatch — just report success
        //    and finish marking the pending order fulfilled if a crashed prior
        //    attempt skipped that step (mirrors airtime's ~L152-172 replay block).
        {
            const { data: dup } = await supabase
                .from('utility_orders')
                .select('id')
                .eq('reference_code', referenceCode)
                .maybeSingle()
            if (dup) {
                if (pendingOrderId) {
                    await supabase
                        .from('ussd_pending_orders')
                        .update({ status: 'fulfilled', fulfilled_at: new Date().toISOString() })
                        .eq('id', pendingOrderId)
                }
                return { success: true, orderId: (dup as any).id }
            }
        }

        // 4. utility_orders — the core ledger row + the dispatch target. Created
        //    FIRST because its UNIQUE reference is the idempotency anchor: once
        //    it exists, any crash later is repairable by the replay self-heal
        //    above. Face value, already paid — the fulfill route only dispatches
        //    after Hubtel confirms payment; the wallet path debits before calling
        //    this function (lib/ussd/handlers/utility.ts's handlePaymentMethod).
        const lookupSnapshot = payload.accountName ? { accountName: payload.accountName } : null
        const { data: utilityOrder, error: uoErr } = await (supabase as any)
            .from('utility_orders')
            .insert({
                ...(userId ? { user_id: userId } : {}),
                shop_id: shopId,
                source: shopId ? 'ussd_shop' : 'ussd',
                biller,
                account_number: account,
                account_name: payload.accountName ?? null,
                destination_phone: phone,
                customer_email: null,
                amount: amountGhs,
                payment_method: paymentMethod === 'wallet' ? 'ussd_wallet' : 'ussd_momo',
                payment_status: 'paid',
                status: 'pending',
                reference_code: referenceCode,
                ...(lookupSnapshot ? { lookup_snapshot: lookupSnapshot } : {}),
            })
            .select('id')
            .single()

        if (uoErr) {
            console.error('[USSD Utility] utility_orders insert failed:', uoErr)
            return { success: false, error: uoErr.message }
        }
        const utilityOrderId = (utilityOrder as any).id as string

        // 5. Mark the pending order fulfilled (claim already stamped hubtel_order_id for momo).
        if (pendingOrderId) {
            const upd: Record<string, unknown> = { status: 'fulfilled', fulfilled_at: new Date().toISOString() }
            if (paymentMethod !== 'wallet' && fulfillment?.OrderId) upd.hubtel_order_id = fulfillment.OrderId
            await supabase.from('ussd_pending_orders').update(upd).eq('id', pendingOrderId)
        }

        // 6. Track guest customer for non-account buyers.
        if (!userId) {
            await trackUSSDCustomer(supabase, mobile, operator, 'utility', amountGhs).catch(() => {})
        }

        // 7. Auto-dispatch via Hubtel Commission. Respects the utility kill-switches
        //    (utility_bills_enabled / utility_auto_fulfillment_enabled /
        //    hubtel_commission_paused / per-biller map): a no-op when auto is OFF
        //    or the biller is disabled — the order stays 'pending' for manual
        //    fulfillment on /admin/utility-bills. Never throws; internal
        //    failures/transient errors revert to 'pending' for retry.
        await dispatchUtilityFulfillment(utilityOrderId)

        return { success: true, orderId: utilityOrderId }
    } catch (err) {
        console.error('[USSD Utility Fulfillment] Unexpected error:', err)
        return { success: false, error: String(err) }
    }
}
