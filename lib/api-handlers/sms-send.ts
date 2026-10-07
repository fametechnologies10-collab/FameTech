// lib/api-handlers/sms-send.ts
// Handler for POST /api/v2/sms/send.
// See lib/api-handlers/packages.ts for why handlers live here.
//
// Auth: API key. Additional gate: the key owner's SMS account must be in
// BUSINESS mode (approved domain + description registration). Shares
// lib/sms-campaign-pipeline with the dashboard, so filtering (telco-only
// profile), atomic billing, delivery records and rate counters are identical —
// this route has never had its own billing logic and still doesn't.
//
// Body: {
//   message:    string (3–1000 chars)
//   recipients: string | string[]   (Ghana numbers, up to the business cap)
//   sender?:    string              (own approved sender ID or a pool sender;
//                                    defaults to the account's default sender)
//   reference?: string              (1–100 chars, idempotency key)
// }
// Returns: { campaignId, status, recipients, segments, creditsCharged,
//            sender, sent?, failed?, balance }
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
import { createCampaign, getSmsAccountContext } from '@/lib/sms-campaign-pipeline'
import { versionMeta } from '@/lib/api-version'

export async function handleSmsSend(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)
    const endpoint = request.nextUrl.pathname
    const meta = versionMeta(endpoint)

    const auth = await validateApiKey(request)
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint, method: 'POST', statusCode: auth.status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Authentication failed' })
        return auth
    }
    const { userId, apiKeyId, supabase } = auth

    const done = (statusCode: number, errorMessage?: string) =>
        logApiRequest({ apiKeyId, userId, endpoint, method: 'POST', statusCode, responseTimeMs: Date.now() - startTime, ip, errorMessage })

    const keyTypeError = requireKeyType(auth, 'sms')
    if (keyTypeError) {
        done(403, 'Requires sms API key')
        return keyTypeError
    }

    try {
        // Per-key SMS rate limit (resolved: per-key override > global > fallback 30/min).
        // Version-agnostic bucket key (was 'v1-sms') — one shared handler must mean
        // one shared bucket, or a developer doubles their send allowance simply by
        // splitting traffic across the two base URLs. This endpoint SPENDS PREPAID
        // CREDITS, so a doubled allowance is a doubled spend rate, not just extra load.
        const rl = consumeRateLimit(`sms-send:${apiKeyId}`, auth.rateLimits.sms, 60_000)
        if (!rl.allowed) {
            done(429, 'Rate limited')
            return apiError(429, `Rate limit exceeded (${auth.rateLimits.sms}/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`)
        }

        let body: any
        try { body = await request.json() } catch {
            done(400, 'Invalid JSON')
            return apiError(400, 'Invalid request body')
        }

        const message = typeof body?.message === 'string' ? body.message : ''
        const rawRecipients = Array.isArray(body?.recipients) ? body.recipients
            : typeof body?.recipients === 'string' ? [body.recipients] : []
        const sender = typeof body?.sender === 'string' ? body.sender : null
        const reference = typeof body?.reference === 'string' ? body.reference.trim() : null

        if (message.trim().length < 3 || message.length > 1000) {
            done(400, 'Invalid message')
            return apiError(400, 'message must be 3–1000 characters')
        }
        if (rawRecipients.length === 0 || rawRecipients.length > 10000) {
            done(400, 'Invalid recipients')
            return apiError(400, 'recipients must contain 1–10,000 Ghana phone numbers')
        }
        if (reference && (reference.length < 1 || reference.length > 100)) {
            done(400, 'Invalid reference')
            return apiError(400, 'reference must be 1–100 characters')
        }

        const ctxRes = await getSmsAccountContext(supabase, userId)
        if (!ctxRes.ok) {
            done(ctxRes.status, ctxRes.error)
            return apiError(ctxRes.status, ctxRes.error)
        }
        if (ctxRes.ctx.account.mode !== 'business') {
            done(403, 'Not business mode')
            return apiError(403, 'Your business approval is no longer active — check your SMS dashboard')
        }
        const outcome = await createCampaign({
            db: supabase,
            userId,
            ctx: ctxRes.ctx,
            message,
            recipients: rawRecipients.map(String),
            requestedSender: sender,
            source: 'api',
            idempotencyReference: reference,
        })

        if (!outcome.ok) {
            done(outcome.status, outcome.error)
            return apiError(outcome.status, outcome.error || 'Send failed')
        }

        done(200)
        return apiSuccess({
            campaignId: outcome.campaign!.id,
            status: outcome.campaign!.status,
            recipients: outcome.campaign!.recipients,
            segments: outcome.campaign!.segments,
            creditsCharged: outcome.campaign!.credits_charged,
            sender: outcome.campaign!.sender,
            sent: outcome.campaign!.sent,
            failed: outcome.campaign!.failed,
            balance: outcome.campaign!.balance,
        }, meta)
    } catch (e: any) {
        console.error('[API SMS Send] error:', e?.message)
        done(500, e?.message)
        return apiError(500, 'Internal error')
    }
}
