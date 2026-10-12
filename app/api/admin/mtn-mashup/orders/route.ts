import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { MASHUP_CATEGORY } from '@/lib/mashup'
import { sendAdminPushNotification } from '@/lib/push-service'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

const ALLOWED_STATUS = ['pending', 'processing', 'completed', 'failed'] as const
type Status = typeof ALLOWED_STATUS[number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function requireAdmin() {
    const supabase = await createRouteClient()
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    if ((user as any)?.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
    return { ok: true as const }
}

export async function GET(request: NextRequest) {
    const auth = await requireAdmin()
    if (auth.error) return auth.error
    const status = new URL(request.url).searchParams.get('status')
    if (status && status !== 'All' && !ALLOWED_STATUS.includes(status as Status)) {
        return NextResponse.json({ error: 'Invalid status filter' }, { status: 400 })
    }
    let query = (supabaseAdmin
        .from('orders')
        .select('id, created_at, phone_number, network, size, price, status, payment_status, reference_code, fulfillment_note, user_id, users(first_name,last_name,phone_number)')
        .eq('category', MASHUP_CATEGORY) as any)
        .order('created_at', { ascending: false })
        .limit(200)
    if (status && status !== 'All') query = query.eq('status', status)
    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
}

type ProcessResult = { ok: boolean; refunded?: boolean; error?: string }

/**
 * Update ONE mashup order's status. For 'failed', performs the ATOMIC refund-once through the
 * refund_mashup_order RPC (order row locked FOR UPDATE; status flip, wallet credit and ledger row
 * commit together), so the wallet is credited at most once even if this runs repeatedly or
 * concurrently (single or bulk path).
 *
 * Previously the route flipped the order to refunded FIRST and credited the wallet SECOND in a
 * separate call. When the credit failed the order was already marked refunded, so a retry hit the
 * "already refunded" branch, reported success, and the customer was never paid back.
 *
 * Always scoped to category='mtn_mashup' — never touches a non-mashup order.
 */
async function processOrderStatus(orderId: string, status: Status, note: string | null): Promise<ProcessResult> {
    const now = new Date().toISOString()

    if (status === 'failed') {
        const { data: refund, error: refundErr } = await (supabaseAdmin as any).rpc('refund_mashup_order', {
            p_order_id: orderId,
            p_note: note,
        })
        if (refundErr) {
            console.error(`[Mashup] CRITICAL: refund RPC failed for order ${orderId}:`, refundErr)
            return { ok: false, error: 'Refund failed — nothing was changed, safe to retry' }
        }
        if (!refund?.ok) {
            if (refund?.error === 'order_not_found') return { ok: false, error: 'Order not found' }
            return { ok: false, error: 'Order is not in a refundable state' }
        }
        // Already refunded earlier (the RPC only re-stamped the note) — nothing more to do.
        if (refund.already_refunded) return { ok: true, refunded: false }

        // The buyer is refunded and the ledger row written (inside the RPC). The remaining steps are
        // follow-ups on a refund that has ALREADY committed, so none of them may fail the request.

        // If this was a SUB-agent's wallet-mode mashup purchase, the upline Lead was credited their
        // margin at buy time (credit_lead_margin, keyed by reference_code). A refund must reverse that
        // credit or the Lead keeps money on a voided sale (wallet pump). reverse_lead_margin is
        // idempotent and a no-op for non-sub orders (no matching credit row).
        const { error: revErr } = await (supabaseAdmin as any).rpc('reverse_lead_margin', {
            p_order_reference: refund.reference_code,
        })
        if (revErr) {
            console.error(`[Mashup] CRITICAL: lead-margin reversal failed for order ${orderId} (ref ${refund.reference_code}):`, revErr)
            // Page admins so the Lead over-credit is reconciled manually rather than lost silently.
            await sendAdminPushNotification({
                title: 'Mashup refund: Lead-margin reversal failed',
                body: `Order ${orderId} (ref ${refund.reference_code}) refunded to buyer, but reversing the upline Lead's margin failed — reconcile manually.`,
                url: '/admin/mtn-mashup',
            }).catch(e => console.error('[Mashup] reversal-alert push error:', e))
        }

        const { error: notifErr } = await (supabaseAdmin.from('notifications') as any).insert({
            user_id: refund.user_id,
            title: 'Order Refunded',
            message: `Your Special MTN Mashup order could not be completed and has been refunded to your wallet.`,
            type: 'order_update',
            action_url: '/dashboard/my-orders',
        })
        if (notifErr) console.error('[Mashup] Refund notification error:', notifErr.message)
        return { ok: true, refunded: true }
    }

    // Non-failed transitions: plain status update, but only on a PAID order that has not already
    // been failed/refunded. Without these filters an admin could reopen a refunded order as
    // 'completed' (customer keeps the refund AND a "delivered" order) or complete an unpaid one.
    const { data, error } = await (supabaseAdmin.from('orders') as any)
        .update({ status, fulfillment_note: note, updated_at: now })
        .eq('id', orderId)
        .eq('category', MASHUP_CATEGORY)
        .eq('payment_status', 'paid')
        .in('status', ['pending', 'processing', 'completed'])
        .select('id, status')
        .maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (!data) {
        const { data: existing } = await (supabaseAdmin.from('orders') as any)
            .select('status, payment_status')
            .eq('id', orderId)
            .eq('category', MASHUP_CATEGORY)
            .maybeSingle()
        if (!existing) return { ok: false, error: 'Order not found' }
        return { ok: false, error: `Order cannot be set to ${status} (status: ${existing.status}, payment: ${existing.payment_status})` }
    }
    return { ok: true, refunded: false }
}

export async function PATCH(request: NextRequest) {
    const auth = await requireAdmin()
    if (auth.error) return auth.error

    const body = await request.json().catch(() => null)
    const status: Status | undefined = body?.status
    // Cap note length to 500 chars to prevent unbounded input.
    const rawNote = typeof body?.note === 'string' ? body.note : null
    const note: string | null = rawNote ? rawNote.slice(0, 500) : null

    // Accept EITHER a single `orderId` (back-compat) OR a bulk `orderIds` array.
    const rawIds: unknown[] = Array.isArray(body?.orderIds)
        ? body.orderIds
        : (body?.orderId ? [body.orderId] : [])
    // Deduplicate so a repeated id can't be processed (or counted) twice.
    const ids = [...new Set(rawIds.filter((x): x is string => typeof x === 'string'))]

    if (ids.length === 0) return NextResponse.json({ error: 'orderId or orderIds is required' }, { status: 400 })
    if (ids.length > 200) return NextResponse.json({ error: 'Too many orders (max 200)' }, { status: 400 })
    // Validate every id is a UUID to prevent injection / unexpected DB behaviour.
    if (!ids.every(id => UUID_RE.test(id))) return NextResponse.json({ error: 'Invalid orderId' }, { status: 400 })
    if (!status || !ALLOWED_STATUS.includes(status)) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }

    let updated = 0
    let refundedCount = 0
    const errors: string[] = []
    for (const id of ids) {
        try {
            const res = await processOrderStatus(id, status, note)
            if (res.ok) {
                updated++
                if (res.refunded) refundedCount++
            } else {
                errors.push(`${id}: ${res.error}`)
            }
        } catch (e: any) {
            errors.push(`${id}: ${e?.message || 'error'}`)
        }
    }

    // Single-order path keeps its original response shape for existing callers.
    if (rawIds.length === 1 && !Array.isArray(body?.orderIds)) {
        if (errors.length) return NextResponse.json({ error: errors[0] }, { status: 500 })
        return NextResponse.json({ success: true, refunded: refundedCount > 0, order: { id: ids[0], status } })
    }

    // Keep the full error list in server logs; only the first 20 go in the response.
    if (errors.length > 20) console.error('[Mashup] Bulk PATCH errors (truncated in response):', errors)
    return NextResponse.json({
        success: errors.length === 0,
        updated,
        refunded: refundedCount,
        failed: errors.length,
        errors: errors.slice(0, 20),
    })
}
