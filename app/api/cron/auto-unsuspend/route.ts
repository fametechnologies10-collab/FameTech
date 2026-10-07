import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { validateCronAuth } from '@/lib/cron-utils'

// Service-role client — bypasses RLS for the bulk reactivation.
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

/**
 * GET /api/cron/auto-unsuspend
 * External cron (cron-job.org) — hourly.
 * Reactivates users whose timed suspension has elapsed
 * (status='suspended' AND suspended_until <= now()). The UI already treats an
 * elapsed suspension as lifted; this keeps the DB canonical.
 */
export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    try {
        const nowIso = new Date().toISOString()
        const { data, error } = await (supabaseAdmin.from('users') as any)
            .update({
                status: 'active',
                suspended_until: null,
                suspension_reason: null,
                suspended_at: null,
                suspended_by: null,
                updated_at: nowIso,
            })
            .eq('status', 'suspended')
            .not('suspended_until', 'is', null)
            .lte('suspended_until', nowIso)
            .select('id')

        if (error) {
            console.error('[auto-unsuspend] error:', error)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        const reactivated = (data || []).length
        if (reactivated > 0) console.log(`[auto-unsuspend] reactivated ${reactivated} user(s)`)
        return NextResponse.json({ success: true, reactivated })
    } catch (e: any) {
        console.error('[auto-unsuspend] exception:', e)
        return NextResponse.json({ error: e.message || 'Internal server error' }, { status: 500 })
    }
}
