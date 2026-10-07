// lib/api-handlers/order-status.ts
// Handler for GET /api/v2/orders/:reference.
// See lib/api-handlers/packages.ts for why handlers live here.
import { NextRequest } from 'next/server'
import {
    validateApiKey,
    isApiError,
    apiSuccess,
    apiError,
    logApiRequest,
    getClientIp,
} from '@/lib/api-auth'
import { apiVersionFromPath, versionMeta } from '@/lib/api-version'

export async function handleOrderStatus(
    request: NextRequest,
    { params }: { params: Promise<{ reference: string }> }
) {
    const startTime = Date.now()
    const ip = getClientIp(request)
    // NOT request.nextUrl.pathname here, unlike the non-dynamic handlers: this
    // route's path contains the caller's actual order reference. Logging the raw
    // path would write a distinct high-cardinality endpoint value into api_logs
    // for every order ever looked up, and put customer order references into the
    // log table. The v1 route deliberately logged the normalised ':reference'
    // form; that is preserved, just made version-aware.
    const endpoint = `/api/${apiVersionFromPath(request.nextUrl.pathname)}/orders/:reference`
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

    try {
        const { userId, apiKeyId, supabase } = auth
        const { reference } = await params

        if (!reference || reference.length < 3) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'GET', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Invalid reference' })
            return apiError(400, 'Invalid reference code')
        }

        // Try both with and without API- prefix for flexibility
        const possibleRefs = [reference, `API-${reference}`]

        const { data: order, error: orderError } = await (supabase
            .from('orders') as any)
            .select('id, reference_code, status, network, size, phone_number, price, payment_status, fulfillment_method, source, created_at, updated_at')
            .eq('user_id', userId)
            .in('reference_code', possibleRefs)
            .single()

        if (orderError || !order) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'GET', statusCode: 404, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Order not found' })
            return apiError(404, 'Order not found. Check the reference code and ensure it belongs to your account.')
        }

        logApiRequest({
            apiKeyId, userId,
            endpoint, method: 'GET',
            statusCode: 200, responseTimeMs: Date.now() - startTime, ip,
        })

        return apiSuccess({
            order_id: order.id,
            reference: order.reference_code.replace(/^API-/, ''),
            status: order.status,
            network: order.network,
            size: order.size,
            recipient: order.phone_number,
            price: parseFloat(String(order.price)),
            payment_status: order.payment_status,
            source: order.source,
            created_at: order.created_at,
            updated_at: order.updated_at,
        }, meta)

    } catch (error: any) {
        console.error('[API Order Status] Error:', error.message)
        logApiRequest({
            apiKeyId: auth.apiKeyId, userId: auth.userId,
            endpoint, method: 'GET',
            statusCode: 500, responseTimeMs: Date.now() - startTime,
            ip, errorMessage: error.message,
        })
        return apiError(500, 'Internal server error')
    }
}
