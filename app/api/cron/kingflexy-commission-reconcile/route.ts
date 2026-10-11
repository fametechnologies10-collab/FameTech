import { NextRequest, NextResponse } from 'next/server'
import { validateCronAuth } from '@/lib/cron-utils'
import { createServerClient } from '@/lib/supabase'
import { dispatchAirtimeFulfillment } from '@/lib/airtime-fulfillment'
import { dispatchUtilityFulfillment } from '@/lib/utility-fulfillment'
import { checkAirtimeOrderStatus, checkUtilityOrderStatus, type KfStatusResult } from '@/lib/kingflexy-commission-service'
import { finalizeKfAirtime, finalizeKfUtility } from '@/lib/kingflexy-finalize'

const KF = 'kingflexy-commission'
const LOG = '[KingFlexyReconcile]'

// Dispatch returns early without bumping attempts when a row is gated (kill-switch, >100 GHS, mashup,
// unverifiable legacy attempt). Touch such a row so it rotates to the back of the updated_at-ordered
// queue instead of starving newer eligible rows.
async function rotateIfBlocked(supabase: any, table: 'airtime_orders' | 'utility_orders', attemptsCol: string, id: string, attemptsBefore: number | null) {
    try {
        const { data: fresh } = await supabase.from(table).select(`status, ${attemptsCol}`).eq('id', id).maybeSingle()
        if (fresh?.status === 'pending' && (fresh[attemptsCol] ?? 0) === (attemptsBefore ?? 0)) {
            await supabase.from(table).update({ updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending')
        }
    } catch (e) { console.error(LOG, 'rotate failed for', id, e) }
}

function statusCheckNote(r: KfStatusResult) {
    return { state: r.state, http_ok: r.httpOk, found: r.found, error: r.error ?? null, at: new Date().toISOString() }
}

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    const supabase = createServerClient() as any
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString()

    const airtime = { checked: 0, finalized: 0, reverted: 0, dispatched: 0 }
    const utilities = { checked: 0, finalized: 0, reverted: 0, dispatched: 0, commissionBackfilled: 0 }

    // Pass A: processing airtime whose webhook never arrived.
    const { data: stuckAirtime } = await supabase.from('airtime_orders')
        .select('id, reference_code, network, airtime_amount, user_id, source, api_key_id, fulfillment_metadata')
        .eq('fulfillment_service', KF)
        .eq('status', 'processing')
        .lt('updated_at', fiveMinAgo)
        .order('updated_at', { ascending: true })
        .limit(10)

    for (const o of (stuckAirtime || [])) {
        try {
            const key = o.fulfillment_metadata?.client_reference ?? o.reference_code
            if (!key) continue
            const r = await checkAirtimeOrderStatus(key)
            if (!r.configured) break
            airtime.checked++
            if (!r.httpOk) continue

            if (r.state === 'completed' || r.state === 'failed') {
                const res = await finalizeKfAirtime(supabase, o, { state: r.state, reason: r.reason, raw: r.raw })
                if (res.transitioned) airtime.finalized++
            } else if (!r.found) {
                // The POST never landed; a same-key re-dispatch is idempotent.
                const { data: rev } = await supabase.from('airtime_orders')
                    .update({ status: 'pending', updated_at: new Date().toISOString() })
                    .eq('id', o.id).eq('status', 'processing').select('id')
                if (rev?.length) airtime.reverted++
            } else {
                await supabase.from('airtime_orders')
                    .update({ fulfillment_metadata: { ...(o.fulfillment_metadata || {}), status_check: statusCheckNote(r) }, updated_at: new Date().toISOString() })
                    .eq('id', o.id).eq('status', 'processing').select('id')
            }
        } catch (e) { console.error(LOG, 'airtime pass A failed for', o.id, e) }
    }

    // Pass B: pending airtime with attempts left.
    const { data: pendingAirtime } = await supabase.from('airtime_orders')
        .select('id, airtime_fulfillment_attempts')
        .eq('fulfillment_service', KF)
        .eq('status', 'pending')
        .lt('airtime_fulfillment_attempts', 5)
        .order('updated_at', { ascending: true })
        .limit(8)
    for (const o of (pendingAirtime || [])) {
        try { await dispatchAirtimeFulfillment(o.id); airtime.dispatched++ } catch (e) { console.error(LOG, 'airtime dispatch failed for', o.id, e) }
        await rotateIfBlocked(supabase, 'airtime_orders', 'airtime_fulfillment_attempts', o.id, o.airtime_fulfillment_attempts)
    }

    // Pass C: processing utilities whose webhook never arrived.
    const { data: stuckUtil } = await supabase.from('utility_orders')
        .select('id, reference_code, biller, account_number, amount, user_id, shop_id, source, api_key_id, destination_phone, fulfillment_request_id, fulfillment_metadata')
        .eq('fulfillment_service', KF)
        .eq('status', 'processing')
        .lt('updated_at', fiveMinAgo)
        .order('updated_at', { ascending: true })
        .limit(10)

    for (const o of (stuckUtil || [])) {
        try {
            if (!o.fulfillment_request_id) {
                // No provider reference recorded: the same-key re-dispatch recovers it.
                const { data: rev } = await supabase.from('utility_orders')
                    .update({ status: 'pending', updated_at: new Date().toISOString() })
                    .eq('id', o.id).eq('status', 'processing').select('id')
                if (rev?.length) utilities.reverted++
                continue
            }
            const r = await checkUtilityOrderStatus(o.fulfillment_request_id)
            if (!r.configured) break
            utilities.checked++
            if (!r.httpOk) continue

            if (r.state === 'completed' || r.state === 'failed') {
                const res = await finalizeKfUtility(supabase, o, {
                    state: r.state, reason: r.reason, raw: r.raw,
                    ...(r.state === 'completed' ? { commissionEarned: r.commissionEarned } : {}),
                })
                if (res.transitioned) utilities.finalized++
            } else {
                await supabase.from('utility_orders')
                    .update({ fulfillment_metadata: { ...(o.fulfillment_metadata || {}), status_check: statusCheckNote(r) }, updated_at: new Date().toISOString() })
                    .eq('id', o.id).eq('status', 'processing').select('id')
            }
        } catch (e) { console.error(LOG, 'utility pass C failed for', o.id, e) }
    }

    // Pass D: pending PAID utilities (any provider). payment_status='paid' is load-bearing: unpaid
    // storefront checkout rows must never be dispatched.
    const { data: pendingUtil } = await supabase.from('utility_orders')
        .select('id, fulfillment_attempts')
        .eq('status', 'pending')
        .eq('payment_status', 'paid')
        .lt('fulfillment_attempts', 5)
        .order('updated_at', { ascending: true })
        .limit(5)
    for (const o of (pendingUtil || [])) {
        try { await dispatchUtilityFulfillment(o.id); utilities.dispatched++ } catch (e) { console.error(LOG, 'utility dispatch failed for', o.id, e) }
        await rotateIfBlocked(supabase, 'utility_orders', 'fulfillment_attempts', o.id, o.fulfillment_attempts)
    }

    // Pass E1: commission was written but the credit RPC errored (commission_credited_at still NULL).
    // The RPC is idempotent, so just call it again. No status call, so it does not use the check budget.
    const { data: uncredited } = await supabase.from('utility_orders')
        .select('id')
        .eq('fulfillment_service', KF)
        .eq('status', 'completed')
        .not('commission_amount', 'is', null)
        .is('commission_credited_at', null)
        .gte('updated_at', dayAgo)
        .order('updated_at', { ascending: true })
        .limit(20)
    for (const o of (uncredited || [])) {
        try {
            const { error } = await supabase.rpc('credit_utility_commission', { p_utility_order_id: o.id })
            if (error) console.error(LOG, 'credit_utility_commission retry failed:', error.message, 'order:', o.id)
        } catch (e) { console.error(LOG, 'utility pass E retry failed for', o.id, e) }
    }

    // Pass E2: backfill commission on recently completed KingFlexyGH utilities that finished without it.
    const { data: noCommission } = await supabase.from('utility_orders')
        .select('id, fulfillment_request_id')
        .eq('fulfillment_service', KF)
        .eq('status', 'completed')
        .is('commission_amount', null)
        .not('fulfillment_request_id', 'is', null)
        .gte('updated_at', dayAgo)
        .order('updated_at', { ascending: true })
        .limit(5)

    for (const o of (noCommission || [])) {
        try {
            const r = await checkUtilityOrderStatus(o.fulfillment_request_id)
            if (!r.configured) break
            const c = r.commissionEarned
            if (!r.httpOk || typeof c !== 'number' || !Number.isFinite(c) || c <= 0) continue
            const { data: upd } = await supabase.from('utility_orders')
                .update({ commission_amount: c })
                .eq('id', o.id).is('commission_amount', null).select('id')
            if (!upd?.length) continue
            utilities.commissionBackfilled++
            const { error } = await supabase.rpc('credit_utility_commission', { p_utility_order_id: o.id })
            if (error) console.error(LOG, 'credit_utility_commission failed:', error.message, 'order:', o.id)
        } catch (e) { console.error(LOG, 'utility pass E failed for', o.id, e) }
    }

    return NextResponse.json({ success: true, airtime, utilities })
}
