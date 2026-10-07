import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { syncShopOrderStatus } from '@/lib/shop-service'
import { validateCronAuth } from '@/lib/cron-utils'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'

// Service-role Supabase client — bypasses RLS for bulk operations
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

/**
 * GET /api/cron/auto-complete-data
 *
 * External cron (cron-job.org) — Runs every 10 minutes.
 * Scans all data package orders stuck in 'processing' for longer than the
 * configured threshold and bulk-marks them as 'completed', syncing to shop_orders.
 * Capped at 50 orders per run to prevent Vercel serverless timeout on large backlogs.
 *
 * Security: Protected by CRON_SECRET via shared validateCronAuth helper.
 */
export async function GET(request: NextRequest) {
    // ── 1. Security Check ────────────────────────────────────────────────────
    const authError = validateCronAuth(request)
    if (authError) return authError

    try {
        // ── 2. Check Admin Toggle ─────────────────────────────────────────────
        const { data: settingsRows } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', ['auto_complete_data_enabled', 'auto_complete_data_threshold_mins'])

        const settingsMap: Record<string, string> = {}
        for (const row of settingsRows || []) {
            settingsMap[row.key] = typeof row.value === 'string' ? row.value : JSON.stringify(row.value)
        }

        const isEnabled = settingsMap['auto_complete_data_enabled'] !== 'false'
        if (!isEnabled) {
            console.log('[AutoComplete Cron] Skipped — auto_complete_data_enabled is off')
            return NextResponse.json({ skipped: true, reason: 'Auto-complete is disabled by admin' })
        }

        // ── 3. Resolve Threshold ──────────────────────────────────────────────
        const thresholdMins = parseInt(settingsMap['auto_complete_data_threshold_mins'] || '30', 10)
        const cutoffTime = new Date(Date.now() - thresholdMins * 60 * 1000).toISOString()

        console.log(`[AutoComplete Cron] Running — threshold: ${thresholdMins} mins, cutoff: ${cutoffTime}`)

        // ── 4. Find Qualifying Orders ─────────────────────────────────────────
        // Only data package orders that have been 'processing' longer than the threshold.
        // Capped at 50 per run — prevents unbounded memory use and Vercel timeout.
        const { data: staleOrders, error: fetchError } = await supabaseAdmin
            .from('orders')
            .select('id')
            .eq('status', 'processing')
            .neq('category', 'mtn_mashup')
            .lt('updated_at', cutoffTime)
            .limit(50)

        if (fetchError) {
            console.error('[AutoComplete Cron] Failed to fetch stale orders:', fetchError)
            return NextResponse.json({ error: fetchError.message }, { status: 500 })
        }

        if (!staleOrders || staleOrders.length === 0) {
            console.log('[AutoComplete Cron] No qualifying stale orders found')
            return NextResponse.json({ completed: 0, threshold_mins: thresholdMins })
        }

        const orderIds = staleOrders.map((o: { id: string }) => o.id)
        console.log(`[AutoComplete Cron] Found ${orderIds.length} stale order(s) to complete`)

        // ── 5. Bulk Update orders Table ───────────────────────────────────────
        // .select('id') added so the developer webhook below fires only for ids THIS
        // call actually flipped — orderIds alone can't distinguish that from an id that
        // lost the 'processing' race (e.g. refunded in the gap above) and was silently
        // skipped by this same UPDATE.
        const { data: updatedRows, error: updateError } = await supabaseAdmin
            .from('orders')
            .update({ status: 'completed', updated_at: new Date().toISOString() })
            .in('id', orderIds)
            // Race guard: only flip rows STILL 'processing'. If an order was refunded
            // (status→'refunded') between the SELECT above and now, skip it — never
            // resurrect a refunded order to 'completed'.
            .eq('status', 'processing')
            .select('id')

        if (updateError) {
            console.error('[AutoComplete Cron] Bulk update failed:', updateError)
            return NextResponse.json({ error: updateError.message }, { status: 500 })
        }

        // Developer webhook — this cron is a genuine, supplier-agnostic terminal-state
        // resolver (it force-completes ANY stuck data order regardless of which supplier
        // dispatched it), so it needs the same hook as every other resolver. waitUntil
        // since up to 50 orders can complete in one run.
        for (const row of (updatedRows || [])) {
            waitUntil(notifyDataOrderWebhook(supabaseAdmin, (row as any).id, 'order.completed'))
        }

        // Trigger push notifications to users in background
        try {
            const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
            orderIds.forEach(id => {
                sendOrderCompletedPushNotification(id).catch(e => console.error('[AutoComplete Cron] Push error:', e))
            })
        } catch (pushErr) {
            console.error('[AutoComplete Cron] Failed to trigger push notifications:', pushErr)
        }

        // ── 6. Sync to shop_orders ────────────────────────────────────────────
        // Uses the same syncShopOrderStatus function as the manual fulfillment page
        const syncResults = await Promise.allSettled(
            orderIds.map((id: string) => syncShopOrderStatus(id, 'completed'))
        )

        let syncFailed = 0
        syncResults.forEach((result, index) => {
            if (result.status === 'rejected') {
                syncFailed++
                console.error(`[AutoComplete Cron] syncShopOrderStatus failed for order ${orderIds[index]}:`, result.reason)
            }
        })

        const syncSucceeded = orderIds.length - syncFailed

        console.log(`[AutoComplete Cron] Done — ${orderIds.length} completed, ${syncSucceeded} synced to shop_orders, ${syncFailed} sync failures`)

        return NextResponse.json({
            completed: orderIds.length,
            synced: syncSucceeded,
            sync_failures: syncFailed,
            threshold_mins: thresholdMins,
        })
    } catch (error: any) {
        console.error('[AutoComplete Cron] Unexpected error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
