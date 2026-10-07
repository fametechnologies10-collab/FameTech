import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { touchAdminPresence } from '@/lib/admin-presence'

export const dynamic = 'force-dynamic'

// GET /api/admin/support/threads?status=open|closed|all&days=30
// Open threads are ALWAYS returned regardless of the date window — an open
// complaint must never age out of the console (the old 3-day bug, B1/B7).
export async function GET(request: Request) {
    try {
        // Admin-only: support threads carry customer PII (phone/WhatsApp).
        const access = await validateAdminAccess(false, request)
        if (access.error) return NextResponse.json({ success: false, error: access.error }, { status: access.status })
        touchAdminPresence(access.user!.id).catch(() => { })

        const url = new URL(request.url)
        const status = ['open', 'closed', 'all'].includes(url.searchParams.get('status') || '')
            ? (url.searchParams.get('status') as 'open' | 'closed' | 'all')
            : 'all'
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 90)

        const supabase = createServerClient() as any
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

        let query = supabase
            .from('support_threads')
            .select(`
                *,
                users (first_name, last_name, email, phone_number),
                orders (reference_code, network, size, status)
            `)
            .order('last_message_at', { ascending: false })
            .limit(300)

        if (status === 'open') {
            query = query.eq('status', 'open')
        } else if (status === 'closed') {
            query = query.eq('status', 'closed').gte('last_message_at', since)
        } else {
            // all: closed threads respect the window, open ones always included
            query = query.or(`status.eq.open,last_message_at.gte.${since}`)
        }

        const { data: threads, error } = await query
        if (error) throw error

        // Attach last-message preview + admin-unread count in one query.
        const ids = (threads || []).map((t: any) => t.id)
        const previews: Record<string, { body: string; sender_role: string; created_at: string }> = {}
        const unread: Record<string, number> = {}
        if (ids.length > 0) {
            // Newest-first with a safety ceiling — previews/unread counts only
            // need recent traffic; without a cap this materialises every message
            // ever sent in view. First row seen per thread = latest message.
            const { data: messages, error: msgError } = await supabase
                .from('support_messages')
                .select('thread_id, body, sender_role, created_at, read_by_admin_at')
                .in('thread_id', ids)
                .order('created_at', { ascending: false })
                .limit(3000)
            if (msgError) throw msgError
            for (const m of messages || []) {
                if (!previews[m.thread_id]) {
                    previews[m.thread_id] = { body: m.body, sender_role: m.sender_role, created_at: m.created_at }
                }
                if (m.sender_role === 'user' && !m.read_by_admin_at) {
                    unread[m.thread_id] = (unread[m.thread_id] || 0) + 1
                }
            }
        }

        const data = (threads || []).map((t: any) => ({
            ...t,
            last_message: previews[t.id] ?? null,
            unread_count: unread[t.id] ?? 0,
        }))

        return NextResponse.json({ success: true, data })
    } catch (error) {
        console.error('[Admin Support] Error listing threads:', error)
        return NextResponse.json({ success: false, error: 'Failed to fetch support threads' }, { status: 500 })
    }
}
