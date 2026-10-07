import { NextRequest } from 'next/server'
import { validateApiKey, isApiError, apiSuccess, apiError, logApiRequest, getClientIp, requireKeyType } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { REASON_MESSAGES } from '@/lib/api-order-failure'

// Only echo refund_reason when it's exactly one of the fixed, sanitized
// REASON_MESSAGES strings — never trust the column's free-text content
// directly. refund_reason is also writable by admin tools (manualRefundAirtime
// accepts an arbitrary p_reason), so without this check a future admin-typed
// reason (internal case notes, a customer's name, fraud-flag detail) could
// reach this public v2 response verbatim. Found in security review, 2026-09-08.
const KNOWN_REASON_MESSAGES = new Set<string>(Object.values(REASON_MESSAGES))

const ENDPOINT = '/api/v2/airtime/orders/:reference'

export async function GET(request: NextRequest, { params }: { params: Promise<{ reference: string }> }) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request)
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'GET', statusCode: auth.status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Authentication failed' })
        return auth
    }

    const { userId, apiKeyId, supabase } = auth
    const done = (statusCode: number, errorMessage?: string) =>
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode, responseTimeMs: Date.now() - startTime, ip, errorMessage })

    const keyTypeError = requireKeyType(auth, 'commission')
    if (keyTypeError) return keyTypeError

    try {
        const rl = consumeRateLimit(`v2-airtime-status:${apiKeyId}`, 30, 60_000)
        if (!rl.allowed) {
            done(429, 'Rate limited')
            return apiError(429, `Rate limit exceeded (30/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`)
        }

        const { reference } = await params
        if (!reference || reference.length < 3) {
            done(400, 'Invalid reference')
            return apiError(400, 'Invalid reference code')
        }
        const possibleRefs = [reference, `API-${reference}`]

        const { data: order, error } = await (supabase.from('airtime_orders') as any)
            .select('id, reference_code, status, network, beneficiary_phone, airtime_amount, fee_amount, total_paid, refund_reason, created_at, updated_at')
            .eq('user_id', userId).in('reference_code', possibleRefs).single()

        if (error || !order) {
            done(404, 'Order not found')
            return apiError(404, 'Order not found. Check the reference code and ensure it belongs to your account.')
        }

        done(200)
        return apiSuccess({
            order_id: order.id, reference: order.reference_code.replace(/^API-/, ''), status: order.status,
            network: order.network, beneficiary_phone: order.beneficiary_phone,
            airtime_amount: parseFloat(String(order.airtime_amount)), fee_amount: parseFloat(String(order.fee_amount)),
            total_paid: parseFloat(String(order.total_paid)),
            ...(order.status === 'refunded' && KNOWN_REASON_MESSAGES.has(order.refund_reason) ? { reason: order.refund_reason } : {}),
            created_at: order.created_at, updated_at: order.updated_at,
        }, { version: 'v2' })
    } catch (error: any) {
        console.error('[API v2 Airtime Order Status] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
