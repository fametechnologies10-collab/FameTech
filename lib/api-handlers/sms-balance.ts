// lib/api-handlers/sms-balance.ts
// Handler for GET /api/v2/sms/balance.
// See lib/api-handlers/packages.ts for why handlers live here.
//
// SMS keys only — the central keyTypeScopeGuard's RESTRICTED_SCOPES pattern
// (/^\/api\/v\d+\/sms(?:\/|$)/) is version-agnostic, so this is gated
// identically on v2; requireKeyType below is the mirror-image check.
import { NextRequest } from 'next/server'
import {
    validateApiKey,
    isApiError,
    apiSuccess,
    apiError,
    logApiRequest,
    getClientIp,
    requireKeyType,
} from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { versionMeta } from '@/lib/api-version'

export async function handleSmsBalance(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)
    const endpoint = request.nextUrl.pathname
    const meta = versionMeta(endpoint)

    const auth = await validateApiKey(request)
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint, method: 'GET', statusCode: auth.status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Authentication failed' })
        return auth
    }
    const { userId, apiKeyId, supabase } = auth
    const done = (statusCode: number, errorMessage?: string) =>
        logApiRequest({ apiKeyId, userId, endpoint, method: 'GET', statusCode, responseTimeMs: Date.now() - startTime, ip, errorMessage })

    const keyTypeError = requireKeyType(auth, 'sms')
    if (keyTypeError) {
        done(403, 'Requires sms API key')
        return keyTypeError
    }

    try {
        // Version-agnostic bucket key (was 'v1-sms-balance') — one shared handler
        // must mean one shared bucket, or a developer doubles their allowance by
        // splitting traffic across the two base URLs during migration.
        const rl = consumeRateLimit(`sms-balance:${apiKeyId}`, auth.rateLimits.balance, 60_000)
        if (!rl.allowed) { done(429, 'Rate limited'); return apiError(429, `Rate limit exceeded (${auth.rateLimits.balance}/min)`) }

        const { data: account } = await (supabase as any).from('sms_accounts')
            .select('id, mode, status').eq('user_id', userId).maybeSingle()
        if (!account) {
            done(200)
            return apiSuccess({ credits: 0, mode: null, note: 'SMS account not initialised — open the SMS dashboard first' }, meta)
        }
        const { data: wallet } = await (supabase as any).from('sms_wallets')
            .select('credits, total_purchased, total_used')
            .eq('account_id', (account as any).id).maybeSingle()

        done(200)
        return apiSuccess({
            credits: (wallet as any)?.credits ?? 0,
            totalPurchased: (wallet as any)?.total_purchased ?? 0,
            totalUsed: (wallet as any)?.total_used ?? 0,
            mode: (account as any).mode,
            accountStatus: (account as any).status,
        }, meta)
    } catch (e: any) {
        console.error('[API SMS Balance] error:', e?.message)
        done(500, e?.message)
        return apiError(500, 'Internal error')
    }
}
