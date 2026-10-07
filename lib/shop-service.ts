import { createServerClient } from './supabase'
import { repairSubAgentEarning } from '@/lib/sub-agent-earning-repair'

/**
 * Syncs order status between mirrored main orders and original shop orders.
 * Also handles profit credit upon order completion.
 */
export async function syncShopOrderStatus(mainOrderId: string, status: string) {
    const supabase = createServerClient()
    const db = supabase as any

    console.log(`[ShopSync DEBUG] Starting sync for Order ${mainOrderId} -> Status: ${status}`)

    try {
        // 1. Fetch main order to see if it's linked to a shop order
        // NOTE: Including reference_code for fallback mapping
        const { data: order, error: orderError } = await db
            .from('orders')
            .select('id, shop_name, shop_order_id, reference_code, price, cost_price_at_time, status, phone_number')
            .eq('id', mainOrderId)
            .single()

        if (orderError) {
            console.error(`[ShopSync DEBUG] Error fetching main order:`, orderError)
            return
        }

        if (!order) {
            console.error(`[ShopSync DEBUG] Main order ${mainOrderId} not found`)
            return
        }

        console.log(`[ShopSync DEBUG] Fetched order:`, { shop_name: order.shop_name, shop_order_id: order.shop_order_id, ref: order.reference_code })

        // If it's not a shop order, skip
        if (!order.shop_order_id && !order.shop_name) {
            console.log(`[ShopSync] Order ${mainOrderId} is not a shop order, skipping sync.`)
            return
        }

        let shopOrderId = order.shop_order_id

        // Fallback: If shop_order_id is missing, try to find it via reference mapping
        // (Useful for existing orders tagged before we added shop_order_id col)
        if (!shopOrderId && order.reference_code?.startsWith('SHOP-')) {
            console.log(`[ShopSync DEBUG] Attempting fallback lookup via reference...`)
            const refSuffix = order.reference_code.replace('SHOP-', '')
            const { data: sOrder, error: lookupError } = await db
                .from('shop_orders')
                .select('id')
                .ilike('paystack_reference', `%${refSuffix}`)
                .single()

            if (lookupError) {
                console.error(`[ShopSync DEBUG] Fallback lookup failed:`, lookupError)
            }

            if (sOrder) {
                shopOrderId = sOrder.id
                console.log(`[ShopSync] Found matching shop order ${shopOrderId} via reference ${order.reference_code}`)
                // Self-heal: update the main order with the missing ID
                await db.from('orders').update({ shop_order_id: shopOrderId }).eq('id', mainOrderId)
            }
        }

        if (!shopOrderId) {
            console.warn(`[ShopSync] Could not find shop order ID for main order ${mainOrderId}`)
            return
        }

        console.log(`[ShopSync] Syncing shop order ${shopOrderId} to status: ${status}`)

        // 2a. Repair a possibly-missing sub-agent earning row BEFORE flipping status to
        // 'completed' — the DB trigger that promotes a pending earning row to credited
        // fires ON that status UPDATE, so the pending row must already exist when it runs.
        // This is the safety net for every path that reaches 'completed' WITHOUT going
        // through processShopOrder's own fresh-insert branch (which already records it
        // there): an admin manually completing a queued/stuck order via
        // app/api/admin/orders/update-status, or any other status-sync caller. Found live
        // (2026-09-15): a sub-agent storefront order held 'queued' by the MTN
        // number-registration gate and later completed by an admin never got a
        // sub_agent_order_earnings row at all — recordPendingSubAgentEarning had only ever
        // run inside processShopOrder's insert branch, never here.
        if (status === 'completed') {
            const { data: shopOrderForRepair } = await db
                .from('shop_orders')
                .select('shop_id, package_id, paystack_reference')
                .eq('id', shopOrderId)
                .maybeSingle()
            if (shopOrderForRepair) {
                // Match the trigger's own COALESCE(NEW.paystack_reference, NEW.id::text) —
                // a USSD-originated shop_orders row never has paystack_reference set (Task 3,
                // 2026-09-16 fix round), so this repair path was previously silently blind to
                // every USSD sub-agent sale: the guard above required paystack_reference to be
                // truthy, which it never is for those rows, so repairSubAgentEarning never ran
                // for them at all — no second chance if the fresh-insert earning write failed.
                const repairReference = shopOrderForRepair.paystack_reference ?? shopOrderId
                await repairSubAgentEarning(db, shopOrderId, repairReference, {
                    shop_id: shopOrderForRepair.shop_id,
                    package_id: shopOrderForRepair.package_id,
                }).catch((e: any) => console.error('[ShopSync] repairSubAgentEarning threw:', e))
            }
        }

        // 2b. Update shop_orders status
        const { error: updateError } = await db
            .from('shop_orders')
            .update({
                status: status,
                updated_at: new Date().toISOString()
            })
            .eq('id', shopOrderId)

        if (updateError) {
            console.error(`[ShopSync] Failed to update shop order ${shopOrderId}:`, updateError)
        } else {
            console.log(`[ShopSync DEBUG] Successfully updated shop order status.`)
        }

        // 3b. If it's an airtime order (SHOP- reference), also sync airtime_orders
        if (order.reference_code?.startsWith('SHOP-')) {
            const { error: airtimeError } = await db
                .from('airtime_orders')
                .update({ status, updated_at: new Date().toISOString() })
                .eq('reference_code', order.reference_code)

            if (airtimeError) {
                console.warn(`[ShopSync] Could not sync airtime_orders for ref ${order.reference_code}:`, airtimeError)
            } else {
                console.log(`[ShopSync] airtime_orders synced to: ${status} for ref ${order.reference_code}`)
            }
        }

        // 4. Profit is now credited immediately at payment time (in /api/shop/verify).
        // No longer credited here on 'completed' to prevent double-crediting.
        console.log(`[ShopSync] Status synced to: ${status}. Profit crediting is handled at payment time.`)
    } catch (err) {
        console.error('[ShopSync] Unexpected error:', err)
    }
}

/**
 * Credits profit to the shop wallet if not already credited (idempotent RPC).
 *
 * A shop owner's earnings hinge on this call, and it runs post-payment where
 * nothing retries it — so a real failure must never be silent. RPC errors and
 * {success:false} results (other than the benign idempotent replay and the
 * zero-profit skip) page the admins for manual reconciliation.
 */
export async function creditShopProfit(
    shopOrderId: string,
): Promise<{ success: boolean; message: string }> {
    const supabase = createServerClient()
    const db = supabase as any

    const alertCreditFailure = async (detail: string) => {
        console.error(`[Profit] CREDIT FAILED for shop order ${shopOrderId}: ${detail}`)
        const { sendAdminPushNotification } = await import('@/lib/push-service')
        await sendAdminPushNotification({
            title: 'Shop profit credit FAILED',
            body: `credit_shop_profit failed for shop order ${shopOrderId} — credit the shop manually and investigate. ${detail}`,
        }).catch(() => {})
    }

    try {
        console.log(`[Profit] Attempting to credit profit for shop order ${shopOrderId}...`)

        const { data, error } = await db.rpc('credit_shop_profit', {
            p_shop_order_id: shopOrderId
        })

        if (error) {
            await alertCreditFailure(`RPC error: ${error.message ?? error}`)
            return { success: false, message: String(error.message ?? error) }
        }

        if (data && !data.success) {
            const message = String(data.message ?? 'unknown failure')
            // 'No profit to credit' (zero-margin sale) and 'Already credited'
            // (idempotent replay — the RPC currently reports it success:true,
            // matched here too so an RPC change can't page admins per retry)
            // are legitimate skips; anything else means a sale happened and
            // the owner was NOT paid.
            if (message.includes('No profit to credit') || message.includes('Already credited')) {
                console.log(`[Profit] Skipped: ${message} (Order ${shopOrderId})`)
                return { success: true, message }
            }
            await alertCreditFailure(message)
            return { success: false, message }
        }

        console.log(`[Profit] Success: ${data?.message} (Order ${shopOrderId})`)
        return { success: true, message: String(data?.message ?? 'Credited') }
    } catch (err) {
        await alertCreditFailure(String(err))
        return { success: false, message: String(err) }
    }
}

/**
 * Credits BOTH parties of a sub-agent storefront sale (idempotent RPC, per-wallet):
 * the sub's retail markup and the Lead's wholesale margin (spec §7.4). Same
 * never-silent policy as creditShopProfit — a real failure pages the admins.
 */
export async function creditShopOrderProfits(
    shopOrderId: string,
): Promise<{ success: boolean; message: string }> {
    const supabase = createServerClient()
    const db = supabase as any

    const alertCreditFailure = async (detail: string) => {
        console.error(`[Profit] SUB-SPLIT CREDIT FAILED for shop order ${shopOrderId}: ${detail}`)
        const { sendAdminPushNotification } = await import('@/lib/push-service')
        await sendAdminPushNotification({
            title: 'Sub-agent profit split FAILED',
            body: `credit_shop_order_profits failed for shop order ${shopOrderId} — credit the sub and/or lead manually and investigate. ${detail}`,
        }).catch(() => {})
    }

    try {
        const { data, error } = await db.rpc('credit_shop_order_profits', {
            p_shop_order_id: shopOrderId,
        })

        if (error) {
            await alertCreditFailure(`RPC error: ${error.message ?? error}`)
            return { success: false, message: String(error.message ?? error) }
        }
        if (data && !data.success) {
            const message = String(data.message ?? 'unknown failure')
            await alertCreditFailure(message)
            return { success: false, message }
        }

        console.log(`[Profit] Sub-split success: ${data?.message} (sub ${data?.sub_amount}, lead ${data?.parent_amount}) (Order ${shopOrderId})`)
        return { success: true, message: String(data?.message ?? 'Credited') }
    } catch (err) {
        await alertCreditFailure(String(err))
        return { success: false, message: String(err) }
    }
}

/**
 * Credits the Lead's wholesale margin when a sub buys data from their own wallet
 * (wallet mode, spec §7.4). Idempotent on (credit_source, order_reference).
 * Never blocks the purchase — the sub already paid — but a real failure means the
 * Lead was NOT paid for a completed sale, so admins are paged for reconciliation.
 */
export async function creditLeadMargin(
    orderReference: string,
    uplineShopId: string,
    amount: number,
    description?: string,
): Promise<{ success: boolean; message: string }> {
    const supabase = createServerClient()
    const db = supabase as any

    const alertCreditFailure = async (detail: string) => {
        console.error(`[Profit] LEAD MARGIN CREDIT FAILED (${orderReference}): ${detail}`)
        const { sendAdminPushNotification } = await import('@/lib/push-service')
        await sendAdminPushNotification({
            title: 'Lead margin credit FAILED',
            body: `credit_lead_margin failed for ref ${orderReference} (shop ${uplineShopId}, GHS ${amount.toFixed(2)}) — credit the lead manually and investigate. ${detail}`,
        }).catch(() => {})
    }

    try {
        const { data, error } = await db.rpc('credit_lead_margin', {
            p_order_reference: orderReference,
            p_upline_shop_id: uplineShopId,
            p_amount: amount,
            p_description: description ?? null,
        })

        if (error) {
            await alertCreditFailure(`RPC error: ${error.message ?? error}`)
            return { success: false, message: String(error.message ?? error) }
        }
        if (data && !data.success) {
            const message = String(data.message ?? 'unknown failure')
            // 'No margin to credit' is a legitimate skip (zero/negative margin was
            // floored to 0 upstream and logged there); everything else is a miss.
            if (message.includes('No margin to credit')) {
                console.log(`[Profit] Lead margin skipped: ${message} (${orderReference})`)
                return { success: true, message }
            }
            await alertCreditFailure(message)
            return { success: false, message }
        }

        console.log(`[Profit] Lead margin: ${data?.message} (${orderReference})`)
        return { success: true, message: String(data?.message ?? 'Credited') }
    } catch (err) {
        await alertCreditFailure(String(err))
        return { success: false, message: String(err) }
    }
}
