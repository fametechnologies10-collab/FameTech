/**
 * /api/sms/campaigns — KFT SMS send choke point + history.
 *
 * POST: create a campaign (validate → filter per policy → atomic debit →
 *       persist per-recipient rows → inline dispatch ≤500 / queue for cron).
 *       All heavy lifting lives in lib/sms-campaign-pipeline.ts (shared with
 *       the developer API and the dispatch cron).
 * GET : paginated campaign history with status filter.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { createCampaign, getSmsAccountContext } from '@/lib/sms-campaign-pipeline'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const sendSchema = z.object({
    message: z.string().min(3).max(1000),
    recipients: z.array(z.string().min(9).max(15)).min(1).max(10000),
    sender: z.string().min(3).max(11).optional().nullable(),
    scheduledAt: z.string().datetime({ offset: true }).optional().nullable(),
})

export async function POST(request: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        // Warm-instance shield; the authoritative limits are the DB counters
        // inside the pipeline (fail-closed) + the Redis middleware limiter.
        const rl = consumeRateLimit(`sms-campaign-post:${user.id}`, 20, 60_000)
        if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

        const body = await request.json().catch(() => null)
        const parsed = sendSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'Invalid request: ' + parsed.error.issues[0]?.message }, { status: 400 })
        }

        const db = createServerClient() as any
        const ctxRes = await getSmsAccountContext(db, user.id)
        if (!ctxRes.ok) {
            return NextResponse.json({ success: false, error: ctxRes.error }, { status: ctxRes.status })
        }

        const outcome = await createCampaign({
            db,
            userId: user.id,
            ctx: ctxRes.ctx,
            message: parsed.data.message,
            recipients: parsed.data.recipients,
            requestedSender: parsed.data.sender ?? null,
            scheduledAt: parsed.data.scheduledAt ?? null,
            source: 'dashboard',
        })

        if (!outcome.ok) {
            return NextResponse.json(
                { success: false, error: outcome.error, blocked: outcome.blocked ?? false },
                { status: outcome.status })
        }
        return NextResponse.json({ success: true, data: outcome.campaign })
    } catch (e: any) {
        console.error('[SMS Campaigns POST] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}

export async function GET(request: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-campaign-get:${user.id}`, 60, 60_000)
        if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

        const db = createServerClient() as any
        const { data: account } = await db.from('sms_accounts')
            .select('id').eq('user_id', user.id).maybeSingle()
        if (!account) return NextResponse.json({ success: true, data: { campaigns: [], total: 0 } })

        const url = new URL(request.url)
        const status = url.searchParams.get('status')
        const page = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0)
        const pageSize = Math.min(50, Math.max(5, parseInt(url.searchParams.get('pageSize') || '20', 10) || 20))

        let q = db.from('sms_campaigns')
            .select('id, sender_used, mode_at_send, message, recipients_count, segments, credits_charged, status, flagged, scheduled_at, source, created_at', { count: 'exact' })
            .eq('account_id', (account as any).id)
            .order('created_at', { ascending: false })
            .range(page * pageSize, page * pageSize + pageSize - 1)
        if (status && ['queued', 'processing', 'completed', 'partial', 'failed', 'blocked', 'cancelled'].includes(status)) {
            q = q.eq('status', status)
        }
        const { data: campaigns, count, error } = await q
        if (error) throw error

        return NextResponse.json({ success: true, data: { campaigns: campaigns ?? [], total: count ?? 0, page, pageSize } })
    } catch (e: any) {
        console.error('[SMS Campaigns GET] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
