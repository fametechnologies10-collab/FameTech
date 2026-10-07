import { NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { createThreadSchema } from '@/lib/support-validation'
import { checkThreadCreateLimit } from '@/lib/support-rate-limit'
import { sendAdminNewComplaintAlert } from '@/lib/email-service'
import { sendAdminPushNotification, sendPushNotification } from '@/lib/push-service'

export const dynamic = 'force-dynamic'

// POST /api/support/threads — open a new support thread (+ first message)
export async function POST(request: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json().catch(() => null)
        const validation = createThreadSchema.safeParse(body)
        if (!validation.success) {
            const details = validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
            return NextResponse.json({ success: false, error: 'Invalid input', details }, { status: 400 })
        }
        const { subject, category, message, phone_number, whatsapp_number, order_id } = validation.data

        // Server-side rate limit is authoritative (client cooldowns are UX only).
        if (!(await checkThreadCreateLimit(user.id))) {
            return NextResponse.json(
                { success: false, error: 'Too many new complaints. Please wait a while before opening another.' },
                { status: 429 }
            )
        }

        // Optional order link — must belong to the caller (RLS client double-checks).
        if (order_id) {
            const { data: ownedOrder } = await supabase
                .from('orders')
                .select('id')
                .eq('id', order_id)
                .eq('user_id', user.id)
                .maybeSingle()
            if (!ownedOrder) {
                return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 })
            }
        }

        // Writes go through the service-role client (tables are read-only to
        // authenticated); validation + ownership are established above.
        const adminDb = createServerClient() as any

        const { data: thread, error: threadError } = await adminDb
            .from('support_threads')
            .insert({
                user_id: user.id,
                order_id: order_id ?? null,
                subject: subject.trim(),
                category,
                phone_number,
                whatsapp_number,
                status: 'open',
            })
            .select()
            .single()

        if (threadError) {
            // Raised by the DB trigger — per-user open-thread cap (race-safe).
            if (String(threadError.message).includes('OPEN_THREAD_LIMIT')) {
                return NextResponse.json(
                    { success: false, error: 'You already have 3 open complaints. Please wait for a response or close one first.' },
                    { status: 409 }
                )
            }
            throw threadError
        }

        const { data: firstMessage, error: messageError } = await adminDb
            .from('support_messages')
            .insert({
                thread_id: thread.id,
                sender_role: 'user',
                sender_id: user.id,
                body: message.trim(),
            })
            .select()
            .single()

        if (messageError) {
            // Don't leave an empty thread behind.
            await adminDb.from('support_threads').delete().eq('id', thread.id)
            throw messageError
        }

        // Admin email + push alerts — run after the response via waitUntil so
        // the user isn't kept waiting, while serverless teardown can't kill them.
        waitUntil((async () => {
            try {
                const { data: userData } = await adminDb
                    .from('users')
                    .select('email, first_name, last_name')
                    .eq('id', user.id)
                    .single()
                const userName = `${userData?.first_name || ''} ${userData?.last_name || ''}`.trim() || 'User'
                await sendAdminNewComplaintAlert({
                    userEmail: userData?.email || 'unknown',
                    userName,
                    orderRef: order_id ? `Linked order ${order_id}` : 'General inquiry',
                    title: subject.trim(),
                    description: message.trim(),
                    priority: category,
                })
                // Push admins on NEW threads only — user replies surface via the
                // unread badge instead, so admin devices aren't flooded.
                // Deliberately NO category: complaint alerts are un-mutable for
                // admins (adding one would let a muted category suppress them).
                await sendAdminPushNotification({
                    title: 'New complaint',
                    body: `${userName}: ${subject.trim()}`,
                    url: '/admin/complaints',
                })
            } catch (alertError) {
                console.error('[Support] Failed to send admin alert:', alertError)
            }

            // Confirm receipt to the user too — always an in-app notification
            // (works with zero setup), push only as a bonus if they've already
            // opted in. Never block or require push permission for this.
            try {
                await adminDb.from('notifications').insert({
                    user_id: user.id,
                    title: 'We received your complaint',
                    message: `"${subject.trim()}" has been logged. Our team will reply here soon.`,
                    type: 'support_reply',
                    action_url: '/dashboard/complaints',
                })
            } catch (notifyError) {
                console.error('[Support] Failed to insert user confirmation notification:', notifyError)
            }
            try {
                await sendPushNotification(user.id, {
                    title: 'We received your complaint',
                    body: `"${subject.trim()}" has been logged. We'll reply here soon.`,
                    url: '/dashboard/complaints',
                    category: 'support',
                })
            } catch (pushError) {
                console.error('[Support] User confirmation push error:', pushError)
            }
        })())

        return NextResponse.json({ success: true, data: { thread, message: firstMessage } })
    } catch (error: any) {
        console.error('[Support] Error creating thread:', error)
        return NextResponse.json({ success: false, error: 'Failed to open complaint' }, { status: 500 })
    }
}
