import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { messageSchema } from '@/lib/validation'
import { sendPushNotification } from '@/lib/push-service'
import { getCounterpartReceipt } from '@/lib/support-ticks'
import { touchAdminPresence } from '@/lib/admin-presence'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const actionSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('reply'), message: messageSchema }),
    z.object({ action: z.literal('close'), closing_note: messageSchema.optional() }),
    z.object({ action: z.literal('read') }),
])

// GET /api/admin/support/threads/[id] — thread + full message history
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const access = await validateAdminAccess(false, request)
        if (access.error) return NextResponse.json({ success: false, error: access.error }, { status: access.status })
        touchAdminPresence(access.user!.id).catch(() => { })

        const { id } = await params
        if (!UUID_RE.test(id)) {
            return NextResponse.json({ success: false, error: 'Invalid thread' }, { status: 400 })
        }

        const supabase = createServerClient() as any
        const { data: thread, error } = await supabase
            .from('support_threads')
            .select(`
                *,
                users (first_name, last_name, email, phone_number),
                orders (reference_code, network, size, status, price, phone_number, created_at, fulfillment_method, download_batch_id)
            `)
            .eq('id', id)
            .maybeSingle()
        if (error) throw error
        if (!thread) {
            return NextResponse.json({ success: false, error: 'Thread not found' }, { status: 404 })
        }

        const { data: rawMessages, error: msgError } = await supabase
            .from('support_messages')
            .select('*')
            .eq('thread_id', id)
            .order('created_at', { ascending: true })
        if (msgError) throw msgError

        // First admin view of each undelivered user message marks it delivered —
        // the grey double-tick, distinct from the blue "read" tick set below.
        // Single scoped UPDATE (not fetch-then-.in()) so this stays O(1) query
        // cost regardless of how many messages the thread has accumulated.
        const hasUndelivered = (rawMessages || []).some((m: any) => m.sender_role === 'user' && !m.delivered_to_admin_at)
        if (hasUndelivered) {
            const deliveredAt = new Date().toISOString()
            await supabase
                .from('support_messages')
                .update({ delivered_to_admin_at: deliveredAt })
                .eq('thread_id', id)
                .eq('sender_role', 'user')
                .is('delivered_to_admin_at', null)
            for (const m of rawMessages as any[]) {
                if (m.sender_role === 'user' && !m.delivered_to_admin_at) m.delivered_to_admin_at = deliveredAt
            }
        }

        const messages = (rawMessages || []).map((m: any) => ({
            ...m,
            ...getCounterpartReceipt(m.sender_role, m),
        }))

        return NextResponse.json({ success: true, data: { thread, messages } })
    } catch (error) {
        console.error('[Admin Support] Error fetching thread:', error)
        return NextResponse.json({ success: false, error: 'Failed to fetch thread' }, { status: 500 })
    }
}

// POST /api/admin/support/threads/[id] — { action: 'reply' | 'close' | 'read' }
// Everything (recipient, thread state) is derived from the thread row —
// nothing sensitive is trusted from the request body (fixes the B2 class).
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const access = await validateAdminAccess(false, request)
        if (access.error) return NextResponse.json({ success: false, error: access.error }, { status: access.status })
        touchAdminPresence(access.user!.id).catch(() => { })

        const { id } = await params
        if (!UUID_RE.test(id)) {
            return NextResponse.json({ success: false, error: 'Invalid thread' }, { status: 400 })
        }

        const body = await request.json().catch(() => null)
        const validation = actionSchema.safeParse(body)
        if (!validation.success) {
            return NextResponse.json({ success: false, error: 'Invalid input' }, { status: 400 })
        }
        const payload = validation.data

        const supabase = createServerClient() as any
        const { data: thread, error: threadError } = await supabase
            .from('support_threads')
            .select('id, user_id, subject, status')
            .eq('id', id)
            .maybeSingle()
        if (threadError) throw threadError
        if (!thread) {
            return NextResponse.json({ success: false, error: 'Thread not found' }, { status: 404 })
        }

        if (payload.action === 'read') {
            const now = new Date().toISOString()
            const { error } = await supabase
                .from('support_messages')
                .update({ read_by_admin_at: now, delivered_to_admin_at: now })
                .eq('thread_id', id)
                .eq('sender_role', 'user')
                .is('read_by_admin_at', null)
            if (error) throw error
            return NextResponse.json({ success: true })
        }

        if (payload.action === 'reply') {
            if (thread.status !== 'open') {
                return NextResponse.json({ success: false, error: 'Thread is closed' }, { status: 409 })
            }
            const { data: newMessage, error: insertError } = await supabase
                .from('support_messages')
                .insert({
                    thread_id: id,
                    sender_role: 'admin',
                    sender_id: access.user!.id,
                    body: payload.message.trim(),
                })
                .select()
                .single()
            if (insertError) throw insertError

            await notifyUser(supabase, thread.user_id, 'Support replied to your complaint',
                `Our team replied on "${thread.subject}". Open Support & Complaints to view it.`)

            return NextResponse.json({
                success: true,
                data: { message: { ...newMessage, ...getCounterpartReceipt('admin', newMessage) } },
            })
        }

        // action === 'close'
        if (thread.status === 'closed') {
            return NextResponse.json({ success: false, error: 'Thread is already closed' }, { status: 409 })
        }

        if (payload.closing_note?.trim()) {
            const { error: noteError } = await supabase
                .from('support_messages')
                .insert({
                    thread_id: id,
                    sender_role: 'admin',
                    sender_id: access.user!.id,
                    body: payload.closing_note.trim(),
                })
            if (noteError) throw noteError
        }

        // Guard on status='open' so two concurrent closes can't both proceed.
        const { data: closed, error: closeError } = await supabase
            .from('support_threads')
            .update({
                status: 'closed',
                closed_at: new Date().toISOString(),
                closed_by: access.user!.id,
            })
            .eq('id', id)
            .eq('status', 'open')
            .select('id')
        if (closeError) throw closeError
        if (!closed || closed.length === 0) {
            return NextResponse.json({ success: false, error: 'Thread is already closed' }, { status: 409 })
        }

        await notifyUser(supabase, thread.user_id, 'Your complaint was closed',
            `"${thread.subject}" has been closed by our support team. You can open a new complaint anytime.`)

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('[Admin Support] Error updating thread:', error)
        return NextResponse.json({ success: false, error: 'Failed to update thread' }, { status: 500 })
    }
}

async function notifyUser(supabase: any, userId: string, title: string, message: string) {
    try {
        const { error } = await supabase.from('notifications').insert({
            user_id: userId,
            title,
            message,
            type: 'support_reply',
            action_url: '/dashboard/complaints',
        })
        if (error) console.error('[Admin Support] Notification insert failed:', error)
    } catch (e) {
        console.error('[Admin Support] Notification error:', e)
    }

    // Web push to all of the user's devices. Fire-and-forget — a push failure
    // must never fail the admin action. Mutable via the 'support' category.
    try {
        await sendPushNotification(userId, {
            title,
            body: message,
            url: '/dashboard/complaints',
            category: 'support',
        })
    } catch (e) {
        console.error('[Admin Support] Push error:', e)
    }
}
