import { NextRequest, NextResponse } from 'next/server'
import { validateCronAuth } from '@/lib/cron-utils'
import { createServerClient } from '@/lib/supabase'
import { dispatchAirtimeFulfillment } from '@/lib/airtime-fulfillment'
import { dispatchUtilityFulfillment } from '@/lib/utility-fulfillment'
import { checkAirtimeOrderStatus, checkUtilityOrderStatus, type KfStatusResult } from '@/lib/kingflexy-commission-service'
import { finalizeKfAirtime, finalizeKfUtility } from '@/lib/kingflexy-finalize'
import { checkBundleOrder } from '@/lib/kingflexy-bundles-service'
import { finalizeBundle } from '@/lib/standard-bundles-finalize'
import { dispatchBundleFulfillment } from '@/lib/standard-bundles-fulfillment'

export const maxDuration = 60

const KF = 'kingflexy-commission'
const LOG = '[KingFlexyReconcile]'

// Dispatch returns early without bumping attempts when a row is gated (kill-switch, >100 GHS, mashup,
// unverifiable legacy attempt). Touch such a row so it rotates to the back of the updated_at-ordered
// queue instead of starving newer eligible rows.
async function rotateIfBlocked(supabase: any, table: 'airtime_orders' | 'utility_orders' | 'standard_bundle_orders', attemptsCol: string, id: string, attemptsBefore: number | null) {
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
    const bundles = { checked: 0, finalized: 0, reverted: 0, dispatched: 0, refundRetried: 0, exhaustedChecked: 0 }
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
            } else if (!r.found) {
                const { data: rev } = await supabase.from('utility_orders')
                    .update({ status: 'pending', fulfillment_request_id: null, updated_at: new Date().toISOString() })
                    .eq('id', o.id).eq('status', 'processing').select('id')
                if (rev?.length) utilities.reverted++
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

    const BUNDLE_COLS = 'id, reference_code, user_id, network, kind, bundle_label, beneficiary_phone, total_paid, status, fulfillment_metadata'

    // Pass F: processing bundle orders whose webhook never arrived.
    try {
        const { data: stuckBundles, error: fErr } = await supabase.from('standard_bundle_orders')
            .select(BUNDLE_COLS)
            .eq('status', 'processing')
            .lt('updated_at', fiveMinAgo)
            .order('updated_at', { ascending: true })
            .limit(10)
        if (fErr) console.error(LOG, 'bundle pass F query failed:', fErr.message)
        for (const o of (stuckBundles || [])) {
            try {
                const r = await checkBundleOrder(o.reference_code)
                if (!r.configured) break
                bundles.checked++
                if (!r.httpOk) continue

                if (r.state === 'completed' || r.state === 'failed') {
                    const res = await finalizeBundle(supabase, o, {
                        state: r.state, reason: r.reason, raw: r.raw,
                        ...(r.state === 'completed' ? { commission: r.commission } : {}),
                    })
                    if (res.transitioned) bundles.finalized++
                } else if (!r.found) {
                    // The POST never landed; a same-reference re-dispatch is idempotent.
                    const { data: rev, error: revErr } = await supabase.from('standard_bundle_orders')
                        .update({ status: 'pending', updated_at: new Date().toISOString() })
                        .eq('id', o.id).eq('status', 'processing').select('id')
                    if (revErr) console.error(LOG, 'bundle revert failed:', revErr.message, 'order:', o.id)
                    if (rev?.length) bundles.reverted++
                } else {
                    const { error: noteErr } = await supabase.from('standard_bundle_orders')
                        .update({ fulfillment_metadata: { ...(o.fulfillment_metadata || {}), status_check: { state: r.state, http_ok: r.httpOk, found: r.found, at: new Date().toISOString() } }, updated_at: new Date().toISOString() })
                        .eq('id', o.id).eq('status', 'processing').select('id')
                    if (noteErr) console.error(LOG, 'bundle status note failed:', noteErr.message, 'order:', o.id)
                }
            } catch (e) { console.error(LOG, 'bundle pass F failed for', o.id, e) }
        }
    } catch (e) { console.error(LOG, 'bundle pass F failed', e) }

    // Pass G: pending bundle orders with attempts left.
    try {
        const { data: pendingBundles, error: gErr } = await supabase.from('standard_bundle_orders')
            .select('id, fulfillment_attempts')
            .eq('status', 'pending')
            .lt('fulfillment_attempts', 5)
            .order('updated_at', { ascending: true })
            .limit(5)
        if (gErr) console.error(LOG, 'bundle pass G query failed:', gErr.message)
        for (const o of (pendingBundles || [])) {
            try { await dispatchBundleFulfillment(o.id); bundles.dispatched++ } catch (e) { console.error(LOG, 'bundle dispatch failed for', o.id, e) }
            await rotateIfBlocked(supabase, 'standard_bundle_orders', 'fulfillment_attempts', o.id, o.fulfillment_attempts)
        }
    } catch (e) { console.error(LOG, 'bundle pass G failed', e) }

    // Pass H: refund backstop. A 'failed' order whose refund RPC errored stays 'failed'; finalizeBundle
    // on an already-failed order re-runs the idempotent refund. The 7-day window skips ancient rows.
    try {
        const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString()
        const { data: failedBundles, error: hErr } = await supabase.from('standard_bundle_orders')
            .select(BUNDLE_COLS)
            .eq('status', 'failed')
            .lt('updated_at', tenMinAgo)
            .gt('created_at', sevenDaysAgo)
            .order('updated_at', { ascending: true })
            .limit(10)
        if (hErr) console.error(LOG, 'bundle pass H query failed:', hErr.message)
        for (const o of (failedBundles || [])) {
            try {
                const res = await finalizeBundle(supabase, o, { state: 'failed', reason: 'refund backstop' })
                if (res.transitioned) bundles.refundRetried++
            } catch (e) { console.error(LOG, 'bundle pass H failed for', o.id, e) }
        }
    } catch (e) { console.error(LOG, 'bundle pass H failed', e) }

    // Pass I: exhausted pending orders (attempts >= 5). Only a definitive terminal state from the
    // provider moves them; pending/processing/unknown/404 are NEVER auto-refunded.
    try {
        const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString()
        const { data: exhausted, error: iErr } = await supabase.from('standard_bundle_orders')
            .select(BUNDLE_COLS)
            .eq('status', 'pending')
            .gte('fulfillment_attempts', 5)
            .lt('updated_at', fifteenMinAgo)
            .order('updated_at', { ascending: true })
            .limit(5)
        if (iErr) console.error(LOG, 'bundle pass I query failed:', iErr.message)
        for (const o of (exhausted || [])) {
            try {
                const r = await checkBundleOrder(o.reference_code)
                if (!r.configured) break
                bundles.exhaustedChecked++
                if (!r.httpOk) continue
                if (r.state === 'completed' || r.state === 'failed') {
                    const res = await finalizeBundle(supabase, o, {
                        state: r.state, reason: r.reason, raw: r.raw,
                        ...(r.state === 'completed' ? { commission: r.commission } : {}),
                    })
                    if (res.transitioned) bundles.finalized++
                }
            } catch (e) { console.error(LOG, 'bundle pass I failed for', o.id, e) }
        }
    } catch (e) { console.error(LOG, 'bundle pass I failed', e) }

    return NextResponse.json({ success: true, airtime, utilities, bundles })
}
