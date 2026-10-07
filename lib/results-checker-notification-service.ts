/**
 * Results Checker Notification Service
 *
 * Delivers vouchers to customers via SMS + Email.
 * Updates delivered_via on the order after sending.
 * Mirrors the deliverVouchers pattern from friend's codebase.
 */

import { createServerClient } from './supabase'
import { sendResultsCheckerDeliverySMS } from './sms-service'
import { sendResultsCheckerDeliveryEmail } from './email-service'
import { resolveOwnConfirmationSender, resolveShopConfirmationSender } from './sms-confirmation-sender'
import type { RCOrder, RCVoucher } from './results-checker-service'

/**
 * Deliver vouchers to customer via SMS and/or Email.
 * Both channels are attempted independently — one failure does not block the other.
 * Updates delivered_via[] on the order after successful delivery.
 */
export async function deliverVouchers(
    order: RCOrder & {
        user_id?: string | null
        shop_id?: string | null
        customer_phone?: string | null
        customer_email?: string | null
        customer_name?: string | null
    },
    vouchers: RCVoucher[]
): Promise<void> {
    const supabase = createServerClient()
    const db = supabase as any
    const deliveredVia: string[] = []

    // KFT SMS v2 (feature-wave5, Task 2): the RC PIN SMS is the PRODUCT itself,
    // not an order confirmation — it is NEVER metered and NEVER suppressed here,
    // only re-branded when a sender is available. Resolution order:
    //   1. shop's approved sender wins for shop orders (resolveShopConfirmationSender)
    //   2. else the order OWNER's own approved sender (guest orders carry no
    //      user_id — skip resolution entirely, they fall back to the platform sender)
    //   3. else undefined → sendResultsCheckerDeliverySMS uses the platform sender.
    // Neither resolver ever throws — a DB error degrades to platform sender.
    const [shopSender, ownSender] = await Promise.all([
        order.shop_id ? resolveShopConfirmationSender(db, order.shop_id) : Promise.resolve(null),
        order.user_id ? resolveOwnConfirmationSender(supabase, order.user_id) : Promise.resolve(null),
    ])

    // ── SMS Delivery ───────────────────────────────────────────────────────
    if (order.customer_phone) {
        try {
            const result = await sendResultsCheckerDeliverySMS(order.customer_phone, {
                typeName:      order.type_name,
                quantity:      order.quantity,
                vouchers,
                referenceCode: order.reference_code,
                sender:        shopSender ?? ownSender ?? undefined,
            })
            if (result.success) {
                deliveredVia.push('sms')
            } else {
                console.error('[RC Notification] SMS delivery failed:', result.error)
            }
        } catch (err) {
            console.error('[RC Notification] SMS exception:', err)
        }
    }

    // ── Email Delivery ────────────────────────────────────────────────────
    if (order.customer_email) {
        try {
            const result = await sendResultsCheckerDeliveryEmail(
                order.customer_email,
                order.customer_name || order.customer_email,
                {
                    referenceCode: order.reference_code,
                    typeName:      order.type_name,
                    quantity:      order.quantity,
                    totalPaid:     order.total_paid,
                },
                vouchers
            )
            if (result.success) {
                deliveredVia.push('email')
            } else {
                console.error('[RC Notification] Email delivery failed:', result.error)
            }
        } catch (err) {
            console.error('[RC Notification] Email exception:', err)
        }
    }

    // ── Update order delivered_via ────────────────────────────────────────
    if (deliveredVia.length > 0) {
        await (db.from('results_checker_orders') as any)
            .update({
                delivered_via: deliveredVia,
                updated_at:    new Date().toISOString(),
            })
            .eq('id', order.id)
            .then(() => {})
            .catch((e: any) => console.error('[RC Notification] delivered_via update error:', e))
    }
}

/**
 * Resend vouchers for an existing completed order.
 * Used by admin manual re-send and dashboard "Resend SMS" button.
 */
export async function resendVouchers(orderId: string): Promise<{ success: boolean; error?: string }> {
    const supabase = createServerClient()
    const db = supabase as any

    // Fetch order
    const { data: order, error: orderError } = await db
        .from('results_checker_orders')
        .select('*')
        .eq('id', orderId)
        .single()

    if (orderError || !order) {
        return { success: false, error: 'Order not found' }
    }

    if (order.status !== 'completed' || !order.inventory_ids?.length) {
        return { success: false, error: 'Order not completed or no vouchers assigned' }
    }

    // Fetch vouchers
    const { data: vouchers, error: vouchersError } = await db
        .from('results_checker_inventory')
        .select('id, pin, serial_number')
        .in('id', order.inventory_ids)

    if (vouchersError || !vouchers?.length) {
        return { success: false, error: 'Vouchers not found' }
    }

    await deliverVouchers(order, vouchers)
    return { success: true }
}
