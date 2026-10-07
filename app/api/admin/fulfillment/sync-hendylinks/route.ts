import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { fetchAllOrderHistory, applyHendyLinksHistoryMatch } from '@/lib/hendylinks-service'
import { validateAdminAccess } from '@/lib/auth-utils'

const HISTORY_PAGE_SIZE = 100

// Admin-triggered version of the cron sweep — no stuck-age threshold (an admin clicking
// "Sync" wants an immediate check), otherwise identical resolution logic.
export async function POST(request: NextRequest) {
    const authResult = await validateAdminAccess(true, request)
    if (authResult.error) {
        return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    const supabase = createServerClient()
    let totalChecked = 0
    let totalUpdated = 0
    let totalFailed = 0
    let totalSkippedDuplicateId = 0
    const errors: string[] = []

    try {
        const { data: mainOrders, error: mainError } = await (supabase
            .from('orders') as any)
            .select('id, hendylinks_order_id, status')
            .eq('fulfillment_method', 'hendylinks')
            .in('status', ['pending', 'processing'])
            .not('hendylinks_order_id', 'is', null)
            .order('created_at', { ascending: true })
            .limit(100)

        if (mainError) {
            errors.push(`orders query failed: ${mainError.message}`)
        } else if (mainOrders && mainOrders.length > 0) {
            // Full history, not one page — see the same change in the cron twin. An admin
            // clicking Sync is usually chasing an OLDER stuck order, which is precisely the
            // row a single-page fetch drops first.
            const historyResult = await fetchAllOrderHistory(HISTORY_PAGE_SIZE)
            if (!historyResult.success) {
                errors.push(historyResult.error || 'fetchAllOrderHistory failed')
            } else {
                const historyById = new Map(historyResult.orders.map(o => [String(o.id), o]))

                // Collision guard — identical mechanism to app/api/cron/sync-hendylinks-status.
                // Any hendylinks_order_id held by MORE THAN ONE row in this batch cannot be
                // resolved: the map above is keyed by supplier id, so applying an external status
                // would force BOTH local rows to one external order's outcome. Skip those rows
                // entirely, log loudly, and count them separately from successes/failures so the
                // run summary stays honest. This needs a human.
                const idCounts = new Map<string, number>()
                for (const o of mainOrders as Array<{ hendylinks_order_id: string }>) {
                    const key = String(o.hendylinks_order_id)
                    idCounts.set(key, (idCounts.get(key) || 0) + 1)
                }
                const duplicateIds = new Set(
                    Array.from(idCounts.entries()).filter(([, count]) => count > 1).map(([id]) => id)
                )
                if (duplicateIds.size > 0) {
                    const msg = `DUPLICATE-SUPPLIER-ID: ${duplicateIds.size} hendylinks_order_id value(s) are held by more than one order in this batch (${Array.from(duplicateIds).join(', ')}) — those orders are SKIPPED, no status applied. MANUAL RECONCILIATION REQUIRED.`
                    console.error(`[SyncHendyLinks] ${msg}`)
                    errors.push(msg)
                }

                for (const order of mainOrders as Array<{ id: string; hendylinks_order_id: string; status: string }>) {
                    totalChecked++
                    try {
                        if (duplicateIds.has(String(order.hendylinks_order_id))) {
                            console.error(`[SyncHendyLinks] Order ${order.id} skipped — its hendylinks_order_id=${order.hendylinks_order_id} is shared with another order in this batch.`)
                            totalSkippedDuplicateId++
                            continue
                        }

                        const match = historyById.get(order.hendylinks_order_id)
                        if (!match) continue

                        // Applies the match through the SAME path as the cron twin and the
                        // selection-scoped sync — see lib/hendylinks-service.ts for why.
                        const applyResult = await applyHendyLinksHistoryMatch(supabase, order, match)
                        if (applyResult.error) {
                            console.error(`[SyncHendyLinks] orders DB update failed for ${order.id}:`, applyResult.error)
                            errors.push(`DB update failed for ${order.id}: ${applyResult.error}`)
                            totalFailed++
                            continue
                        }
                        if (applyResult.updated) totalUpdated++
                    } catch (orderErr: any) {
                        errors.push(`orders exception for ${order.id}: ${orderErr.message}`)
                        totalFailed++
                    }
                }
            }
        }
    } catch (syncErr: any) {
        errors.push(`sync failed: ${syncErr.message}`)
    }

    return NextResponse.json({
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        skippedDuplicateId: totalSkippedDuplicateId,
        errors,
    })
}
