import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from './utils'

/**
 * Upsert the ussd_customers record after a successful fulfillment.
 * This builds a free CRM of non-account users for future engagement.
 */
export async function trackUSSDCustomer(
    supabase: SupabaseClient,
    mobile: string,
    operator: string,
    service: string,
    amount: number,
): Promise<void> {
    const normalized = normalizePhone(mobile)

    const { data: existing } = await supabase
        .from('ussd_customers')
        .select('id, total_orders, total_spent')
        .eq('mobile', normalized)
        .maybeSingle()

    if (existing) {
        await supabase
            .from('ussd_customers')
            .update({
                last_seen: new Date().toISOString(),
                total_orders: (existing.total_orders ?? 0) + 1,
                total_spent: Number(existing.total_spent ?? 0) + amount,
                last_service: service,
                operator,
            })
            .eq('mobile', normalized)
    } else {
        await supabase.from('ussd_customers').insert({
            mobile: normalized,
            operator,
            total_orders: 1,
            total_spent: amount,
            last_service: service,
        })
    }
}
