import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyReceiveCallbackSig } from '@/lib/hubtel-receive-money'
import { settleReceivePaid } from '@/lib/hubtel-receive/settle'

/**
 * POST /api/webhooks/hubtel-receive-money
 *
 * Confirms a CUSTOMER PAYMENT via Hubtel Direct Receive Money. This is UPSTREAM
 * of app/api/webhooks/hubtel-commission/route.ts, which handles the bill-PAYOUT
 * result and finalizes status/commission — NOT touched here. Flow: payment
 * confirmed here -> settleReceivePaid claims + dispatches fulfillment -> the
 * commission webhook finalizes later.
 *
 * Auth: Hubtel sends no signature/secret header on Receive Money callbacks, so
 * we authenticate via a per-request HMAC carried in the PrimaryCallbackUrl we
 * issued (?ref&ts&sig — see buildSignedReceiveCallbackUrl in
 * lib/hubtel-receive-money.ts). The secret is never transmitted; the sig is
 * reference-bound and time-bounded. Unlike the Commission rail, Receive Money
 * references carry no "-r{n}" retry suffix — `ref` is used verbatim, never
 * stripped, and the settle action is bound to this HMAC-authenticated URL ref,
 * NEVER the (unauthenticated) request body.
 *
 * Re-verify before credit: the callback body is only a TRIGGER, never the basis
 * for the settle decision — settleReceivePaid always re-checks the charge's live
 * status via checkReceiveMoneyStatus before claiming. A forged/replayed body
 * claiming success can never settle a charge Hubtel doesn't also confirm live.
 *
 * Always-200: once auth passes, every handled outcome (including settle errors)
 * returns 200 so Hubtel stops retrying — mirrors hubtel-commission's contract.
 * Only 401 (bad sig), 503 (secret unset), and 400 (unparseable body) are non-200.
 */
export async function POST(request: NextRequest) {
    const expectedSecret = process.env.HUBTEL_RECEIVE_WEBHOOK_SECRET || ''
    if (!expectedSecret) {
        console.error('[HubtelReceive] Rejected: HUBTEL_RECEIVE_WEBHOOK_SECRET not configured')
        return NextResponse.json({ success: false, error: 'Webhook not configured' }, { status: 503 })
    }

    const sp = request.nextUrl.searchParams
    const ref = sp.get('ref') || ''
    const urlTs = sp.get('ts') || ''
    const urlSig = sp.get('sig') || ''

    // Receive Money references carry NO "-r{n}" retry suffix (unlike the Commission
    // rail's baseRef()) — used verbatim, both for HMAC verification and as the
    // settle reference.
    let authed = false
    if (ref && /^\d+$/.test(urlTs) && urlSig) {
        const age = Date.now() - Number(urlTs)
        if (age >= -60_000 && age < 24 * 60 * 60 * 1000) { // <=1min future skew, <24h old
            authed = verifyReceiveCallbackSig(ref, urlTs, urlSig)
        }
    }
    if (!authed) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    let payload: any
    try {
        payload = await request.json()
    } catch {
        return NextResponse.json({ success: false, error: 'Invalid payload' }, { status: 400 })
    }

    // Observability only — NEVER the basis for the settle decision (unauthenticated body).
    console.log('[HubtelReceive] callback:', 'ref:', ref, 'status:', payload?.Data?.Status, 'rc:', payload?.ResponseCode)

    // `return await` (not a bare `return <promise>`) is load-bearing: it keeps this
    // call inside the try/catch below so a late rejection from settleReceivePaid can
    // never escape the always-200 contract to Hubtel.
    return await (async () => {
        try {
            const db = createServerClient()
            await settleReceivePaid(db, ref)
        } catch (error: any) {
            console.error('[HubtelReceive] settle failed (still 200 to stop retries):', error?.message || error, 'ref:', ref)
        }
        return NextResponse.json({ success: true }, { status: 200 })
    })()
}
