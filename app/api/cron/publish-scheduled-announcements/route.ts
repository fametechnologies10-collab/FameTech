import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateCronAuth } from '@/lib/cron-utils'
import { resolveCtas } from '@/lib/announcement-cta'
import { deactivateOverlappingActive } from '@/lib/announcement-write'
import {
    sendAnnouncementPushNotification,
    sendGuestAnnouncementPush,
} from '@/lib/push-service'

// ─── GET /api/cron/publish-scheduled-announcements ────────────────────────────
// Publishes any scheduled announcement whose time has arrived, then fires its
// push (with the primary-CTA deep-link). Cron-secret guarded; service-role.
export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    const supabase = createServerClient()

    try {
        const nowIso = new Date().toISOString()

        // Due = scheduled AND scheduled_at has passed.
        const { data: due, error: fetchErr } = await (supabase
            .from('system_announcements') as any)
            .select('id, title, message, visible_on, cta_primary_label, cta_primary_url')
            .eq('status', 'scheduled')
            .lte('scheduled_at', nowIso)

        if (fetchErr) throw fetchErr
        if (!due || due.length === 0) {
            return NextResponse.json({ success: true, published: 0 })
        }

        let published = 0
        for (const row of due) {
            // Flip to published + active. scheduled_at kept as an audit trail.
            const { data: claimed, error: updErr } = await (supabase
                .from('system_announcements') as any)
                .update({ is_active: true, status: 'published' })
                .eq('id', row.id)
                .eq('status', 'scheduled') // idempotent guard against double-publish
                .select('id')

            if (updErr) {
                console.error('[cron publish-scheduled] update failed for', row.id, updErr)
                continue
            }
            // A concurrent tick may have already flipped this row; 0 rows claimed -> skip push
            // so we never re-send the same announcement to every subscriber + guest.
            if (!claimed || claimed.length === 0) continue
            published++

            // One active per surface: this now-published row supersedes overlapping actives.
            await deactivateOverlappingActive(supabase, row.visible_on ?? 'main_site', row.id)

            const message: string = row.message ?? ''
            const snippet = message.length > 90 ? message.slice(0, 87) + '…' : message
            const actionUrl = resolveCtas(row).primary?.url ?? undefined
            const visibleOn: string = row.visible_on ?? 'main_site'

            if (visibleOn === 'main_site' || visibleOn === 'both') {
                await sendAnnouncementPushNotification({
                    title: row.title,
                    body: snippet,
                    sendPush: true,
                    actionUrl,
                }).catch(e => console.error('[cron publish-scheduled] auth push:', e))
            }
            if (visibleOn === 'storefronts' || visibleOn === 'both') {
                await sendGuestAnnouncementPush({
                    title: row.title,
                    body: snippet,
                    actionUrl,
                }).catch(e => console.error('[cron publish-scheduled] guest push:', e))
            }
        }

        console.log(`[cron publish-scheduled] published ${published}/${due.length} scheduled announcements`)
        return NextResponse.json({ success: true, published })
    } catch (error: any) {
        console.error('[cron publish-scheduled] error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
