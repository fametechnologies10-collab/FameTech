/**
 * /api/sms/campaigns/[id] — campaign detail + cancel (KFT SMS).
 *
 * GET   : campaign + delivery-status rollup (aggregated on read — no stored
 *         counters to corrupt) + paginated per-recipient rows.
 * DELETE: cancel a queued/scheduled campaign (cancel_sms_campaign RPC —
 *         idempotent full refund via the 'refund:{id}' ledger key).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

export const dynamic = 'force-dynamic'

async function ownedCampaign(db: any, userId: string, campaignId: string) {
    const { data: account } = await db.from('sms_accounts')
        .select('id').eq('user_id', userId).maybeSingle()
    if (!account) return null
    const { data: campaign } = await db.from('sms_campaigns')
        .select('*').eq('id', campaignId).eq('account_id', account.id).maybeSingle()
    return campaign ? { account, campaign } : null
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-campaign-detail:${user.id}`, 120, 60_000)
        if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

        const { id } = await params
        const db = createServerClient() as any
        const owned = await ownedCampaign(db, user.id, id)
        if (!owned) return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })

        const url = new URL(request.url)
        const page = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0)
        const pageSize = Math.min(100, Math.max(10, parseInt(url.searchParams.get('pageSize') || '50', 10) || 50))
        const statusFilter = url.searchParams.get('status')

        // Delivery rollup aggregated on read (one indexed count per status —
        // no stored counters that webhook replays could corrupt).
        const STATUSES = ['queued', 'sent', 'delivered', 'undelivered', 'failed', 'expired', 'rejected'] as const
        const counts = await Promise.all(STATUSES.map(s =>
            db.from('sms_messages')
                .select('id', { count: 'exact', head: true })
                .eq('campaign_id', id)
                .eq('status', s)))
        const rollup: Record<string, number> = {}
        STATUSES.forEach((s, i) => { if ((counts[i].count ?? 0) > 0) rollup[s] = counts[i].count as number })

        let mq = db.from('sms_messages')
            .select('id, recipient, status, status_detail, network_id, provider_message_id, status_updated_at, created_at', { count: 'exact' })
            .eq('campaign_id', id)
            .order('created_at', { ascending: true })
            .range(page * pageSize, page * pageSize + pageSize - 1)
        if (statusFilter && ['queued', 'sent', 'delivered', 'undelivered', 'failed', 'expired', 'rejected'].includes(statusFilter)) {
            mq = mq.eq('status', statusFilter)
        }
        const { data: messages, count } = await mq

        return NextResponse.json({
            success: true,
            data: {
                campaign: owned.campaign,
                rollup,
                messages: messages ?? [],
                totalMessages: count ?? 0,
                page,
                pageSize,
            },
        })
    } catch (e: any) {
        console.error('[SMS Campaign Detail] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-campaign-cancel:${user.id}`, 20, 60_000)
        if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

        const { id } = await params
        const db = createServerClient() as any
        const owned = await ownedCampaign(db, user.id, id)
        if (!owned) return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })

        const { data, error } = await db.rpc('cancel_sms_campaign', {
            p_campaign_id: id,
            p_account_id: (owned.account as any).id,
        })
        if (error) {
            console.error('[SMS Campaign Cancel] rpc error:', error.message)
            return NextResponse.json({ success: false, error: 'Could not cancel campaign' }, { status: 500 })
        }
        if (!(data as any)?.cancelled) {
            return NextResponse.json({ success: false, error: 'Only queued or scheduled campaigns can be cancelled' }, { status: 409 })
        }
        return NextResponse.json({ success: true, data: { refunded_credits: (data as any).refunded_credits } })
    } catch (e: any) {
        console.error('[SMS Campaign Cancel] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
