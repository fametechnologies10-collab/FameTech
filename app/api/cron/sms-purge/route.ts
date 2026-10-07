/**
 * GET /api/cron/sms-purge — retention cleanup for per-recipient SMS rows.
 * Schedule: daily on cronjob.org. Deletes sms_messages older than the
 * admin-configured retention (admin_settings.user_sms_message_retention_months,
 * default 12) in bounded batches via the purge_old_sms_messages RPC.
 * Campaign summary rows are kept forever (they are the billing audit trail).
 *
 * Also purges expired shop_sms_send_claims rows (see
 * app/api/shop/sms/send/route.ts and migration 20260811_shop_sms_send_idempotency.sql)
 * — those are pure send-idempotency dedup markers with a fixed 24h lifetime,
 * unrelated to the message-retention setting above, so they're deleted
 * unconditionally past that age rather than gated by any admin setting.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateCronAuth } from '@/lib/cron-utils'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SEND_CLAIM_TTL_HOURS = 24

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    const db = createServerClient() as any
    try {
        const { data: setting } = await db.from('admin_settings')
            .select('value').eq('key', 'user_sms_message_retention_months').maybeSingle()
        const months = Math.max(1, parseInt(String((setting as any)?.value ?? '12').replace(/"/g, ''), 10) || 12)

        const { data: deleted, error } = await db.rpc('purge_old_sms_messages', {
            p_months: months,
            p_limit: 5000,
        })
        if (error) throw error

        const claimCutoff = new Date(Date.now() - SEND_CLAIM_TTL_HOURS * 60 * 60 * 1000).toISOString()
        const { count: claimsDeleted, error: claimsError } = await db
            .from('shop_sms_send_claims')
            .delete({ count: 'exact' })
            .lt('created_at', claimCutoff)
        if (claimsError) console.error('[SMS Purge Cron] shop_sms_send_claims cleanup error (non-fatal):', claimsError.message)

        return NextResponse.json({
            success: true,
            data: { deleted: deleted ?? 0, retention_months: months, sendClaimsDeleted: claimsDeleted ?? 0 },
        })
    } catch (e: any) {
        console.error('[SMS Purge Cron] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
