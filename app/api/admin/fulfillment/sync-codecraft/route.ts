import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkOrderStatus } from '@/lib/codecraft-service'
import { validateAdminAccess } from '@/lib/auth-utils'

const CONCURRENCY = 5

async function runInChunks<T>(items: T[], worker: (item: T) => Promise<void>) {
    for (let i = 0; i < items.length; i += CONCURRENCY) {
        await Promise.allSettled(items.slice(i, i + CONCURRENCY).map(worker))
    }
}

export async function POST(request: NextRequest) {
    const authResult = await validateAdminAccess(true, request)
    if (authResult.error) {
        return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    const supabase = createServerClient()
    let totalChecked = 0
    let totalUpdated = 0
    let totalFailed = 0
    const errors: string[] = []

    // ── Part A: shop_orders ───────────────────────────────────────────────────
    try {
        const { data: shopOrders, error: shopError } = await (supabase
            .from('shop_orders') as any)
            .select('id, codecraft_reference_id, status')
            .eq('fulfilled_by', 'codecraft')
            .in('status', ['pending', 'processing'])
            .not('codecraft_reference_id', 'is', null)
            .order('created_at', { ascending: true })
            .limit(100)

        if (shopError) {
            errors.push(`shop_orders query failed: ${shopError.message}`)
        } else {
            await runInChunks(shopOrders || [], async (order: any) => {
                totalChecked++
                try {
                    const statusResult = await checkOrderStatus(order.codecraft_reference_id)

                    if (!statusResult.success) return

                    const newStatus = statusResult.status
                    if (newStatus === order.status || newStatus === 'processing') return

                    // NO wallet touch. NO payment_status change.
                    // Guard: only update if status hasn't changed since we queried it —
                    // prevents a concurrent cron/admin run or manual admin edit from being
                    // overwritten with a stale CodeCraft response.
                    const { error: updateError } = await (supabase
                        .from('shop_orders') as any)
                        .update({
                            status: newStatus,
                            updated_at: new Date().toISOString(),
                        })
                        .eq('id', order.id)
                        .eq('status', order.status)

                    if (updateError) {
                        console.error(`[SyncCodeCraft] shop_orders DB update failed for ${order.id}:`, updateError.message)
                        errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                        totalFailed++
                    } else {
                        totalUpdated++
                    }
                } catch (orderErr: any) {
                    errors.push(`shop_orders exception for ${order.id}: ${orderErr.message}`)
                    totalFailed++
                }
            })
        }
    } catch (partAErr: any) {
        errors.push(`Part A (shop_orders) failed: ${partAErr.message}`)
    }

    // ── Part B: orders ────────────────────────────────────────────────────────
    try {
        const { data: mainOrders, error: mainError } = await (supabase
            .from('orders') as any)
            .select('id, codecraft_reference, status')
            .eq('fulfillment_method', 'codecraft')
            .in('status', ['pending', 'processing'])
            .not('codecraft_reference', 'is', null)
            .order('created_at', { ascending: true })
            .limit(100)

        if (mainError) {
            errors.push(`orders query failed: ${mainError.message}`)
        } else {
            await runInChunks(mainOrders || [], async (order: any) => {
                totalChecked++
                try {
                    const statusResult = await checkOrderStatus(order.codecraft_reference)

                    if (!statusResult.success) return

                    const newStatus = statusResult.status
                    if (newStatus === order.status || newStatus === 'processing') return

                    // NO wallet touch. NO refund logic.
                    // Guard: only update if status matches what we read — mirrors the cron
                    // pattern (.eq('status', 'processing')) but uses order.status so the
                    // broader fetch (.in('status', ['pending','processing'])) is respected.
                    const { error: updateError } = await (supabase
                        .from('orders') as any)
                        .update({
                            status: newStatus,
                            updated_at: new Date().toISOString(),
                        })
                        .eq('id', order.id)
                        .eq('status', order.status)

                    if (updateError) {
                        console.error(`[SyncCodeCraft] orders DB update failed for ${order.id}:`, updateError.message)
                        errors.push(`DB update failed for ${order.id}: ${updateError.message}`)
                        totalFailed++
                        return
                    }

                    // Sync status to shop storefront orders if any
                    try {
                        const { syncShopOrderStatus } = await import('@/lib/shop-service')
                        await syncShopOrderStatus(order.id, newStatus).catch(err =>
                            console.error(`[SyncCodeCraft] Failed to sync shop order for ${order.id}:`, err)
                        )
                    } catch (syncErr) {
                        console.error('[SyncCodeCraft] Failed to import shop service:', syncErr)
                    }

                    if (newStatus === 'completed') {
                        try {
                            const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                            sendOrderCompletedPushNotification(order.id).catch(e => console.error('[SyncCodeCraft] Push error:', e))
                        } catch (pushErr) {
                            console.error('[SyncCodeCraft] Failed to trigger push notification:', pushErr)
                        }
                    }
                    totalUpdated++
                } catch (orderErr: any) {
                    errors.push(`orders exception for ${order.id}: ${orderErr.message}`)
                    totalFailed++
                }
            })
        }
    } catch (partBErr: any) {
        errors.push(`Part B (orders) failed: ${partBErr.message}`)
    }

    return NextResponse.json({
        checked: totalChecked,
        updated: totalUpdated,
        failed: totalFailed,
        errors,
    })
}
