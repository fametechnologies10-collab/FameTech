import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkOrderStatus, mapConsoleStatus } from '@/lib/atishare-console-service'
import { sanitizeForStorage } from '@/lib/sanitize-for-storage'
import { validateAdminAccess } from '@/lib/auth-utils'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'

// Admin-triggered twin of app/api/cron/sync-atishare-console-status. No age threshold —
// an admin clicking "Sync" wants an immediate check — otherwise identical resolution logic.
export async function POST(request: NextRequest) {
    // Same helper every other admin fulfillment route uses; returns { error, status }.
    const authResult = await validateAdminAccess(true, request)
    if (authResult.error) {
        return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    const supabase = createServerClient()
    let totalChecked = 0
    let totalUpdated = 0
    let totalFailed = 0
    const errors: string[] = []

    try {
        const { data: orders, error: ordersError } = await (supabase
            .from('orders') as any)
            .select('id, status, atishare_console_transaction_id')
            .eq('fulfillment_method', 'atishare_console')
            .in('status', ['pending', 'processing'])
            .not('atishare_console_transaction_id', 'is', null)
            .order('created_at', { ascending: true })
            .limit(100)

        if (ordersError) {
            errors.push(`orders query failed: ${ordersError.message}`)
            return NextResponse.json({ checked: totalChecked, updated: totalUpdated, failed: totalFailed, errors }, { status: 500 })
        }

        for (const order of (orders || []) as Array<{ id: string; status: string; atishare_console_transaction_id: string }>) {
            totalChecked++
            try {
                const status = await checkOrderStatus(order.atishare_console_transaction_id)
                if (!status.success || !status.orderStatus) {
                    // A failed status CHECK (network error, vendor error response) is not a
                    // failed ORDER — log and skip, never mark the order failed because the
                    // vendor was unreachable.
                    console.warn(`[SyncAtiShareConsole] Status check failed for order ${order.id}: ${status.error}`)
                    continue
                }

                const mapped = mapConsoleStatus(status.orderStatus)
                if (mapped === 'processing') continue // still in flight

                // fulfillment_method repeats the SELECT's own guard HERE on the UPDATE: an
                // order can be reassigned to another supplier between the two while status
                // stays unchanged, and a stale outcome must not overwrite it. The observed
                // status is constrained too, so a row already resolved elsewhere in the
                // meantime is never clobbered.
                const { data: updated, error: updateError } = await (supabase.from('orders') as any)
                    .update({ status: mapped, updated_at: new Date().toISOString() })
                    .eq('id', order.id)
                    .in('status', ['pending', 'processing'])
                    .eq('fulfillment_method', 'atishare_console')
                    .select('id')

                if (updateError) {
                    errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                    totalFailed++
                    continue
                }

                // Zero rows affected means this call LOST a race — the cron sweep, or another
                // admin click, already resolved (or reassigned) this order between our SELECT
                // and this UPDATE. `.update()` without `.select()` returns error: null even
                // when the predicate matches nothing, so rows-affected is the only reliable
                // signal. A losing call must not fire any side effect: not the tracking-row
                // insert, not the shop sync, and especially not a second customer-facing push
                // notification.
                if (updated && updated.length > 0) {
                    if (mapped === 'failed') {
                        await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                            order_id: order.id,
                            status: 'failed',
                            api_response: {
                                supplier: 'atishare_console',
                                source: 'admin-reconciliation',
                                order_status: status.orderStatus,
                                message: sanitizeForStorage(status.responseMessage ?? '', 500),
                            },
                        })
                    }

                    await syncShopOrderStatus(order.id, mapped).catch(err =>
                        console.error(`[SyncAtiShareConsole] Shop sync failed for ${order.id}:`, err)
                    )
                    if (mapped === 'completed') {
                        const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                        sendOrderCompletedPushNotification(order.id).catch(e =>
                            console.error('[SyncAtiShareConsole] Push error:', e)
                        )
                    }
                    if (mapped === 'completed' || mapped === 'failed') {
                        waitUntil(notifyDataOrderWebhook(
                            supabase, order.id,
                            mapped === 'completed' ? 'order.completed' : 'order.failed',
                        ))
                    }
                    totalUpdated++
                }
            } catch (orderErr: any) {
                // One order's exception must never escape the loop and abort the run.
                errors.push(`exception for ${order.id}: ${orderErr.message}`)
                totalFailed++
            }
        }
    } catch (syncErr: any) {
        errors.push(`sync failed: ${syncErr.message}`)
    }

    return NextResponse.json({ checked: totalChecked, updated: totalUpdated, failed: totalFailed, errors })
}
