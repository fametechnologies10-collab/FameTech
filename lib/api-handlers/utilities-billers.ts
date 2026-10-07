// lib/api-handlers/utilities-billers.ts
// Handler for GET /api/v2/utilities/billers.
// See lib/api-handlers/packages.ts for why handlers live here.
//
// Commission keys only. Two independent gates cover this:
//   * the CENTRAL keyTypeScopeGuard in lib/api-auth.ts keeps a `standard` key
//     out of /api/v{N}/utilities/* — its RESTRICTED_SCOPES patterns are
//     version-agnostic (/^\/api\/v\d+\/utilities(?:\/|$)/), so this endpoint is
//     protected identically on v2 with no change needed.
//   * requireKeyType below is the mirror-image check, since the central guard
//     only restricts commission keys AWAY from other paths.
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
import { parseSettingNumber } from '@/lib/paystack-fees'
import { UTILITY_BILLER_KEYS, UTILITY_BILLERS } from '@/lib/hubtel-utility/billers'
import { versionMeta } from '@/lib/api-version'

export async function handleUtilitiesBillers(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)
    const endpoint = request.nextUrl.pathname
    const meta = versionMeta(endpoint)

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
        // ── Rate limit (actually consumed) ────────────────────────────────
        // Bucket key is deliberately VERSION-AGNOSTIC (was 'v1-util-billers',
        // from when v1 and v2 shared this handler and had to share one bucket).
        const rl = consumeRateLimit(`util-billers:${apiKeyId}`, 30, 60_000)
        if (!rl.allowed) {
            done(429, 'Rate limited')
            return apiError(429, `Rate limit exceeded (30/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`)
        }

        // ── Gate + limit settings ────────────────────────────────────────
        const { data: settingsRows } = await (supabase.from('admin_settings') as any)
            .select('key, value')
            .in('key', ['utility_bills_enabled', 'hubtel_utility_billers', 'utility_min_amount', 'utility_max_amount'])

        const settingsMap: Record<string, any> = {}
        for (const s of (settingsRows || [])) settingsMap[s.key] = s.value

        const globallyEnabled = settingsMap['utility_bills_enabled'] === 'true'
        const rawBillersMap = settingsMap['hubtel_utility_billers']
        const billersMap = (rawBillersMap && typeof rawBillersMap === 'object' && !Array.isArray(rawBillersMap))
            ? rawBillersMap
            : {}

        const billers = UTILITY_BILLER_KEYS.map((key) => {
            const def = UTILITY_BILLERS[key]
            return {
                key,
                label: def.label,
                enabled: globallyEnabled && billersMap[key] === true,
                account_label: def.accountLabel,
                requires_phone: key === 'ecg' || key === 'ghana_water',
                lookup_by: def.queryBy,
                links_phone_to_account: def.linksPhoneToAccount,
                has_amount_due: def.hasAmountDue,
            }
        })

        done(200)
        return apiSuccess({
            billers,
            min_amount: parseSettingNumber(settingsMap['utility_min_amount'], 1),
            max_amount: parseSettingNumber(settingsMap['utility_max_amount'], 1000),
            currency: 'GHS',
        }, meta)

    } catch (error: any) {
        console.error('[API Utilities Billers] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
