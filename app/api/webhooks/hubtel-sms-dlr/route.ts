/**
 * POST /api/webhooks/hubtel-sms-dlr — Hubtel SMS delivery reports (KFG SMS).
 *
 * ⛔ G1 NOTE: Hubtel's DLR payload/registration is pending confirmation from
 * the account manager. This endpoint is built to the conservative trust model
 * so the payload shape can be adapted without touching the security posture:
 *
 *  AUTH  : static shared secret in the x-dlr-secret HEADER only (never a query
 *          param — that leaks the secret into CDN/proxy/Vercel access logs),
 *          checked with timing-safe comparison; 503 fail-closed when the env is
 *          unset. (Hubtel sends unsigned callbacks — same reality as the
 *          Commission webhook; if per-request CallbackUrls turn out to be
 *          supported, switch to the HMAC-in-URL pattern from hubtel-commission.)
 *  TRUST : the body selects the row ONLY via provider_message_id, and the
 *          transition allowlist lives in the apply_sms_delivery_report RPC —
 *          only queued/sent rows can move, terminal states are immutable, so
 *          replays and forged repeats are no-ops.
 *  MONEY : this handler NEVER moves credits. Refunds happen exclusively in
 *          settle/cancel. A leaked secret can at worst mislabel delivery
 *          states of in-flight messages — never mint credits.
 *
 * Always returns 200 on processed requests so Hubtel does not retry-storm;
 * auth failures return 401/503.
 */

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual, createHash } from 'crypto'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

function safeEqual(a: string, b: string): boolean {
    const ha = createHash('sha256').update(a).digest()
    const hb = createHash('sha256').update(b).digest()
    return timingSafeEqual(ha, hb)
}

/** Map Hubtel's DLR status vocabulary → our sms_messages statuses (confirmed
 *  docs 2026-07-07). Non-terminal 'Sent'/'Pending' return null (no-op — the
 *  reconcile cron resolves them later). Unknown values also no-op. */
function mapDlrStatus(raw: string): string | null {
    const s = (raw || '').trim().toLowerCase()
    if (!s) return null
    if (s === 'delivered') return 'delivered'
    if (s === 'sent' || s === 'pending') return null
    if (s === 'expired') return 'expired'
    if (s.includes('undeliver') || s === 'failed' || s.includes('unrouteable') || s === 'error') return 'undelivered'
    if (s === 'rejected' || s === 'blacklisted' || s.includes('nack') || s.includes('invalid destination') || s.includes('invalid source')) return 'rejected'
    return null
}

export async function POST(request: NextRequest) {
    const expected = process.env.HUBTEL_SMS_DLR_SECRET
    if (!expected) {
        console.error('[SMS DLR] HUBTEL_SMS_DLR_SECRET not configured — rejecting all requests')
        return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
    }

    // Header only — a query-param secret (?k=) would leak into access logs.
    const provided = request.headers.get('x-dlr-secret') || ''
    if (!provided || !safeEqual(provided, expected)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
        const body: any = await request.json().catch(() => ({}))

        // Accept single object or array; field names parsed defensively (G1).
        const reports: any[] = Array.isArray(body) ? body
            : Array.isArray(body?.data) ? body.data
            : [body]

        const db = createServerClient() as any
        let updated = 0
        let skipped = 0

        for (const r of reports.slice(0, 500)) {
            const messageId = String(
                r.messageId ?? r.MessageId ?? r.message_id ?? r.id ?? '').trim()
            const rawStatus = String(r.status ?? r.Status ?? r.deliveryStatus ?? r.DeliveryStatus ?? '')
            const mapped = mapDlrStatus(rawStatus)
            if (!messageId || !mapped) { skipped++; continue }

            // Try the campaign-product table first, then the shop-SMS table.
            // provider_message_id is unique Hubtel-account-wide regardless of
            // which product sent it, so there's no routing ambiguity — at
            // most one of these two calls can ever find a matching row.
            const { data, error } = await db.rpc('apply_sms_delivery_report', {
                p_provider_message_id: messageId,
                p_status: mapped,
                p_detail: rawStatus ? `dlr:${rawStatus}` : null,
            })
            if (error) {
                console.error('[SMS DLR] apply_sms_delivery_report failed:', error.message)
                skipped++
            } else if ((data as any)?.updated) {
                updated++
            } else {
                const { data: shopData, error: shopError } = await db.rpc('apply_shop_sms_delivery_report', {
                    p_provider_message_id: messageId,
                    p_status: mapped,
                    p_detail: rawStatus ? `dlr:${rawStatus}` : null,
                })
                if (shopError) {
                    console.error('[SMS DLR] apply_shop_sms_delivery_report failed:', shopError.message)
                    skipped++
                } else if ((shopData as any)?.updated) {
                    updated++
                } else {
                    skipped++ // unknown id or already terminal — replay-safe no-op
                }
            }
        }

        return NextResponse.json({ received: true, updated, skipped })
    } catch (e: any) {
        console.error('[SMS DLR] error:', e?.message)
        // 200 so Hubtel doesn't retry-storm a parse edge; nothing was trusted.
        return NextResponse.json({ received: true, error: 'parse_failed' })
    }
}
