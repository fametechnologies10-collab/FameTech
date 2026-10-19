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

const INSERT_CHUNK_SIZE = 1000
const CLAIM_LIMIT = 10
const SEND_BATCH_SIZE = 5

export type AdminSmsBroadcastStatus = {
    status: 'queued' | 'sending' | 'done'
    totalRecipients: number
    sentCount: number
    failedCount: number
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
        if (insertError) throw insertError
    }

    return { broadcastId, total: recipients.length }
}

export async function getAdminSmsBroadcastStatus(db: any, broadcastId: string): Promise<AdminSmsBroadcastStatus | null> {
    const { data, error } = await db
        .from('admin_sms_broadcasts')
        .select('status, total_recipients, sent_count, failed_count')
        .eq('id', broadcastId)
        .maybeSingle()
    if (error) throw error
    if (!data) return null

    const status: AdminSmsBroadcastStatus = {
        status: data.status,
        totalRecipients: data.total_recipients,
        sentCount: data.sent_count,
        failedCount: data.failed_count,
    }

    if (status.status === 'done' && status.failedCount > 0) {
        status.failedSamples = await fetchFailedSamples(db, broadcastId)
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

    const status: AdminSmsBroadcastStatus = {
        status: row.status,
        totalRecipients: row.total_recipients,
        sentCount: row.sent_count,
        failedCount: row.failed_count,
    }

    if (status.status === 'done' && status.failedCount > 0) {
        status.failedSamples = await fetchFailedSamples(db, broadcastId)
    }

    return status
}
