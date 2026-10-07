/**
 * GET /api/cron/sms-dispatch — KFG SMS queued-campaign dispatcher.
 * Schedule: every minute on cronjob.org (Authorization: Bearer CRON_SECRET).
 *
 * Claims due queued campaigns (or stale claims from a crashed run) via the
 * atomic claim_sms_campaigns RPC (FOR UPDATE SKIP LOCKED), RE-VALIDATES the
 * account/role/sender at claim time, sends chunk-by-chunk within the 60 s
 * budget, and settles finished campaigns (single terminal refund).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateCronAuth } from '@/lib/cron-utils'
import {
    dispatchClaimedCampaign,
    revalidateForDispatch,
    failAndSettleCampaign,
} from '@/lib/sms-campaign-pipeline'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    const db = createServerClient() as any
    const startedAt = Date.now()
    const results: any[] = []

    try {
        const { data: claimed, error } = await db.rpc('claim_sms_campaigns', {
            p_limit: 3,
            p_stale_minutes: 10,
        })
        if (error) {
            console.error('[SMS Dispatch Cron] claim failed:', error.message)
            return NextResponse.json({ success: false, error: 'claim failed' }, { status: 500 })
        }

        for (const campaign of (claimed as any[]) || []) {
            // Keep a safety margin inside the 60 s route budget.
            if (Date.now() - startedAt > 45_000) break

            // Re-validate with the campaign's EXACT stored sender — a revoked
            // sender / suspended account fails the campaign (refund), and is
            // NEVER substituted with another sender.
            const valid = await revalidateForDispatch(db, campaign)
            if (!valid) {
                await failAndSettleCampaign(db, campaign.id, 'policy re-validation failed at dispatch')
                results.push({ id: campaign.id, outcome: 'failed_validation' })
                continue
            }

            const dispatch = await dispatchClaimedCampaign(db, campaign, 10)
            if (dispatch.done) {
                const { data: settled } = await db.rpc('settle_sms_campaign', { p_campaign_id: campaign.id })
                results.push({ id: campaign.id, outcome: (settled as any)?.final_status || 'settled', sent: dispatch.sent, failed: dispatch.failed })
            } else {
                // More chunks remain — leave status='processing'; claimed_at was
                // refreshed by the claim, so the next tick resumes it as stale
                // only if this run dies. Touch claimed_at to mark liveness.
                await db.from('sms_campaigns')
                    .update({ claimed_at: new Date().toISOString() })
                    .eq('id', campaign.id)
                    .eq('status', 'processing')
                results.push({ id: campaign.id, outcome: 'partial_progress', sent: dispatch.sent, failed: dispatch.failed })
            }
        }

        return NextResponse.json({ success: true, data: { processed: results.length, results } })
    } catch (e: any) {
        console.error('[SMS Dispatch Cron] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
