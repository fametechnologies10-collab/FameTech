// lib/api-handlers/utilities-order-status.ts
// Handler for GET /api/v2/utilities/orders/:reference. See
// lib/api-handlers/packages.ts for why handlers live here.
//
// Only returns orders belonging to the authenticated user — never a global
// lookup, so commission-key tenants cannot probe each other's orders by
// guessing reference codes. The explicit column allowlist mirrors
// app/api/utilities/history/route.ts's exposure rule: commission_amount
// (the platform total), lookup_snapshot and fulfillment_metadata are never the
// developer's business — only their own commission_earned
// (partner_commission_amount) share is exposed.
import { NextRequest } from 'next/server'
import {
    validateApiKey,
    isApiError,
    requireKeyType,
    apiSuccess,
    apiError,
    logApiRequest,
    getClientIp,
} from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { apiVersionFromPath, versionMeta } from '@/lib/api-version'
import { REASON_MESSAGES } from '@/lib/api-order-failure'

// Only echo refund_reason when it's exactly one of the fixed, sanitized
// REASON_MESSAGES strings — never trust the column's free-text content
// directly. refund_reason is also writable by admin tools with an arbitrary
// free-text reason, so without this check a future admin-typed reason
// (internal case notes, a customer's name, fraud-flag detail) could reach
// this public v1/v2 response verbatim. Found in security review, 2026-09-08.
const KNOWN_REASON_MESSAGES = new Set<string>(Object.values(REASON_MESSAGES))

export async function handleUtilitiesOrderStatus(
    request: NextRequest,
    { params }: { params: Promise<{ reference: string }> }
) {
    const startTime = Date.now()
    const ip = getClientIp(request)
    // Normalised, NOT the raw pathname — this path carries the caller's utility
    // order reference. See lib/api-handlers/order-status.ts for the same reasoning.
    const endpoint = `/api/${apiVersionFromPath(request.nextUrl.pathname)}/utilities/orders/:reference`
    const meta = versionMeta(request.nextUrl.pathname)

    // ── Authenticate ──────────────────────────────────────────────────────
    const auth = await validateApiKey(request)
    if (isApiError(auth)) {
        logApiRequest({
            apiKeyId: null, userId: null,
            endpoint, method: 'GET',
            statusCode: auth.status, responseTimeMs: Date.now() - startTime,
            ip, errorMessage: 'Authentication failed',
        })
        return auth
    }

    const { userId, apiKeyId, supabase } = auth
    const done = (statusCode: number, errorMessage?: string) =>
        logApiRequest({ apiKeyId, userId, endpoint, method: 'GET', statusCode, responseTimeMs: Date.now() - startTime, ip, errorMessage })

    // ── Key-type gate — commission keys only ────────────────────────────────
    const keyTypeError = requireKeyType(auth, 'commission')
    if (keyTypeError) {
        done(403, 'Wrong key type')
        return keyTypeError
    }

    try {
        // Version-agnostic bucket key (was 'v1-util-status') — one shared handler
        // means one shared bucket across both base URLs.
        const rl = consumeRateLimit(`util-status:${apiKeyId}`, 30, 60_000)
        if (!rl.allowed) {
            done(429, 'Rate limited')
            return apiError(429, `Rate limit exceeded (30/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`)
        }

        const { reference } = await params
        if (!reference || reference.length < 3) {
            done(400, 'Invalid reference')
            return apiError(400, 'Invalid reference code')
        }

        const { data: order, error: orderError } = await (supabase as any).from('utility_orders')
            .select('reference_code, status, payment_status, biller, account_number, account_name, amount, partner_commission_amount, refund_reason, created_at, updated_at')
            .eq('user_id', userId)
            .eq('reference_code', reference)
            .single()

        if (orderError || !order) {
            done(404, 'Order not found')
            return apiError(404, 'Order not found. Check the reference code and ensure it belongs to your account.')
        }

        done(200)
        return apiSuccess({
            reference: order.reference_code,
            status: order.status,
            payment_status: order.payment_status,
            biller: order.biller,
            account_number: order.account_number,
            account_name: order.account_name,
            amount: parseFloat(String(order.amount)),
            commission_earned: (order.partner_commission_amount !== null && order.partner_commission_amount !== undefined)
                ? parseFloat(String(order.partner_commission_amount))
                : null,
            ...(order.status === 'refunded' && KNOWN_REASON_MESSAGES.has(order.refund_reason) ? { reason: order.refund_reason } : {}),
            created_at: order.created_at,
            updated_at: order.updated_at,
        }, meta)

    } catch (error: any) {
        console.error('[API Utilities Order Status] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
