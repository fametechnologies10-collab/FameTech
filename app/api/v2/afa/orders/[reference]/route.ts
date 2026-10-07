import { NextRequest } from 'next/server'
import { validateApiKey, isApiError, apiSuccess, apiError, logApiRequest, getClientIp } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

// ============================================================================
// GET /api/v2/afa/orders/[reference]
// PII GUARD: afa_orders also holds id_number, date_of_birth and location —
// NEVER select or return those here. Only full_name, region, status,
// reference, payment_amount, timestamps. See
// docs/superpowers/specs/2026-08-24-api-v2-new-products-design.md §2.
// ============================================================================

const ENDPOINT = '/api/v2/afa/orders/:reference'

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

    try {
        const rl = consumeRateLimit(`v2-afa-status:${apiKeyId}`, 30, 60_000)
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

        const { data: order, error } = await (supabase.from('afa_orders') as any)
            .select('id, reference_code, status, full_name, region, payment_amount, created_at, updated_at')
            .eq('user_id', userId).in('reference_code', possibleRefs).single()

        if (error || !order) {
            done(404, 'Order not found')
            return apiError(404, 'Order not found. Check the reference code and ensure it belongs to your account.')
        }

        done(200)
        return apiSuccess({
            order_id: order.id, reference: order.reference_code.replace(/^API-/, ''), status: order.status,
            full_name: order.full_name, region: order.region,
            payment_amount: parseFloat(String(order.payment_amount)),
            created_at: order.created_at, updated_at: order.updated_at,
        }, { version: 'v2' })
    } catch (error: any) {
        console.error('[API v2 AFA Order Status] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
