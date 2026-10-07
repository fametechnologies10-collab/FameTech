import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { buildAnnouncementColumns, deactivateShopAnnouncements, deactivateOverlappingActive } from '@/lib/announcement-write'
import {
    sendAnnouncementPushNotification,
    sendGuestAnnouncementPush,
} from '@/lib/push-service'

// ─── POST /api/admin/announcements — create a new announcement ────────────────
export async function POST(request: NextRequest) {
    try {
        // Cookie-aware client so auth.getUser() validates the caller's session JWT.
        const supabase = await createRouteClient()

        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const { data: dbUser } = await supabase
            .from('users')
            .select('role')
            .eq('id', user.id)
            .single()

        if (!dbUser || !['admin', 'sub-admin'].includes((dbUser as any).role)) {
            return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
        }

        // Defence-in-depth: cap blast writes even for a compromised admin account.
        const rl = consumeRateLimit(`announce-write:${user.id}`, 20, 60_000)
        if (!rl.allowed) {
            return NextResponse.json(
                { success: false, error: 'Too many requests. Try again shortly.' },
                { status: 429 }
            )
        }

        const body = await request.json()
        const { columns, pushPrimaryUrl, error: valError } = buildAnnouncementColumns(body)
        if (valError || !columns) {
            return NextResponse.json({ success: false, error: valError ?? 'Invalid input' }, { status: 400 })
        }

        // Insert via the RLS-aware client (user must be admin for write — RLS allows it).
        const { data: row, error: insertError } = await supabase
            .from('system_announcements')
            .insert(columns)
            .select()
            .single()

        if (insertError) throw insertError

        // One active announcement per surface: a newly-published notice deactivates any
        // other active one competing for the same popup (main_site & storefronts are
        // independent; a 'both' supersedes everything).
        if (columns.is_active) {
            await deactivateOverlappingActive(supabase, columns.visible_on, (row as any).id)
        }
        // When publishing to storefronts (not main_site only), deactivate shop-level
        // announcements so the system announcement takes precedence.
        if (columns.is_active && columns.visible_on !== 'main_site') {
            await deactivateShopAnnouncements(supabase)
        }

        // Fire push notifications when publishing immediately and caller hasn't opted out.
        if (columns.status === 'published' && body?.sendPush !== false) {
            const snippet = columns.message.length > 90
                ? columns.message.slice(0, 87) + '…'
                : columns.message
            const actionUrl = pushPrimaryUrl ?? undefined

            if (columns.visible_on === 'main_site' || columns.visible_on === 'both') {
                await sendAnnouncementPushNotification({
                    title: columns.title,
                    body: snippet,
                    sendPush: true,
                    actionUrl,
                }).catch(e => console.error('[announce-post] Auth push error:', e))
            }

            if (columns.visible_on === 'storefronts' || columns.visible_on === 'both') {
                await sendGuestAnnouncementPush({
                    title: columns.title,
                    body: snippet,
                    actionUrl,
                }).catch(e => console.error('[announce-post] Guest push error:', e))
            }
        }

        return NextResponse.json({ success: true, data: row })
    } catch (e: any) {
        console.error('[announce-post]', e)
        return NextResponse.json({ success: false, error: e.message ?? 'Internal error' }, { status: 500 })
    }
}
