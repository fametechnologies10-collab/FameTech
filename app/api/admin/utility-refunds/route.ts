import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// Admin utility refund queue — mirrors app/api/admin/ussd-refunds/route.ts's shape:
// GET lists pending rows; POST resolves one by recording the manual MoMo payout
// the team already sent out-of-band. No automated payout call exists — see
// lib/utility-fulfillment.ts's isWalletRefundEligible doc comment.

async function requireAdmin() {
    const supabaseUserClient = await createRouteClient()
    const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
    if (error || !authUser) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
    const supabase = createServerClient()
    const { data: adminUser } = await (supabase.from('users') as any).select('role').eq('id', authUser.id).single()
    const role = adminUser?.role
    if (role !== 'admin' && role !== 'sub-admin') {
        return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
    }
    return { authUser, role }
}

export async function GET() {
    const auth = await requireAdmin()
    if (auth.error) return auth.error

    const supabase = createServerClient() as any
    const { data, error } = await supabase
        .from('utility_refund_queue')
        .select('id, utility_order_id, source, biller, amount, momo_number, shop_id, reason, status, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(500)

    if (error) {
        console.error('[Utility Refunds] list failed:', error)
        return NextResponse.json({ success: false, error: 'Failed to load refund queue' }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: data ?? [] })
}

export async function POST(request: NextRequest) {
    const auth = await requireAdmin()
    if (auth.error) return auth.error
    // Refunds move money — admin only, mirrors the PATCH /api/admin/utilities refund restriction.
    if (auth.role !== 'admin') {
        return NextResponse.json({ success: false, error: 'Forbidden — refunds are admin only' }, { status: 403 })
    }

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid body' }, { status: 400 }) }
    const id: string | undefined = body?.id
    if (!id || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
        return NextResponse.json({ success: false, error: 'Invalid id' }, { status: 400 })
    }

    const supabase = createServerClient() as any

    const { data: row, error: rowError } = await supabase
        .from('utility_refund_queue').select('*').eq('id', id).maybeSingle()
    if (rowError) return NextResponse.json({ success: false, error: 'Lookup failed' }, { status: 500 })
    if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    if (row.status !== 'pending') {
        return NextResponse.json({ success: false, error: 'Already resolved', status: row.status }, { status: 409 })
    }

    // Win the lock atomically so a double-click can't resolve twice.
    const { data: locked, error: lockErr } = await supabase
        .from('utility_refund_queue')
        .update({ status: 'refunded', refunded_by: auth.authUser!.id, refunded_at: new Date().toISOString(), refund_reference: `UTIL-REFUND-${row.utility_order_id}` })
        .eq('id', id).eq('status', 'pending')
        .select('id').maybeSingle()
    if (lockErr || !locked) return NextResponse.json({ success: false, error: 'Already resolved' }, { status: 409 })

    // Also mark the underlying order refunded — the queue is the source of
    // truth for "did the team pay this out," but the order row must reflect
    // it too (Orders tab status filter, order history, etc.). Guard against
    // clobbering a status that raced to 'completed' (e.g. a successful
    // refulfill) between our read and this write — mirrors the
    // .neq('status', 'completed') pattern used elsewhere in
    // lib/utility-fulfillment.ts's manualStatusSyncUtility.
    const { error: orderUpdateError } = await supabase.from('utility_orders')
        .update({ status: 'refunded', payment_status: 'refunded', updated_at: new Date().toISOString() })
        .eq('id', row.utility_order_id)
        .neq('status', 'completed')
    if (orderUpdateError) {
        console.error('[Utility Refunds] failed to mark order refunded (queue row already resolved):', orderUpdateError, 'order:', row.utility_order_id)
    }

    // SMS — ONLY for shop-attributed GUEST orders via ussd_shop AND no
    // user_id. Storefront is deliberately excluded here even though it can
    // also be a shop-attributed guest order: its momo_number is the
    // destination_phone captured at checkout, which is not reliably the
    // actual payer's MoMo number (see the reason note manualRefundUtility
    // attaches to storefront queue rows in lib/utility-fulfillment.ts) —
    // an SMS claiming "sent to your MoMo number" cannot be substantiated
    // for this source. A registered user who checked out through their own
    // shop's ussd_shop flow still lands in this queue, per RULING in the
    // ledger, but must not get the SMS either. Dashboard/API/registered-user
    // non-shop orders never reach this queue at all (Task 2's wallet path).
    if (row.source === 'ussd_shop' && !row.user_id && row.momo_number) {
        try {
            const { sendUtilityRefundSMS } = await import('@/lib/utility-fulfillment')
            await sendUtilityRefundSMS(row.momo_number, row.biller, row.amount)
        } catch (e) {
            console.error('[Utility Refunds] SMS dispatch failed (non-fatal):', e)
        }
    }

    return NextResponse.json({ success: true })
}
