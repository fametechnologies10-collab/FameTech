// lib/api-handlers/verify-number.ts
// Public developer-API whitelist checks. Recommended, not required.
//   POST /api/v2/data/verify-number           merged check — the one to use as a checkout gate,
//                                             it matches what /data/purchase enforces.
//   POST /api/v2/data/verify-number/server-1  Server 1 only — informational: which server a
//   POST /api/v2/data/verify-number/server-2  Server 2 only   number is registered on.
// All three share ONE rate-limit bucket per API key (each call can submit an unregistered number
// for registration, so splitting the bucket would multiply the allowance). Unlike the merged
// one, the per-server endpoints do NOT fail open: they are diagnostics, so an upstream outage
// returns 502 instead of a fake allowed:true.
import { NextRequest } from 'next/server'
import { validateApiKey, isApiError, apiSuccess, apiError, logApiRequest, getClientIp } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { normalizeMtnMsisdn } from '@/lib/agentportal-whitelist'
import { verifyMtnWhitelistMerged } from '@/lib/mtn-whitelist-merge'
import { verifyMtnWhitelistServer, type WhitelistServer } from '@/lib/mtn-whitelist-server-check'

const RATE_LIMIT_PER_MINUTE = 20

interface VerifyHandlerConfig {
    endpoint: string
    rateLimitPrefix: string
    /** Absent = merged check. */
    server?: WhitelistServer
}

function createVerifyNumberHandler({ endpoint, rateLimitPrefix, server }: VerifyHandlerConfig) {
    return async function handler(request: NextRequest) {
        const startTime = Date.now()
        const ip = getClientIp(request)

        const auth = await validateApiKey(request)
        if (isApiError(auth)) return auth

        const log = (statusCode: number, errorMessage?: string) =>
            logApiRequest({ apiKeyId: auth.apiKeyId, userId: auth.userId, endpoint, method: 'POST', statusCode, responseTimeMs: Date.now() - startTime, ip, errorMessage })

        const rl = consumeRateLimit(`${rateLimitPrefix}:${auth.apiKeyId}`, RATE_LIMIT_PER_MINUTE, 60_000)
        if (!rl.allowed) {
            log(429, 'Rate limit exceeded')
            return apiError(429, `Rate limit exceeded (${RATE_LIMIT_PER_MINUTE}/min)`)
        }

        let body: any
        try {
            body = await request.json()
        } catch {
            log(400, 'Invalid JSON body')
            return apiError(400, 'Invalid request body')
        }

        const { network, recipient } = body || {}
        if (!recipient || typeof recipient !== 'string') {
            log(400, 'Missing recipient')
            return apiError(400, 'recipient phone number is required')
        }
        if (!network || typeof network !== 'string') {
            log(400, 'Missing network')
            return apiError(400, 'network is required')
        }

        const serverField = server ? { server } : {}

        // Non-MTN networks: no-op, always allowed — a developer checking a Telecel/AT number
        // shouldn't have to special-case the call. Mirrors shouldEvaluateWhitelistGate's
        // MTN-only scope in lib/mtn-whitelist-gate.ts.
        if (network.trim().toUpperCase() !== 'MTN') {
            log(200)
            return apiSuccess({ recipient, network, ...serverField, allowed: true })
        }

        const norm = normalizeMtnMsisdn(recipient)
        if (!norm.ok) {
            log(400, norm.reason)
            return apiError(400, `Invalid recipient: ${norm.reason}`)
        }

        const verification = server
            ? await verifyMtnWhitelistServer(server, [norm.msisdn])
            : await verifyMtnWhitelistMerged([norm.msisdn])

        if (verification.error || verification.results.length === 0) {
            if (server) {
                log(502, verification.error || 'No verdict returned')
                return apiError(502, `Server ${server} could not check this number right now. Please try again shortly.`)
            }
            // Merged: fail open at the HTTP layer too — an upstream outage must not read to the
            // developer as "not allowed" (a false negative could wrongly block a real customer).
            log(200, verification.error)
            return apiSuccess({ recipient, network: 'MTN', allowed: true })
        }

        log(200)
        return apiSuccess({ recipient, network: 'MTN', ...serverField, allowed: verification.results[0].allowed })
    }
}

const RATE_LIMIT_PREFIX = 'verify-number'

export const handleVerifyNumber = createVerifyNumberHandler({
    endpoint: '/api/v2/data/verify-number',
    rateLimitPrefix: RATE_LIMIT_PREFIX,
})

export const handleVerifyNumberServer1 = createVerifyNumberHandler({
    endpoint: '/api/v2/data/verify-number/server-1',
    rateLimitPrefix: RATE_LIMIT_PREFIX,
    server: 1,
})

export const handleVerifyNumberServer2 = createVerifyNumberHandler({
    endpoint: '/api/v2/data/verify-number/server-2',
    rateLimitPrefix: RATE_LIMIT_PREFIX,
    server: 2,
})
