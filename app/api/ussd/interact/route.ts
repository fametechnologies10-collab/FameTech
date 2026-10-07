import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAllowedHubtelIP } from '@/lib/ussd/ip-guard'
import { hasValidUssdCallbackSecret } from '@/lib/ussd/callback-auth'
import { decodeState } from '@/lib/ussd/utils'
import { saveInterruptedSession, logSessionStep } from '@/lib/ussd/session'
import { handleMainMenu, isStorefrontMode } from '@/lib/ussd/handlers/main-menu'
import { findUserByMobile } from '@/lib/ussd/price-resolver'
import { getAdminSetting } from '@/lib/admin-settings-cache'
import type { HubtelRequest, USSDState } from '@/lib/ussd/types'

// =============================================================================
// POST /api/ussd/interact — Hubtel Service Interaction URL
// Receives every USSD request and returns the appropriate menu or action.
// =============================================================================

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
)

export async function POST(request: NextRequest): Promise<NextResponse> {
    // ── IP Guard ───────────────────────────────────────────────────────────────
    if (!isAllowedHubtelIP(request)) {
        console.warn('[USSD Interact] Rejected request from non-Hubtel IP')
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // ── Optional shared-secret second factor (B1) — no-op until env is set ──────
    if (!hasValidUssdCallbackSecret(request)) {
        console.warn('[USSD Interact] Rejected: invalid/missing callback secret')
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // ── Parse body ─────────────────────────────────────────────────────────────
    let body: HubtelRequest
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    // ── Validate required fields ───────────────────────────────────────────────
    if (!body.SessionId || !body.Mobile || !body.Type) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // ── Check master kill switch ───────────────────────────────────────────────
    // EGRESS: every USSD button press is a fresh HTTP request (no client-side
    // session to skip this on), so this was 7,785 req/day on its own — 12% of
    // ALL admin_settings traffic. Cached 60s per lib/admin-settings-cache.ts,
    // same accepted tradeoff already approved for CRITICAL_TOGGLE_KEYS.
    const killSwitchValue = await getAdminSetting('ussd_enabled')

    if (killSwitchValue === 'false') {
        // Storefront mode's guest/registered split already exists for the normal
        // flow (main-menu.ts's showMainMenu) — reuse the same two checks here so
        // an unregistered guest isn't sent to the generic platform site while the
        // shop-code system they'd actually need (shop.fametechgh.com) is right
        // there. No shop is resolved here — there's no code to resolve it FROM
        // yet (the guest hasn't entered anything) and USSD itself is down anyway,
        // so we can only point them at the right *page*, not a specific shop.
        // Registered users, or storefront mode off, keep the original message.
        let isGuest = false
        try {
            if (await isStorefrontMode(supabase)) {
                const user = await findUserByMobile(supabase, body.Mobile)
                isGuest = !user
            }
        } catch (err) {
            console.error('[USSD Interact] Kill-switch guest check failed, falling back to default message:', err)
        }

        const offResponse = {
            SessionId: body.SessionId,
            Type: 'release',
            Message: isGuest
                ? 'Fame Technologies\nUSSD service is temporarily unavailable.\nVisit shop.fametechgh.com and enter your shop\'s 4-digit code to order directly.'
                : 'Fame Technologies\nUSSD service is temporarily unavailable.\nPlease visit fametechgh.com or try again later.',
            Label: 'Service Unavailable',
            DataType: 'display',
            FieldType: 'text',
        }
        return NextResponse.json(offResponse)
    }

    // ── Handle Timeout — save state for session resume ─────────────────────────
    if (body.Type === 'Timeout') {
        const state = decodeState(body.ClientState)
        if (state.step && state.step !== 'main' && state.step !== 'main_choice') {
            await saveInterruptedSession(
                supabase,
                body.SessionId,
                body.Mobile,
                body.Operator,
                state,
            )
        }
        // Timeout requires no response
        return new NextResponse(null, { status: 200 })
    }

    // ── Log session step (non-blocking analytics) ──────────────────────────────
    logSessionStep(supabase, body.SessionId, body.Mobile, body.Operator, body.Platform)
        .catch(err => console.error('[USSD] logSessionStep error:', err))

    // ── Decode current state ───────────────────────────────────────────────────
    const state: USSDState =
        body.Type === 'Initiation'
            ? { step: 'main' }
            : decodeState(body.ClientState)

    // ── Route to handler ───────────────────────────────────────────────────────
    try {
        const response = await handleMainMenu(body, state, supabase)
        return NextResponse.json(response)
    } catch (err) {
        console.error('[USSD Interact] Unhandled error:', err)
        const fallback = {
            SessionId: body.SessionId,
            Type: 'release',
            Message: 'An error occurred. Please dial *713*9939# to try again.',
            Label: 'Error',
            DataType: 'display',
            FieldType: 'text',
        }
        return NextResponse.json(fallback)
    }
}
