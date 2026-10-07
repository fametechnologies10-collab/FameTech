// lib/sub-agent-earnings.ts
// =============================================================================
// The ONE write every Plan 2 wiring task calls after computing a sale's
// recruiterEarns (spec §5.1). Writes a PENDING row; the SQL trigger in
// 20260907e is the only thing that ever moves it to credited/reversed.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type SubAgentOrderTable = 'orders' | 'afa_orders' | 'results_checker_orders' | 'shop_orders'

export async function recordPendingSubAgentEarning(
    db: SupabaseClient,
    params: {
        orderReference: string
        orderTable: SubAgentOrderTable
        recruiterId: string
        subUserId: string
        amount: number
    },
): Promise<{ success: boolean; message: string }> {
    // Zero-amount earnings (airtime/mashup, or a sub priced at exactly their
    // recruiter's cost) have nothing to track — writing a row would only
    // create dashboard noise with no money behind it (spec §4.2).
    if (!(params.amount > 0)) {
        return { success: true, message: 'No margin to record' }
    }

    const { error } = await (db as any).from('sub_agent_order_earnings').insert({
        order_reference: params.orderReference,
        order_table: params.orderTable,
        recruiter_id: params.recruiterId,
        sub_user_id: params.subUserId,
        amount: params.amount,
        status: 'pending',
    })

    if (error) {
        // 23505 = unique_violation on order_reference — a replayed pricing call
        // for the same order. Already recorded; not a failure.
        if (error.code === '23505') {
            return { success: true, message: 'Already recorded' }
        }
        console.error(`[SubAgentEarnings] failed to record pending earning for ${params.orderReference}:`, error)
        const { sendAdminPushNotification } = await import('@/lib/push-service')
        await sendAdminPushNotification({
            title: 'Sub-agent earning record FAILED',
            body: `Order ref ${params.orderReference} — recruiter margin of GHS ${params.amount} could not be recorded. Manual investigation and crediting may be needed.`,
        }).catch(() => {})
        return { success: false, message: String(error.message ?? error) }
    }

    return { success: true, message: 'Recorded' }
}
