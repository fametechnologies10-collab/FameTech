import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateCronAuth } from '@/lib/cron-utils'

export async function GET(request: NextRequest) {
    // Verify cron secret
    const authError = validateCronAuth(request)
    if (authError) return authError

    const supabase = createServerClient()

    try {
        // Calculate date 90 days ago
        const ninetyDaysAgo = new Date()
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

        // Delete orders older than 90 days
        const { data, error, count } = await (supabase
            .from('orders') as any)
            .delete()
            .lt('created_at', ninetyDaysAgo.toISOString())
            .select('id', { count: 'exact' })

        if (error) throw error

        console.log(`Deleted ${count || 0} orders older than 90 days`)

        return NextResponse.json({
            success: true,
            deleted: count || 0,
            cutoffDate: ninetyDaysAgo.toISOString()
        })
    } catch (error) {
        console.error('Cron delete-old-orders error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
