// lib/commission-order-detail.ts
// =============================================================================
// Resolves a human-readable item label + the underlying order's own live status
// for a commission-relevant order reference, WITHOUT ever selecting a phone
// number, email, name, or other beneficiary-identifying field from any of the
// 4 order tables a sub-agent earning can point at (lib/sub-agent-earnings.ts's
// SubAgentOrderTable union). Used by app/api/commission/transactions/route.ts
// to enrich both the credited-transaction history and the not-yet-credited
// list — same lookup, two call sites, one place that owns "what's safe to
// show here."
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type CommissionOrderTable = 'orders' | 'shop_orders' | 'afa_orders' | 'results_checker_orders'

export interface OrderDetailLookup {
    /** Human-readable item description, e.g. "MTN 1GB Data Bundle" or "AFA Registration". */
    detail: string
    /** The underlying order's own current status column value (e.g. 'pending', 'completed', 'failed', 'refunded'), or null if the row couldn't be found. */
    orderStatus: string | null
}

/**
 * Batch-resolves item detail + live order status for a set of (order_table, order_reference)
 * pairs, grouped by table so each table is queried once (not N+1). Returns a map keyed by
 * `${order_table}:${order_reference}` — callers look up their own rows by that same key.
 */
export async function resolveOrderDetails(
    db: SupabaseClient,
    refs: Array<{ orderTable: CommissionOrderTable; orderReference: string }>,
): Promise<Map<string, OrderDetailLookup>> {
    const result = new Map<string, OrderDetailLookup>()
    if (refs.length === 0) return result

    const byTable = new Map<CommissionOrderTable, string[]>()
    for (const r of refs) {
        const list = byTable.get(r.orderTable) ?? []
        list.push(r.orderReference)
        byTable.set(r.orderTable, list)
    }

    const key = (table: CommissionOrderTable, ref: string) => `${table}:${ref}`

    for (const [table, references] of byTable) {
        if (table === 'orders') {
            const { data } = await (db.from('orders') as any)
                .select('reference_code, network, size, status')
                .in('reference_code', references)
            for (const row of data ?? []) {
                result.set(key(table, row.reference_code), {
                    detail: [row.network, row.size].filter(Boolean).join(' '),
                    orderStatus: row.status ?? null,
                })
            }
        } else if (table === 'shop_orders') {
            // A shop_orders earning is keyed on paystack_reference when one exists
            // (storefront sales), or the row's OWN id when it doesn't (USSD sales never
            // populate paystack_reference — lib/sub-agent-earning-repair.ts and
            // lib/ussd/fulfillment/data.ts both key on the row's id for exactly this
            // reason, mirroring the DB trigger's own COALESCE(paystack_reference, id::text)
            // precedence). References passed in here can be either shape, so query both
            // columns — id.in(...) only ever receives values that already look like a UUID,
            // since a non-UUID string there would be a Postgres type error, not a miss.
            const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            const possibleIds = references.filter((r) => uuidRe.test(r))
            const orFilter = possibleIds.length > 0
                ? `paystack_reference.in.(${references.join(',')}),id.in.(${possibleIds.join(',')})`
                : `paystack_reference.in.(${references.join(',')})`
            const { data } = await (db.from('shop_orders') as any)
                .select('id, paystack_reference, network, package_size, status')
                .or(orFilter)
            for (const row of data ?? []) {
                const matchedRef = row.paystack_reference ?? row.id
                result.set(key(table, matchedRef), {
                    detail: [row.network, row.package_size].filter(Boolean).join(' '),
                    orderStatus: row.status ?? null,
                })
            }
        } else if (table === 'afa_orders') {
            const { data } = await (db.from('afa_orders') as any)
                .select('reference_code, status')
                .in('reference_code', references)
            for (const row of data ?? []) {
                result.set(key(table, row.reference_code), {
                    detail: 'AFA Registration',
                    orderStatus: row.status ?? null,
                })
            }
        } else if (table === 'results_checker_orders') {
            const { data } = await (db.from('results_checker_orders') as any)
                .select('reference_code, type_name, quantity, status')
                .in('reference_code', references)
            for (const row of data ?? []) {
                const qty = Number(row.quantity) || 1
                result.set(key(table, row.reference_code), {
                    detail: qty > 1 ? `${row.type_name} Results Checker x${qty}` : `${row.type_name} Results Checker`,
                    orderStatus: row.status ?? null,
                })
            }
        }
    }

    return result
}
