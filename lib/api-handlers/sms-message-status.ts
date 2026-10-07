// lib/api-handlers/sms-message-status.ts
// Handler for GET /api/v2/sms/messages/{id}.
// See lib/api-handlers/packages.ts for why handlers live here.
//
// {id} = the campaignId returned by POST /sms/send. Returns the campaign
// summary, a delivery rollup, and up to PAGE_SIZE per-recipient statuses per
// page (?page=N&status=delivered|undelivered|…).
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
import { apiVersionFromPath, versionMeta } from '@/lib/api-version'

// 30 to match MAX_RECORDS on every v2 list endpoint. Was an inline 100 with no
// named constant. Paging still reaches every message via ?page= — only the page
// size shrank. The `delivery` rollup below is an exact per-status COUNT over the
// WHOLE campaign and is deliberately unaffected, so a caller can still see the
// true totals for a 10,000-recipient campaign without walking a single page.
const PAGE_SIZE = 30
const STATUSES = ['queued', 'sent', 'delivered', 'undelivered', 'failed', 'expired', 'rejected'] as const

export async function handleSmsMessageStatus(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const startTime = Date.now()
    const ip = getClientIp(request)
    // Normalised, NOT request.nextUrl.pathname — this path carries the caller's
    // campaign id, which would otherwise become a distinct high-cardinality
    // endpoint value in api_logs for every campaign ever polled. The v1 route
    // logged the '[id]' form; preserved, just made version-aware.
    const endpoint = `/api/${apiVersionFromPath(request.nextUrl.pathname)}/sms/messages/[id]`
    const meta = versionMeta(request.nextUrl.pathname)

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
        // Version-agnostic bucket key (was 'v1-sms-status') — one shared handler
        // means one shared bucket across both base URLs.
        const rl = consumeRateLimit(`sms-status:${apiKeyId}`, auth.rateLimits.status, 60_000)
        if (!rl.allowed) { done(429, 'Rate limited'); return apiError(429, `Rate limit exceeded (${auth.rateLimits.status}/min)`) }

        const { id } = await params
        if (!/^[0-9a-f-]{36}$/i.test(id)) { done(400, 'Bad id'); return apiError(400, 'Invalid campaign id') }

        const { data: account } = await (supabase as any).from('sms_accounts')
            .select('id').eq('user_id', userId).maybeSingle()
        if (!account) { done(404, 'No account'); return apiError(404, 'Campaign not found') }

        const { data: campaign } = await (supabase as any).from('sms_campaigns')
            .select('id, sender_used, recipients_count, segments, credits_charged, status, scheduled_at, source, created_at')
            .eq('id', id).eq('account_id', (account as any).id).maybeSingle()
        if (!campaign) { done(404, 'Not found'); return apiError(404, 'Campaign not found') }

        const counts = await Promise.all(STATUSES.map(s =>
            (supabase as any).from('sms_messages')
                .select('id', { count: 'exact', head: true })
                .eq('campaign_id', id).eq('status', s)))
        const rollup: Record<string, number> = {}
        STATUSES.forEach((s, i) => { if ((counts[i].count ?? 0) > 0) rollup[s] = counts[i].count as number })

        const url = new URL(request.url)
        const page = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0)
        const statusFilter = url.searchParams.get('status')
        let mq = (supabase as any).from('sms_messages')
            .select('recipient, status, status_detail, status_updated_at')
            .eq('campaign_id', id)
            .order('created_at', { ascending: true })
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
        if (statusFilter && (STATUSES as readonly string[]).includes(statusFilter)) {
            mq = mq.eq('status', statusFilter)
        }
        const { data: messages } = await mq

        done(200)
        return apiSuccess({ campaign, delivery: rollup, messages: messages ?? [], page }, meta)
    } catch (e: any) {
        console.error('[API SMS Status] error:', e?.message)
        done(500, e?.message)
        return apiError(500, 'Internal error')
    }
}
