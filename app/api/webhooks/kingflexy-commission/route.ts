import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import {
    verifyKingFlexySignature,
    decideKfWebhookAction,
    baseReferenceFromKey,
    isStaleAirtimeReference,
    checkUtilityOrderStatus,
} from '@/lib/kingflexy-commission-service'
import { finalizeKfAirtime, finalizeKfUtility } from '@/lib/kingflexy-finalize'
import { decideBundleWebhook } from '@/lib/standard-bundles-logic'
import { checkBundleOrder } from '@/lib/kingflexy-bundles-service'
import { finalizeBundle } from '@/lib/standard-bundles-finalize'

export const dynamic = 'force-dynamic'

const LOG = '[KingFlexyWebhook]'

export async function POST(request: NextRequest) {
    const secret = process.env.KINGFLEXY_COMMISSION_WEBHOOK_SECRET || ''
    if (!secret) {
        console.error(LOG, 'Rejected: KINGFLEXY_COMMISSION_WEBHOOK_SECRET not configured')
        return NextResponse.json({ success: false, error: 'Webhook not configured' }, { status: 503 })
    }

    // The HMAC is over the exact raw bytes, so read text first and only parse after verifying.
    const raw = await request.text()
    if (!verifyKingFlexySignature(raw, request.headers.get('x-kft-signature'), secret)) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    let payload: any
    try { payload = JSON.parse(raw) } catch {
        return NextResponse.json({ success: false, error: 'Invalid payload' }, { status: 400 })
    }

    // Standard Bundles share this endpoint; branch before the airtime/utility decision.
    if (payload?.product === 'bundles') {
        const bd = decideBundleWebhook(payload)
        if (bd.action === 'ignore' || !bd.reference) {
            return NextResponse.json({ success: true }, { status: 200 })
        }
        try {
            const supabase = createServerClient()
            const { data: bundleOrder, error: bundleLookupError } = await (supabase as any).from('standard_bundle_orders')
                .select('id, reference_code, user_id, network, kind, bundle_label, beneficiary_phone, total_paid, status, fulfillment_metadata')
                .eq('reference_code', bd.reference).maybeSingle()
            if (bundleLookupError) {
                console.error(LOG, 'Bundle order lookup failed:', bundleLookupError.message, 'reference:', bd.reference)
                return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
            }
            if (!bundleOrder) return NextResponse.json({ success: true }, { status: 200 })

            if (bd.action === 'completed') {
                let commission: number | null | undefined
                try {
                    const chk = await checkBundleOrder(bd.reference)
                    commission = chk.commission
                } catch { /* best-effort */ }
                await finalizeBundle(supabase, bundleOrder, {
                    state: 'completed', commission, raw: payload, previouslyRefunded: bd.previouslyRefunded,
                })
            } else {
                const failReason = typeof payload?.detail?.reason === 'string' ? payload.detail.reason : undefined
                await finalizeBundle(supabase, bundleOrder, {
                    state: 'failed', reason: failReason, raw: payload, previouslyRefunded: bd.previouslyRefunded,
                })
            }
            return NextResponse.json({ success: true }, { status: 200 })
        } catch (error: any) {
            console.error(LOG, 'Bundle unhandled:', error?.message || error, 'reference:', bd.reference)
            return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
        }
    }

    const decision = decideKfWebhookAction(payload)
    if (decision.action === 'ignore' || !decision.product || !decision.reference) {
        return NextResponse.json({ success: true }, { status: 200 })
    }
    const { product, reference } = decision
    const state = decision.action
    const reason = typeof payload?.detail?.reason === 'string' ? payload.detail.reason : undefined

    try {
        const supabase = createServerClient()

        if (product === 'airtime') {
            const { data: order, error: lookupError } = await (supabase.from('airtime_orders') as any)
                .select('id, reference_code, network, airtime_amount, user_id, source, api_key_id, fulfillment_metadata')
                .eq('reference_code', baseReferenceFromKey(reference)).maybeSingle()
            if (lookupError) {
                console.error(LOG, 'Order lookup failed:', lookupError.message, 'product:', product, 'reference:', reference)
                return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
            }
            if (!order) return NextResponse.json({ success: true }, { status: 200 })
            if (isStaleAirtimeReference(order, reference)) {
                console.warn(LOG, 'Ignoring event for superseded attempt, product:', product, 'reference:', reference)
                return NextResponse.json({ success: true }, { status: 200 })
            }

            await finalizeKfAirtime(supabase, order, { state, reason, raw: payload })
            return NextResponse.json({ success: true }, { status: 200 })
        }

        const { data: order, error: lookupError } = await (supabase.from('utility_orders') as any)
            .select('id, reference_code, biller, account_number, amount, user_id, shop_id, source, api_key_id, destination_phone, fulfillment_metadata')
            .eq('fulfillment_request_id', reference).maybeSingle()
        if (lookupError) {
            console.error(LOG, 'Order lookup failed:', lookupError.message, 'product:', product, 'reference:', reference)
            return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
        }
        if (!order) {
            // The provider may call before we have persisted its reference; it retries once and the reconcile cron is the fallback.
            return NextResponse.json({ success: false, error: 'order not found yet' }, { status: 503 })
        }

        let commissionEarned: number | null | undefined
        if (state === 'completed') {
            try {
                const status = await checkUtilityOrderStatus(reference)
                commissionEarned = status.commissionEarned
            } catch { /* best-effort; reconcile can backfill */ }
        }

        await finalizeKfUtility(supabase, order, { state, commissionEarned, reason, raw: payload })
        return NextResponse.json({ success: true }, { status: 200 })
    } catch (error: any) {
        console.error(LOG, 'Unhandled:', error?.message || error, 'product:', product, 'reference:', reference)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
