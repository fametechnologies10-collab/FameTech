import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { validateCronAuth } from '@/lib/cron-utils'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

// Sub-agent withdrawal escalation (spec §10, Phase 9). Runs hourly on cron-job.org.
// Sweeps `shop_owner_pending` sub withdrawals whose 48h Lead-approval SLA has lapsed,
// OR whose Lead is now ineligible/suspended, and forwards them into the admin payout
// queue ('pending', auto_escalated=true). An absent Lead can never trap a sub's funds.
export async function GET(request: Request) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    try {
        const { data, error } = await (supabaseAdmin as any).rpc('escalate_stale_sub_withdrawals')
        if (error) {
            console.error('[EscalateSubWithdrawals] RPC error:', error)
            return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
        }
        const escalated = (data as any)?.escalated ?? 0
        if (escalated > 0) {
            console.log(`[EscalateSubWithdrawals] Auto-escalated ${escalated} stale/orphaned sub withdrawal(s) to the admin queue.`)
        }
        return NextResponse.json({ success: true, escalated })
    } catch (error: any) {
        console.error('[EscalateSubWithdrawals]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
