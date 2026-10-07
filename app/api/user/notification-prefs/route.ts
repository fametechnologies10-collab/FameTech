import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { CATEGORY_ORDER } from '@/lib/notification-categories'

// GET — return the caller's own notification preferences.
export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }
        const rl = consumeRateLimit(`user-notif-prefs-get:${user.id}`, 60, 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many requests. Try again shortly.' }, { status: 429 })
        }
        const { data, error } = await (supabase as any)
            .from('users')
            .select('notification_prefs, order_success_sms_enabled')
            .eq('id', user.id)
            .maybeSingle()
        if (error) {
            console.error('[NotificationPrefs] GET DB error:', error)
            return NextResponse.json({ success: false, error: 'Failed to load preferences' }, { status: 500 })
        }
        return NextResponse.json({
            success: true,
            notification_prefs: data?.notification_prefs ?? {},
            order_success_sms_enabled: data?.order_success_sms_enabled !== false,
        })
    } catch (err) {
        console.error('[NotificationPrefs] GET error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// POST — toggle the caller's own order-success SMS preference. Applies to both
// single and bulk data purchases. The update is scoped to the authenticated
// user's own row (id), so the service-role client can never touch another
// account (no IDOR).
export async function POST(request: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const rl = consumeRateLimit(`user-notif-prefs:${user.id}`, 20, 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many requests. Try again shortly.' }, { status: 429 })
        }

        const body = await request.json().catch(() => ({}))

        // ── Branch A: per-category push mutes ────────────────────────────────
        if (Array.isArray((body as any).mutedCategories)) {
            const incoming = (body as any).mutedCategories as unknown[]
            const valid = new Set<string>(CATEGORY_ORDER)
            const muted: Record<string, boolean> = {}
            for (const c of incoming) {
                if (typeof c === 'string' && valid.has(c)) muted[c] = true
            }
            // Use the RLS-aware client: the "Users can update own profile"
            // policy (auth.uid() = id) enforces IDOR protection at the DB level,
            // not just via the .eq() filter.
            const { data: rowA, error: errA } = await (supabase as any)
                .from('users')
                .update({ notification_prefs: { muted }, updated_at: new Date().toISOString() })
                .eq('id', user.id)
                .select('id')
                .maybeSingle()
            if (errA) {
                console.error('[NotificationPrefs] mutes DB error:', errA)
                return NextResponse.json({ success: false, error: 'Failed to update preferences' }, { status: 500 })
            }
            if (!rowA) {
                return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
            }
            return NextResponse.json({ success: true, muted: Object.keys(muted) })
        }

        // ── Branch B: order-success SMS toggle (unchanged) ───────────────────
        const { enabled } = body as { enabled?: unknown }
        if (typeof enabled !== 'boolean') {
            return NextResponse.json({ success: false, error: 'enabled must be a boolean' }, { status: 400 })
        }

        const admin = createServerClient() as any
        const { data, error } = await admin
            .from('users')
            .update({ order_success_sms_enabled: enabled, updated_at: new Date().toISOString() })
            .eq('id', user.id)
            .select('id')
            .maybeSingle()

        if (error) {
            console.error('[NotificationPrefs] DB error:', error)
            return NextResponse.json({ success: false, error: 'Failed to update preference' }, { status: 500 })
        }
        if (!data) {
            return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
        }

        return NextResponse.json({ success: true, order_success_sms_enabled: enabled })
    } catch (err) {
        console.error('[NotificationPrefs] Error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
