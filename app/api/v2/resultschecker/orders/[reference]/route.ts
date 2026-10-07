import { NextRequest } from 'next/server'
import { validateApiKey, isApiError, apiSuccess, apiError, logApiRequest, getClientIp } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

// ============================================================================
// GET /api/v2/resultschecker/orders/:reference
// Re-returns vouchers for a completed order so a developer can re-fetch them
// (e.g. after losing the original purchase response). See
// docs/superpowers/specs/2026-08-24-api-v2-new-products-design.md §8.
// ============================================================================

const ENDPOINT = '/api/v2/resultschecker/orders/:reference'

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
        const rl = consumeRateLimit(`v2-rc-status:${apiKeyId}`, 30, 60_000)
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

        const { data: order, error } = await (supabase.from('results_checker_orders') as any)
            .select('id, reference_code, status, type_name, quantity, unit_price, total_paid, inventory_ids, created_at, updated_at')
            .eq('user_id', userId).in('reference_code', possibleRefs).single()

        if (error || !order) {
            done(404, 'Order not found')
            return apiError(404, 'Order not found. Check the reference code and ensure it belongs to your account.')
        }

        let vouchers: any[] = []
        if (order.inventory_ids?.length) {
            const { data: v } = await (supabase.from('results_checker_inventory') as any)
                .select('id, pin, serial_number').in('id', order.inventory_ids)
            vouchers = v || []
        }

        done(200)
        return apiSuccess({
            order_id: order.id, reference: order.reference_code.replace(/^API-/, ''), status: order.status,
            type_name: order.type_name, quantity: order.quantity, unit_price: parseFloat(String(order.unit_price)),
            total_paid: parseFloat(String(order.total_paid)), vouchers,
            created_at: order.created_at, updated_at: order.updated_at,
        }, { version: 'v2' })
    } catch (error: any) {
        console.error('[API v2 RC Order Status] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
