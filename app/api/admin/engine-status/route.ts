import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { fetchSupplierBalance } from '@/lib/fulfillment-service'

/**
 * Durable "engine health" for the operational panel. Intentionally does NOT
 * expose the in-memory circuit breaker (per-instance/ephemeral on serverless);
 * instead derives health from persistent signals: the auto-fulfillment switch,
 * today's failure rate, and the live supplier float balance.
 */
export async function GET(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }

        const supabase = createServerClient()

        const [settingsRes, todayRes, failedTodayRes, supplier] = await Promise.all([
            supabase.from('admin_settings').select('key, value').in('key', ['auto_fulfillment_enabled', 'ussd_enabled']),
            supabase.from('orders').select('id', { count: 'exact', head: true }).gte('created_at', new Date().toISOString().split('T')[0]),
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', new Date().toISOString().split('T')[0]),
            fetchSupplierBalance().catch(() => ({ success: false as const })),
        ])

        const settings: Record<string, string> = {}
        ;(settingsRes.data as { key: string; value: string }[] | null)?.forEach(r => { settings[r.key] = r.value })

        const todayCount = todayRes.count || 0
        const failedToday = failedTodayRes.count || 0
        const failedRateToday = todayCount > 0 ? Math.round((failedToday / todayCount) * 100) : 0

        return NextResponse.json({
            autoFulfillmentEnabled: settings.auto_fulfillment_enabled === 'true',
            ussdEnabled: settings.ussd_enabled !== 'false',
            todayOrders: todayCount,
            failedToday,
            failedRateToday,
            supplierBalance: supplier.success ? (supplier as any).balance ?? null : null,
            supplierCurrency: supplier.success ? (supplier as any).currency ?? 'GHS' : null,
        })
    } catch (error: any) {
        console.error('Admin Engine Status Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
