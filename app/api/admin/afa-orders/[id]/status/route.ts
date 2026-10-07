import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { logAdminAction } from '@/lib/admin-audit'

// ============================================================================
// PATCH /api/admin/afa-orders/[id]/status
//
// Closes a Phase 3 finding recorded during the API v2 build (SDD ledger, Task 7):
// admin AFA status changes previously happened CLIENT-SIDE from the admin
// browser (app/admin/afa-management/page.tsx, direct supabase-js .update()),
// with RLS as the only authorization and NO server-side audit trail. This
// route replaces that write path with a real API route: admin-gated the same
// way every other admin route in this codebase is gated, validated against an
// allowlist, and logged to admin_audit_log via lib/admin-audit.ts.
//
// This ALSO becomes the webhook hook point Task 7 documented as absent — the
// dashboard route (app/api/user/afa-registration) has no analogous update
// site because AFA orders are never updated by user-facing code. Wiring an
// actual webhook dispatch here is deliberately NOT done in this task: the
// spec's data-order webhook work (R1) taught this codebase that a hook must
// be an intentional design decision (event naming, payload shape, retry
// posture), not a byproduct of an unrelated route rewrite. Left as a clearly
// labelled follow-up.
//
// NOTE: AFA orders do NOT always have a user_id. Dashboard/USSD/v2-API orders
// are placed by authenticated users and do, but storefront orders (shop_id
// set) are placed by guests and have user_id NULL — those fall back to the
// shop owner (via shop_profiles.owner_id) for the audit's target_user_id, and
// get their markup credited to the shop wallet on completion.
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Matches the AfarOrder['status'] union in app/admin/afa-management/page.tsx
// and the afa_orders table's actual status values — not re-derived, copied.
const VALID_STATUSES = ['pending', 'processing', 'completed', 'cancelled', 'refunded'] as const
type AfaStatus = (typeof VALID_STATUSES)[number]

async function verifyAdmin(supabaseUserClient: any) {
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    const role = (user as any)?.role
    if (!['admin', 'sub-admin'].includes(role)) return null
    return { userId: authUser.id, role }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params
        if (!UUID_RE.test(id)) {
            return NextResponse.json({ success: false, error: 'Invalid application id' }, { status: 400 })
        }

        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        let body: any
        try { body = await request.json() } catch {
            return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
        }

        const nextStatus = body?.status
        if (typeof nextStatus !== 'string' || !(VALID_STATUSES as readonly string[]).includes(nextStatus)) {
            return NextResponse.json(
                { success: false, error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
                { status: 400 }
            )
        }

        // 'refunded' is a legitimate EXISTING status (kept in VALID_STATUSES so
        // the previousStatus==='refunded' guard below can recognize it), but it
        // must never be reachable as the TARGET of a plain status PATCH — that
        // would set afa_orders.status = 'refunded' without any of the real
        // refund route's work (wallet credit, Paystack/wallet reversal,
        // refund_method/refunded_at population), and the guard above would then
        // permanently lock the fabricated state from correction through this
        // same route. Checked before any DB read/write.
        if (nextStatus === 'refunded') {
            return NextResponse.json(
                { success: false, error: 'Use POST /api/admin/afa-orders/[id]/refund to refund an order — this endpoint cannot set that status directly.' },
                { status: 400 }
            )
        }

        const supabase = createServerClient()

        // Read the current row FIRST — needed for the old/new audit pair and to
        // resolve the applicant's user_id for the audit's target_user_id (which
        // is NOT NULL on admin_audit_log). Storefront AFA orders are placed by
        // guests and have user_id NULL — for those we fall back to the shop
        // owner (via shop_id) below, the same pattern the shop-order/momo-details
        // route uses for guest orders.
        const { data: existing, error: fetchError } = await (supabase.from('afa_orders') as any)
            .select('id, user_id, status, shop_id')
            .eq('id', id)
            .maybeSingle()

        if (fetchError || !existing) {
            return NextResponse.json({ success: false, error: 'Application not found' }, { status: 404 })
        }

        const previousStatus = existing.status as AfaStatus

        // A refunded order is terminal: the refund route already credited the
        // owner's cost-share and deliberately left profit untouched. Any status
        // change from here — including 'cancelled' — would reach the unrelated
        // reverse_shop_afa_profit RPC below, which has no awareness of
        // afa_orders.status and would debit profit the owner is entitled to
        // keep. Read fresh off `existing` (fetched just above, same request) so
        // a concurrent second request also sees the true current row rather
        // than a stale snapshot — this is what closes the race, not just the
        // single-click case.
        if (previousStatus === 'refunded') {
            return NextResponse.json(
                { success: false, error: 'Cannot change the status of a refunded order' },
                { status: 400 }
            )
        }

        // Service-role client bypasses RLS, so .eq('id', id) plus the .select()
        // below (which fails closed on zero rows) IS the correctness check —
        // there is no RLS layer left to silently swallow a bad write the way
        // the old client-side .update() could.
        const { data: updated, error: updateError } = await (supabase.from('afa_orders') as any)
            .update({ status: nextStatus, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select('id, user_id, status, shop_id')
            .maybeSingle()

        if (updateError || !updated) {
            console.error('[Admin AFA Status] Update failed:', updateError)
            return NextResponse.json({ success: false, error: 'Failed to update status' }, { status: 500 })
        }

        // Storefront AFA order reaching 'completed' → credit the shop owner's markup.
        // Profit normally credits at PAYMENT time now (lib/shop-afa-order-processor.ts),
        // like every other product. This call is retained as an idempotent backstop —
        // it also covers any order created before that change (there was at least one
        // live 'pending' order still uncredited). The RPC is idempotent (locks the
        // wallet row before its idempotency check and is backstopped by a unique
        // index), so an admin re-clicking 'completed' or a retried request credits
        // exactly once.
        if (updated.shop_id && nextStatus === 'completed') {
            const { data: creditResult, error: creditError } = await (supabase as any).rpc('credit_shop_afa_profit', {
                p_afa_order_id: updated.id,
            })
            if (creditError || creditResult?.success === false) {
                // Non-fatal: the status change already succeeded and is the admin's
                // primary intent. Surfaced loudly so a missed credit is diagnosable
                // rather than silent — the RPC can be re-run safely for this order.
                console.error(
                    '[Admin AFA Status] Profit credit failed for order', id,
                    creditError ?? creditResult?.message
                )
                // Durable record — a console log alone is invisible to the owner and
                // to anyone not tailing Vercel logs at the right moment. Never include
                // KYC (legal name, Ghana Card number, DOB) in `detail`.
                const { error: auditError } = await (supabase as any).from('security_events').insert({
                    event_type: 'afa_profit_credit_failed',
                    reference: updated.id,
                    shop_id: updated.shop_id,
                    order_type: 'afa',
                    detail: {
                        order_id: updated.id,
                        rpc_message: creditError?.message ?? creditResult?.message ?? null,
                    },
                })
                if (auditError) {
                    console.error('[Admin AFA Status] security_events insert failed:', auditError)
                }
            }
        }

        // Storefront AFA order moving INTO 'cancelled' → reverse the credited markup.
        // Guarded on previousStatus !== 'cancelled' so re-saving an already-cancelled
        // order can't double-reverse — the RPC's own idempotency covers this too, but
        // the guard means we don't rely on that alone.
        if (updated.shop_id && nextStatus === 'cancelled' && previousStatus !== 'cancelled') {
            const { data: reverseResult, error: reverseError } = await (supabase as any).rpc('reverse_shop_afa_profit', {
                p_afa_order_id: updated.id,
            })
            if (reverseError || reverseResult?.success === false) {
                // Non-fatal: the status change already succeeded and is the admin's
                // primary intent. Surfaced loudly so a missed reversal is diagnosable
                // rather than silent — the RPC can be re-run safely for this order.
                console.error(
                    '[Admin AFA Status] Profit reversal failed for order', id,
                    reverseError ?? reverseResult?.message
                )
                // Durable record — never include KYC in `detail`.
                const { error: auditError } = await (supabase as any).from('security_events').insert({
                    event_type: 'afa_profit_reversal_failed',
                    reference: updated.id,
                    shop_id: updated.shop_id,
                    order_type: 'afa',
                    detail: {
                        order_id: updated.id,
                        rpc_message: reverseError?.message ?? reverseResult?.message ?? null,
                    },
                })
                if (auditError) {
                    console.error('[Admin AFA Status] security_events insert failed:', auditError)
                }
            }
        }

        // Storefront orders are placed by guests (user_id NULL), but
        // admin_audit_log.target_user_id is NOT NULL — fall back to the shop owner so
        // the action is still attributable. Without this the audit write is rejected
        // and, because supabase-js returns rather than throws, it vanished silently.
        let auditTargetUserId: string | null = existing.user_id
        if (!auditTargetUserId && updated.shop_id) {
            const { data: shopOwnerRow } = await (supabase.from('shop_profiles') as any)
                .select('owner_id')
                .eq('id', updated.shop_id)
                .maybeSingle()
            auditTargetUserId = shopOwnerRow?.owner_id ?? null
        }

        // Fire-and-forget audit trail — never blocks the response, and fires
        // even when previousStatus === nextStatus (an admin re-clicking the
        // same status is still an auditable action, not a no-op worth hiding).
        if (auditTargetUserId) {
            logAdminAction(supabase, {
                adminId: admin.userId,
                action: 'afa_status_change',
                targetUserId: auditTargetUserId,
                oldValue: { order_id: id, status: previousStatus },
                newValue: { order_id: id, status: nextStatus },
            })
        } else {
            console.error('[Admin AFA Status] No audit target for order', id, '- audit skipped')
        }

        return NextResponse.json({ success: true, data: { id: updated.id, status: updated.status } })
    } catch (error) {
        console.error('[Admin AFA Status] Unexpected error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
