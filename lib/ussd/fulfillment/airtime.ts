import type { SupabaseClient } from '@supabase/supabase-js'
import type { HubtelFulfillment } from '../types'
import { normalizePhone } from '../utils'
import { trackUSSDCustomer } from '../guest-tracker'
import { sendAirtimeBeneficiarySMS } from '@/lib/sms-service'
import { sendShopConfirmationSMS } from '@/lib/sms-confirmation-sender'
import { creditShopProfit } from '@/lib/shop-service'
import { sendAdminPushNotification } from '@/lib/push-service'
import { dispatchAirtimeFulfillment } from '@/lib/airtime-fulfillment'

// =============================================================================
// USSD Airtime fulfillment — runs after Hubtel MoMo payment (or wallet debit).
// Records the sale in the SAME airtime_orders ledger the dashboard/storefront use,
// credits the shop owner for a shop USSD sale, then hands the order to the existing
// dispatchAirtimeFulfillment() pipeline (Hubtel Commission Services). Delivery
// correctness (callback auto-complete, retry, refulfill, the failure web-push) is
// then owned by that pipeline + the admin airtime tools — exactly like storefront.
// =============================================================================

export interface AirtimeOrderPayload {
    network: string             // 'MTN' | 'Telecel' | 'AT' (canonical Hubtel keys)
    beneficiaryPhone: string    // 0XXXXXXXXX
    airtimeAmount: number       // airtime/mashup value delivered to the beneficiary (exact mode)
    price: number               // amount the customer paid (= airtimeAmount + fee)
    feeAmount: number
    adminFeeAmount: number
    shopFeeAmount: number
    buyerRole?: string | null
    shopId?: string | null
    shopName?: string | null
    shopOwnerId?: string | null
    shopOwnerRole?: string | null
    orderType?: 'airtime' | 'mashup'                    // defaults 'airtime' for existing callers
    bundlePreference?: 'balanced' | 'data' | 'voice' | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

export async function fulfillAirtimeUSSDOrder(
    supabase: SupabaseClient,
    pendingOrderId: string,
    sessionId: string,
    mobile: string,
    operator: string,
    payload: AirtimeOrderPayload,
    userId: string | null,
    fulfillment: HubtelFulfillment | null,
    paymentMethod: 'momo' | 'wallet' = 'momo',
): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
        const orderType = payload.orderType ?? 'airtime'
        const referenceCode = `USSD-${orderType === 'mashup' ? 'MASH' : 'AIR'}-${sessionId.toUpperCase()}`
        const network = payload.network
        const airtimeAmount = Number(payload.airtimeAmount)
        const price = Number(payload.price)
        const shopId = payload.shopId ?? null
        // Shared label used for shop_orders.package_size, the orders mirror's size, and SMS bodies.
        const sizeLabel = orderType === 'mashup' ? `GHS ${airtimeAmount} Mashup Bundle` : `${airtimeAmount} Airtime`

        // Owner attribution: a registered buyer owns the row; a guest shop sale is
        // attributed to the shop owner; a guest non-shop sale has no account
        // (user_id null — allowed by the 20260624 migration).
        const orderUserId = userId ?? payload.shopOwnerId ?? null
        const orderUserRole = shopId
            ? (payload.shopOwnerRole ?? 'customer')
            : (payload.buyerRole ?? 'customer')

        // Shop-side bookkeeping for a shop USSD airtime sale: the shop_orders
        // ledger row PLUS an `orders` mirror row linked via shop_order_id.
        // The mirror is what makes the sale syncable: the Hubtel Commission
        // completion webhook and admin tools resolve orders.reference_code →
        // shop_order_id → syncShopOrderStatus (exactly how the website shop
        // airtime flow works). Without it, USSD shop airtime rows were stuck
        // 'pending' forever — no status sync path existed at all. The mirror's
        // size ('<amt> Airtime') keeps it out of the data refulfill pipeline
        // (refulfillment-service excludes size ILIKE '%Airtime%').
        // Used by BOTH the fresh path and the replay self-heal below.
        const ensureShopSideRecords = async (): Promise<string | null> => {
            if (!shopId) return null

            // Replay-safe: reuse an existing mirror's shop_order_id if present.
            const { data: existingMirror } = await supabase
                .from('orders')
                .select('id, shop_order_id')
                .eq('reference_code', referenceCode)
                .maybeSingle()
            if ((existingMirror as any)?.shop_order_id) {
                return (existingMirror as any).shop_order_id as string
            }

            const { data: shopOrder, error: soErr } = await (supabase as any)
                .from('shop_orders')
                .insert({
                    shop_id:            shopId,
                    package_id:         null, // null for airtime
                    guest_phone:        payload.beneficiaryPhone,
                    // The dialing MSISDN is the number that actually paid.
                    // guest_phone above is the BENEFICIARY and is a different
                    // number on ~31% of USSD orders.
                    payer_momo_number:  normalizePhone(mobile),
                    network,
                    package_size:       sizeLabel,
                    selling_price:      airtimeAmount,
                    cost_price:         airtimeAmount,
                    profit:             Math.max(0, Number(payload.shopFeeAmount) || 0),
                    admin_cost_at_time: airtimeAmount,
                    owner_role_at_time: payload.shopOwnerRole ?? 'customer',
                    status:             'pending',
                    source:             'ussd',
                })
                .select('id')
                .single()
            if (soErr) {
                console.error('[USSD Airtime] shop_orders insert failed:', soErr)
                await sendAdminPushNotification({
                    title: 'Shop USSD airtime credit not recorded',
                    body: `shop_orders insert failed for shop ${shopId} (${network} GHS ${airtimeAmount}). Airtime still delivered; credit the shop manually. Error: ${soErr.message ?? soErr}`,
                }).catch(() => {})
                return null
            }
            const soId = (shopOrder as any).id as string

            // Mirror row — reuse the pre-checked existing one, else create it.
            if ((existingMirror as any)?.id) {
                await (supabase.from('orders') as any)
                    .update({ shop_order_id: soId })
                    .eq('id', (existingMirror as any).id)
            } else {
                const { error: mirrorErr } = await (supabase.from('orders') as any).insert({
                    ...(payload.shopOwnerId ? { user_id: payload.shopOwnerId } : {}),
                    phone_number:       payload.beneficiaryPhone,
                    network,
                    size:               sizeLabel,
                    price:              airtimeAmount,
                    cost_price_at_time: airtimeAmount,
                    role_at_time:       payload.shopOwnerRole ?? 'customer',
                    status:             'pending',
                    payment_status:     'paid',
                    payment_method:     paymentMethod,
                    reference_code:     referenceCode,
                    fulfillment_method: 'auto',
                    shop_name:          payload.shopName ?? null,
                    shop_order_id:      soId,
                    source:             'ussd_shop',
                })
                if (mirrorErr) {
                    // Sync degrades to manual, but money is unaffected (credit
                    // keys off shop_orders directly) — surface it.
                    console.error('[USSD Airtime] orders mirror insert failed:', mirrorErr)
                    await sendAdminPushNotification({
                        title: 'USSD airtime mirror row failed',
                        body: `orders mirror insert failed for ${referenceCode} (shop ${shopId}) — shop_orders ${soId} will not auto-sync status. Error: ${mirrorErr.message ?? mirrorErr}`,
                    }).catch(() => {})
                }
            }
            return soId
        }

        // Idempotency + SELF-HEAL: airtime_orders.reference_code is UNIQUE. A
        // replay (status-check race / late callback) must not re-charge or
        // re-dispatch — but it DOES finish any shop bookkeeping a crashed prior
        // attempt skipped (ledger row, mirror link, idempotent credit).
        {
            const { data: dup } = await supabase
                .from('airtime_orders')
                .select('id')
                .eq('reference_code', referenceCode)
                .maybeSingle()
            if (dup) {
                const healedShopOrderId = await ensureShopSideRecords()
                if (pendingOrderId) {
                    await supabase
                        .from('ussd_pending_orders')
                        .update({ status: 'fulfilled', fulfilled_at: new Date().toISOString() })
                        .eq('id', pendingOrderId)
                }
                if (healedShopOrderId) {
                    await creditShopProfit(healedShopOrderId).catch((e) => console.error('[USSD Airtime] replay credit failed:', e))
                }
                return { success: true, orderId: (dup as any).id }
            }
        }

        // 1. airtime_orders — the core ledger row + the dispatch target. Created
        //    FIRST because its UNIQUE reference is the idempotency anchor: once
        //    it exists, any crash later is repairable by the replay self-heal.
        const { data: airtimeOrder, error: aoErr } = await (supabase as any)
            .from('airtime_orders')
            .insert({
                ...(orderUserId ? { user_id: orderUserId } : {}),
                user_role:         orderUserRole,
                beneficiary_phone: payload.beneficiaryPhone,
                network,
                airtime_amount:    airtimeAmount,
                fee_rate:          airtimeAmount > 0 ? round2((Number(payload.feeAmount) / airtimeAmount) * 100) : 0,
                fee_amount:        round2(Number(payload.feeAmount) || 0),
                admin_fee_amount:  round2(Number(payload.adminFeeAmount) || 0),
                shop_fee_amount:   round2(Number(payload.shopFeeAmount) || 0),
                total_paid:        price,
                use_exact_amount:  true,
                status:            'pending',
                // Explicit: the column's DEFAULT is 'web', which would mislabel every
                // USSD order. See 20260826_airtime_source_default.sql.
                source:            'ussd_shop',
                reference_code:    referenceCode,
                type:              orderType,
                bundle_preference: orderType === 'mashup' ? (payload.bundlePreference ?? 'balanced') : null,
                ...(shopId ? { shop_id: shopId, shop_name: payload.shopName ?? null } : {}),
            })
            .select('id')
            .single()

        if (aoErr) {
            console.error('[USSD Airtime] airtime_orders insert failed:', aoErr)
            return { success: false, error: aoErr.message }
        }
        const airtimeOrderId = (airtimeOrder as any).id as string

        // 2. Shop ledger + syncable orders mirror (shop sales only).
        const shopOrderId = await ensureShopSideRecords()

        // 3. Mark the pending order fulfilled (claim already stamped hubtel_order_id for momo).
        if (pendingOrderId) {
            const upd: Record<string, unknown> = { status: 'fulfilled', fulfilled_at: new Date().toISOString() }
            if (paymentMethod !== 'wallet' && fulfillment?.OrderId) upd.hubtel_order_id = fulfillment.OrderId
            await supabase.from('ussd_pending_orders').update(upd).eq('id', pendingOrderId)
        }

        // 4. Beneficiary SMS. SHOP orders join the metered sender system
        //    (feature-wave5, Task 1) — mirrors the website shop checkout flow,
        //    which sends ONE unified sendShopConfirmationSMS regardless of order
        //    type, airtime/mashup included (lib/shop-order-processor.ts).
        //    Fire-and-forget with .catch: must never affect fulfillment.
        //    Non-shop USSD orders keep the free platform send exactly as before
        //    (currently a no-op — the airtime SMS template is disabled
        //    platform-wide, see sendAirtimeBeneficiarySMS).
        if (shopId) {
            // Bug fix: this call used to fire unconditionally, ignoring the shop
            // owner's "Customer order SMS" toggle
            // (shop_profiles.sms_order_confirmation_enabled) — a shop owner who
            // turned confirmations off still had SMS sent and credits debited for
            // every USSD airtime order. The storefront/webhook path
            // (lib/shop-order-processor.ts) already gated on this column; USSD
            // fulfillment did not. Same default-true convention as that path.
            const { data: spData } = await supabase
                .from('shop_profiles')
                .select('sms_order_confirmation_enabled')
                .eq('id', shopId)
                .maybeSingle()
            const smsConfirmEnabled = (spData as any)?.sms_order_confirmation_enabled !== false
            if (smsConfirmEnabled) {
                sendShopConfirmationSMS(supabase, shopId, normalizePhone(payload.beneficiaryPhone), {
                    network,
                    size:  sizeLabel,
                    price: airtimeAmount,
                }).catch(() => {})
            }
        } else {
            await sendAirtimeBeneficiarySMS(normalizePhone(payload.beneficiaryPhone), airtimeAmount).catch(() => {})
        }

        // 5. Track guest customer for non-account buyers.
        if (!userId) {
            await trackUSSDCustomer(supabase, mobile, operator, orderType, price).catch(() => {})
        }

        // 6. Credit the shop owner's profit after the order exists.
        if (shopOrderId) {
            await creditShopProfit(shopOrderId).catch((e) => console.error('[USSD Airtime] creditShopProfit failed:', e))
        }

        // 7. Auto-fulfill via Hubtel Commission — AIRTIME ONLY. Mashup is manually fulfilled
        //    and must NEVER reach Hubtel: this explicit skip is defense-in-depth on top of
        //    dispatchAirtimeFulfillment's own internal `type === 'mashup'` early-return, so a
        //    mashup order can't be auto-dispatched even if that internal guard is ever changed.
        //    A mashup order stays 'pending' here for the admin manual-fulfillment queue
        //    (/admin/airtime already handles type==='mashup' orders).
        if (orderType !== 'mashup') {
            await dispatchAirtimeFulfillment(airtimeOrderId)
        }

        return { success: true, orderId: airtimeOrderId }
    } catch (err) {
        console.error('[USSD Airtime Fulfillment] Unexpected error:', err)
        return { success: false, error: String(err) }
    }
}
