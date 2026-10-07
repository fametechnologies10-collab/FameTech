import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkOrderStatus, mapConsoleStatus } from '@/lib/atishare-console-service'
import { sanitizeForStorage } from '@/lib/sanitize-for-storage'
import { validateCronAuth } from '@/lib/cron-utils'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'

// AT-iShare Console (SPFastIT) has NO webhook. This cron is the ONLY mechanism that
// ever moves a console order out of pending/processing — without it, every console
// order dispatches and then sits unresolved forever. See lib/atishare-console-service.ts.
//
// Paginated oldest-first over OUR OWN rows (the vendor has no history/list endpoint, so
// pagination applies to our query, not theirs) with a hard page cap so a bad/huge result
// set cannot spin an unbounded loop, and so the same stuck orders can't get starved run
// after run.
const PAGE_SIZE = 50
const MAX_PAGES = 20

export async function GET(request: NextRequest) {
    // Project cron auth helper — identical pattern to
    // app/api/cron/sync-bundleportal-status/route.ts. Returns a ready-made error
    // response, or null when the request is authorised.
    const authError = validateCronAuth(request)
    if (authError) return authError

    const supabase = createServerClient()
    let checked = 0
    let resolved = 0
    let failed = 0
    const errors: string[] = []

    console.log('[CronSyncAtiShareConsole] Starting sweep...')

    try {
        for (let page = 0; page < MAX_PAGES; page++) {
            // atishare_console_transaction_id / atishare_console_reference are not yet in
            // the generated types/supabase.ts, so `orders` is accessed loosely here — same
            // reason sync-bundleportal-status/route.ts casts `as any` on every `orders` call.
            const { data: orders, error } = await (supabase
                .from('orders') as any)
                .select('id, atishare_console_transaction_id')
                .eq('fulfillment_method', 'atishare_console')
                .in('status', ['pending', 'processing'])
                .not('atishare_console_transaction_id', 'is', null)
                .order('created_at', { ascending: true })
                .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

            if (error) {
                console.error('[CronSyncAtiShareConsole] Orders query failed:', error.message)
                errors.push(`Orders query failed: ${error.message}`)
                return NextResponse.json({ success: false, checked, resolved, failed, errors }, { status: 500 })
            }
            if (!orders || orders.length === 0) break

            console.log(`[CronSyncAtiShareConsole] Page ${page}: checking ${orders.length} order(s)`)

            for (const order of orders as Array<{ id: string; atishare_console_transaction_id: string }>) {
                checked++

                // Per-order isolation: this cron is the ONLY mechanism that ever resolves an
                // AT-iShare Console order, and the sweep runs oldest-first. If one order's
                // body threw uncaught, it would abort the whole run and permanently starve
                // every order behind it, on every subsequent run too. Nothing in this body
                // throws today (callConsole swallows transport/parse errors into
                // {success:false}, and the notification calls are already .catch()-guarded),
                // but the isolation must hold regardless of what future code does here.
                try {
                    const status = await checkOrderStatus(order.atishare_console_transaction_id)
                    if (!status.success || !status.orderStatus) {
                        // A failed status CHECK (network error, vendor error response) is logged
                        // and skipped — never marks the order failed. We could not reach the
                        // vendor to ask about it, so we say nothing about its fate.
                        console.warn(`[CronSyncAtiShareConsole] Status check failed for order ${order.id}: ${status.error}`)
                        continue
                    }

                    const mapped = mapConsoleStatus(status.orderStatus)
                    if (mapped === 'processing') continue // still in flight (queued/processing/pending_retry/unknown)

                    // The fulfillment_method filter is repeated HERE, in the UPDATE itself, not
                    // only in the SELECT above: an order can be reassigned to a different
                    // supplier in the window between the two while its status stays unchanged,
                    // and a stale outcome must never overwrite that reassignment. The status is
                    // constrained too, so a row already resolved elsewhere in the meantime is
                    // never clobbered.
                    const { data: updated, error: updateError } = await (supabase
                        .from('orders') as any)
                        .update({ status: mapped, updated_at: new Date().toISOString() })
                        .eq('id', order.id)
                        .eq('fulfillment_method', 'atishare_console')
                        .in('status', ['pending', 'processing'])
                        .select('id')

                    if (updateError) {
                        console.error(`[CronSyncAtiShareConsole] DB update failed for ${order.id}:`, updateError.message)
                        errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                        failed++
                        continue
                    }

                    if (updated && updated.length > 0) {
                        resolved++
                        console.log(`[CronSyncAtiShareConsole] Order ${order.id} -> ${mapped}`)

                        // Supplier reason is INTERNAL ONLY — never orders.error_message, which is
                        // rendered to the customer as "Failure Reason" in
                        // components/dashboard/RecentOrdersWidget.tsx.
                        // sanitizeForStorage(value, maxLen=500) strips control characters, so a
                        // supplier string cannot forge log lines or bloat the audit trail.
                        if (mapped === 'failed') {
                            const { error: trackingError } = await (supabase
                                .from('mtn_fulfillment_tracking') as any)
                                .insert({
                                    order_id: order.id,
                                    status: 'failed',
                                    api_response: {
                                        supplier: 'atishare_console',
                                        source: 'cron-reconciliation',
                                        order_status: status.orderStatus,
                                        message: sanitizeForStorage(status.responseMessage ?? '', 500),
                                    },
                                })
                            if (trackingError) {
                                console.error(`[CronSyncAtiShareConsole] Tracking insert failed for ${order.id}:`, trackingError.message)
                                errors.push(`Tracking insert failed for ${order.id}: ${trackingError.message}`)
                            }
                        }

                        // Mirror to the shop_orders row and notify, matching every other sweep.
                        await syncShopOrderStatus(order.id, mapped).catch(err =>
                            console.error(`[CronSyncAtiShareConsole] Shop sync failed for ${order.id}:`, err)
                        )
                        if (mapped === 'completed') {
                            const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                            sendOrderCompletedPushNotification(order.id).catch(e =>
                                console.error('[CronSyncAtiShareConsole] Push error:', e)
                            )
                        }

                        // waitUntil, not inline await — up to MAX_PAGES*PAGE_SIZE=1000 orders
                        // can be swept in one run, sequentially; an inline wait per webhook
                        // risks the same maxDuration:60 exposure fixed elsewhere (I3). `updated`
                        // already proves this row (not some other) just made the transition.
                        if (mapped === 'completed' || mapped === 'failed') {
                            waitUntil(notifyDataOrderWebhook(
                                supabase, order.id,
                                mapped === 'completed' ? 'order.completed' : 'order.failed',
                            ))
                        }
                    }
                } catch (orderErr: any) {
                    // One order's exception must never escape the loop and abort the sweep.
                    console.error(`[CronSyncAtiShareConsole] Exception for order ${order.id}:`, orderErr?.message || orderErr)
                    errors.push(`Exception for ${order.id}: ${orderErr?.message || orderErr}`)
                    failed++
                }
            }

            if (orders.length < PAGE_SIZE) break
        }
    } catch (err: any) {
        console.error('[CronSyncAtiShareConsole] Fatal error:', err?.message || err)
        errors.push(`Fatal: ${err?.message || err}`)
        return NextResponse.json({ success: false, checked, resolved, failed, errors }, { status: 500 })
    }

    console.log(`[CronSyncAtiShareConsole] Done. checked=${checked}, resolved=${resolved}, failed=${failed}`)
    return NextResponse.json({ success: true, checked, resolved, failed, errors })
}
