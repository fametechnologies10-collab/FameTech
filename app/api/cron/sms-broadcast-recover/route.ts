/**
 * GET /api/cron/sms-broadcast-recover — admin SMS broadcast safety net.
 * Schedule: every N minutes on cron-job.org (Authorization: Bearer CRON_SECRET).
 *
 * The normal path for an admin SMS broadcast is the admin's browser
 * repeatedly calling POST /api/admin/sms-broadcast/[id]/dispatch while the
 * broadcast page stays open. If the admin closes the tab (or it crashes)
 * mid-send, nothing else drives that broadcast forward. This cron finds
 * broadcasts that aren't 'done' and have had no recipient activity in the
 * last 5 minutes (admin_sms_broadcast_recipients.updated_at is touched on
 * every claim and every terminal write — see Task 1's migration and
 * lib/admin-sms-broadcast.ts), and finishes them by repeatedly calling
 * dispatchAdminSmsBroadcastChunk, the same chunking function the admin UI
 * drives, until each is 'done' or the time budget runs out.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateCronAuth } from '@/lib/cron-utils'
import { dispatchAdminSmsBroadcastChunk } from '@/lib/admin-sms-broadcast'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    const db = createServerClient() as any
    const startedAt = Date.now()
    const results: Array<{ id: string; status: string }> = []

    try {
        // Broadcasts with any recipient activity in the last 5 minutes are
        // still being actively driven (by the admin UI or a prior cron tick
        // still in flight) — leave them alone.
        const { data: active, error: activeError } = await db
            .from('admin_sms_broadcast_recipients')
            .select('broadcast_id')
            .gt('updated_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())

        if (activeError) {
            console.error('[SMSBroadcastRecover] active lookup failed:', activeError.message)
            return NextResponse.json({ success: false, error: 'active lookup failed' }, { status: 500 })
        }

        const activeIds = Array.from(new Set(((active as Array<{ broadcast_id: string }>) || []).map((r) => r.broadcast_id)))

        let query = db
            .from('admin_sms_broadcasts')
            .select('id')
            .neq('status', 'done')

        if (activeIds.length > 0) {
            query = query.not('id', 'in', `(${activeIds.join(',')})`)
        }

        const { data: abandoned, error: abandonedError } = await query

        if (abandonedError) {
            console.error('[SMSBroadcastRecover] abandoned lookup failed:', abandonedError.message)
            return NextResponse.json({ success: false, error: 'abandoned lookup failed' }, { status: 500 })
        }

        for (const broadcast of (abandoned as Array<{ id: string }>) || []) {
            // Isolate each broadcast's dispatch loop — a transient failure on
            // one (e.g. a dropped DB connection) must not abort the whole
            // tick and block recovery of every OTHER abandoned broadcast.
            try {
                let status: Awaited<ReturnType<typeof dispatchAdminSmsBroadcastChunk>> = null

                while (Date.now() - startedAt < 45_000) {
                    status = await dispatchAdminSmsBroadcastChunk(db, broadcast.id)
                    if (!status || status.status === 'done') break
                }

                results.push({ id: broadcast.id, status: status?.status ?? 'unknown' })
            } catch (e: any) {
                console.error('[SMSBroadcastRecover] dispatch failed for broadcast', broadcast.id, e?.message)
                results.push({ id: broadcast.id, status: 'error' })
            }

            if (Date.now() - startedAt > 45_000) break
        }

        return NextResponse.json({ success: true, data: { processed: results.length, results } })
    } catch (e: any) {
        console.error('[SMSBroadcastRecover] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
