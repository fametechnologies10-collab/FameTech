// lib/api-handlers/sms-campaigns.ts
// Handler for GET /api/v2/sms/campaigns.
// See lib/api-handlers/packages.ts for why handlers live here.
//
// Lists recent campaigns for the caller's SMS account. Complements
// GET /sms/messages/{campaignId}, which requires already knowing a campaign id
// — this lets an integrator discover recent sends without tracking every
// campaignId client-side.
//
// Query: page (0-based, 30/page, default 0), status (optional filter),
// from/to (optional ISO date range on created_at).
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
import { getSmsAccountContext } from '@/lib/sms-campaign-pipeline'
import { versionMeta } from '@/lib/api-version'

// 30 to match MAX_RECORDS on every v2 list endpoint. Lowered from 50 rather
// than capped with a hard .limit() so paging still reaches every campaign —
// callers who want more walk ?page=, and webhooks cover the live updates.
const PAGE_SIZE = 30
const VALID_STATUSES = ['queued', 'processing', 'completed', 'failed', 'blocked'] as const

export async function handleSmsCampaigns(request: NextRequest) {
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
        // Version-agnostic bucket key (was 'v1-sms-campaigns') — one shared
        // handler means one shared bucket across both base URLs.
        const rl = consumeRateLimit(`sms-campaigns:${apiKeyId}`, auth.rateLimits.status, 60_000)
        if (!rl.allowed) { done(429, 'Rate limited'); return apiError(429, `Rate limit exceeded (${auth.rateLimits.status}/min)`) }

        const ctxRes = await getSmsAccountContext(supabase, userId)
        if (!ctxRes.ok) {
            done(ctxRes.status, ctxRes.error)
            return apiError(ctxRes.status, ctxRes.error)
        }

        const url = new URL(request.url)
        const page = Math.min(10000, Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0))
        const statusFilter = url.searchParams.get('status')
        const from = url.searchParams.get('from')
        const to = url.searchParams.get('to')

        if (statusFilter && !(VALID_STATUSES as readonly string[]).includes(statusFilter)) {
            done(400, 'Invalid status filter')
            return apiError(400, `status must be one of: ${VALID_STATUSES.join(', ')}`)
        }
        if (from && isNaN(Date.parse(from))) {
            done(400, 'Invalid from date')
            return apiError(400, 'from must be a valid ISO date string')
        }
        if (to && isNaN(Date.parse(to))) {
            done(400, 'Invalid to date')
            return apiError(400, 'to must be a valid ISO date string')
        }

        let q = (supabase as any).from('sms_campaigns')
            .select('id, status, recipients_count, segments, credits_charged, sender_used, source, scheduled_at, created_at')
            .eq('account_id', ctxRes.ctx.account.id)
            .order('created_at', { ascending: false })
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

        if (statusFilter) {
            q = q.eq('status', statusFilter)
        }
        if (from) q = q.gte('created_at', from)
        if (to) q = q.lte('created_at', to)

        const { data: campaigns, error } = await q
        if (error) {
            console.error('[API SMS Campaigns] query error:', error.message)
            done(500, error.message)
            return apiError(500, 'Internal error')
        }

        done(200)
        return apiSuccess({ campaigns: campaigns ?? [], page }, meta)
    } catch (e: any) {
        console.error('[API SMS Campaigns] error:', e?.message)
        done(500, e?.message)
        return apiError(500, 'Internal error')
    }
}
