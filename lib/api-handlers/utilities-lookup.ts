// lib/api-handlers/utilities-lookup.ts
// Handler for GET /api/v2/utilities/lookup.
// See lib/api-handlers/packages.ts for why handlers live here.
//
// Name-verification lookup for the developer API. Structurally the API sibling
// of app/api/utilities/lookup/route.ts (dashboard) and
// app/api/shop/utility/lookup/route.ts (storefront guest): same per-biller
// destination/mobile mapping, same queryUtilityAccount call, same
// sanitizeAccountInfoForClient scrub (Ghana Water's sessionId NEVER reaches a
// client — the dispatch pipeline always re-queries a fresh session at pay-time).
// Response is a clean, mapped field set — never the raw provider rows or the
// session itself.
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
import { isUtilityBiller, UTILITY_BILLERS, sanitizeAccountInfoForClient } from '@/lib/hubtel-utility/billers'
import { queryUtilityAccount } from '@/lib/hubtel-utility/service'
import { versionMeta } from '@/lib/api-version'

const MAX_INPUT_LEN = 30

export async function handleUtilitiesLookup(request: NextRequest) {
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
        // Version-agnostic bucket key (was 'v1-util-lookup') — one shared handler
        // means one shared bucket across both base URLs. Matters more here than
        // on most endpoints: each lookup is an outbound call to Hubtel, so a
        // doubled allowance would double our upstream provider load too.
        const rl = consumeRateLimit(`util-lookup:${apiKeyId}`, 10, 60_000)
        if (!rl.allowed) {
            done(429, 'Rate limited')
            return apiError(429, `Rate limit exceeded (10/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`)
        }

        // ── Parse + structurally validate query params ─────────────────────
        const url = new URL(request.url)
        const biller = url.searchParams.get('biller')
        const account = url.searchParams.get('account')
        const phone = url.searchParams.get('phone')

        if (!isUtilityBiller(biller)) {
            done(400, 'Invalid biller')
            return apiError(400, 'Invalid biller')
        }
        const def = UTILITY_BILLERS[biller]

        const trimmedAccount = typeof account === 'string' ? account.trim() : ''
        if (!trimmedAccount) {
            done(400, 'Missing account')
            return apiError(400, `${def.accountLabel} is required`)
        }
        if (trimmedAccount.length > MAX_INPUT_LEN) {
            done(400, 'Account too long')
            return apiError(400, `${def.accountLabel} is too long`)
        }

        const trimmedPhone = typeof phone === 'string' ? phone.trim() : ''
        if (trimmedPhone.length > MAX_INPUT_LEN) {
            done(400, 'Phone too long')
            return apiError(400, 'Phone number is too long')
        }
        if (biller === 'ghana_water' && !trimmedPhone) {
            done(400, 'Missing phone')
            return apiError(400, 'Phone number is required for Ghana Water lookup')
        }

        // ── Gates (API is its own surface — storefront/USSD gates don't apply) ──
        const { data: settingsRows } = await (supabase.from('admin_settings') as any)
            .select('key, value')
            .in('key', ['utility_bills_enabled', 'hubtel_utility_billers'])
        const settingsMap: Record<string, any> = {}
        for (const s of (settingsRows || [])) settingsMap[s.key] = s.value

        if (settingsMap['utility_bills_enabled'] !== 'true') {
            done(503, 'Utility bills disabled')
            return apiError(503, 'Utility bill payments are currently unavailable')
        }
        const billersMap = settingsMap['hubtel_utility_billers']
        if (!billersMap || typeof billersMap !== 'object' || Array.isArray(billersMap) || billersMap[biller] !== true) {
            done(503, 'Biller disabled')
            return apiError(503, `${def.label} is currently unavailable`)
        }

        // ── Map inputs per biller (identical to app/api/utilities/lookup/route.ts) ──
        // ecg: queries BY PHONE — prefer the explicit phone field, falling back to
        // `account` (a caller may pass the phone number in the generic account field).
        // ghana_water: destination = meter (account), mobile = phone (validated above).
        // dstv/gotv/startimes: destination = account (smartcard/account number).
        let destination: string
        let mobile: string | undefined
        if (biller === 'ecg') {
            destination = trimmedPhone || trimmedAccount
        } else if (biller === 'ghana_water') {
            destination = trimmedAccount
            mobile = trimmedPhone
        } else {
            destination = trimmedAccount
        }

        const result = await queryUtilityAccount(biller, destination, mobile)

        if (!result.success) {
            if (result.isRateLimited || result.isNetworkError) {
                done(502, 'Provider unavailable')
                return apiError(502, 'Could not reach the billing provider — please try again shortly')
            }
            // Business failure (bad account/meter number etc.)
            done(404, result.error || 'Account not found')
            return apiError(404, result.error || 'Account not found — check the number')
        }

        const info = sanitizeAccountInfoForClient(result.info!)

        done(200)
        return apiSuccess({
            account_name: info.accountName,
            account_number: info.accountNumber,
            amount_due: info.amountDue,
            bouquet: info.bouquet,
            meters: info.meters,
        }, meta)

    } catch (error: any) {
        console.error('[API Utilities Lookup] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
