import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { messageSchema } from '@/lib/validation'
import { checkMessageSendLimit } from '@/lib/support-rate-limit'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /api/support/threads/[id]/messages — user reply on their own open thread
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params
        if (!UUID_RE.test(id)) {
            return NextResponse.json({ success: false, error: 'Invalid thread' }, { status: 400 })
        }

        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json().catch(() => null)
        const validation = messageSchema.safeParse(body?.message)
        if (!validation.success) {
            return NextResponse.json(
                { success: false, error: validation.error.errors[0]?.message || 'Invalid message' },
                { status: 400 }
            )
        }

        if (!(await checkMessageSendLimit(user.id))) {
            return NextResponse.json(
                { success: false, error: 'You are sending messages too fast. Please slow down.' },
                { status: 429 }
            )
        }

        // RLS-scoped read — returns the thread only if the caller owns it.
        const { data: thread } = await supabase
            .from('support_threads')
            .select('id, user_id, status')
            .eq('id', id)
            .maybeSingle()

        if (!thread || (thread as any).user_id !== user.id) {
            return NextResponse.json({ success: false, error: 'Complaint not found' }, { status: 404 })
        }
        if ((thread as any).status !== 'open') {
            return NextResponse.json(
                { success: false, error: 'This complaint is closed. Please open a new one.' },
                { status: 409 }
            )
        }

        const adminDb = createServerClient() as any
        const { data: newMessage, error: insertError } = await adminDb
            .from('support_messages')
            .insert({
                thread_id: id,
                sender_role: 'user',
                sender_id: user.id,
                body: validation.data.trim(),
            })
            .select()
            .single()

        if (insertError) throw insertError

        return NextResponse.json({ success: true, data: { message: newMessage } })
    } catch (error: any) {
        console.error('[Support] Error sending message:', error)
        return NextResponse.json({ success: false, error: 'Failed to send message' }, { status: 500 })
    }
}
