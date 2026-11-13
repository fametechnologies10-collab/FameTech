import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { verifyAdminSmsBroadcast } from '@/lib/admin-sms-broadcast'
import { listKingFlexyFailedCampaignIds } from '@/lib/kingflexy-campaigns'

export const maxDuration = 300

/**
 * POST /api/admin/sms-broadcast/[id]/verify
 *
 * Checks KingFlexyGH's real outcome for a finished broadcast: messages the
 * supplier accepted but its carrier gateway rejected are flipped to 'failed'.
 * Idempotent — a no-op for a broadcast that isn't done or is already verified.
 * 502 when the supplier lookup fails; the broadcast stays unverified and the
 * safety-net cron retries.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const auth = await validateAdminAccess()
        if (auth.error !== null) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const { id } = await params
        const supabase = createServerClient()

        let status
        try {
            // The supplier's list endpoint allows 5 calls/min; a broadcast with
            // many rejections needs several pages, so wait out 429s here.
            status = await verifyAdminSmsBroadcast(supabase, id, (opts) =>
                listKingFlexyFailedCampaignIds({ ...opts, maxWaitMs: 120_000 }),
            )
        } catch (e: any) {
            console.error('[SMSBroadcast Verify] Delivery check failed:', e?.message)
            return NextResponse.json({ success: false, error: 'Delivery check unavailable' }, { status: 502 })
        }
        if (!status) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

        return NextResponse.json({ success: true, data: status })
    } catch (e: any) {
        console.error('[SMSBroadcast Verify] Error:', e)
        return NextResponse.json({ error: e.message || 'Internal server error' }, { status: 500 })
    }
}
