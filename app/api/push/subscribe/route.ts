import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/push/subscribe
// Receives the browser's PushSubscription object and persists it in the
// `push_subscriptions` table linked to the authenticated user.
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
    try {
        // 1. Authenticate the caller
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // 2. Parse the incoming subscription object
        const body = await req.json()
        const { endpoint, keys } = body

        if (!endpoint || !keys?.p256dh || !keys?.auth) {
            return NextResponse.json(
                { error: 'Invalid subscription object. Missing endpoint or keys.' },
                { status: 400 }
            )
        }

        // 3. Upsert into push_subscriptions using standard authenticated client
        //    (RLS policies now guarantee users can only affect their own records)
        const { error: upsertError } = await (supabase as any)
            .from('push_subscriptions')
            .upsert(
                {
                    user_id: user.id,
                    endpoint,
                    p256dh: keys.p256dh,
                    auth: keys.auth,
                    updated_at: new Date().toISOString(),
                },
                // If the same endpoint already exists for this user, update it
                { onConflict: 'user_id,endpoint' }
            )

        if (upsertError) {
            console.error('[push/subscribe] Upsert error:', upsertError)
            return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 })
        }

        return NextResponse.json({ success: true })

    } catch (err: any) {
        console.error('[push/subscribe] Error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/push/subscribe
// Removes a subscription when the user revokes notification permission.
// ─────────────────────────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await req.json()
        const { endpoint } = body

        if (!endpoint) {
            return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 })
        }

        await (supabase as any)
            .from('push_subscriptions')
            .delete()
            .eq('user_id', user.id)
            .eq('endpoint', endpoint)

        return NextResponse.json({ success: true })

    } catch (err: any) {
        console.error('[push/subscribe] DELETE error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
