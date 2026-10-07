import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendPushNotification } from '@/lib/push-service'
import { validateCronAuth } from '@/lib/cron-utils'

// Ensure this route is dynamic or handled as a cron
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
    try {
        // SEC-012: fail-closed cron auth (constant-time, 500 if secret unset)
        const authError = validateCronAuth(request)
        if (authError) return authError

        const adminDb = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        // Fetch all distinct user IDs that have a push subscription
        const { data: subscriptions, error } = await adminDb
            .from('push_subscriptions')
            .select('user_id')

        if (error) {
            console.error('[CronDailyGreeting] Failed to fetch subscriptions:', error)
            return NextResponse.json({ error: 'Database error' }, { status: 500 })
        }

        // Extract unique user IDs
        const userIds = [...new Set(subscriptions.map(s => s.user_id))]

        if (userIds.length === 0) {
            return NextResponse.json({ success: true, message: 'No subscribed users found' })
        }

        let sentCount = 0
        let failedCount = 0

        // Send greeting to each user concurrently
        await Promise.allSettled(
            userIds.map(async (userId) => {
                const { sent, failed } = await sendPushNotification(userId, {
                    title: 'Good Morning! ☀️',
                    body: 'Have a great day ahead! Remember to check your dashboard for new updates.',
                    url: '/dashboard'
                })
                sentCount += sent
                failedCount += failed
            })
        )

        return NextResponse.json({
            success: true,
            message: 'Daily greetings sent',
            stats: { users: userIds.length, sent: sentCount, failed: failedCount }
        })
    } catch (error) {
        console.error('[CronDailyGreeting] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
