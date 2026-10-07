import type { SupabaseClient } from '@supabase/supabase-js'
import type { HubtelFulfillment } from '../types'
import { normalizePhone } from '../utils'
import { trackUSSDCustomer } from '../guest-tracker'
import { sendSMS } from '@/lib/sms-service'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentAfaCost } from '@/lib/sub-agent-afa-pricing'
import { recordPendingSubAgentEarning } from '@/lib/sub-agent-earnings'
import { AFA_PRICE_KEYS } from '@/lib/afa-pricing'
import { sendAdminPushNotification } from '@/lib/push-service'
import { resolveSubAgentSelfAfaPrice } from '../price-resolver'
import { deriveSelfPurchaseMargin } from '../self-purchase-margin'
import { getUSSDFeePercent } from '../fee'

// =============================================================================
// USSD AFA Registration fulfillment
// Creates afa_order directly after Hubtel MoMo payment (or wallet debit).
// USSD orders have NULL user_id for guest users.
//
// Shop attribution (mirrors lib/ussd/fulfillment/utility.ts's shopId ->
// shop_id/source pattern): when the session went through a shop's USSD code,
// the row carries shop_id, source='ussd_shop', and the cost/selling/profit
// snapshot needed to credit the shop owner via credit_shop_afa_profit — same
// on-payment credit as the storefront AFA path (lib/shop-afa-order-processor.ts).
// =============================================================================

export interface AFAOrderPayload {
    full_name: string
    phone: string
    id_type: string
    id_number: string
    region: string
    location: string
    date_of_birth: string
    occupation: string
    price: number
    // Optional on purpose: a ussd_pending_orders row staged before shop attribution
    // existed has none of these in its order_payload, and that JSON is cast straight
    // to this type by app/api/ussd/fulfill. The fulfiller degrades safely when they
    // are absent (no shop, no profit) rather than writing NaN.
    shopId?: string | null
    costPrice?: number
    sellingPrice?: number
}

export async function fulfillAFAOrder(
    supabase: SupabaseClient,
    pendingOrderId: string,
    sessionId: string,
    mobile: string,
    operator: string,
    payload: AFAOrderPayload,
    userId: string | null,
    fulfillment: HubtelFulfillment | null,
    paymentMethod: 'momo' | 'wallet' = 'momo',
): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
        const referenceCode = `USSD-AFA-${sessionId.toUpperCase()}`

        // P1-2 / idempotency: replay guard — return if this AFA order already exists.
        {
            const { data: dup } = await (supabase.from('afa_orders') as any)
                .select('id')
                .eq('reference_code', referenceCode)
                .maybeSingle()
            if (dup) return { success: true, orderId: (dup as any).id }
        }

        // Shop attribution + pricing snapshot. costPrice/sellingPrice are computed
        // upstream in lib/ussd/handlers/afa.ts (resolveAFAPrice base + resolveUSSDFeePercent
        // markup) and carried through the pending-order payload — round to 2dp here the
        // same way the rest of the codebase does, defensively, since money already
        // rounded upstream can still pick up float noise crossing a JSON round-trip.
        const shopId = payload.shopId ?? null
        const sellingPrice = Math.round(Number(payload.sellingPrice ?? payload.price) * 100) / 100
        // LEGACY PENDING ORDERS: a ussd_pending_orders row staged before this change
        // has no costPrice in its order_payload. Number(undefined) is NaN, which would
        // propagate into profit and be written to the row — so fall back to the selling
        // price, yielding profit 0 and no credit. Never invent a profit we cannot derive.
        const rawCost = Number(payload.costPrice)
        const costPrice = Number.isFinite(rawCost)
            ? Math.round(rawCost * 100) / 100
            : sellingPrice
        const profit = Math.round((sellingPrice - costPrice) * 100) / 100

        // 1. Create afa_order (user_id is nullable for guests — migration applied)
        const orderInsertData: Record<string, unknown> = {
            full_name:      payload.full_name,
            phone:          normalizePhone(payload.phone),
            ghana_card:     payload.id_number,
            id_type:        'Ghana Card',
            id_number:      payload.id_number,
            location:       payload.location,
            region:         payload.region,
            occupation:     payload.occupation,
            date_of_birth:  payload.date_of_birth,
            // reference_code is NOT NULL on afa_orders (no default) — it MUST be set
            // on every insert, exactly like the data/RC USSD fulfillers do. Omitting
            // it made every USSD AFA order fail with a 23502 not-null violation, so no
            // order was created even though the customer had already paid.
            reference_code: referenceCode,
            status:         'pending',
            notes:          `USSD registration | Ref: ${referenceCode}`,
            source:         shopId ? 'ussd_shop' : 'ussd',
            payment_method: paymentMethod,
            shop_id:        shopId,
            cost_price:     costPrice,
            selling_price:  sellingPrice,
            profit:         profit,
            payment_amount: sellingPrice,
        }

        if (userId) {
            orderInsertData.user_id = userId
        }

        const { data: afaOrder, error: afaError } = await (supabase
            .from('afa_orders') as any)
            .insert(orderInsertData)
            .select('id')
            .single()

        if (afaError) {
            console.error('[USSD AFA Fulfillment] AFA order insert failed:', afaError)
            return { success: false, error: afaError.message }
        }

        // 2. Mark pending order as fulfilled
        //    hubtel_order_id is only available for MoMo payments; null for wallet path
        if (pendingOrderId) {
            const updateData: Record<string, unknown> = {
                status:       'fulfilled',
                fulfilled_at: new Date().toISOString(),
            }
            if (paymentMethod !== 'wallet' && fulfillment?.OrderId) {
                updateData.hubtel_order_id = fulfillment.OrderId
            }
            await supabase
                .from('ussd_pending_orders')
                .update(updateData)
                .eq('id', pendingOrderId)
        }

        // 3. Credit the shop owner's profit, on payment — same timing as the storefront
        //    AFA path (lib/shop-afa-order-processor.ts) and as every other shop product.
        //    Before this existed, a shop's USSD customers were charged the shop's markup
        //    (applied upstream via resolveUSSDFeePercent) while the owner was never
        //    credited and never saw the order — the markup silently stayed with us.
        //    The RPC is idempotent (locks the wallet row before its idempotency check,
        //    backstopped by a unique index), so the replay guard above plus this makes a
        //    double credit impossible. Non-fatal: the customer has paid and the order
        //    exists, so a credit failure must not fail fulfillment — but it is recorded
        //    to security_events rather than left in a console log, since an uncredited
        //    owner is otherwise invisible.
        if (shopId && profit > 0) {
            try {
                const { data: creditResult, error: creditError } = await (supabase as any).rpc(
                    'credit_shop_afa_profit',
                    { p_afa_order_id: (afaOrder as any).id },
                )
                if (creditError || creditResult?.success === false) {
                    const reason = creditError ?? creditResult?.message
                    console.error('[USSD AFA Fulfillment] Profit credit failed:', reason)
                    const { error: auditError } = await (supabase.from('security_events') as any).insert({
                        event_type: 'afa_profit_credit_failed',
                        reference: referenceCode,
                        shop_id: shopId,
                        order_type: 'afa',
                        // No KYC in detail — the applicant's identity stays in afa_orders.
                        detail: {
                            afa_order_id: (afaOrder as any).id,
                            source: shopId ? 'ussd_shop' : 'ussd',
                            rpc_message: creditError?.message ?? creditResult?.message ?? null,
                        },
                    })
                    if (auditError) {
                        console.error('[USSD AFA Fulfillment] security_events insert failed:', auditError)
                    }
                }
            } catch (creditErr) {
                console.error('[USSD AFA Fulfillment] Profit credit threw:', creditErr)
            }
        }

        // 3b. Record the recruiter's pending earning for a sub-agent-owned shop (Task 3,
        // Step 6) — resolved fresh here from shopId, mirroring lib/ussd/fulfillment/data.ts's
        // and results-checker.ts's self-contained pattern (resolve context, resolve cost,
        // record earning), matching the storefront AFA processor's own orderTable convention
        // (lib/shop-afa-order-processor.ts). Independent of the credit above: the shop owner
        // earns their OWN margin (cost_price/selling_price/profit, credited above) exactly as
        // before; the recruiter earns SEPARATELY here. Uses `referenceCode`, this file's OWN
        // idempotency check value (checked against afa_orders.reference_code above), so the
        // earning ledger and this order key off the exact same value.
        if (shopId) {
            try {
                const { data: shopRow } = await (supabase.from('shop_profiles') as any)
                    .select('owner_id')
                    .eq('id', shopId)
                    .maybeSingle()
                const ownerId: string | undefined = (shopRow as any)?.owner_id
                if (ownerId) {
                    const subCtx = await resolveSubAgentContext(supabase, ownerId)
                    if (subCtx.isSub && subCtx.effectiveActive) {
                        const { data: afaSettingsRows } = await supabase
                            .from('admin_settings')
                            .select('key, value')
                            .in('key', AFA_PRICE_KEYS)
                        const afaSettings: Record<string, unknown> = {}
                        for (const row of (afaSettingsRows ?? []) as any[]) afaSettings[row.key] = row.value

                        const resolved = await resolveSubAgentAfaCost(supabase, ownerId, afaSettings)
                        if (resolved.ok && resolved.recruiterEarns > 0 && resolved.recruiterId) {
                            await recordPendingSubAgentEarning(supabase, {
                                orderReference: referenceCode,
                                orderTable: 'afa_orders',
                                recruiterId: resolved.recruiterId,
                                subUserId: ownerId,
                                amount: resolved.recruiterEarns,
                            }).catch((e) => console.error('[USSD AFA Fulfillment] recordPendingSubAgentEarning threw:', e))
                        }
                    }
                }
            } catch (e) {
                console.error('[USSD AFA Fulfillment] sub-agent earning resolution threw:', e)
            }
        } else if (userId) {
            // A sub-agent registering for THEMSELVES (no shop): their recruiter earns the markup.
            try {
                const sub = await resolveSubAgentSelfAfaPrice(supabase, userId)
                if (sub.kind === 'blocked') {
                    await sendAdminPushNotification({
                        title: 'Sub-agent USSD earning not recorded',
                        body: `AFA order ${referenceCode} (paid GHS ${payload.price}): sub pricing/eligibility changed before fulfillment, so the recruiter margin was not recorded. Reconcile manually.`,
                    }).catch(() => {})
                } else if (sub.kind === 'sub') {
                    const { amount, drifted } = deriveSelfPurchaseMargin({
                        paid: Number(payload.price),
                        feePercent: await getUSSDFeePercent(supabase),
                        subPrice: sub.price,
                        recruiterEarns: sub.recruiterEarns,
                    })
                    if (drifted) {
                        await sendAdminPushNotification({
                            title: 'Sub-agent USSD price drift',
                            body: `AFA order ${referenceCode}: sub paid GHS ${payload.price} but current sub price is GHS ${sub.price}. Recruiter margin recorded as GHS ${amount}.`,
                        }).catch(() => {})
                    }
                    await recordPendingSubAgentEarning(supabase, {
                        orderReference: referenceCode,
                        orderTable: 'afa_orders',
                        recruiterId: sub.recruiterId,
                        subUserId: userId,
                        amount,
                    })
                }
            } catch (e) {
                console.error('[USSD AFA Fulfillment] self-purchase earning resolution threw:', e)
            }
        }

        // 4. SMS to applicant phone (form field — the beneficiary of the AFA registration)
        //    Recipient: payload.phone (entered in the USSD AFA form, not the USSD dialer)
        //    Template:  "Your AFA registration has been received and is being processed. You will be registered within 24-48hrs. Thank you."
        const applicantPhone = normalizePhone(payload.phone)
        await sendSMS({
            recipient: applicantPhone,
            message: `Your AFA registration has been received and is being processed. You will be registered within 24-48hrs. Thank you.`,
        })

        // 5. Notify admins via email (fire-and-forget, mirrors existing AFA route)
        notifyAdmins(supabase, payload.full_name, applicantPhone, payload.region).catch(
            (err) => console.error('[USSD AFA] Admin notify failed:', err),
        )

        // 6. Track guest customer
        if (!userId) {
            await trackUSSDCustomer(supabase, mobile, operator, 'afa', payload.price)
        }

        return { success: true, orderId: (afaOrder as any).id }
    } catch (err) {
        console.error('[USSD AFA Fulfillment] Unexpected error:', err)
        return { success: false, error: String(err) }
    }
}

async function notifyAdmins(
    supabase: SupabaseClient,
    applicantName: string,
    phone: string,
    region: string,
): Promise<void> {
    const { data: adminUsers } = await supabase
        .from('users')
        .select('email')
        .eq('role', 'admin')

    const recipients = new Set<string>()
    if (process.env.ADMIN_EMAIL) recipients.add(process.env.ADMIN_EMAIL)
    if (adminUsers) {
        for (const u of adminUsers as any[]) {
            if (u.email) recipients.add(u.email)
        }
    }

    if (recipients.size > 0) {
        const { sendAdminNewAfaApplicationAlert } = await import('@/lib/email-service')
        await Promise.allSettled(
            Array.from(recipients).map((email) =>
                sendAdminNewAfaApplicationAlert(
                    { applicantName, phone, region },
                    email,
                ),
            ),
        )
    }
}
