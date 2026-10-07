import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { validateCronAuth } from '@/lib/cron-utils'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
    // Verify cron secret
    const authError = validateCronAuth(request)
    if (authError) return authError

    const supabase = createServerClient()

    try {
        // Calculate date 30 days ago
        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

        // Delete old complaints
        const { count, error } = await (supabase
            .from('complaints') as any)
            .delete({ count: 'exact' })
            .lt('created_at', thirtyDaysAgo.toISOString())

        if (error) throw error

        // Purge support threads CLOSED more than 90 days ago (messages cascade).
        // Open threads are never deleted — an unanswered complaint must not vanish.
        const ninetyDaysAgo = new Date()
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

        const { count: threadCount, error: threadError } = await (supabase as any)
            .from('support_threads')
            .delete({ count: 'exact' })
            .eq('status', 'closed')
            .lt('closed_at', ninetyDaysAgo.toISOString())

        if (threadError) throw threadError

        return NextResponse.json({
            success: true,
            message: `Deleted ${count} old complaints, ${threadCount} expired support threads`,
            deletedCount: count,
            deletedThreads: threadCount
        })
    } catch (error: any) {
        console.error('Error deleting old complaints:', error)
        return NextResponse.json(
            { error: error.message },
            { status: 500 }
        )
    }
}
