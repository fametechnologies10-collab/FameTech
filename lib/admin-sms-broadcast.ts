/**
 * Admin SMS broadcast — create/dispatch/status library.
 *
 * Drives admin_sms_broadcasts / admin_sms_broadcast_recipients and the
 * claim_admin_sms_broadcast_recipients / increment_admin_sms_broadcast_counts
 * RPCs (see supabase/migrations/20261019_admin_sms_broadcast_queue.sql).
 *
 * dispatchAdminSmsBroadcastChunk claims a small batch of still-queued
 * recipients, sends them, and ALWAYS calls the increment RPC afterward —
 * even when nothing was claimed (0/0 deltas) — purely to re-check whether
 * the broadcast can now be finalized. That's what makes it safe to call
 * repeatedly: a caller (an API route, or the safety-net cron) can re-dispatch
 * a done or stuck broadcast without special-casing it.
 */
import { sendSMS } from '@/lib/sms-service'
import type { SMSResult } from '@/lib/sms-service'
import { listKingFlexyFailedCampaignIds } from '@/lib/kingflexy-campaigns'

const INSERT_CHUNK_SIZE = 1000
const CLAIM_LIMIT = 10
const SEND_BATCH_SIZE = 5

export type AdminSmsBroadcastStatus = {
    status: 'queued' | 'sending' | 'done'
    totalRecipients: number
    sentCount: number
    failedCount: number
    /** True once the supplier's outcome has been checked (see verifyAdminSmsBroadcast). */
    verified: boolean
    failedSamples?: Array<{ phone: string; error: string | null }>
}

type SendFn = (opts: { recipient: string; message: string }) => Promise<SMSResult>

async function fetchFailedSamples(db: any, broadcastId: string) {
    const { data, error } = await db
        .from('admin_sms_broadcast_recipients')
        .select('phone, error')
        .eq('broadcast_id', broadcastId)
        .eq('status', 'failed')
        .limit(20)
    if (error) throw error
    return ((data as Array<{ phone: string; error: string | null }>) || []).map((r) => ({ phone: r.phone, error: r.error }))
}

export async function createAdminSmsBroadcast(
    db: any,
    params: {
        createdBy: string
        message: string
        audienceType: 'users' | 'group'
        recipients: Array<{ phone: string; resolvedMessage: string }>
    },
): Promise<{ broadcastId: string; total: number }> {
    const { createdBy, message, audienceType, recipients } = params
    if (!recipients || recipients.length === 0) {
        throw new Error('No recipients')
    }

    const { data: broadcast, error } = await db
        .from('admin_sms_broadcasts')
        .insert({
            created_by: createdBy,
            message,
            audience_type: audienceType,
            total_recipients: recipients.length,
        })
        .select('id')
        .single()
    if (error) throw error

    const broadcastId = broadcast.id as string

    for (let i = 0; i < recipients.length; i += INSERT_CHUNK_SIZE) {
        const rows = recipients.slice(i, i + INSERT_CHUNK_SIZE).map((r) => ({
            broadcast_id: broadcastId,
            phone: r.phone,
            resolved_message: r.resolvedMessage,
        }))
        const { error: insertError } = await db.from('admin_sms_broadcast_recipients').insert(rows)
        if (insertError) {
            // Don't leave an orphaned parent row behind — the cron treats any
            // non-'done' broadcast with no recent recipient activity as
            // abandoned and will dispatch it, and the admin's retry (after
            // seeing this failure) would then double-send. The `on delete
            // cascade` FK removes any partially-inserted recipient chunks.
            try {
                const { error: deleteError } = await db.from('admin_sms_broadcasts').delete().eq('id', broadcastId)
                if (deleteError) throw deleteError
            } catch (cleanupError) {
                console.error('[createAdminSmsBroadcast] cleanup failed for orphaned broadcast', broadcastId, cleanupError)
            }
            throw insertError
        }
    }

    return { broadcastId, total: recipients.length }
}

export async function getAdminSmsBroadcastStatus(db: any, broadcastId: string): Promise<AdminSmsBroadcastStatus | null> {
    const { data, error } = await db
        .from('admin_sms_broadcasts')
        .select('status, total_recipients, sent_count, failed_count, verified_at')
        .eq('id', broadcastId)
        .maybeSingle()
    if (error) throw error
    if (!data) return null

    const status: AdminSmsBroadcastStatus = {
        status: data.status,
        totalRecipients: data.total_recipients,
        sentCount: data.sent_count,
        failedCount: data.failed_count,
        verified: data.verified_at != null,
    }

    if (status.status === 'done' && status.failedCount > 0) {
        status.failedSamples = await fetchFailedSamples(db, broadcastId)
    }

    return status
}

async function statusFromRow(db: any, row: any): Promise<AdminSmsBroadcastStatus> {
    const status: AdminSmsBroadcastStatus = {
        status: row.status,
        totalRecipients: row.total_recipients,
        sentCount: row.sent_count,
        failedCount: row.failed_count,
        verified: row.verified_at != null,
    }
    if (status.status === 'done' && status.failedCount > 0) {
        status.failedSamples = await fetchFailedSamples(db, row.id)
    }
    return status
}

export async function dispatchAdminSmsBroadcastChunk(
    db: any,
    broadcastId: string,
    sendFn: SendFn = sendSMS,
): Promise<AdminSmsBroadcastStatus | null> {
    const { data: claimed, error: claimError } = await db.rpc('claim_admin_sms_broadcast_recipients', {
        p_broadcast_id: broadcastId,
        p_limit: CLAIM_LIMIT,
    })
    if (claimError) throw claimError

    const rows = (claimed || []) as Array<{ id: string; phone: string; resolved_message: string }>

    let sentDelta = 0
    let failedDelta = 0

    for (let i = 0; i < rows.length; i += SEND_BATCH_SIZE) {
        const batch = rows.slice(i, i + SEND_BATCH_SIZE)
        const results = await Promise.all(
            batch.map((r) => sendFn({ recipient: r.phone, message: r.resolved_message })),
        )

        await Promise.all(
            batch.map(async (r, idx) => {
                const result = results[idx]
                if (result.success) sentDelta++
                else failedDelta++

                const { error: updateError } = await db
                    .from('admin_sms_broadcast_recipients')
                    .update({
                        status: result.success ? 'sent' : 'failed',
                        provider_message_id: result.messageId ?? null,
                        error: result.success ? null : (result.error ?? 'unknown error'),
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', r.id)
                if (updateError) throw updateError
            }),
        )
    }

    // Always runs — even with 0/0 deltas — so a broadcast whose last chunk
    // crashed before finalizing still gets finalized on the next call.
    const { data: incremented, error: incrementError } = await db.rpc('increment_admin_sms_broadcast_counts', {
        p_broadcast_id: broadcastId,
        p_sent_delta: sentDelta,
        p_failed_delta: failedDelta,
    })
    if (incrementError) throw incrementError

    const row = Array.isArray(incremented) ? incremented[0] : incremented
    if (!row || !row.id) return null

    return statusFromRow(db, row)
}

/**
 * Checks KingFlexyGH's outcome for a finished broadcast. A message the supplier
 * accepted at send time can still be rejected by its carrier gateway; those
 * campaigns show up as `failed` in the campaign list. Matching recipients are
 * flipped sent -> failed (never the reverse) and verified_at is stamped.
 *
 * No-op (returns current status) when the broadcast isn't 'done' or is already
 * verified. If the supplier lookup throws, the error propagates and verified_at
 * stays null so a later call (page or cron) retries.
 */
export async function verifyAdminSmsBroadcast(
    db: any,
    broadcastId: string,
    listFn: (opts: { from: Date; to: Date }) => Promise<Set<string>> = listKingFlexyFailedCampaignIds,
): Promise<AdminSmsBroadcastStatus | null> {
    const { data: broadcast, error } = await db
        .from('admin_sms_broadcasts')
        .select('*')
        .eq('id', broadcastId)
        .maybeSingle()
    if (error) throw error
    if (!broadcast) return null
    if (broadcast.status !== 'done' || broadcast.verified_at) return statusFromRow(db, broadcast)

    const from = new Date(new Date(broadcast.created_at).getTime() - 60_000)
    const to = new Date(new Date(broadcast.completed_at ?? Date.now()).getTime() + 5 * 60_000)
    const failedCampaignIds = await listFn({ from, to })

    const sentCampaignIds: string[] = []
    for (let offset = 0; ; offset += 1000) {
        const { data, error: recError } = await db
            .from('admin_sms_broadcast_recipients')
            .select('provider_message_id')
            .eq('broadcast_id', broadcastId)
            .eq('status', 'sent')
            .not('provider_message_id', 'is', null)
            .order('id')
            .range(offset, offset + 999)
        if (recError) throw recError
        const page = (data as Array<{ provider_message_id: string }>) || []
        for (const r of page) sentCampaignIds.push(r.provider_message_id)
        if (page.length < 1000) break
    }

    const rejected = sentCampaignIds.filter((id) => failedCampaignIds.has(id))
    const { data: marked, error: markError } = await db.rpc('mark_admin_sms_broadcast_rejected', {
        p_broadcast_id: broadcastId,
        p_campaign_ids: rejected,
    })
    if (markError) throw markError

    const row = Array.isArray(marked) ? marked[0] : marked
    if (!row || !row.id) return null
    return statusFromRow(db, row)
}

/**
 * Requeues every failed recipient (supplier-rejected or send-time failures)
 * and reopens the broadcast; the normal dispatch loop then resends them.
 * Returns null for an unknown broadcast.
 */
export async function retryFailedAdminSmsBroadcast(
    db: any,
    broadcastId: string,
): Promise<{ requeued: number; status: AdminSmsBroadcastStatus } | null> {
    const { data, error } = await db.rpc('retry_failed_admin_sms_broadcast_recipients', { p_broadcast_id: broadcastId })
    if (error) throw error
    // An unknown id yields a broadcast object whose fields are all null.
    if (!data?.broadcast?.id) return null
    return { requeued: data.requeued as number, status: await statusFromRow(db, data.broadcast) }
}

export type AdminSmsBroadcastSummary = {
    id: string
    messagePreview: string
    status: 'queued' | 'sending' | 'done'
    verified: boolean
    totalRecipients: number
    sentCount: number
    failedCount: number
    createdAt: string
}

export async function listRecentAdminSmsBroadcasts(db: any, limit = 10): Promise<AdminSmsBroadcastSummary[]> {
    const { data, error } = await db
        .from('admin_sms_broadcasts')
        .select('id, message, status, verified_at, total_recipients, sent_count, failed_count, created_at')
        .order('created_at', { ascending: false })
        .limit(limit)
    if (error) throw error
    return ((data as any[]) || []).map((b) => ({
        id: b.id,
        messagePreview: String(b.message).slice(0, 60),
        status: b.status,
        verified: b.verified_at != null,
        totalRecipients: b.total_recipients,
        sentCount: b.sent_count,
        failedCount: b.failed_count,
        createdAt: b.created_at,
    }))
}
