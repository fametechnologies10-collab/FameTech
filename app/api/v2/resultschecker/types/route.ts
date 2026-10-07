import { NextRequest } from 'next/server'
import { validateApiKey, isApiError, apiSuccess, apiError, logApiRequest, getClientIp } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { getAvailableTypes, getPriceForRole } from '@/lib/results-checker-service'

// ============================================================================
// GET /api/v2/resultschecker/types
// Lists active voucher types with the CALLER'S OWN role-based price and
// current stock — so a developer purchases against real numbers, not a
// hardcoded typeId or a generic customer rate. See
// docs/superpowers/specs/2026-08-24-api-v2-new-products-design.md §2/§9.
// ============================================================================

const ENDPOINT = '/api/v2/resultschecker/types'

export async function GET(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request)
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'GET', statusCode: auth.status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Authentication failed' })
        return auth
    }

    const { userId, apiKeyId, effectiveRole, supabase } = auth
    const done = (statusCode: number, errorMessage?: string) =>
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'GET', statusCode, responseTimeMs: Date.now() - startTime, ip, errorMessage })

    try {
        const rl = consumeRateLimit(`v2-rc-types:${apiKeyId}`, 30, 60_000)
        if (!rl.allowed) {
            done(429, 'Rate limited')
            return apiError(429, `Rate limit exceeded (30/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`)
        }

        // Expiry-aware, so the price quoted here is the price /purchase will
        // actually charge. Previously this quoted the raw-role price while the
        // sibling GET /account/role reported the same caller as is_active:false.
        const userRole = effectiveRole

        const types = await getAvailableTypes()

        done(200)
        return apiSuccess({
            types: types.map(t => ({
                type_id: t.id, name: t.name, price: getPriceForRole(t, userRole),
                available_count: t.available_count ?? 0, is_active: t.is_active,
            })),
        }, { version: 'v2' })
    } catch (error: any) {
        console.error('[API v2 RC Types] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
