import { NextRequest } from 'next/server'
import { validateApiKey, isApiError, apiSuccess, apiError, logApiRequest, getClientIp, requireKeyType } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

// ============================================================================
// GET /api/v2/airtime/orders?status=
// Recent airtime orders for the caller, newest first, capped at 30. See
// docs/superpowers/specs/2026-08-24-api-v2-new-products-design.md §8.
// ============================================================================

const ENDPOINT = '/api/v2/airtime/orders'
const MAX_RECORDS = 30
const VALID_STATUSES = ['pending', 'processing', 'completed', 'failed', 'refunded']

export async function GET(request: NextRequest) {
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
        const rl = consumeRateLimit(`v2-airtime-list:${apiKeyId}`, 30, 60_000)
        if (!rl.allowed) {
            done(429, 'Rate limited')
            return apiError(429, `Rate limit exceeded (30/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`)
        }

        const statusFilter = request.nextUrl.searchParams.get('status')
        if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
            done(400, 'Invalid status filter')
            return apiError(400, `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`)
        }

        let query = (supabase.from('airtime_orders') as any)
            .select('id, reference_code, status, network, beneficiary_phone, airtime_amount, total_paid, created_at, updated_at')
            .eq('user_id', userId).order('created_at', { ascending: false }).limit(MAX_RECORDS)
        if (statusFilter) query = query.eq('status', statusFilter)

        const { data: orders, error } = await query
        if (error) {
            console.error('[API v2 Airtime Orders] Query error:', error)
            done(500, 'Query failed')
            return apiError(500, 'Failed to fetch orders')
        }

        done(200)
        return apiSuccess({
            orders: (orders || []).map((o: any) => ({
                order_id: o.id, reference: o.reference_code.replace(/^API-/, ''), status: o.status,
                network: o.network, beneficiary_phone: o.beneficiary_phone,
                airtime_amount: parseFloat(String(o.airtime_amount)), total_paid: parseFloat(String(o.total_paid)),
                created_at: o.created_at, updated_at: o.updated_at,
            })),
            count: (orders || []).length,
        }, { version: 'v2' })
    } catch (error: any) {
        console.error('[API v2 Airtime Orders] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
