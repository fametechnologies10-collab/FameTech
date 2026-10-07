import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { createServerClient } from '@/lib/supabase'
import { waitUntil } from '@vercel/functions'
import { notifyDataOrderWebhook } from '@/lib/data-order-webhook'

/**
 * Recovers OUR order UUID from whatever identifier DataKazina quotes back.
 *
 * Returns ALL plausible interpretations rather than one, because DataKazina's reference
 * format is not contractually fixed and has been observed in more than one shape. Every
 * candidate is then matched with an exact `.in('id', ...)` on a UUID column, additionally
 * gated on `fulfillment_method='datakazina'` — so an extra wrong candidate simply matches
 * nothing. Being generous here is safe; being too strict silently strands orders.
 *
 * Shapes handled:
 *   1. The bare order UUID (dashed or undashed) — the overwhelmingly common case: 1,654 of
 *      1,893 stored references equal orders.id exactly.
 *   2. "<uuid>-r<n>" — the retry-suffixed incoming_api_ref this codebase now sends, see
 *      buildIncomingApiRef in lib/datakazina-request.ts.
 *   3. "498" + <uuid> + <10-digit suffix> — the shape the original implementation assumed.
 *
 * NOTE the original implementation ONLY handled shape 3, via /^.{3}([0-9a-f]{32})/ — which
 * requires at least 35 hex characters. Every one of the 1,893 stored references is exactly
 * 32 hex characters, so that regex could never match and this whole id-based matching path
 * had never once fired in production. Fixed 2026-08-20.
 */
function extractOrderIdCandidates(value: unknown): string[] {
    if (!value) return []
    const hexOnly = String(value).replace(/-/g, '').toLowerCase()
    const toUuid = (h: string) =>
        `${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20, 32)}`

    const out: string[] = []
    // Shapes 1 and 2: the order id is the LEADING 32 hex chars.
    const leading = hexOnly.match(/^([0-9a-f]{32})/)
    if (leading) out.push(toUuid(leading[1]))
    // Shape 3: a 3-char prefix, then the order id. Only meaningful when the string is long
    // enough to actually contain both, otherwise this would re-slice shape 1 at an offset and
    // fabricate a UUID that was never real.
    if (hexOnly.length >= 35) {
        const prefixed = hexOnly.match(/^.{3}([0-9a-f]{32})/)
        if (prefixed) out.push(toUuid(prefixed[1]))
    }
    return Array.from(new Set(out))
}

function dedupe<T>(arr: (T | null | undefined | '')[]): T[] {
    return Array.from(new Set(arr.filter(Boolean) as T[]))
}

// Extract the password from an HTTP Basic Authorization header. Lets DataKazina's
// URL-only console authenticate via URL userinfo (https://x:SECRET@host/...), which
// HTTP clients send as `Authorization: Basic base64(user:SECRET)` — keeping the
// secret in a header instead of the query string (and out of access logs).
function extractBasicAuthSecret(authHeader: string | null): string {
    if (!authHeader || !authHeader.toLowerCase().startsWith('basic ')) return ''
    try {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
        const idx = decoded.indexOf(':')
        return idx === -1 ? decoded : decoded.slice(idx + 1)
    } catch {
        return ''
    }
}

export async function POST(request: NextRequest) {
    // SEC-002: fail-closed shared-secret auth. Without this, any unauthenticated
    // POST could flip an order to completed and trigger fulfillment/notifications
    // with no real payment.
    const expectedSecret = process.env.DAKAZINA_WEBHOOK_SECRET || ''
    if (!expectedSecret) {
        console.error('[DakazinaWebhook] Rejected: DAKAZINA_WEBHOOK_SECRET not configured')
        return NextResponse.json({ success: false, error: 'Webhook not configured' }, { status: 503 })
    }
    // DataKazina's webhook console is URL-only (no custom-header / signing-secret
    // field), so the shared secret must travel in the URL. Accepted forms, most-
    // private first:
    //   1. HTTP Basic via URL userinfo — https://x:SECRET@host/... — arrives as an
    //      Authorization header, kept OUT of query-string access logs. Preferred.
    //   2. Query param — ...?secret=SECRET (or ?token=). Works everywhere, but the
    //      secret lands in access logs: treat the whole URL as a credential and
    //      ROTATE it (env var + DataKazina URL together) on any suspected exposure.
    // The x-dakazina-secret header is also accepted for non-URL-only callers.
    // Comparison is timing-safe; the env-var guard above keeps this fail-closed.
    const expBuf = Buffer.from(expectedSecret)
    const candidateSecrets = [
        request.headers.get('x-dakazina-secret') || '',
        extractBasicAuthSecret(request.headers.get('authorization')),
        request.nextUrl.searchParams.get('secret') || '',
        request.nextUrl.searchParams.get('token') || '',
    ]
    const authorized = candidateSecrets.some((candidate) => {
        if (!candidate) return false
        const candBuf = Buffer.from(candidate)
        return candBuf.length === expBuf.length && timingSafeEqual(candBuf, expBuf)
    })
    if (!authorized) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    let payload: any
    try {
        payload = await request.json()
    } catch (err) {
        console.error('[DakazinaWebhook] Failed to parse payload:', err)
        return NextResponse.json({ success: false, error: 'Invalid payload' }, { status: 400 })
    }

    try {
        const { order_code, reference, status, type } = payload || {}

        if (type === 'test_event') {
            console.log('[DakazinaWebhook] Test event received, ignoring')
            return NextResponse.json({ success: true, message: 'Test event ignored' }, { status: 200 })
        }

        const upperStatus = (status || '').toUpperCase()
        let targetStatus: 'completed' | 'failed'
        if (upperStatus === 'DELIVERED') {
            targetStatus = 'completed'
        } else if (upperStatus === 'WAITING') {
            // Per a KiNG FLEXY GH + DataKazina ops decision, WAITING is treated as a failed
            // delivery attempt — NOT a refund. The wallet charge is left untouched; an admin
            // refunds manually via the payments centre, same as every other supplier's
            // webhook-driven failure (mirrors app/api/webhooks/hendylinks/route.ts).
            targetStatus = 'failed'
        } else {
            console.log(`[DakazinaWebhook] Ignored non-actionable status '${upperStatus}' (order_code=${order_code}, reference=${reference}) — admin will handle`)
            return NextResponse.json({ success: true }, { status: 200 })
        }

        // Build all candidate match shapes
        const exactRefCandidates = dedupe<string>([
            reference ? String(reference) : '',
            order_code ? String(order_code) : '',
        ])

        const idCandidates = dedupe<string>([
            ...extractOrderIdCandidates(reference),
            ...extractOrderIdCandidates(order_code),
        ])

        // SF-03: match only on EXACT reference / order_code and the
        // reconstructed UUID. The previous loose `ilike %substr%` matching (down
        // to 4 chars) could flip an UNRELATED order whose dakazina_reference
        // merely shared a short substring.
        if (exactRefCandidates.length === 0 && idCandidates.length === 0) {
            console.warn(`[DakazinaWebhook] ${upperStatus} event has no usable identifiers; payload:`, JSON.stringify(payload))
            return NextResponse.json({ success: true }, { status: 200 })
        }

        console.log(`[DakazinaWebhook] ${upperStatus} match attempt (→ ${targetStatus}) — ids=${JSON.stringify(idCandidates)} exact=${JSON.stringify(exactRefCandidates)}`)

        const supabase = createServerClient()
        const completedOrderIds = new Set<string>()
        const completedShopOrderIds = new Set<string>()

        async function runUpdate(
            table: 'orders' | 'shop_orders',
            applyFilters: (q: any) => any,
            label: string,
        ): Promise<string[]> {
            try {
                let q: any = (supabase.from(table) as any)
                    .update({ status: targetStatus, updated_at: new Date().toISOString() })
                q = applyFilters(q)
                const { data, error } = await q.eq('status', 'processing').select('id')
                if (error) {
                    console.error(`[DakazinaWebhook] ${table} ${label} failed:`, error.message)
                    return []
                }
                return (data || []).map((r: any) => r.id)
            } catch (e: any) {
                console.error(`[DakazinaWebhook] ${table} ${label} exception:`, e?.message || e)
                return []
            }
        }

        // ── orders table ──────────────────────────────────────────────────
        // fulfillment_method='datakazina' is required on every match below — without it, a
        // late/delayed DELIVERED event for an order that has SINCE been retried onto a
        // different supplier could still match (the id-candidate path in particular
        // reconstructs our order UUID from ANY reference/order_code Dakazina sends, regardless
        // of whether dakazina_reference itself was ever cleared) and flip its status out from
        // under the new supplier. Mirrors the guard lib/agentportal-apply-outcome.ts uses for
        // AgentPortal.
        if (idCandidates.length > 0) {
            (await runUpdate('orders', q => q.in('id', idCandidates).eq('fulfillment_method', 'datakazina'), 'update-by-id'))
                .forEach(id => completedOrderIds.add(id))
        }
        if (exactRefCandidates.length > 0) {
            (await runUpdate('orders', q => q.in('dakazina_reference', exactRefCandidates).eq('fulfillment_method', 'datakazina'), 'update-by-ref-exact'))
                .forEach(id => completedOrderIds.add(id))
        }
        // DataKazina's OWN order code (ORDER-.../BULK-...). Their webhook may quote this
        // instead of the incoming_api_ref we sent, and we cannot control which — so both are
        // stored at dispatch (orders.dakazina_order_code) and both are matched here.
        if (exactRefCandidates.length > 0) {
            (await runUpdate('orders', q => q.in('dakazina_order_code', exactRefCandidates).eq('fulfillment_method', 'datakazina'), 'update-by-order-code'))
                .forEach(id => completedOrderIds.add(id))
        }

        // ── shop_orders table ─────────────────────────────────────────────
        // Same guard, keyed on shop_orders.fulfilled_by (the shop-order equivalent of
        // orders.fulfillment_method).
        if (idCandidates.length > 0) {
            (await runUpdate('shop_orders', q => q.in('id', idCandidates).eq('fulfilled_by', 'datakazina'), 'update-by-id'))
                .forEach(id => completedShopOrderIds.add(id))
        }
        if (exactRefCandidates.length > 0) {
            (await runUpdate('shop_orders', q => q.in('dakazina_reference', exactRefCandidates).eq('fulfilled_by', 'datakazina'), 'update-by-ref-exact'))
                .forEach(id => completedShopOrderIds.add(id))
        }

        // ── Side-effects for any orders we transitioned ───────────────────
        for (const orderId of completedOrderIds) {
            console.log(`[DakazinaWebhook] orders.${orderId} → ${targetStatus} (ref=${reference}, code=${order_code})`)

            try {
                const { syncShopOrderStatus } = await import('@/lib/shop-service')
                syncShopOrderStatus(orderId, targetStatus).catch(e =>
                    console.error(`[DakazinaWebhook] syncShopOrderStatus failed for ${orderId}:`, e)
                )
            } catch (e) {
                console.error('[DakazinaWebhook] shop-service import failed:', e)
            }

            if (targetStatus === 'completed') {
                try {
                    const { sendOrderCompletedPushNotification } = await import('@/lib/push-service')
                    sendOrderCompletedPushNotification(orderId).catch(e =>
                        console.error(`[DakazinaWebhook] push notification failed for ${orderId}:`, e)
                    )
                } catch (e) {
                    console.error('[DakazinaWebhook] push-service import failed:', e)
                }
            } else {
                // WAITING → failed. Deliberately NOT a refund — the wallet charge is left
                // as-is and an admin reconciles/refunds manually, same as every other
                // supplier's webhook-driven failure. Record the reason where admins can see
                // it (mtn_fulfillment_tracking is internal-only); never write to
                // orders.error_message — that column is CUSTOMER-FACING
                // (components/dashboard/RecentOrdersWidget.tsx renders it under "Failure
                // Reason") and a raw supplier status must never reach it.
                const { error: trackingError } = await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                    order_id: orderId,
                    status: targetStatus,
                    api_response: {
                        supplier: 'datakazina',
                        source: 'webhook',
                        dakazina_status: upperStatus,
                        reference,
                        order_code,
                    },
                })
                if (trackingError) console.error(`[DakazinaWebhook] Tracking insert failed for ${orderId}:`, trackingError.message)
            }

            // waitUntil so a lambda freeze right after this route's response cannot
            // drop the developer webhook — orderId only reaches this loop after
            // runUpdate's own CAS (.eq('status','processing').select('id')) proved a
            // real pending/processing→{completed,failed} transition just happened.
            waitUntil(notifyDataOrderWebhook(supabase, orderId, targetStatus === 'completed' ? 'order.completed' : 'order.failed'))
        }
        for (const id of completedShopOrderIds) {
            console.log(`[DakazinaWebhook] shop_orders.${id} → ${targetStatus} (ref=${reference}, code=${order_code})`)
        }

        // ── Diagnostic dump on miss ───────────────────────────────────────
        // When we fail to match, dump what we have stored on the 5 most
        // recent processing Dakazina orders so we can see the actual shape
        // of dakazina_reference and lock the matcher down.
        if (completedOrderIds.size === 0 && completedShopOrderIds.size === 0) {
            try {
                const { data: recent } = await (supabase.from('orders') as any)
                    .select('id, dakazina_reference, status, created_at, fulfillment_method')
                    .eq('fulfillment_method', 'datakazina')
                    .eq('status', 'processing')
                    .order('created_at', { ascending: false })
                    .limit(5)
                console.log('[DakazinaWebhook] DIAGNOSTIC — last 5 processing Dakazina orders:', JSON.stringify(recent))
            } catch (e: any) {
                console.error('[DakazinaWebhook] diagnostic dump failed:', e?.message || e)
            }
            console.log(`[DakazinaWebhook] ${upperStatus} acknowledged but no processing rows matched (ref=${reference}, code=${order_code})`)
        }

        return NextResponse.json({
            success: true,
            updated_orders: completedOrderIds.size,
            updated_shop_orders: completedShopOrderIds.size,
        }, { status: 200 })

    } catch (error: any) {
        console.error('[DakazinaWebhook] Unhandled exception:', error?.message || error, 'payload:', JSON.stringify(payload))
        return NextResponse.json({ success: true }, { status: 200 })
    }
}
