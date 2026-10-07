import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

export const dynamic = 'force-dynamic'

const MAX_LABEL_LEN = 30
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * /api/utilities/saved — "My Accounts" (saved billers) for the dashboard.
 *
 * ALL methods use the ROUTE client — owner-scoped RLS (usa_owner_all) is the authorization
 * boundary here, not a service-role client with manual filtering. Every query still adds an
 * explicit `.eq('user_id', user.id)` as defense-in-depth, matching project convention.
 */

async function authenticateAndRateLimit() {
    const supabase = await createRouteClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
        return { supabase, user: null, errorResponse: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
    }
    // Shared rate limit across GET/DELETE/PATCH — this is a light, non-money surface.
    const rl = consumeRateLimit(`util-saved:${user.id}`, 30, 60_000)
    if (!rl.allowed) {
        return {
            supabase, user, errorResponse: NextResponse.json(
                { success: false, error: 'Too many requests. Try again shortly.' }, { status: 429 },
            ),
        }
    }
    return { supabase, user, errorResponse: null }
}

export async function GET() {
    try {
        const { supabase, user, errorResponse } = await authenticateAndRateLimit()
        if (errorResponse) return errorResponse

        const { data, error } = await (supabase.from('utility_saved_accounts') as any)
            .select('*')
            .eq('user_id', user!.id)
            .order('last_paid_at', { ascending: false, nullsFirst: false })
            .limit(50)

        if (error) {
            console.error('[Utilities Saved] GET error:', error)
            return NextResponse.json({ success: false, error: 'Failed to load saved accounts' }, { status: 500 })
        }

        return NextResponse.json({ success: true, data: { accounts: data || [] } })
    } catch (error) {
        console.error('[Utilities Saved] Unexpected GET error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const { supabase, user, errorResponse } = await authenticateAndRateLimit()
        if (errorResponse) return errorResponse

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
        }
        const { id } = body || {}
        if (typeof id !== 'string' || !UUID_RE.test(id)) {
            return NextResponse.json({ success: false, error: 'Invalid id' }, { status: 400 })
        }

        const { error } = await (supabase.from('utility_saved_accounts') as any)
            .delete()
            .eq('id', id)
            .eq('user_id', user!.id)

        if (error) {
            console.error('[Utilities Saved] DELETE error:', error)
            return NextResponse.json({ success: false, error: 'Failed to delete saved account' }, { status: 500 })
        }

        // Idempotent — success even when no row matched (already gone).
        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('[Utilities Saved] Unexpected DELETE error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const { supabase, user, errorResponse } = await authenticateAndRateLimit()
        if (errorResponse) return errorResponse

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
        }
        const { id, label } = body || {}
        if (typeof id !== 'string' || !UUID_RE.test(id)) {
            return NextResponse.json({ success: false, error: 'Invalid id' }, { status: 400 })
        }
        if (typeof label !== 'string') {
            return NextResponse.json({ success: false, error: 'Invalid label' }, { status: 400 })
        }
        // Empty string clears the label back to null.
        const trimmedLabel = label.trim().slice(0, MAX_LABEL_LEN) || null

        const { data, error } = await (supabase.from('utility_saved_accounts') as any)
            .update({ label: trimmedLabel })
            .eq('id', id)
            .eq('user_id', user!.id)
            .select('id')

        if (error) {
            console.error('[Utilities Saved] PATCH error:', error)
            return NextResponse.json({ success: false, error: 'Failed to update label' }, { status: 500 })
        }
        if (!data || data.length === 0) {
            return NextResponse.json({ success: false, error: 'Saved account not found' }, { status: 404 })
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('[Utilities Saved] Unexpected PATCH error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
