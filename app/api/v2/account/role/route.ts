import { NextRequest } from 'next/server'
import { validateApiKey, isApiError, apiSuccess, apiError, logApiRequest, getClientIp } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { resolveRoleStatus } from '@/lib/user-role-status'

// ============================================================================
// GET /api/v2/account/role
// Returns the caller's role and, for time-limited roles (dealer/agent), days
// remaining before it lapses — so a developer can check "am I still a
// dealer?" without a support ticket. See
// docs/superpowers/specs/2026-08-24-api-v2-new-products-design.md §9.
// ============================================================================

const ENDPOINT = '/api/v2/account/role'

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

    try {
        const rl = consumeRateLimit(`v2-account-role:${apiKeyId}`, 30, 60_000)
        if (!rl.allowed) {
            done(429, 'Rate limited')
            return apiError(429, `Rate limit exceeded (30/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`)
        }

        const { data: userRow, error: userError } = await (supabase.from('users') as any)
            .select('role, dealer_expires_at, agent_expires_at')
            .eq('id', userId)
            .single()

        if (userError || !userRow) {
            done(404, 'User not found')
            return apiError(404, 'User not found')
        }

        const status = resolveRoleStatus(
            (userRow as any).role,
            (userRow as any).dealer_expires_at,
            (userRow as any).agent_expires_at,
        )

        done(200)
        return apiSuccess(status, { version: 'v2' })
    } catch (error: any) {
        console.error('[API v2 Account Role] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
