// Safety-net sweep for kingflexy orders stuck in `processing` (webhook missed / never sent).
// Shared by the cron route and admin sync (Task 7). Never fails, refunds or re-dispatches.
import { checkOrderStatus, type KingflexyStatusResult } from '@/lib/kingflexy-data-service'
import { applyKingflexyOutcome, recordKingflexyAnomaly, type KingflexyOutcomeDeps } from '@/lib/kingflexy-apply-outcome'

const CONCURRENCY = 5
const NOT_FOUND_GRACE_MS = 15 * 60 * 1000

export async function syncKingflexyProcessingOrders(
    supabase: any,
    opts: {
        limit?: number
        /** Test seams */
        checkStatus?: (reference: string) => Promise<KingflexyStatusResult>
        apply?: typeof applyKingflexyOutcome
        nowMs?: number
        alertAdmin?: KingflexyOutcomeDeps['alertAdmin']
    } = {},
): Promise<{ checked: number; updated: number; failed: number; errors: string[] }> {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 100
    const check = opts.checkStatus ?? checkOrderStatus
    const apply = opts.apply ?? applyKingflexyOutcome
    const nowMs = opts.nowMs ?? Date.now()
    const result = { checked: 0, updated: 0, failed: 0, errors: [] as string[] }

    const { data: rows, error } = await supabase
        .from('orders')
        .select('id, kingflexy_reference, created_at')
        .eq('status', 'processing')
        .eq('fulfillment_method', 'kingflexy')
        .not('kingflexy_reference', 'is', null)
        .order('created_at', { ascending: true })
        .limit(limit)
    if (error) {
        result.errors.push(`Orders query failed: ${error.message}`)
        return result
    }
    const orders: Array<{ id: string; kingflexy_reference: string; created_at?: string }> = rows || []

    const one = async (o: { id: string; kingflexy_reference: string; created_at?: string }) => {
        result.checked++
        try {
            const st = await check(o.kingflexy_reference)
            if (!st.success) return

            if (!st.found) {
                const age = nowMs - Date.parse(o.created_at || '')
                if (Number.isFinite(age) && age > NOT_FOUND_GRACE_MS) await recordKingflexyAnomaly(
                        supabase,
                        {
                            orderId: o.id,
                            reference: o.kingflexy_reference,
                            source: 'cron_sweep',
                            note: 'not_found_at_supplier',
                            alertReason: 'supplier has no record of this order after 15+ min; placement may never have reached KingFlexy. Order left in processing, check manually',
                        },
                        opts.alertAdmin,
                    )
                return
            }

            const { applied } = await apply(supabase, {
                reference: o.kingflexy_reference,
                rawStatus: st.status,
                source: 'cron',
            })
            if (applied > 0) result.updated++
        } catch (e: any) {
            console.error(`[KingflexySync] Exception for order ${o.id}:`, e?.message || e)
            result.errors.push(`Exception for ${o.id}: ${e?.message || 'unknown'}`)
            result.failed++
        }
    }

    for (let i = 0; i < orders.length; i += CONCURRENCY) {
        await Promise.allSettled(orders.slice(i, i + CONCURRENCY).map(one))
    }
    return result
}
