import type { SupabaseClient } from '@supabase/supabase-js'
import type { HubtelFulfillment } from '../types'
import { normalizePhone } from '../utils'
import { trackUSSDCustomer } from '../guest-tracker'
import { sendOrderSuccessSMS } from '@/lib/sms-service'
import { sendShopConfirmationSMS } from '@/lib/sms-confirmation-sender'
import { triggerFulfillment } from '@/lib/fulfillment-trigger'
import { creditShopProfit } from '@/lib/shop-service'
import { sendAdminPushNotification } from '@/lib/push-service'
import { effectiveRole, resolveSubAgentSelfDataPrice } from '../price-resolver'
import { deriveSelfPurchaseMargin } from '../self-purchase-margin'
import { getUSSDFeePercent } from '../fee'
import { resolveOrderQueueing } from '@/lib/number-registration'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentDataCost } from '@/lib/sub-agent-data-pricing'
import { recordPendingSubAgentEarning } from '@/lib/sub-agent-earnings'

// =============================================================================
// USSD Data bundle fulfillment — runs after Hubtel MoMo payment succeeds
// Creates an order in the existing `orders` table (source='ussd')
// then triggers the standard auto-fulfillment pipeline.
// =============================================================================

export interface DataOrderPayload {
    packageId: string
    packageSize: string
    network: string
    recipientPhone: string
    price: number               // amount the guest paid (incl. the shop USSD fee)
    shopId?: string | null
    shopBasePrice?: number | null   // shop selling price BEFORE the fee (shop credit basis)
}

export async function fulfillDataOrder(
    supabase: SupabaseClient,
    pendingOrderId: string,
    sessionId: string,
    mobile: string,
    operator: string,
    payload: DataOrderPayload,
    userId: string | null,
    fulfillment: HubtelFulfillment | null,
    paymentMethod: 'momo' | 'wallet' = 'momo',
): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
        const referenceCode = `USSD-DATA-${sessionId.toUpperCase()}`

        const shopId = (payload as any).shopId as string | null ?? null

        // Defensive net for the shop-attribution-loss bug class (orders 1ff7c45f,
        // 40e04b3e): if THIS order has no shop context, but the same guest had a
        // shop-scoped session within the last hour (captured, then lost across a
        // redial), alert admins immediately instead of relying on the shop owner
        // to notice a missing order days later. Never blocks fulfillment — errors
        // here are caught and logged, not thrown.
        if (!shopId) {
            try {
                const lookbackMinutes = 60
                const cutoff = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString()
                const { data: priorSessions } = await supabase
                    .from('ussd_sessions')
                    .select('interrupted_state, session_id')
                    .eq('mobile', mobile)
                    .gte('created_at', cutoff)
                    .not('interrupted_state', 'is', null)
                    .order('created_at', { ascending: false })
                    .limit(5)

                const lostShop = (priorSessions ?? []).find((r: any) => r.interrupted_state?.shopId)
                if (lostShop) {
                    const lostShopId = (lostShop as any).interrupted_state.shopId
                    await sendAdminPushNotification({
                        title: 'Possible shop-attribution loss (USSD)',
                        body: `Guest ${mobile} completed ${payload.network} ${payload.packageSize} (ref ${referenceCode}) with NO shop context, but had a shop-scoped session (shop ${lostShopId}) in the last ${lookbackMinutes} min. Verify and manually credit the shop if attribution was lost.`,
                    })
                }
            } catch (e: unknown) {
                console.error('[USSD Data Fulfillment] shop-attribution-loss check failed:', e)
            }
        }


        // 1. Fetch package for cost_price snapshot + role-based pricing
        const { data: pkg } = await supabase
            .from('data_packages')
            .select('cost_price, price, agent_price, dealer_price, network, size, category')
            .eq('id', payload.packageId)
            .maybeSingle()

        // Admin's true supplier cost — snapshot it on both the shop_orders row
        // (drives the log_shop_profit trigger) and the main orders row.
        const adminCost = Number((pkg as any)?.cost_price ?? 0)

        // Price the SHOP is credited against: the pre-fee selling price. The guest
        // paid payload.price (selling + dedicated USSD shop fee); the fee is the
        // platform's, never the shop's. Falls back to payload.price for legacy
        // pending orders saved before shopBasePrice existed.
        const shopSellingPrice = Number((payload as any).shopBasePrice ?? payload.price)

        // Shop identity — fetched up-front because the orders row records
        // shop_name and the ledger helper below needs the owner.
        let shopName: string | null = null
        let shopOwnerId: string | null = null
        let shopSmsConfirmEnabled = true
        if (shopId) {
            const { data: spData } = await supabase
                .from('shop_profiles')
                .select('owner_id, shop_name, sms_order_confirmation_enabled')
                .eq('id', shopId)
                .maybeSingle()
            shopOwnerId = (spData as any)?.owner_id ?? null
            shopName = (spData as any)?.shop_name ?? null
            // Same default-true convention as the storefront/webhook path
            // (lib/shop-order-processor.ts) and the dashboard toggle itself.
            shopSmsConfirmEnabled = (spData as any)?.sms_order_confirmation_enabled !== false
        }

        // Creates the shop_orders ledger row for a shop sale and links it onto
        // the main orders row. Used by BOTH the fresh path and the replay
        // self-heal, so a crash between the two inserts can always be repaired
        // on the next attempt instead of orphaning attribution or credit.
        const createAndLinkShopOrder = async (orderId: string, mirrorStatus: string = 'pending'): Promise<string | null> => {
            if (!shopId) return null

            let ownerRole = 'customer'
            if (shopOwnerId) {
                const { data: ownerUser } = await supabase
                    .from('users')
                    .select('role, agent_expires_at, dealer_expires_at')
                    .eq('id', shopOwnerId)
                    .maybeSingle()

                // P2-4: reuse the canonical resolver so shop-cost role never drifts
                // from the menu/charge role logic (effectiveRole).
                ownerRole = effectiveRole({
                    id: shopOwnerId,
                    role: (ownerUser as any)?.role,
                    agentExpiresAt: (ownerUser as any)?.agent_expires_at ?? null,
                    dealerExpiresAt: (ownerUser as any)?.dealer_expires_at ?? null,
                })
            }

            // Cost price = what admin charges the shop owner (their role-based price) —
            // UNLESS the owner is a sub-agent, in which case the plain tier lookup never
            // applies at all: their true wholesale cost comes from the sub-agent pricing
            // engine (Task 3), mirroring lib/shop-order-processor.ts's storefront pattern
            // (resolve context, resolve cost, insert, record the recruiter's earning).
            const plainTierCost = (): number => {
                if (ownerRole === 'dealer' && (pkg as any)?.dealer_price) {
                    return Number((pkg as any).dealer_price)
                } else if (ownerRole === 'agent' && (pkg as any)?.agent_price) {
                    return Number((pkg as any).agent_price)
                }
                return Number((pkg as any)?.price ?? payload.price)
            }

            let ownerCostPrice: number
            let recruiterMargin: { recruiterId: string; amount: number } | null = null

            if (shopOwnerId) {
                const subCtx = await resolveSubAgentContext(supabase, shopOwnerId)
                if (subCtx.isSub) {
                    // FAIL CLOSED: never fulfil a sub-agent shop's order at a fabricated
                    // price. resolveSubAgentDataCost itself returns !ok both when the
                    // sub/recruiter chain is ineligible (suspended, recruiter expired) and
                    // when pricing can't be resolved — either way, no order is recorded.
                    const resolved = await resolveSubAgentDataCost(supabase, shopOwnerId, payload.packageId, pkg, 'data')
                    if (!resolved.ok) {
                        console.error(`[USSD Data Fulfillment] sub-agent cost unresolvable for shop ${shopId} owner ${shopOwnerId}: ${resolved.reason}`)
                        await sendAdminPushNotification({
                            title: 'Shop USSD sub-agent pricing unavailable',
                            body: `Sub-agent shop ${shopId} (${payload.network} ${payload.packageSize}) could not be priced (${resolved.reason}). Order NOT recorded at a fabricated price — the customer's payment needs manual review.`,
                        }).catch(() => {})
                        return null
                    }
                    ownerCostPrice = resolved.subCost
                    if (resolved.recruiterEarns > 0 && resolved.recruiterId) {
                        recruiterMargin = { recruiterId: resolved.recruiterId, amount: resolved.recruiterEarns }
                    }
                } else {
                    ownerCostPrice = plainTierCost()
                }
            } else {
                ownerCostPrice = plainTierCost()
            }

            const shopProfit = parseFloat((shopSellingPrice - ownerCostPrice).toFixed(2))

            // Should be unreachable: the USSD handler refuses to charge a shop sale that
            // is not above the owner's cost (isShopDataPriceSellable). If it happens anyway
            // (e.g. a role change after the charge), the paid order still ships — alert so
            // the loss is reviewed rather than silently absorbed by the Math.max(0) below.
            if (shopProfit < 0) {
                console.error(`[USSD Data Fulfillment] 🚨 UNDERWATER shop sale: shop ${shopId}, pkg ${payload.packageId}, selling ${shopSellingPrice}, owner cost ${ownerCostPrice}`)
                await sendAdminPushNotification({
                    title: 'USSD shop sale below cost',
                    body: `Shop ${shopId} sold ${payload.network} ${payload.packageSize} at GHS ${shopSellingPrice} below the owner's cost GHS ${ownerCostPrice}. Order ships; review the shop's pricing.`,
                }).catch(() => {})
            }

            const { data: shopOrder, error: shopOrderError } = await (supabase as any)
                .from('shop_orders')
                .insert({
                    shop_id:            shopId,
                    package_id:         payload.packageId,
                    guest_phone:        payload.recipientPhone,
                    // The dialing MSISDN is the number that actually paid.
                    // guest_phone above is the BENEFICIARY and is a different
                    // number on ~31% of USSD orders.
                    payer_momo_number:  normalizePhone(mobile),
                    network:            payload.network,
                    package_size:       payload.packageSize,
                    selling_price:      shopSellingPrice,
                    cost_price:         ownerCostPrice,
                    profit:             Math.max(0, shopProfit),
                    admin_cost_at_time: adminCost,
                    owner_role_at_time: ownerRole,
                    status:             mirrorStatus,
                    source:             'ussd',
                })
                .select('id')
                .single()

            if (shopOrderError) {
                console.error('[USSD Data Fulfillment] shop_orders insert failed:', shopOrderError)
                // Non-fatal for the customer (their bundle still ships), but the shop
                // owner loses their profit credit silently — alert admins to reconcile.
                await sendAdminPushNotification({
                    title: 'Shop USSD credit not recorded',
                    body: `shop_orders insert failed for shop ${shopId} (${payload.network} ${payload.packageSize}, GHS ${payload.price}). Customer order proceeds; credit the shop manually. Error: ${shopOrderError.message ?? shopOrderError}`,
                }).catch(() => {})
                return null
            }

            const soId = (shopOrder as any).id as string
            const { error: linkError } = await (supabase.from('orders') as any)
                .update({ shop_order_id: soId })
                .eq('id', orderId)
            if (linkError) {
                // The credit RPC keys off shop_orders directly, so money still
                // flows — but status sync + refund tooling need the link.
                console.error('[USSD Data Fulfillment] orders.shop_order_id link failed:', linkError)
            }

            // Record the recruiter's pending earning (Task 3) — keyed on THIS shop_orders
            // row's own id (soId), NOT referenceCode. The DB trigger on shop_orders
            // (trg_sub_agent_earning_by_paystack_reference, 20260907e) looks the pending
            // row up by COALESCE(NEW.paystack_reference, NEW.id::text) scoped to
            // order_table='shop_orders' — and a USSD-originated shop_orders row never has
            // paystack_reference set, so the trigger always searches by the row's own id.
            // referenceCode (the USSD-DATA-<SESSION> value) is only ever matched against
            // `orders.reference_code` by THIS file's idempotency check above; it is not a
            // shop_orders column at all and the trigger would never find a row keyed on it.
            // recordPendingSubAgentEarning's insert is naturally idempotent (a replayed call
            // for the same order_reference hits 23505 and returns success without writing
            // twice) — safe to call from both this fresh path AND the replay self-heal call
            // site above.
            if (recruiterMargin) {
                await recordPendingSubAgentEarning(supabase, {
                    orderReference: soId,
                    orderTable: 'shop_orders',
                    recruiterId: recruiterMargin.recruiterId,
                    subUserId: shopOwnerId!,
                    amount: recruiterMargin.amount,
                }).catch((e) => console.error('[USSD Data Fulfillment] recordPendingSubAgentEarning threw:', e))
            }

            return soId
        }

        // A sub-agent buying for THEMSELVES (no shop): their recruiter earns the markup, keyed on
        // the orders.reference_code the trigger (trg_sub_agent_earning_by_reference_code) reads.
        // Idempotent (23505 on replay), so safe on both the fresh and the replay path.
        const recordSelfPurchaseEarning = async (): Promise<void> => {
            if (shopId || !userId) return
            try {
                const sub = await resolveSubAgentSelfDataPrice(supabase, userId, payload.packageId, (pkg ?? {}) as any)
                if (sub.kind !== 'sub') {
                    if (sub.kind === 'blocked') {
                        await sendAdminPushNotification({
                            title: 'Sub-agent USSD earning not recorded',
                            body: `Order ${referenceCode} (${payload.network} ${payload.packageSize}, paid GHS ${payload.price}): sub pricing/eligibility changed before fulfillment, so the recruiter margin was not recorded. Reconcile manually.`,
                        }).catch(() => {})
                    }
                    return
                }
                // Margin follows what the sub ACTUALLY paid (locked at the confirm screen); the
                // global USSD fee is the platform's and is stripped before comparing.
                const paid = Number(payload.price)
                const { amount, drifted } = deriveSelfPurchaseMargin({
                    paid,
                    feePercent: await getUSSDFeePercent(supabase),
                    subPrice: sub.price,
                    recruiterEarns: sub.recruiterEarns,
                })
                if (drifted) {
                    await sendAdminPushNotification({
                        title: 'Sub-agent USSD price drift',
                        body: `Order ${referenceCode}: sub paid GHS ${paid} but current sub price is GHS ${sub.price}. Recruiter margin recorded as GHS ${amount}.`,
                    }).catch(() => {})
                }
                await recordPendingSubAgentEarning(supabase, {
                    orderReference: referenceCode,
                    orderTable:     'orders',
                    recruiterId:    sub.recruiterId,
                    subUserId:      userId,
                    amount,
                })
            } catch (e) {
                console.error('[USSD Data Fulfillment] self-purchase earning record threw:', e)
            }
        }

        // P1-2 / idempotency + SELF-HEAL: an order with this per-session
        // reference means this is a replay (status-check race, late callback,
        // or a prior attempt that crashed mid-way). Never create a second
        // order — but DO finish the bookkeeping the crashed attempt may have
        // skipped: ensure the shop ledger row exists and is linked, mark the
        // pending order fulfilled, and (re-)attempt the idempotent credit.
        // Dispatch is intentionally NOT re-triggered: the first worker may
        // still be mid-dispatch, and stuck 'pending' orders belong to the
        // refulfill cron — re-dispatching here risks double supply.
        {
            const { data: dup } = await supabase
                .from('orders')
                .select('id, shop_order_id, status')
                .eq('reference_code', referenceCode)
                .maybeSingle()
            if (dup) {
                const dupOrderId = (dup as any).id as string
                let dupShopOrderId = (dup as any).shop_order_id as string | null
                if (shopId && !dupShopOrderId) {
                    // Mirror the existing orders row's status (may be 'queued').
                    dupShopOrderId = await createAndLinkShopOrder(dupOrderId, (dup as any).status || 'pending')
                }
                await recordSelfPurchaseEarning()
                if (pendingOrderId) {
                    await supabase
                        .from('ussd_pending_orders')
                        .update({ status: 'fulfilled', fulfilled_at: new Date().toISOString() })
                        .eq('id', pendingOrderId)
                }
                // Never (re-)credit a refunded order — a queued order can sit for days
                // awaiting registration, widening the overlap with an admin refund, so a
                // late Hubtel replay must not resurrect the shop profit.
                if (dupShopOrderId && (dup as any).status !== 'refunded') {
                    await creditShopProfit(dupShopOrderId)
                }
                return { success: true, orderId: dupOrderId }
            }
        }

        // 2. Create the MAIN order first (mirrors the website purchase route).
        //    The shop ledger row is created and linked AFTERWARDS: once the
        //    orders row exists, any later crash is repairable by the replay
        //    self-heal above. The previous ordering (shop_orders first) left an
        //    orphaned, credit-eligible ledger row the replay would duplicate.
        // MTN number-registration gate — hold unregistered MTN recipients as 'queued'.
        const queueDecision = await resolveOrderQueueing(payload.recipientPhone, payload.network)

        const orderInsertData: Record<string, unknown> = {
            phone_number:   payload.recipientPhone,
            network:        payload.network,
            size:           payload.packageSize,
            // Record the shop's selling price (pre-fee) like the website shop flow;
            // identical to payload.price for non-shop USSD orders.
            price:          shopSellingPrice,
            cost_price_at_time: adminCost,
            status:         queueDecision.queue ? 'queued' : 'pending',
            payment_status: 'paid',
            payment_method: paymentMethod,
            reference_code: referenceCode,
            fulfillment_method: 'auto',
            source:         shopId ? 'ussd_shop' : 'ussd',
            ...(shopId && shopName ? { shop_name: shopName } : {}),
        }

        // Only include user_id if the user has an account
        if (userId) {
            orderInsertData.user_id = userId
        }

        const { data: order, error: orderError } = await (supabase
            .from('orders') as any)
            .insert(orderInsertData)
            .select('id, reference_code')
            .single()

        if (orderError) {
            console.error('[USSD Data Fulfillment] Order insert failed:', orderError)
            return { success: false, error: orderError.message }
        }

        // 2b. Shop ledger row (created after the orders row — see comment above).
        //     Mirror the queued status so shop_orders stays in lock-step with orders.
        const shopOrderId = await createAndLinkShopOrder((order as any).id as string, queueDecision.queue ? 'queued' : 'pending')
        await recordSelfPurchaseEarning()

        // 3. Mark pending order as fulfilled
        if (pendingOrderId) {
            const pendingUpdateData: Record<string, unknown> = {
                status: 'fulfilled',
                fulfilled_at: new Date().toISOString(),
            }
            if (paymentMethod !== 'wallet' && fulfillment?.OrderId) {
                pendingUpdateData.hubtel_order_id = fulfillment.OrderId
            }
            await supabase
                .from('ussd_pending_orders')
                .update(pendingUpdateData)
                .eq('id', pendingOrderId)
        }

        // 4. SMS to data recipient — same template as website storefront. SHOP
        //    orders join the metered sender system (feature-wave5, Task 1):
        //    suppressed until the shop has an approved sender and credit-debited
        //    per send — no free platform-sender fallback, mirroring the website
        //    shop checkout flow (lib/shop-order-processor.ts). Fire-and-forget
        //    with .catch: must never affect fulfillment. Non-shop USSD orders
        //    keep the free platform send exactly as before. Held (queued) orders
        //    send no "being processed" SMS until they are released after the
        //    supplier confirms the number's registration.
        const recipientPhone = normalizePhone(payload.recipientPhone)
        if (!queueDecision.queue) {
            if (shopId) {
                // Bug fix: this call used to fire unconditionally, ignoring the
                // shop owner's "Customer order SMS" toggle
                // (shop_profiles.sms_order_confirmation_enabled) — a shop owner
                // who turned confirmations off still had SMS sent and credits
                // debited for every USSD order. The storefront/webhook path
                // (lib/shop-order-processor.ts) already gated on this column;
                // USSD fulfillment did not.
                if (shopSmsConfirmEnabled) {
                    sendShopConfirmationSMS(supabase, shopId, recipientPhone, {
                        network: payload.network,
                        size:    payload.packageSize,
                        price:   payload.price,
                    }).catch(() => {})
                }
            } else {
                await sendOrderSuccessSMS(recipientPhone, {
                    network:         payload.network,
                    size:            payload.packageSize,
                    price:           payload.price,
                    recipientNumber: recipientPhone,
                    currentBalance:  0,
                })
            }
        }

        // 5. Track guest customer
        if (!userId) {
            await trackUSSDCustomer(supabase, mobile, operator, 'data', payload.price)
        }

        // 5b. Credit shop profit after successful order creation
        if (shopOrderId) {
            await creditShopProfit(shopOrderId)
        }

        // 6. Trigger auto-fulfillment via the same pipeline as the website purchase route.
        //    Must be AWAITED, not wrapped in waitUntil: the wallet path already runs
        //    this whole function inside a waitUntil (after the USSD response is sent),
        //    and a second nested waitUntil registered post-response is dropped by the
        //    platform — which left wallet orders created but stuck on 'pending'.
        //    Awaiting keeps fulfillment inside the caller's single tracked promise.
        //    Queued (unregistered MTN) orders are held — released later by an admin.
        if (queueDecision.queue) {
            console.log(`[USSD Data Fulfillment] Order ${(order as any).id} QUEUED for MTN number registration — fulfillment held`)
        } else {
            await triggerFulfillment((order as any).id, payload.network, { email: 'ussd-guest', name: 'USSD Order' })
        }

        return { success: true, orderId: (order as any).id }
    } catch (err) {
        console.error('[USSD Data Fulfillment] Unexpected error:', err)
        return { success: false, error: String(err) }
    }
}
