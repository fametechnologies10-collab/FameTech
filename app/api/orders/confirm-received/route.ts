import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { confirmOrderReceived, ConfirmReceivedOutcome } from '@/lib/order-complete-service'
import { isUuid } from '@/lib/refunds'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

/**
 * POST /api/orders/confirm-received
 * The buyer confirms their OWN order, or a shop owner confirms a customer's
 * order placed through their storefront/USSD shop. Ownership AND eligibility
 * (status must be exactly 'processing') are both re-verified inside
 * claim_self_order_complete — this route never trusts client input for
 * either check; it only forwards orderId + the authenticated actor's id.
 * Body: { orderId: uuid }
 */

// Deliberate, exhaustive mapping — mirrors app/api/orders/retry/route.ts's
// statusForOutcome pattern. No fallthrough: unmapped outcomes are 500.
function statusForOutcome(outcome: ConfirmReceivedOutcome): number {
    switch (outcome) {
        case 'order_not_found':
            return 404
        case 'not_owner':
            return 403
        case 'not_eligible':
            return 400
        case 'already_completed':
        case 'ok':
            return 200
        case 'error':
        default:
            return 500
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
        if (authError || !authUser) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const rl = consumeRateLimit(`order-confirm-received:${authUser.id}`, 10, 60_000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many requests, slow down.' }, { status: 429 })
        }

        const body = await request.json().catch(() => ({}))
        const orderId = body?.orderId
        if (!isUuid(orderId)) {
            return NextResponse.json({ success: false, error: 'A valid orderId is required' }, { status: 400 })
        }

        const admin = createServerClient()
        const result = await confirmOrderReceived(admin, { orderId, actorId: authUser.id })

        if (result.ok) {
            return NextResponse.json({
                success: true,
                data: { outcome: result.outcome, role: result.role, message: result.message },
            })
        }

        return NextResponse.json(
            {
                success: false,
                error: result.message,
                outcome: result.outcome,
                ...(result.currentStatus !== undefined && { currentStatus: result.currentStatus }),
            },
            { status: statusForOutcome(result.outcome) }
        )
    } catch (e: any) {
        console.error('[ConfirmReceived] error:', e?.message || e)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
