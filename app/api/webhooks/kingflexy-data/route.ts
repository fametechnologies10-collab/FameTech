import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature } from '@/lib/kingflexy-data-service'
import { handleKingflexyWebhookPayload } from '@/lib/kingflexy-apply-outcome'

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

    const supabase: any = createServerClient()
    const { status, applied } = await handleKingflexyWebhookPayload(supabase, payload, Date.now())
    if (status === 500) {
        // 500 makes KingFlexy redeliver (non-2xx -> retries); the CAS update keeps redelivery idempotent.
        return NextResponse.json({ success: false, error: 'Temporary error' }, { status: 500 })
    }
    return NextResponse.json({ success: true, updated_orders: applied }, { status: 200 })
}
