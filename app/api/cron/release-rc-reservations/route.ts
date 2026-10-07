import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateCronAuth } from '@/lib/cron-utils'

/**
 * GET /api/cron/release-rc-reservations
 *
 * Releases timed-out RC inventory reservations back to 'available' status.
 * Secured with CRON_SECRET header via shared validateCronAuth helper.
 * Scheduled via cron-job.org every 15 minutes.
 */
export async function GET(request: NextRequest) {
    // Verify cron secret
    const authError = validateCronAuth(request)
    if (authError) return authError

    const supabase = createServerClient()

    try {
        const { data: released, error } = await (supabase as any)
            .rpc('release_expired_rc_reservations')

        if (error) {
            console.error('[Cron RC] release_expired_rc_reservations error:', error)
            return NextResponse.json({ error: 'RPC error', detail: error.message }, { status: 500 })
        }

        const releasedCount = typeof released === 'number' ? released : 0
        console.log(`[Cron RC] Released ${releasedCount} expired reservations`)

        return NextResponse.json({
            success:  true,
            released: releasedCount,
            ran_at:   new Date().toISOString(),
        })
    } catch (error) {
        console.error('[Cron RC] Unexpected error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
