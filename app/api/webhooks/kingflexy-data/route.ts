import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature } from '@/lib/kingflexy-data-service'
import {
    applyKingflexyOutcome,
    kingflexyReferenceExists,
    decideWebhookStatus,
} from '@/lib/kingflexy-apply-outcome'

export const dynamic = 'force-dynamic'

const LOG = '[KingflexyDataWebhook]'

/**
 * KingFlexyGH data-supplier webhook. HMAC-SHA256 of the RAW body in X-KFT-Signature. Fails closed
 * (503) if the secret is unset. Never logs the secret, signature header or body.
 */
export async function POST(request: NextRequest) {
    const secret = process.env.KINGFLEXY_DATA_WEBHOOK_SECRET || ''
    if (!secret) {
        console.error(LOG, 'Rejected: KINGFLEXY_DATA_WEBHOOK_SECRET not configured')
        return NextResponse.json({ success: false, error: 'Webhook not configured' }, { status: 503 })
    }

    // Raw bytes first: the HMAC is over the exact body.
    const raw = await request.text()
    if (!verifyWebhookSignature(raw, request.headers.get('x-kft-signature'), secret)) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    let payload: any
    try {
        payload = JSON.parse(raw)
    } catch {
        return NextResponse.json({ success: false, error: 'Invalid payload' }, { status: 400 })
    }

    if (!payload || typeof payload !== 'object' || payload.event === 'webhook.test' || payload.product !== 'data') {
        return NextResponse.json({ success: true }, { status: 200 })
    }

    const reference = payload.reference
    if (typeof reference !== 'string' || reference.length === 0) {
        console.warn(LOG, 'Payload has no usable reference')
        return NextResponse.json({ success: true }, { status: 200 })
    }

    try {
        const supabase: any = createServerClient()
        const { applied } = await applyKingflexyOutcome(supabase, {
            reference,
            rawStatus: payload.status,
            source: 'webhook',
        })

        if (applied === 0) {
            const referenceKnown = await kingflexyReferenceExists(supabase, reference)
            const code = decideWebhookStatus({ applied, referenceKnown, timestamp: payload.timestamp, nowMs: Date.now() })
            if (code === 500) {
                console.warn(LOG, 'Event beat the reference write; asking for redelivery')
                return NextResponse.json({ success: false, error: 'Order not yet recorded' }, { status: 500 })
            }
        }
        return NextResponse.json({ success: true, updated_orders: applied }, { status: 200 })
    } catch (error: any) {
        // The cron sweep is the safety net for anything we fail to apply here.
        console.error(LOG, 'Unhandled exception:', error?.message || error)
        return NextResponse.json({ success: true }, { status: 200 })
    }
}
