import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { buildAnnouncementColumns, deactivateShopAnnouncements, deactivateOverlappingActive } from '@/lib/announcement-write'
import {
    sendAnnouncementPushNotification,
    sendGuestAnnouncementPush,
} from '@/lib/push-service'

// ─── Shared admin guard ───────────────────────────────────────────────────────
async function requireAdmin() {
    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: 'Unauthorized' as const, status: 401 as const, supabase: null, userId: '' }
    const { data: dbUser } = await supabase
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single()
    if (!dbUser || !['admin', 'sub-admin'].includes((dbUser as any).role)) {
        return { error: 'Forbidden' as const, status: 403 as const, supabase: null, userId: '' }
    }
    return { error: null, status: 200 as const, supabase, userId: user.id }
}

// ─── PATCH /api/admin/announcements/[id] — update / toggle / publish / reschedule
export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const auth = await requireAdmin()
        if (auth.error) {
            return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })
        }

        const rl = consumeRateLimit(`announce-write:${auth.userId}`, 20, 60_000)
        if (!rl.allowed) {
            return NextResponse.json(
                { success: false, error: 'Too many requests. Try again shortly.' },
                { status: 429 }
            )
        }

        const { id } = await params
        const supabase = auth.supabase!
        const body = await request.json()
        const action: string = body?.action ?? 'update'

        let updateColumns: Record<string, any> = {}
        let shouldFirePush = false
        let publishedVisibleOn = ''
        let pushPrimaryUrl: string | null = null

        if (action === 'update') {
            // Re-validate & rebuild all columns from scratch.
            const { columns, pushPrimaryUrl: pUrl, error: valError } = buildAnnouncementColumns(body)
            if (valError || !columns) {
                return NextResponse.json({ success: false, error: valError ?? 'Invalid input' }, { status: 400 })
            }
            updateColumns = columns
            pushPrimaryUrl = pUrl
            shouldFirePush = columns.status === 'published' && body?.sendPush !== false
            publishedVisibleOn = columns.visible_on

        } else if (action === 'toggle') {
            // Flip is_active only — no push fired.
            const { data: current, error: fetchErr } = await supabase
                .from('system_announcements')
                .select('is_active')
                .eq('id', id)
                .single()
            if (fetchErr || !current) {
                return NextResponse.json({ success: false, error: 'Announcement not found' }, { status: 404 })
            }
            updateColumns = { is_active: !(current as any).is_active }

        } else if (action === 'publish') {
            // Promote any status → published + active, optionally fire push.
            const { data: current, error: fetchErr } = await supabase
                .from('system_announcements')
                .select('title, message, visible_on, cta_primary_url')
                .eq('id', id)
                .single()
            if (fetchErr || !current) {
                return NextResponse.json({ success: false, error: 'Announcement not found' }, { status: 404 })
            }
            updateColumns = { is_active: true, status: 'published', scheduled_at: null }
            shouldFirePush = body?.sendPush !== false
            publishedVisibleOn = (current as any).visible_on ?? 'main_site'
            pushPrimaryUrl = (current as any).cta_primary_url ?? null

        } else if (action === 'reschedule') {
            const ts = new Date(body?.scheduledAt)
            if (isNaN(ts.getTime()) || ts.getTime() < Date.now()) {
                return NextResponse.json(
                    { success: false, error: 'scheduledAt must be a future date' },
                    { status: 400 }
                )
            }
            updateColumns = { status: 'scheduled', is_active: false, scheduled_at: ts.toISOString() }

        } else {
            return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 })
        }

        const { data: row, error: updateErr } = await supabase
            .from('system_announcements')
            .update(updateColumns)
            .eq('id', id)
            .select()
            .single()

        if (updateErr) throw updateErr
        if (!row) return NextResponse.json({ success: false, error: 'Announcement not found' }, { status: 404 })

        // When the row ends up active + storefront-targeted, deactivate shop-level
        // announcements so the system announcement takes precedence (parity with POST).
        const becameActive = (row as any).is_active === true
        const resultVisibleOn = publishedVisibleOn || (row as any).visible_on || 'main_site'
        // One active announcement per surface (covers toggle-on, publish, update-to-active).
        if (becameActive) {
            await deactivateOverlappingActive(supabase, resultVisibleOn, id)
        }
        if (becameActive && resultVisibleOn !== 'main_site') {
            await deactivateShopAnnouncements(supabase)
        }

        // Fire push when the row ends up published.
        if (shouldFirePush) {
            // For 'update': use columns.title/message; for 'publish': from fetched row stored in body.
            const title: string = (row as any).title ?? ''
            const message: string = (row as any).message ?? ''
            const snippet = message.length > 90 ? message.slice(0, 87) + '…' : message
            const actionUrl = pushPrimaryUrl ?? undefined
            const visibleOn = publishedVisibleOn || (row as any).visible_on || 'main_site'

            if (visibleOn === 'main_site' || visibleOn === 'both') {
                await sendAnnouncementPushNotification({
                    title,
                    body: snippet,
                    sendPush: true,
                    actionUrl,
                }).catch(e => console.error('[announce-patch] Auth push error:', e))
            }

            if (visibleOn === 'storefronts' || visibleOn === 'both') {
                await sendGuestAnnouncementPush({
                    title,
                    body: snippet,
                    actionUrl,
                }).catch(e => console.error('[announce-patch] Guest push error:', e))
            }
        }

        return NextResponse.json({ success: true, data: row })
    } catch (e: any) {
        console.error('[announce-patch]', e)
        return NextResponse.json({ success: false, error: e.message ?? 'Internal error' }, { status: 500 })
    }
}

// ─── DELETE /api/admin/announcements/[id] — hard-delete announcement ──────────
export async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const auth = await requireAdmin()
        if (auth.error) {
            return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })
        }

        // Parity with POST/PATCH: cap delete bursts even for a compromised admin session.
        const rl = consumeRateLimit(`announce-write:${auth.userId}`, 20, 60_000)
        if (!rl.allowed) {
            return NextResponse.json(
                { success: false, error: 'Too many requests. Try again shortly.' },
                { status: 429 }
            )
        }

        const { id } = await params
        const supabase = auth.supabase!

        // .select('id') makes the delete authoritative: 0 rows returned means nothing
        // was deleted (already gone / RLS), so we report that instead of a false success.
        const { data: deleted, error } = await supabase
            .from('system_announcements')
            .delete()
            .eq('id', id)
            .select('id')

        if (error) throw error
        if (!deleted || deleted.length === 0) {
            return NextResponse.json(
                { success: false, error: 'Announcement not found (it may have already been deleted).' },
                { status: 404 }
            )
        }

        return NextResponse.json({ success: true })
    } catch (e: any) {
        console.error('[announce-delete]', e)
        return NextResponse.json({ success: false, error: e.message ?? 'Internal error' }, { status: 500 })
    }
}
