import { UTILITY_BILLERS, type UtilityBiller } from '@/lib/hubtel-utility/billers'

// ── Task B6: SMS receipt on completed utility payments ─────────────────────
// Called fire-and-forget (never awaited) from the 'completed' case's finalize-matched
// branch above (`updated.length > 0` only) — never on duplicate callbacks, never on the
// late-commission-fill path. NEVER throws — any failure is logged and swallowed so the
// webhook's always-200 contract to Hubtel is unaffected.
//
// Branches by order source/attribution — this used to send one platform-generic SMS
// unconditionally, which was wrong for two of these three cases:
//   - source='api' (a Commission Services developer's own customer): send NOTHING. The
//     developer already gets their own notification via dispatchApiWebhook's
//     'order.completed' event (see the two call sites above and in lib/utility-fulfillment.ts)
//     — that IS their real notification channel. A platform-branded "KFT:" SMS to the
//     developer's own customer is both redundant and leaks the underlying platform's
//     identity into a white-label integration.
//   - shop_id set (a storefront/USSD-shop sale): the SHOP's own sender + SMS credits,
//     via sendShopUtilityConfirmationSMS — same credit-metered, suppress-until-sender,
//     toggle-gated contract every other shop confirmation already uses
//     (lib/sms-confirmation-sender.ts). Never the free platform sender for shop traffic.
//   - everything else (source='dashboard' — a customer paying their own bill directly):
//     unchanged — the original platform-sender SMS via sendSMS.
export async function sendUtilityCompletionSMS(
    supabase: any,
    order: {
        user_id: string | null
        biller: string
        account_number: string
        amount: number
        reference_code: string
        destination_phone?: string | null
        shop_id?: string | null
        source?: string | null
    },
): Promise<void> {
    try {
        if (order.source === 'api') return // developer's own webhook is the real notification channel

        // Recipient resolution chain (brief order): destination_phone (ecg/ghana_water
        // always carry it) → else the buyer's own phone_number via user_id → else skip
        // silently (e.g. a guest TV purchase with no phone on file — not an error).
        let phone: string | null = order.destination_phone || null
        if (!phone && order.user_id) {
            const { data: buyer } = await (supabase as any).from('users')
                .select('phone_number')
                .eq('id', order.user_id).maybeSingle()
            phone = buyer?.phone_number || null
        }
        if (!phone) return

        const billerLabel = UTILITY_BILLERS[order.biller as UtilityBiller]?.label || order.biller
        const amountStr = Number(order.amount).toFixed(2)
        let message = `KFT: GHS ${amountStr} ${billerLabel} payment for ${order.account_number} successful. Ref: ${order.reference_code}`
        if (order.biller === 'ecg') message += ' Token arrives by SMS from ECG.'

        if (order.shop_id) {
            const { sendShopUtilityConfirmationSMS } = await import('@/lib/sms-confirmation-sender')
            await sendShopUtilityConfirmationSMS(supabase, order.shop_id, phone, message)
            return
        }

        const { sendSMS } = await import('@/lib/sms-service')
        const result = await sendSMS({ recipient: phone, message })
        if (!result.success) {
            console.error('[HubtelCommission] utility completion SMS send failed:', result.error, 'ref:', order.reference_code)
        }
    } catch (err) {
        console.error('[HubtelCommission] utility completion SMS unexpected error (suppressed):', err)
    }
}
