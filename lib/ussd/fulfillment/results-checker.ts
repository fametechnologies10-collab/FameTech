import type { SupabaseClient } from '@supabase/supabase-js'
import type { HubtelFulfillment } from '../types'
import { normalizePhone } from '../utils'
import { trackUSSDCustomer } from '../guest-tracker'
import { sendResultsCheckerDeliverySMS } from '@/lib/sms-service'
import { resolveShopConfirmationSender, resolveOwnConfirmationSender } from '@/lib/sms-confirmation-sender'
import { creditShopUSSDProfit } from '@/lib/ussd/shop-resolver'
import { sendAdminPushNotification } from '@/lib/push-service'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentRcCost } from '@/lib/sub-agent-rc-pricing'
import { recordPendingSubAgentEarning } from '@/lib/sub-agent-earnings'
import { resolveSubAgentSelfRcPrice } from '../price-resolver'
import { deriveSelfPurchaseMargin } from '../self-purchase-margin'

// =============================================================================
// USSD Results Checker fulfillment
// Mirrors lib/results-checker-service.ts purchaseWithWallet flow exactly:
//   1. Create order record (pending)
//   2. Assign vouchers via assign_results_checker_vouchers RPC
//   3. Finalize sale via finalize_results_checker_sale RPC
//   4. Update order → completed with inventory_ids
//   5. Mark USSD pending order fulfilled
//   6. Send PINs to delivery phone via sendResultsCheckerDeliverySMS
// =============================================================================

export interface RCOrderPayload {
    typeId: string
    typeName: string
    quantity: number
    unitPrice: number
    deliveryPhone: string
    totalPrice: number
    shopId?: string | null
    shopMarkup?: number
}

export async function fulfillRCOrder(
    supabase: SupabaseClient,
    pendingOrderId: string,
    sessionId: string,
    mobile: string,
    operator: string,
    payload: RCOrderPayload,
    userId: string | null,
    fulfillment: HubtelFulfillment | null,
    paymentMethod: 'momo' | 'wallet' = 'momo',
): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
        const referenceCode = `USSD-RC-${sessionId.toUpperCase()}`
        const db = supabase as any

        // Idempotency: a COMPLETED order with this per-session reference is a true replay →
        // return success. A NON-completed row (a prior transient assign/finalize failure)
        // must NOT report success — the customer paid and got nothing, and the caller only
        // queues a refund on success:false. Resume from that row instead (re-attempt under the
        // same id; the assign RPC is idempotent per order, and reference_code is UNIQUE so we
        // cannot simply re-insert).
        let existingOrderId: string | null = null
        {
            const { data: dup } = await db
                .from('results_checker_orders')
                .select('id, status')
                .eq('reference_code', referenceCode)
                .maybeSingle()
            if (dup && (dup as any).status === 'completed') {
                return { success: true, orderId: (dup as any).id }
            }
            if (dup) existingOrderId = (dup as any).id
        }
        const deliveryPhone = normalizePhone(payload.deliveryPhone)
        const shopId     = payload.shopId ?? null
        const shopMarkup = Number(payload.shopMarkup ?? 0)

        // 1a. Fetch cost_price snapshot for profit log trigger
        //     Mirrors results-checker-service.ts purchaseWithWallet (cost_price_at_time)
        const { data: rcType } = await db
            .from('results_checker_types')
            .select('cost_price')
            .eq('id', payload.typeId)
            .maybeSingle()

        const costPriceAtTime: number | null = rcType?.cost_price ? Number(rcType.cost_price) : null

        // 1a-shop. For shop USSD sales, fetch the shop name so the order is fully
        //          attributed to the shop (mirrors the website RC flow which sets
        //          shop_id / shop_name / shop_markup). Without shop_id the
        //          upsert_shop_customer_from_rc_order trigger skips the row and the
        //          sale never appears in the shop's customer book or RC views.
        let shopName: string | null = null
        if (shopId) {
            const { data: shopRow } = await db
                .from('shop_profiles')
                .select('shop_name')
                .eq('id', shopId)
                .maybeSingle()
            shopName = (shopRow as any)?.shop_name ?? null
        }

        // 1b. Create results_checker_orders record (status pending — mirrors website flow)
        const orderInsertData: Record<string, unknown> = {
            type_id:             payload.typeId,
            type_name:           payload.typeName,
            quantity:            payload.quantity,
            unit_price:          payload.unitPrice,
            total_paid:          payload.totalPrice,
            cost_price_at_time:  costPriceAtTime,
            status:              'pending',
            payment_status:      'completed',
            reference_code:      referenceCode,
            delivered_via:       [],
            source:              shopId ? 'ussd_shop' : 'ussd',
            customer_phone:      deliveryPhone,
            payment_method:      paymentMethod,
        }

        // Attribute to the shop so it lands in the shop's order/customer records
        if (shopId) {
            orderInsertData.shop_id     = shopId
            orderInsertData.shop_name   = shopName
            orderInsertData.shop_markup = shopMarkup
        }

        if (userId) {
            orderInsertData.user_id   = userId
            orderInsertData.user_role = 'customer'
        }

        // Resume an existing (non-completed) order, else create a new one. Re-inserting would
        // violate the UNIQUE reference_code; resuming lets a transiently-failed attempt retry.
        let rcOrder: { id: string }
        if (existingOrderId) {
            rcOrder = { id: existingOrderId }
        } else {
            const { data: inserted, error: rcOrderError } = await db
                .from('results_checker_orders')
                .insert(orderInsertData)
                .select('id')
                .single()
            if (rcOrderError || !inserted) {
                console.error('[USSD RC Fulfillment] Order insert failed:', rcOrderError)
                return { success: false, error: rcOrderError?.message ?? 'Order creation failed' }
            }
            rcOrder = inserted
        }

        // 2. Assign vouchers atomically via the correct RPC (mirrors results-checker-service.ts:329)
        //    assign_results_checker_vouchers raises INSUFFICIENT_INVENTORY if stock unavailable.
        const { data: vouchers, error: assignError } = await db
            .rpc('assign_results_checker_vouchers', {
                p_type_id:  payload.typeId,
                p_quantity: payload.quantity,
                p_order_id: rcOrder.id,
            })

        if (assignError || !vouchers || vouchers.length === 0) {
            console.error('[USSD RC Fulfillment] Voucher assignment failed:', assignError)
            // Mark order failed so admin can see it
            await db.from('results_checker_orders')
                .update({ status: 'failed', updated_at: new Date().toISOString() })
                .eq('id', rcOrder.id)
            return { success: false, error: assignError?.message ?? 'No vouchers available' }
        }

        // 3. Finalize sale — marks vouchers as sold (mirrors results-checker-service.ts:348)
        const { error: finalizeError } = await db.rpc('finalize_results_checker_sale', {
            p_order_id: rcOrder.id,
            p_user_id:  userId ?? null,
        })
        if (finalizeError) {
            console.error('[USSD RC Fulfillment] Finalize RPC failed:', finalizeError)
            await db.from('results_checker_orders')
                .update({ status: 'failed', updated_at: new Date().toISOString() })
                .eq('id', rcOrder.id)
            return { success: false, error: finalizeError.message }
        }

        const inventoryIds: string[] = (vouchers as any[]).map((v: any) => v.id)

        // 3b. Record the recruiter's pending earning for a sub-agent-owned shop (Task 3,
        // Step 5) — resolved fresh here from shopId, mirroring lib/ussd/fulfillment/data.ts's
        // self-contained pattern (resolve context, resolve cost, record earning) rather than
        // threading pricing state from the handler. Independent of the shop-profit credit
        // below: the shop owner earns their OWN markup (shopMarkup, credited later) exactly
        // as before; the recruiter earns SEPARATELY here. Uses `referenceCode`, this file's
        // OWN idempotency key (checked against results_checker_orders.reference_code above)
        // AND the exact column (`reference_code`) the DB trigger on results_checker_orders
        // (trg_sub_agent_earning_by_reference_code, 20260907e) reads via NEW.reference_code —
        // so the earning ledger and this order key off the exact same value.
        //
        // MUST happen before the completed-status UPDATE below (step 4) — that UPDATE is what
        // fires the trigger that credits the recruiter's wallet, and the trigger can only find
        // a pending row that already exists. This file previously recorded the earning AFTER
        // the completed-status update (former step 8b): the trigger fired against nothing at
        // step 4, then never fired again since the status never changes a second time, leaving
        // the earning permanently 'pending' with no error anywhere. Mirrors the identical,
        // already-correct ordering in lib/results-checker-service.ts's purchaseWithWallet flow
        // (search for "MUST happen before the completed-status UPDATE" there).
        if (shopId) {
            try {
                const { data: shopRow } = await db.from('shop_profiles').select('owner_id').eq('id', shopId).maybeSingle()
                const ownerId: string | undefined = (shopRow as any)?.owner_id
                if (ownerId) {
                    const subCtx = await resolveSubAgentContext(db, ownerId)
                    if (subCtx.isSub && subCtx.effectiveActive) {
                        const { data: rcTypeFull } = await db
                            .from('results_checker_types')
                            .select('id, name, customer_price, agent_price, dealer_price, cost_price, bulk_pricing')
                            .eq('id', payload.typeId)
                            .maybeSingle()
                        if (rcTypeFull) {
                            const resolved = await resolveSubAgentRcCost(db, ownerId, rcTypeFull as any, payload.quantity)
                            if (resolved.ok && resolved.recruiterEarns > 0 && resolved.recruiterId) {
                                await recordPendingSubAgentEarning(db, {
                                    orderReference: referenceCode,
                                    orderTable: 'results_checker_orders',
                                    recruiterId: resolved.recruiterId,
                                    subUserId: ownerId,
                                    amount: parseFloat((resolved.recruiterEarns * payload.quantity).toFixed(2)),
                                }).catch((e: any) => console.error('[USSD RC Fulfillment] recordPendingSubAgentEarning threw:', e))
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('[USSD RC Fulfillment] sub-agent earning resolution threw:', e)
            }
        } else if (userId) {
            // A sub-agent buying for THEMSELVES (no shop): their recruiter earns the markup.
            // unitPrice is pre-fee, so no fee stripping is needed (feePercent 0).
            try {
                const { data: rcTypeFull } = await db
                    .from('results_checker_types')
                    .select('id, name, customer_price, agent_price, dealer_price, cost_price, bulk_pricing')
                    .eq('id', payload.typeId)
                    .maybeSingle()
                if (rcTypeFull) {
                    const sub = await resolveSubAgentSelfRcPrice(db, userId, rcTypeFull as any)
                    if (sub.kind === 'blocked') {
                        await sendAdminPushNotification({
                            title: 'Sub-agent USSD earning not recorded',
                            body: `RC order ${referenceCode} (${payload.quantity}x ${payload.typeName}, paid GHS ${payload.totalPrice}): sub pricing/eligibility changed before fulfillment, so the recruiter margin was not recorded. Reconcile manually.`,
                        }).catch(() => {})
                    } else if (sub.kind === 'sub') {
                        const { amount, drifted } = deriveSelfPurchaseMargin({
                            paid: Number(payload.unitPrice),
                            feePercent: 0,
                            subPrice: sub.price,
                            recruiterEarns: sub.recruiterEarns,
                        })
                        if (drifted) {
                            await sendAdminPushNotification({
                                title: 'Sub-agent USSD price drift',
                                body: `RC order ${referenceCode}: sub paid unit GHS ${payload.unitPrice} but current sub price is GHS ${sub.price}. Recruiter margin recorded as GHS ${amount} per voucher.`,
                            }).catch(() => {})
                        }
                        await recordPendingSubAgentEarning(db, {
                            orderReference: referenceCode,
                            orderTable: 'results_checker_orders',
                            recruiterId: sub.recruiterId,
                            subUserId: userId,
                            amount: parseFloat((amount * payload.quantity).toFixed(2)),
                        })
                    }
                }
            } catch (e) {
                console.error('[USSD RC Fulfillment] self-purchase earning resolution threw:', e)
            }
        }

        // 4. Update order → completed with assigned inventory.
        //    P1-1: vouchers are ALREADY sold here, so a failure must NOT fail/refund
        //    the order (the customer is served). Retry; if it still fails, alert
        //    admins to fix the status manually — never refund a delivered order.
        let completedOk = false
        for (let attempt = 0; attempt < 3 && !completedOk; attempt++) {
            const { error: updateError } = await db.from('results_checker_orders')
                .update({
                    status:         'completed',
                    payment_status: 'completed',
                    inventory_ids:  inventoryIds,
                    fulfilled_at:   new Date().toISOString(),
                    updated_at:     new Date().toISOString(),
                })
                .eq('id', rcOrder.id)
            if (!updateError) { completedOk = true; break }
            console.error(`[USSD RC Fulfillment] completed-update attempt ${attempt + 1} failed:`, updateError)
        }
        if (!completedOk) {
            await sendAdminPushNotification({
                title: 'RC order stuck pending after delivery',
                body: `RC order ${rcOrder.id} (${payload.quantity}x ${payload.typeName}) delivered vouchers but the completed-status update failed. Fix status manually — do NOT refund. Session ${sessionId}.`,
            }).catch(() => {})
        }

        // 5. Mark USSD pending order as fulfilled
        if (pendingOrderId) {
            const pendingUpdateData: Record<string, unknown> = {
                status:       'fulfilled',
                fulfilled_at: new Date().toISOString(),
            }
            if (paymentMethod !== 'wallet' && fulfillment?.OrderId) {
                pendingUpdateData.hubtel_order_id = fulfillment.OrderId
            }
            const { error: pendingUpdateError } = await supabase
                .from('ussd_pending_orders')
                .update(pendingUpdateData)
                .eq('id', pendingOrderId)

            if (pendingUpdateError) {
                console.error('[USSD RC Fulfillment] Pending order update failed:', pendingUpdateError)
            }
        }

        // 6. Send PINs to delivery phone using same template as website
        //    Recipient: payload.deliveryPhone (the beneficiary phone entered in the USSD form)
        //    Template (1 PIN):  "Your {typeName} PIN is ready!\nPIN: {pin}\nSerial: {sn}\n\nPlease visit {url} to print your results."
        //    Template (multi):  "Your {qty}x {typeName} vouchers:\n\nPIN: {p1}\nSerial: {s1}\n\n...\n\nPlease visit {url} to print your results."
        //    Feature-wave5 Task 2: this PIN SMS is the PRODUCT — NEVER metered,
        //    NEVER suppressed, only re-branded when a sender is available. Same
        //    resolution order as lib/results-checker-notification-service.ts:
        //    shop's approved sender wins for shop orders, else the buyer's own
        //    approved sender, else the platform sender. Neither resolver throws.
        const [shopSender, ownSender] = await Promise.all([
            shopId ? resolveShopConfirmationSender(db, shopId) : Promise.resolve(null),
            userId ? resolveOwnConfirmationSender(db, userId) : Promise.resolve(null),
        ])
        const smsResult = await sendResultsCheckerDeliverySMS(deliveryPhone, {
            typeName:      payload.typeName,
            quantity:      payload.quantity,
            vouchers:      (vouchers as any[]).map((v: any) => ({ pin: v.pin, serial_number: v.serial_number })),
            referenceCode,
            sender:        shopSender ?? ownSender ?? undefined,
        })

        // Mark delivered_via after SMS attempt
        if (smsResult.success) {
            await db.from('results_checker_orders')
                .update({ delivered_via: ['sms'], updated_at: new Date().toISOString() })
                .eq('id', rcOrder.id)
        }

        // 7. Track guest customer
        if (!userId) {
            await trackUSSDCustomer(supabase, mobile, operator, 'results_checker', payload.totalPrice)
        }

        // 8. Credit shop profit for RC order if routed through a shop
        if (shopId && shopMarkup > 0) {
            const rcRef = `USSD-RC-CREDIT-${sessionId.toUpperCase()}`
            const profit = shopMarkup * payload.quantity
            await creditShopUSSDProfit(
                supabase,
                shopId,
                profit,
                rcRef,
                `RC sale: ${payload.quantity}x ${payload.typeName}`,
            )
        }

        return { success: true, orderId: rcOrder.id }
    } catch (err) {
        console.error('[USSD RC Fulfillment] Unexpected error:', err)
        return { success: false, error: String(err) }
    }
}
