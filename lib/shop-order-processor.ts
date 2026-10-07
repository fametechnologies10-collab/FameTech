import { waitUntil } from '@vercel/functions'
import { createServerClient } from './supabase'
import { creditShopProfit, creditShopOrderProfits } from './shop-service'
import { sendShopConfirmationSMS, resolveShopSenderFromRow } from './sms-confirmation-sender'
import { getAdminOOSNetworks, mergeOOS, isNetworkOOS } from '@/lib/network-stock'
import { resolveOwnerCost } from '@/lib/pricing/cost-basis'
import { roleFeeSettingKeys, resolveRoleFeeSetting } from '@/lib/pricing/shop-fee-resolver'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentDataCost } from '@/lib/sub-agent-data-pricing'
import { recordPendingSubAgentEarning } from '@/lib/sub-agent-earnings'
import { repairSubAgentEarning } from '@/lib/sub-agent-earning-repair'
import { resolveOrderQueueing } from '@/lib/number-registration'
import { sanitizeForStorage } from '@/lib/sanitize-for-storage'
import { resolveEnabledSuppliers, type FulfillmentNetworkSettings } from '@/lib/order-supplier'
import { claimForDispatchByShopOrderId, acceptDispatch, releaseClaim } from '@/lib/dispatch-claim'

// In-memory lock to prevent race conditions between frontend verification and Paystack webhooks
const processingLocks = new Set<string>();

/**
 * Shared logic for processing a successful shop storefront payment.
 * Handles idempotency, security amount validation, order creation, profit credit, and fulfillment.
 */
export async function processShopOrder(
    reference: string,
    metadata: {
        shop_id: string;
        package_id: string;
        guest_phone: string;
        network: string;
        package_size: string;
        fulfillment_mode?: string;
        order_type?: string;
        airtime_amount?: number;
        selling_price?: number;
        cost_price?: number;
        profit?: number;
        use_exact_amount?: boolean;
        original_amount?: number;
        bundle_preference?: string;
    },
    paidAmountPesewas: number,
    slug?: string
): Promise<{ success: boolean; error?: string; orderId?: string; isDuplicate?: boolean }> {
    const supabase = createServerClient()
    const db = supabase as any

    try {
        console.log(`[Shop Order Processor] Processing Ref: ${reference}, Amount: ${paidAmountPesewas} pesewas`)

        // 0. High-Speed Memory Lock (prevents exact-millisecond race conditions on same Vercel lambda)
        if (processingLocks.has(reference)) {
            console.log(`[Shop Order Processor] Active lock found for ${reference}. Skipping duplicate execution.`);
            return { success: true, isDuplicate: true }
        }
        processingLocks.add(reference);

        // 1. Idempotency Check
        const { data: existingOrder } = await db
            .from('shop_orders')
            .select('id, status')
            .eq('paystack_reference', reference)
            .single()

        if (existingOrder) {
            // STRICT IDEMPOTENCY: If the order exists, another process handles/handled it.
            // Do NOT re-trigger fulfillment if it's pending to prevent double-charging DataKazina.
            // 'refunded'/'failed' are terminal — reprocessing must NOT re-credit (an unauth
            // charge-status replay could otherwise re-run SMS + profit credit on a voided sale).
            if (['pending', 'queued', 'processing', 'completed', 'delivered', 'refunded', 'failed'].includes(existingOrder.status)) {
                console.log(`[Shop Order Processor] Idempotency: Order exists with status: ${existingOrder.status}. Skipping duplicate fulfillment.`)

                if (!['refunded', 'failed'].includes(existingOrder.status)) {
                    await repairSubAgentEarning(db, existingOrder.id, reference, metadata)
                        .catch((e: any) => console.error('[Shop Order Processor] replay repair threw:', e))
                }

                processingLocks.delete(reference);
                return { success: true, orderId: existingOrder.id, isDuplicate: true }
            }
        }

        // 2. Security: Verify Amount Against DB Prices
        // A1 — Added airtime_fee_mtn, airtime_fee_telecel, airtime_fee_at to select
        const { data: shopProfile } = await db
            .from('shop_profiles')
            .select('owner_id, shop_name, paystack_fee_percent, fulfillment_mode, airtime_fee_mtn, airtime_fee_telecel, airtime_fee_at, mashup_fee_percent, sms_order_confirmation_enabled, sms_sender_id, sms_sender_status')
            .eq('id', metadata.shop_id)
            .single()

        if (!shopProfile) return { success: false, error: 'Shop profile not found' }

        let expectedTotalPesewas = 0
        let verifiedSellingPrice = 0
        let verifiedCostPrice = 0
        let verifiedProfit = 0
        let adminCostAtTime = 0
        // Sub-agent attribution — re-derived from the DB here (never trusted from metadata)
        let verifiedParentShopId: string | null = null
        let verifiedParentProfit: number | null = null
        // Recruiter's pending earning on this sale (set only for a sub-agent order); hoisted to
        // this scope so it is visible at the recordPendingSubAgentEarning call site further down.
        let recruiterMargin: { recruiterId: string; amount: number } | null = null
        // True whenever this sale is a sub-agent storefront sale, regardless of whether a
        // recruiter markup applies (a zero-markup sub sale is still a sub sale for the
        // underwater-guard's purposes below).
        let isSubSale = false

        const { data: ownerProfile } = await db
            .from('users')
            .select('role, dealer_expires_at, agent_expires_at')
            .eq('id', shopProfile?.owner_id)
            .single()
            
        const ownerRole = ownerProfile?.role || 'customer'

        // Hoisted so the airtime_orders insert can split totalFeeAmount into admin vs shop portions
        let airtimeShopFeeRate  = 0
        let airtimeAdminFeeRate = 0

        if (metadata.order_type === 'airtime' || metadata.order_type === 'mashup') {
            const feePrefix = metadata.order_type === 'mashup' ? 'mashup' : 'airtime'
            const { data: settingsRows } = await db.from('admin_settings').select('key, value').in('key', [
                `${feePrefix}_fee_${metadata.network.toLowerCase()}_customer`,
                `${feePrefix}_fee_${metadata.network.toLowerCase()}_agent`,
                `${feePrefix}_fee_${metadata.network.toLowerCase()}_dealer`,
            ])
            const settingsMap = (settingsRows || []).reduce((acc: any, curr: any) => ({ ...acc, [curr.key]: curr.value }), {})

            // Use mashup_fee_percent for mashup shop markup, airtime_fee_X for airtime shop markup
            const shopFeeKey = `airtime_fee_${metadata.network.toLowerCase()}`
            const shopFee = metadata.order_type === 'mashup'
                ? parseFloat((shopProfile as any).mashup_fee_percent || 1)
                : parseFloat((shopProfile as any)[shopFeeKey] || 0)
            const adminFee = parseFloat(settingsMap[`${feePrefix}_fee_${metadata.network.toLowerCase()}_${ownerRole}`] || '0')

            // Store rates so we can split fee_amount in the airtime_orders insert below
            airtimeShopFeeRate  = shopFee
            airtimeAdminFeeRate = adminFee
            
            const originalAmount = parseFloat((metadata.original_amount || metadata.airtime_amount || metadata.selling_price || '0') as any)
            
            const totalFeeMultiplier = (shopFee + adminFee) / 100
            const feeAmount = originalAmount * totalFeeMultiplier
            
            let actualAirtimeAmount = originalAmount
            const exactFlag = metadata.use_exact_amount
            const isExact = exactFlag === true || String(exactFlag) === 'true'
            
            if (isExact || exactFlag === undefined) {
                // If it's an old pending order without the flag, it behaves like exact mode
                expectedTotalPesewas = Math.round((originalAmount + feeAmount) * 100)
            } else {
                expectedTotalPesewas = Math.round(originalAmount * 100)
                actualAirtimeAmount = Math.max(0, originalAmount - feeAmount)
            }
            
            verifiedSellingPrice = actualAirtimeAmount
            verifiedCostPrice = actualAirtimeAmount
            verifiedProfit = actualAirtimeAmount > 0 ? actualAirtimeAmount * (shopFee / 100) : 0
            adminCostAtTime = actualAirtimeAmount
        } else {
            // --- Role-Aware Paystack Fee Resolution ---
            // Priority: per-shop override → role-specific global → (subagent only)
            // customer-tagged global → legacy global → hardcoded default. See
            // lib/pricing/shop-fee-resolver.ts for the shared resolver — this used to be
            // a local copy of that logic (5 other copies existed across the codebase,
            // and had drifted: none of them fell back to the customer rate for a
            // sub-agent with no `_subagent`-tagged global row of their own).
            // A per-shop override of exactly 0 means "deliberately free for this shop".
            // Only null means "inherit from global".
            const { data: paystackSettingsRows } = await db
                .from('shop_global_settings')
                .select('key, value')
                .in('key', roleFeeSettingKeys(ownerRole, 'shop_paystack_fee_percent'))
            const paystackSettingsMap: Record<string, string> = {}
            for (const row of (paystackSettingsRows || [])) {
                paystackSettingsMap[row.key] = row.value
            }

            const paystackFeePercent = resolveRoleFeeSetting(
                paystackSettingsMap, ownerRole, 'shop_paystack_fee_percent', 1.95, shopProfile?.paystack_fee_percent
            )

            const { data: pkg } = await db.from('data_packages').select('price, agent_price, dealer_price, cost_price').eq('id', metadata.package_id).single()
            const { data: shopPrice } = await db.from('shop_pricing').select('selling_price').eq('shop_id', metadata.shop_id).eq('package_id', metadata.package_id).maybeSingle()

            if (!pkg) return { success: false, error: 'Price configuration missing' }

            // Sub-agent shop? Re-derive from the DB — metadata hints are never trusted (spec §11).
            const subCtx = await resolveSubAgentContext(db, shopProfile.owner_id)

            // FAIL CLOSED on a chain that stopped being eligible between checkout and now
            // (security review 2026-08-17, finding H1 — preserved from the retired engine).
            // computeShopCheckout gates on effectiveActive, but that only blocks sales from
            // STARTING; a suspension landing while the customer is mid-payment leaves an
            // in-flight order this webhook must also reject, not silently credit.
            if (subCtx.isSub && !subCtx.effectiveActive) {
                console.error(`[Shop Order Processor] 🚨 INELIGIBLE SUB blocked: Ref ${reference}, shop ${metadata.shop_id} — went inactive between checkout and payment confirmation. Flagging for refund.`)
                try {
                    await db.from('security_events').insert({
                        event_type: 'shop_ineligible_sub_chain_blocked',
                        reference,
                        shop_id: metadata.shop_id,
                        paid_amount: paidAmountPesewas,
                        guest_phone: metadata.guest_phone,
                        network: metadata.network,
                        order_type: metadata.order_type || 'data',
                        created_at: new Date().toISOString(),
                    })
                } catch (auditErr) {
                    console.warn('[Shop Order Processor] ineligible-sub audit log failed:', auditErr)
                }
                return { success: false, error: 'This order cannot be completed. Your payment will be refunded.' }
            }

            let dbSubCost: number | null = null
            if (subCtx.isSub) {
                isSubSale = true
                const resolved = await resolveSubAgentDataCost(db, shopProfile.owner_id, metadata.package_id, pkg, 'data')
                if (!resolved.ok) {
                    console.error(`[Shop Order Processor] 🚨 sub cost unresolvable: ${resolved.reason} (Ref ${reference})`)
                    return { success: false, error: 'Pricing changed and this order cannot be completed. Your payment will be refunded.' }
                }
                dbSubCost = resolved.subCost
                if (resolved.recruiterEarns > 0 && resolved.recruiterId) {
                    recruiterMargin = { recruiterId: resolved.recruiterId, amount: resolved.recruiterEarns }
                }
            }

            if (!shopPrice && dbSubCost == null) {
                return { success: false, error: 'Price configuration missing' }
            }

            const adminOOS = await getAdminOOSNetworks(db)
            const { data: shopStock } = await db.from('shop_profiles').select('oos_networks').eq('id', metadata.shop_id).maybeSingle()
            if (isNetworkOOS(mergeOOS(adminOOS, shopStock?.oos_networks), metadata.network)) {
                return { success: false, error: `${metadata.network} is out of stock at the moment` }
            }

            const dbSellingPrice = shopPrice ? parseFloat(shopPrice.selling_price) : (dbSubCost as number)
            const paystackFee = Math.round(dbSellingPrice * (paystackFeePercent / 100) * 100) / 100
            expectedTotalPesewas = Math.round((dbSellingPrice + paystackFee) * 100)

            verifiedSellingPrice = dbSellingPrice
            adminCostAtTime = parseFloat(pkg?.cost_price) || 0

            if (subCtx.isSub && dbSubCost != null) {
                verifiedCostPrice = dbSubCost
                verifiedProfit = dbSellingPrice - dbSubCost
            } else {
                // Not a sub sale: process as a NORMAL single-party sale rather than stranding a
                // paid order. Mirrors the checkout-time computation so the webhook re-verify
                // agrees. (Spec D17.)
                verifiedCostPrice = resolveOwnerCost(pkg, {
                    role: ownerRole,
                    agent_expires_at: ownerProfile?.agent_expires_at,
                    dealer_expires_at: ownerProfile?.dealer_expires_at,
                })
                verifiedProfit = dbSellingPrice - verifiedCostPrice
            }
        }

        const amountDifference = Math.abs(paidAmountPesewas - expectedTotalPesewas)

        // A2 — SECURITY: Amount validation runs BEFORE any order creation
        if (amountDifference > 5) {
            console.error(`[Shop Order Processor] 🚨 AMOUNT MISMATCH: Ref: ${reference}, Paid: ${paidAmountPesewas}, Expected: ${expectedTotalPesewas}`)

            // B5 — Audit trail: persist mismatch for fraud monitoring
            try {
                await db.from('security_events').insert({
                    event_type: 'airtime_amount_mismatch',
                    reference,
                    shop_id: metadata.shop_id,
                    paid_amount: paidAmountPesewas,
                    expected_amount: expectedTotalPesewas,
                    guest_phone: metadata.guest_phone,
                    network: metadata.network,
                    order_type: metadata.order_type || 'data',
                    created_at: new Date().toISOString()
                })
            } catch (auditErr) {
                // Non-fatal — log but continue returning the error
                console.warn('[Shop Order Processor] Audit log failed:', auditErr)
            }

            // A5 — Safety net: if an existingOrder record was found (already in DB), update all tables to failed
            if (existingOrder?.id) {
                await db.from('shop_orders').update({ status: 'failed' }).eq('id', existingOrder.id)
                await db.from('orders').update({ status: 'failed' }).eq('shop_order_id', existingOrder.id)
                await db.from('airtime_orders')
                    .update({ status: 'failed' })
                    .eq('reference_code', `SHOP-${reference.slice(-10)}`)
            }

            return { success: false, error: 'Payment amount mismatch' }
        }

        // FIX D (spec §7.5): re-enforce the profit floor here. computeShopCheckout rejects
        // profit<=0, but a role downgrade BETWEEN checkout and this webhook can raise the
        // owner cost and flip a valid sale underwater — and previously the order was still
        // inserted (and later credited a NEGATIVE profit, debiting the owner). Block it,
        // flag for refund. Data orders only (airtime/mashup profit is fee-based, always >=0).
        // Sub-agent orders: zero sub-markup is LEGAL (no-markup default), so the floor is
        // strictly-negative for a sub sale; normal shops keep profit > 0.
        const isDataOrder = !(metadata.order_type === 'airtime' || metadata.order_type === 'mashup')
        const underwater = isSubSale ? verifiedProfit < 0 : verifiedProfit <= 0
        if (isDataOrder && underwater) {
            console.error(`[Shop Order Processor] 🚨 UNDERWATER ORDER blocked: Ref ${reference}, selling ${verifiedSellingPrice}, cost ${verifiedCostPrice}, profit ${verifiedProfit} — likely a role-downgrade race. Flagging for refund.`)
            try {
                await db.from('security_events').insert({
                    event_type: 'shop_underwater_order_blocked',
                    reference,
                    shop_id: metadata.shop_id,
                    paid_amount: paidAmountPesewas,
                    expected_amount: expectedTotalPesewas,
                    guest_phone: metadata.guest_phone,
                    network: metadata.network,
                    order_type: metadata.order_type || 'data',
                    created_at: new Date().toISOString(),
                })
            } catch (auditErr) {
                console.warn('[Shop Order Processor] underwater audit log failed:', auditErr)
            }
            return { success: false, error: 'Pricing changed and this order cannot be completed. Your payment will be refunded.' }
        }

        // MTN number-registration gate — data orders only (airtime/mashup unaffected).
        // Unregistered MTN guest numbers are held 'queued' (no dispatch) until an
        // admin releases the batch after the supplier confirms registration.
        const queueDecision = isDataOrder
            ? await resolveOrderQueueing(metadata.guest_phone, metadata.network)
            : { queue: false, canonicalPhone: null }
        const shopOrderStatus = queueDecision.queue ? 'queued' : 'pending'

        // 3. Create Order Records (only runs after amount validation passes)
        let orderId = existingOrder?.id
        let airtimeOrderId: string | null = null
        const fulfillmentMode = shopProfile?.fulfillment_mode || metadata.fulfillment_mode || 'auto'

        if (!existingOrder) {
            const payload = {
                shop_id: metadata.shop_id,
                package_id: metadata.package_id || null, // null for airtime
                guest_phone: metadata.guest_phone,
                network: metadata.network,
                package_size: metadata.package_size || `${metadata.airtime_amount} Airtime`,
                selling_price: verifiedSellingPrice,
                cost_price: verifiedCostPrice,
                profit: verifiedProfit,
                admin_cost_at_time: adminCostAtTime,
                owner_role_at_time: ownerRole,
                // Sub-agent split snapshot (DB-verified above; both immutable from here)
                parent_shop_id: verifiedParentShopId,
                parent_profit: verifiedParentProfit,
                paystack_reference: reference,
                status: shopOrderStatus
            }

            const { data: newOrder, error: createError } = await db
                .from('shop_orders')
                .insert(payload)
                .select('id')
                .single()

            if (createError) {
                // Cross-lambda race: the UNIQUE(paystack_reference) constraint rejected this
                // duplicate insert because another instance (or the webhook) already created the
                // order. Treat as an idempotent duplicate, not a failure — the winner fulfills.
                if ((createError as any).code === '23505') {
                    console.log(`[Shop Order Processor] Idempotency: duplicate insert for ${reference} (unique violation). Skipping.`)
                    processingLocks.delete(reference)
                    return { success: true, isDuplicate: true }
                }
                console.error('[Shop Order Processor] Failed to create shop order:', createError)
                return { success: false, error: 'Order creation failed' }
            }
            orderId = newOrder?.id

            // Record the recruiter's pending earning (spec §3.2) via the shared ledger helper.
            // recordPendingSubAgentEarning's insert is naturally idempotent (a replayed call
            // with the same order_reference hits 23505 and returns success without writing
            // twice) — the trigger built in Plan 1 does the actual wallet crediting once the
            // order's status reaches completed.
            if (orderId && recruiterMargin) {
                await recordPendingSubAgentEarning(db, {
                    orderReference: reference,
                    orderTable: 'shop_orders',
                    recruiterId: recruiterMargin.recruiterId,
                    subUserId: shopProfile.owner_id,
                    amount: recruiterMargin.amount,
                }).catch((e) => console.error('[Shop Order Processor] recordPendingSubAgentEarning threw:', e))
            }

            await db.from('orders').insert({
                user_id: shopProfile?.owner_id,
                phone_number: metadata.guest_phone,
                network: metadata.network,
                size: metadata.package_size || `${metadata.airtime_amount} Airtime`,
                price: verifiedSellingPrice,
                cost_price_at_time: verifiedCostPrice,
                role_at_time: ownerRole,
                status: shopOrderStatus,
                payment_status: 'paid',
                reference_code: `SHOP-${reference.slice(-10)}`,
                fulfillment_method: 'auto',
                shop_name: shopProfile?.shop_name || slug,
                shop_order_id: orderId
            })

            // Mirror airtime orders to the primary airtime_orders ledger
            // so admins can view and fulfill them in the Airtime Intelligence page
            if (metadata.order_type === 'airtime' || metadata.order_type === 'mashup') {
                // A3 — Use actual paid amount (paidAmountPesewas), NOT expectedTotalPesewas
                const totalPaidGHS = paidAmountPesewas / 100
                const totalFeeAmount = Math.max(0, totalPaidGHS - verifiedSellingPrice)
                const totalFeeRate = verifiedSellingPrice > 0 ? (totalFeeAmount / verifiedSellingPrice) * 100 : 0

                // Split fee into admin vs shop portions for transparent profit tracking
                const totalFeeRate2 = airtimeShopFeeRate + airtimeAdminFeeRate
                const adminFeeAmount = totalFeeRate2 > 0
                    ? totalFeeAmount * (airtimeAdminFeeRate / totalFeeRate2)
                    : totalFeeAmount
                const shopFeeAmount = totalFeeRate2 > 0
                    ? totalFeeAmount * (airtimeShopFeeRate / totalFeeRate2)
                    : 0

                // A4 — Read use_exact_amount from metadata instead of hardcoding false
                const useExactAmountFlag = metadata.use_exact_amount === true || String(metadata.use_exact_amount) === 'true'

                const { data: newAirtimeOrder, error: airtimeInsertError } = await db.from('airtime_orders').insert({
                    user_id: shopProfile?.owner_id,
                    user_role: ownerRole,
                    beneficiary_phone: metadata.guest_phone,
                    network: metadata.network,
                    airtime_amount: verifiedSellingPrice,
                    fee_rate: totalFeeRate,
                    fee_amount: totalFeeAmount,
                    admin_fee_amount: adminFeeAmount,
                    shop_fee_amount: shopFeeAmount,
                    total_paid: totalPaidGHS,
                    use_exact_amount: useExactAmountFlag,
                    status: 'pending',
                    // Explicit: the column's DEFAULT is 'web', which would mislabel every
                    // storefront order. See 20260826_airtime_source_default.sql.
                    source: 'shop',
                    reference_code: `SHOP-${reference.slice(-10)}`,
                    shop_id: metadata.shop_id,
                    shop_name: shopProfile?.shop_name || slug,
                    type: metadata.order_type,
                    bundle_preference: metadata.bundle_preference || null
                }).select('id').single()
                if (airtimeInsertError) {
                    console.error('[ShopOrder] Failed to capture airtime order id:', airtimeInsertError)
                }
                // Hubtel airtime dispatch is for plain airtime only — never mashup
                airtimeOrderId = metadata.order_type === 'airtime' ? (newAirtimeOrder?.id ?? null) : null
            }
        }

        // 4. Process Valid Order — SMS, Profit Credit, Fulfillment
        // Customer confirmation SMS is opt-out per shop (defaults to enabled).
        // Held (queued) orders send no "delivered" SMS until they are released.
        // Task F3: suppress-until-sender + credit-metered — a shop with no
        // APPROVED sms_sender_id sends NOTHING (no free platform-sender
        // fallback); an approved shop pays 1 SMS credit/confirmation via
        // debit_sms_credits (with atomic refund-on-send-failure). The sender
        // is pre-resolved from the shopProfile row already SELECTed above so
        // sendShopConfirmationSMS doesn't re-query shop_profiles.
        if (metadata.guest_phone && !queueDecision.queue && (shopProfile as any)?.sms_order_confirmation_enabled !== false) {
            waitUntil(sendShopConfirmationSMS(db, metadata.shop_id, metadata.guest_phone, {
                network: metadata.network,
                size: metadata.package_size || `${metadata.airtime_amount} Airtime`,
                price: verifiedSellingPrice,
            }, {
                sender: resolveShopSenderFromRow(shopProfile as any),
            }).catch((err: Error) => console.error('[Shop Order Processor] Confirmation SMS error:', err)))
        }

        // 4.2 Credit Profit — under the new single-recruiter engine every shop order,
        // sub-agent or not, is a single-party sale for crediting purposes: `verifiedParentShopId`
        // is always null now (Finding 1 fix), so this always takes the `creditShopProfit` path.
        // `creditShopOrderProfits` (the OLD chain-aware crediting RPC, credits the retired
        // `shop_wallets` chain-split system) is intentionally left dispatchable below as
        // dead-but-harmless code rather than deleted, so a future re-introduction of
        // `verifiedParentShopId` doesn't silently resurrect it without review. Recruiter
        // crediting for sub-agent sales is handled entirely separately — recorded here via
        // recordPendingSubAgentEarning above, then actually credited to the NEW
        // `commission_wallets` system by a database trigger (from Plan 1) once the order
        // reaches completed. Firing both paths for the same order would double-credit, which
        // is exactly what this dispatch must never do.
        try {
            if (verifiedParentShopId) {
                await creditShopOrderProfits(orderId!)
            } else {
                await creditShopProfit(orderId!)
            }
        } catch (profitErr) {
            console.error('[Shop Order Processor] Profit credit error:', profitErr)
        }

        // 4.3 Trigger Fulfillment (held for queued MTN-registration orders)
        if (queueDecision.queue) {
            console.log(`[Shop Order Processor] Order ${orderId} QUEUED for MTN number registration — fulfillment held`)
        } else {
            try {
                const fulfillmentPayload = (metadata.order_type === 'airtime' || metadata.order_type === 'mashup')
                   ? { amount: metadata.airtime_amount || verifiedSellingPrice }
                   : { size: metadata.package_size }

                await triggerShopFulfillment(orderId!, metadata.network, metadata.guest_phone, db, {
                    referenceCode: `SHOP-${reference.slice(-10)}`,
                    price: verifiedSellingPrice,
                    customerName: 'Shop Guest',
                    customerEmail: 'N/A',
                    shopName: shopProfile?.shop_name || slug || shopProfile?.shop_name,
                    fulfillmentMode,
                    orderType: metadata.order_type || 'data',
                    airtimeOrderId: airtimeOrderId ?? undefined,
                    ...fulfillmentPayload
                })
            } catch (fulfillErr) {
                console.error('[Shop Order Processor] Fulfillment error:', fulfillErr)
            }
        }

        return { success: true, orderId }

    } catch (error) {
        console.error('[Shop Order Processor] Critical error:', error)
        return { success: false, error: 'Internal processor error' }
    } finally {
        // Clear lock after processing completes or fails
        processingLocks.delete(reference);
    }
}

async function triggerShopFulfillment(
    orderId: string,
    network: string,
    phone: string,
    db: any,
    extra: {
        referenceCode: string
        price: number
        customerName: string
        customerEmail: string
        shopName: string
        fulfillmentMode: string
        orderType: string
        amount?: number
        size?: string
        airtimeOrderId?: string
    }
) {
    // Refund guard (defense-in-depth): never fulfill a shop order that was refunded — or has a
    // Paystack refund IN PROGRESS (refund_method='paystack', finalized by the refund webhook) —
    // between payment and this dispatch.
    const { data: statusRow } = await db.from('shop_orders').select('status, refund_method').eq('id', orderId).maybeSingle()
    const _rm = (statusRow as any)?.refund_method
    if ((statusRow as any)?.status === 'refunded' || _rm === 'paystack' || _rm === 'paystack_attention') {
        console.log(`[Shop Order Processor] Skipping fulfillment for refunded/refunding shop order ${orderId}`)
        return
    }

    const { sendAdminNewOrderAlert } = await import('./email-service')

    const alertDetails = {
        referenceCode: extra.referenceCode,
        phoneNumber: phone,
        network: network,
        size: extra.size || `${extra.amount} Airtime`,
        price: extra.price,
        customerName: extra.customerName,
        customerEmail: extra.customerEmail,
        source: 'shop_storefront' as const,
        shopName: extra.shopName
    }

    let internalOrderId: string | null = null

    if (extra.fulfillmentMode !== 'auto' || extra.orderType === 'airtime') {
        console.log(`[Shop Order Processor] Manual fulfillment required - sending alert`)
        
        if (extra.orderType === 'airtime') {
            const { sendAdminAirtimeOrderEmail } = await import('./email-service')
            await sendAdminAirtimeOrderEmail({
                referenceCode: extra.referenceCode,
                userName: extra.customerName,
                userEmail: extra.customerEmail,
                userRole: 'Guest',
                beneficiaryPhone: phone,
                network: network,
                airtimeAmount: extra.amount || extra.price,
                totalPaid: extra.price,
                useExactAmount: false,
                source: `Shop Storefront (${extra.shopName})`
            }).catch(e => console.error('[Shop Order Processor] Admin Airtime Email Error:', e))
            
            // Admin SMS alert disabled for airtime — it auto-fulfills via Hubtel now (admins still get the
            // email above + a web-push on auto-fulfillment failure). Mashup uses sendAdminNewOrderAlert below.

            // ── Auto-dispatch via Hubtel Commission Services (no-op when kill-switch off) ──
            // Fallback: admin alerts above already fired; if auto is OFF the order stays pending
            // for manual fulfillment — today's behavior preserved.
            if (extra.airtimeOrderId) {
                try {
                    const { dispatchAirtimeFulfillment } = await import('@/lib/airtime-fulfillment')
                    await dispatchAirtimeFulfillment(extra.airtimeOrderId)
                } catch (e) {
                    console.error('[ShopOrder] airtime auto-dispatch failed:', e)
                }
            }
        } else {
            await sendAdminNewOrderAlert({
                ...alertDetails,
                reason: 'Manual fulfillment mode enabled for this shop'
            }).catch(e => console.error('[Shop Order Processor] Admin Alert Error:', e))
        }

        return
    }

    try {
        // ── 1. Fetch fulfillment settings from admin_settings ──────────────
        const { data: settingsData } = await db
            .from('admin_settings')
            .select('key, value')
            .in('key', ['auto_fulfillment_enabled', 'fulfillment_settings'])

        const settingsMap = (settingsData || []).reduce((acc: any, curr: any) => {
            acc[curr.key] = curr.value
            return acc
        }, {})

        if (settingsMap.auto_fulfillment_enabled === 'false') {
            console.log(`[Shop Order Processor] Auto-fulfillment globally disabled`)
            await sendAdminNewOrderAlert({ ...alertDetails, reason: 'Global auto-fulfillment is disabled' })
            return
        }

        // ── 2. Parse fulfillment_settings ─────────────────────────────────
        let fulfillmentSettings: {
            networks: Record<string, boolean>
            codecraft_networks: Record<string, boolean>
            xpress_networks: Record<string, boolean>
            ghdata_networks: Record<string, boolean>
            agentportal_networks: Record<string, boolean>
            bundleportal_networks: Record<string, boolean>
            hendylinks_networks: Record<string, boolean>
            atishare_console_networks: Record<string, boolean>
            spfastit_networks: Record<string, boolean>
        } = { networks: {}, codecraft_networks: {}, xpress_networks: {}, ghdata_networks: {}, agentportal_networks: {}, bundleportal_networks: {}, hendylinks_networks: {}, atishare_console_networks: {}, spfastit_networks: {} }

        try {
            if (settingsMap.fulfillment_settings) {
                const parsed = typeof settingsMap.fulfillment_settings === 'string'
                    ? JSON.parse(settingsMap.fulfillment_settings)
                    : settingsMap.fulfillment_settings
                fulfillmentSettings.networks = parsed.networks || {}
                fulfillmentSettings.codecraft_networks = parsed.codecraft_networks || {}
                fulfillmentSettings.xpress_networks = parsed.xpress_networks || {}
                fulfillmentSettings.ghdata_networks = parsed.ghdata_networks || {}
                fulfillmentSettings.agentportal_networks = parsed.agentportal_networks || {}
                fulfillmentSettings.bundleportal_networks = parsed.bundleportal_networks || {}
                fulfillmentSettings.hendylinks_networks = parsed.hendylinks_networks || {}
                fulfillmentSettings.atishare_console_networks = parsed.atishare_console_networks || {}
                fulfillmentSettings.spfastit_networks = parsed.spfastit_networks || {}
            }
        } catch (e) { /* ignore parse failure — defaults to empty */ }

        const isDataKazinaEnabled = fulfillmentSettings.networks[network] === true
        const isCodeCraftEnabled = fulfillmentSettings.codecraft_networks[network] === true
        const isXpressEnabled = fulfillmentSettings.xpress_networks[network] === true
        const isGhDataEnabled = fulfillmentSettings.ghdata_networks[network] === true
        const isAgentPortalEnabled = fulfillmentSettings.agentportal_networks[network] === true
        const isBundlePortalEnabled = fulfillmentSettings.bundleportal_networks[network] === true
        const isHendyLinksEnabled = fulfillmentSettings.hendylinks_networks[network] === true
        const isAtiShareConsoleEnabled = fulfillmentSettings.atishare_console_networks[network] === true
        const isSpfastitEnabled = fulfillmentSettings.spfastit_networks[network] === true
        // Supplier selection comes from the shared registry in lib/order-supplier.ts so
        // this guard can never drift out of sync with the other dispatch paths.
        const enabledSuppliers = resolveEnabledSuppliers(
            fulfillmentSettings as FulfillmentNetworkSettings,
            network
        )
        const enabledCount = enabledSuppliers.length

        // ── 3. FULFILLMENT_CONFLICT Guard (absolute last line of defense) ──
        if (enabledCount > 1) {
            console.error(`[Fulfillment] CONFLICT DETECTED for ${network} on order ${orderId}`)
            await sendAdminNewOrderAlert({
                ...alertDetails,
                reason: `⚠️ SYSTEM HALTED: Multiple suppliers active for ${network}. Order ${orderId} kept pending. Fix in admin panel immediately.`
            })
            // Keep order as PENDING — do not throw to outer catch (would trigger duplicate alert)
            return
        }

        // ── 4. No active supplier ──────────────────────────────────────────
        if (enabledCount === 0) {
            console.log(`[Shop Order Processor] No active supplier for network ${network}. Order ${orderId} kept pending.`)
            await sendAdminNewOrderAlert({ ...alertDetails, reason: `No active supplier configured for network: ${network}` })
            return
        }

        // ── 5. Determine supplier and stamp fulfilled_by ATOMICALLY first ──
        // Taken from the registry rather than a ternary chain: the old chain ended in a
        // 'datakazina' default, so any supplier missing from it silently routed to
        // DataKazina instead. enabledSuppliers[0] is exact — both guards above have
        // already returned unless exactly one supplier is enabled.
        const supplierLabel = enabledSuppliers[0]
        await db.from('shop_orders').update({ fulfilled_by: supplierLabel }).eq('id', orderId)
        console.log(`[Shop Order Processor] Routing to ${supplierLabel} for order ${orderId} | network: ${network}`)

        // ── 5b. Claim (NOT a status flip — see lib/dispatch-claim.ts) ──────
        // orders.status stays 'pending' through the whole dispatch attempt. A claim that
        // never resolves simply expires and becomes reclaimable.
        internalOrderId = await claimForDispatchByShopOrderId(db, orderId, supplierLabel)
        if (!internalOrderId) {
            console.log(`[Shop Order Processor] Underlying order for shop order ${orderId} could not be claimed for ${supplierLabel} (not pending, or already claimed by a live process), skipping`)
            return
        }

        // ── 6. Execute fulfillment (dedicated try/catch — ensures alert fires on any exception) ──
        // `ambiguous` means "the supplier may already have accepted and CHARGED this order" —
        // set by ./hendylinks-service and ./agentportal-service (no idempotency key on
        // placement) AND by ./fulfillment-service on a DataKazina duplicate-reference rejection.
        // Step 7's failure handler treats it generically; don't assume a single supplier.
        let result: { success: boolean; reference?: string; transactionId?: string; error?: string; isRateLimited?: boolean; apiResponse?: any; ghdataOrderId?: string; ghdataShortId?: string; ambiguous?: boolean }

        try {
            if (isCodeCraftEnabled) {
                const { fulfillOrder: ccFulfill } = await import('./codecraft-service')
                result = await ccFulfill(network, phone, extra.size || '', orderId)
            } else if (isXpressEnabled) {
                const { fulfillOrder: xpFulfill } = await import('./xpress-service')
                result = await xpFulfill(network, phone, extra.size || '', orderId)
            } else if (isGhDataEnabled) {
                const { fulfillGhDataOrder } = await import('./ghdata-service')
                const ghResult = await fulfillGhDataOrder(network, phone, extra.size || '', orderId)
                result = {
                    success: ghResult.success,
                    error: ghResult.error,
                    apiResponse: ghResult.apiResponse,
                    ghdataOrderId: ghResult.ghdataOrderId,
                    ghdataShortId: ghResult.ghdataShortId,
                }
            } else if (isAgentPortalEnabled) {
                // NOTE (scope, deliberate): unlike fulfillment-trigger.ts / refulfillment-service.ts,
                // this file has no MTN whitelist-rejection fallback for AgentPortal — nor does it have
                // one for CodeCraft's 422 fallback, which is the pre-existing asymmetry this mirrors.
                // A rejected MTN order here simply stays pending and is picked up by the bulk
                // re-fulfillment cron, which does implement the fallback. Do not add it here.
                //
                // CRITICAL: `orderId` in this function is shop_orders.id (see the call site in
                // processShopOrder, which passes the shop_orders insert/lookup id). AgentPortal's
                // order.completed webhook matches back to us via `.eq('id', item.reference)` on the
                // `orders` table using whatever we send as `reference` at submit time — it has no
                // concept of shop_orders.id at all. Sending shop_orders.id here means the webhook can
                // NEVER match this order: the order stays charged and stuck in `processing` forever,
                // with no refund fired on failure. `internalOrderId` (resolved by the 5b claim above,
                // which already matched this same row via shop_order_id) is the internal `orders.id`
                // — dispatch with THAT as the reference instead.
                const { fulfillOrder: apFulfill } = await import('./agentportal-service')
                result = await apFulfill(network, phone, extra.size || '', internalOrderId)
            } else if (isBundlePortalEnabled) {
                // Same reasoning as the AgentPortal branch above: `orderId` in this function is
                // shop_orders.id, but Bundle Portal's `order_id` is ITS idempotency key — every
                // other call site (lib/fulfillment-trigger.ts, fulfillOrdersConcurrent) sends
                // orders.id. If a retry after a lost reply re-dispatches with a different
                // order_id (shop_orders.id here vs. orders.id at refulfill time), Bundle Portal
                // sees a brand-new order_id and places a second real, charged order instead of
                // returning the original via its idempotency match. Dispatch with
                // `internalOrderId` (orders.id) so retries always reuse the same key.
                const { fulfillOrder: bpFulfill } = await import('./bundleportal-service')
                result = await bpFulfill(network, phone, extra.size || '', internalOrderId)
            } else if (isHendyLinksEnabled) {
                // HendyLinks has no idempotency key at all, so the shop_orders.id vs. orders.id
                // distinction that matters for Bundle Portal/AgentPortal doesn't apply here —
                // either id would be equally (non-)meaningful to HendyLinks. internalOrderId is
                // still used for consistency with the other suppliers' dispatch calls in this
                // function and because it's the id fulfillment-trigger.ts's parity code expects
                // in logs.
                const { fulfillOrder: hlFulfill } = await import('./hendylinks-service')
                result = await hlFulfill(network, phone, extra.size || '', internalOrderId)
            } else if (isAtiShareConsoleEnabled) {
                // Same orders.id-vs-shop_orders.id reasoning as Bundle Portal/AgentPortal above:
                // client_reference must be built from internalOrderId (orders.id), the same id
                // used on every retry path, so a retry after a lost reply reuses the SAME
                // reference and the console returns the existing transaction instead of placing
                // (and charging for) a second one. retry_count is not meaningful for a first
                // shop dispatch, so it is always 0 here — mirrors Task 8 Step 3's single-order
                // trigger branch in lib/fulfillment-trigger.ts.
                const { sendBundle, buildClientReference, sizeToMb, assertAtIShareNetwork } =
                    await import('./atishare-console-service')

                if (!assertAtIShareNetwork(network)) {
                    result = { success: false, error: `AT-iShare Console cannot serve ${network}` }
                } else {
                    const bundleMb = sizeToMb(extra.size || '')
                    if (bundleMb === null) {
                        result = { success: false, error: `Unparseable size "${extra.size}" for AT-iShare Console` }
                    } else {
                        const clientReference = buildClientReference(internalOrderId, 0)
                        const sendResult = await sendBundle({ phone, bundleMb, clientReference })
                        result = {
                            success: sendResult.success,
                            reference: clientReference,
                            transactionId: sendResult.transactionId,
                            error: sendResult.error,
                            apiResponse: sendResult.apiResponse,
                        }
                    }
                }
            } else if (isSpfastitEnabled) {
                // Same orders.id-vs-shop_orders.id reasoning as the AT-iShare Console branch
                // above: the reference must be built from internalOrderId (orders.id), the
                // same id used on every retry path, so a retry after a lost reply reuses the
                // same reference. retry_count is always 0 for a first shop dispatch.
                const { placeOrder, buildSpfastitReference, sizeToMb, assertTelecelNetwork } =
                    await import('./spfastit-service')

                if (!assertTelecelNetwork(network)) {
                    result = { success: false, error: `SPFastIT cannot serve ${network}` }
                } else {
                    const bundleMb = sizeToMb(extra.size || '')
                    if (bundleMb === null) {
                        result = { success: false, error: `Unsupported size "${extra.size}" for SPFastIT` }
                    } else {
                        const reference = buildSpfastitReference(internalOrderId, 0)
                        const sendResult = await placeOrder({ phone, bundleMb, reference })
                        result = {
                            success: sendResult.success,
                            reference,
                            error: sendResult.error,
                            apiResponse: sendResult.apiResponse,
                            ambiguous: sendResult.transportFault === true,
                        }
                    }
                }
            } else if (isDataKazinaEnabled) {
                const { fulfillOrder: dkFulfill } = await import('./fulfillment-service')
                result = await dkFulfill(network, phone, extra.size || '', orderId)
            } else {
                // No dispatch branch exists for the enabled supplier. Throw rather than falling
                // through to DataKazina: a silent fallthrough spends real money at the wrong
                // wholesaler AND leaves the order stamped with a supplier that never saw it.
                // Throwing routes into the exception branch below, which reverts the claim's
                // `status` back to 'pending' and alerts an admin. Unlike lib/fulfillment-trigger.ts's
                // equivalent catch, THIS catch does not clear `fulfillment_method` or any
                // supplier reference column — the order is re-queued still labelled with the
                // supplier that never actually dispatched it. Pre-existing gap shared by every
                // supplier routed through this processor, not specific to this branch — tracked
                // separately, not fixed here.
                throw new Error(`No dispatch implementation for supplier ${supplierLabel}`)
            }
        } catch (importOrCallErr: any) {
            console.error(`[Shop Order Processor] Supplier import/call exception for order ${orderId}:`, importOrCallErr)
            // Revert the 5b claim so the order goes back to pending for re-fulfillment — the
            // supplier call never returned a definite result (mirrors lib/fulfillment-trigger.ts).
            await releaseClaim(db, internalOrderId)
            await sendAdminNewOrderAlert({
                ...alertDetails,
                reason: `Supplier exception during fulfillment (${supplierLabel}): ${importOrCallErr?.message || 'Unknown error'}. Order kept pending.`
            })
            return
        }

        // ── 7. Handle result ───────────────────────────────────────────────
        if (result.success) {
            // THIS is the moment status actually transitions pending -> processing (the
            // 5b claim above left it 'pending' — see lib/dispatch-claim.ts). Guarded on
            // status='pending' inside acceptDispatch, so a webhook that already resolved
            // the order during dispatch is a safe no-op, not overwritten.
            //
            // The shop_orders write below is gated on `accepted` — NOT unconditional the
            // way it used to be. An order whose acceptDispatch call no-op'd (a webhook
            // already resolved it) must not have its shop_orders row forced to
            // 'processing' either, or shop_orders and orders end up disagreeing again —
            // the same class of bug Task 4's review found in the bulk dispatch path.
            const referenceColumns: Record<string, any> = {}
            if (isCodeCraftEnabled && result.transactionId) {
                referenceColumns.codecraft_reference = result.transactionId
            }
            const bundlePortalRef = result.transactionId || result.reference
            if (isBundlePortalEnabled && bundlePortalRef) {
                referenceColumns.bundleportal_reference = bundlePortalRef
            }
            const hendyLinksRef = result.transactionId || result.reference
            if (isHendyLinksEnabled && hendyLinksRef) {
                // Supplier-controlled string — bounded/stripped before persisting, per the
                // codebase convention (lib/sanitize-for-storage.ts). Same treatment at the
                // other two sites that write this column: lib/fulfillment-trigger.ts and
                // lib/refulfillment-service.ts.
                referenceColumns.hendylinks_order_id = sanitizeForStorage(hendyLinksRef, 200)
            }
            if (isAtiShareConsoleEnabled && result.reference) {
                referenceColumns.atishare_console_reference = result.reference
                if (result.transactionId) referenceColumns.atishare_console_transaction_id = sanitizeForStorage(result.transactionId, 200)
            }
            if (isSpfastitEnabled && result.reference) {
                referenceColumns.spfastit_reference = result.reference
            }
            if (isDataKazinaEnabled && (result.transactionId || result.reference)) {
                referenceColumns.dakazina_reference = result.transactionId || result.reference
            }

            const accepted = await acceptDispatch(db, internalOrderId, supplierLabel, referenceColumns)
            if (!accepted) {
                console.log(`[Shop Order Processor] Accept was a no-op for order ${orderId} — a webhook already resolved it before this bookkeeping ran`)
            } else {
                const updatePayload: Record<string, any> = {
                    status: 'processing',
                    updated_at: new Date().toISOString(),
                }
                if (isCodeCraftEnabled && result.transactionId) {
                    updatePayload.codecraft_reference_id = result.transactionId
                }
                // Guard: never overwrite a row that was refunded during the external dispatch window.
                await db.from('shop_orders').update(updatePayload).eq('id', orderId).neq('status', 'refunded')

                if (isDataKazinaEnabled && (result.transactionId || result.reference)) {
                    await db
                        .from('shop_orders')
                        .update({ dakazina_reference: result.transactionId || result.reference })
                        .eq('id', orderId)
                }

                // Xpress/GhData tracking inserts moved inside this `else` (gated on `accepted`,
                // same as the shop_orders writes above) — they used to run unconditionally even
                // when acceptDispatch no-op'd (a webhook already resolved the order), which would
                // still record a 'completed' tracking row for a dispatch attempt this bookkeeping
                // never actually landed.

                // Xpress: insert tracking with status='completed' so cron/sync can find and poll it
                if (isXpressEnabled) {
                    const { error: xpTrackingError } = await db.from('mtn_fulfillment_tracking').insert({
                        order_id: internalOrderId,
                        status: 'completed',
                        api_response: {
                            ...(result as any).apiResponse,
                            note: 'Shop Order Success via xpress',
                            order_id: result.reference,
                            supplier: 'xpress',
                        },
                    })
                    if (xpTrackingError) console.error('[ShopOrderProcessor] Xpress tracking insert error:', xpTrackingError)
                }

                // GhData: insert tracking with status='completed' so the ghdata sync cron can poll it
                if (isGhDataEnabled) {
                    const { error: ghTrackingError } = await db.from('mtn_fulfillment_tracking').insert({
                        order_id: internalOrderId,
                        status: 'completed',
                        api_response: {
                            ...(result.apiResponse || {}),
                            note: 'Shop Order Success via ghdata',
                            supplier: 'ghdata',
                            ghdata_order_id: result.ghdataOrderId,
                            ghdata_short_id: result.ghdataShortId,
                        },
                    })
                    if (ghTrackingError) console.error('[ShopOrderProcessor] GhData tracking insert error:', ghTrackingError)
                }
            }

            console.log(`[Shop Order Processor] ✅ Fulfillment success for order ${orderId} via ${supplierLabel}. Ref: ${result.transactionId || result.reference || result.ghdataOrderId}`)

        } else if (result.ambiguous) {
            // AMBIGUOUS, not definite — same rule as lib/refulfillment-service.ts step 11.
            // Set by hendylinks/agentportal (no idempotency key on placement) and by
            // fulfillment-service on a DataKazina duplicate-reference rejection. Land the
            // order in 'processing' anyway (acceptDispatch, no reference columns — we
            // don't have a confirmed one): reverting to 'pending' would let the
            // re-fulfillment cron re-dispatch and pay/deliver a second time.
            console.error(`[Shop Order Processor] AMBIGUOUS dispatch outcome for order ${orderId} via ${supplierLabel}: ${result.error}. Marking 'processing' (NOT reverted to pending) to avoid a possible double-charge/double-deliver. Manual reconciliation required.`)

            // SPFastIT generates its reference deterministically BEFORE the dispatch call
            // (buildSpfastitReference), so even a transport-fault ambiguous outcome already
            // has a known attempted reference. Persist it here — unlike every other supplier,
            // which has no confirmed reference on an ambiguous outcome — so the order is
            // pollable by app/api/cron/sync-spfastit-status (which only selects orders with
            // spfastit_reference IS NOT NULL); otherwise it's stuck in 'processing' forever
            // with only the webhook's thin by-id fallback as a safety net.
            const ambiguousExtraColumns: Record<string, any> =
                supplierLabel === 'spfastit' && result.reference ? { spfastit_reference: result.reference } : {}
            const ambiguousAccepted = await acceptDispatch(db, internalOrderId, supplierLabel, ambiguousExtraColumns)
            if (!ambiguousAccepted) {
                console.log(`[Shop Order Processor] Ambiguous-accept was a no-op for order ${orderId} — a webhook already resolved it`)
            } else {
                // The success branch above writes shop_orders.status='processing' alongside
                // its own accept (gated on that accept succeeding — see Step 7); this branch's
                // orders.status now also moves to 'processing' (via acceptDispatch just above)
                // but previously had no shop_orders write at all — producing the same "admin
                // sees processing, shop sees pending" divergence this whole plan exists to
                // close, for the ambiguous case specifically. `orderId` here is
                // shop_orders.id (this function's own parameter), unlike the orders.id used
                // above — matches the success branch's `.eq('id', orderId)` on shop_orders
                // exactly.
                await db.from('shop_orders').update({ status: 'processing', updated_at: new Date().toISOString() })
                    .eq('id', orderId).neq('status', 'refunded')
            }

            // Distinct dedup-key prefix, same discipline as step 11: sendAdminNewOrderAlert
            // suppresses re-alerts for 6h on push:order_alert:${referenceCode} and silently
            // returns success:true when suppressed (a .catch() can't see it) — reusing the
            // order's own referenceCode here would risk this alert being swallowed by an
            // unrelated earlier alert for the same order.
            // .catch() is NOT optional here, unlike the sibling failure branch below: this
            // function's outer catch reverts the order to 'pending'. An alert rejection escaping
            // this branch would therefore undo the very protection above and hand the order back
            // to the re-fulfillment cron.
            await sendAdminNewOrderAlert({
                ...alertDetails,
                referenceCode: `AMBIGUOUS-DISPATCH-${orderId}`,
                reason: `⚠️ AMBIGUOUS_TRANSPORT_FAILURE: order ${orderId} left in 'processing' — the ${supplierLabel} request may have already been accepted/charged (${result.error || 'unknown error'}). Do NOT resubmit without confirming with the supplier first.`
            }).catch((e: any) => console.error(`[Shop Order Processor] Ambiguous-failure alert error for ${orderId}:`, e))
        } else {
            // ALL failures → keep order as PENDING — never mark as failed.
            // Revert the 5b claim so the order goes back to pending for re-fulfillment.
            console.warn(`[Shop Order Processor] Fulfillment attempt failed for order ${orderId} via ${supplierLabel}:`, result.error)
            console.warn(`[Shop Order Processor] Order ${orderId} kept as PENDING for manual review.`)
            await releaseClaim(db, internalOrderId)
            await sendAdminNewOrderAlert({
                ...alertDetails,
                reason: `Auto-fulfillment (${supplierLabel}) failed: ${result.error || 'Unknown error'}. Order kept pending.`
            })
        }

    } catch (err) {
        console.error(`[Shop Order Processor] Exception for order ${orderId}:`, err)
        // internalOrderId may be null if the outer catch fired before the 5b claim
        // ran (e.g. an exception during settings parsing) — in that case there is no
        // claim to release, and the order is already 'pending' (untouched).
        if (typeof internalOrderId === 'string') {
            const released = await releaseClaim(db, internalOrderId)
            if (!released) console.log(`[Shop Order Processor] Release was a no-op for order ${orderId} in the outer catch — claim already gone`)
        }
        await sendAdminNewOrderAlert({
            ...alertDetails,
            reason: `System Exception during fulfillment: ${err instanceof Error ? err.message : 'Unknown exception'}. Order kept pending.`
        })
    }
}
