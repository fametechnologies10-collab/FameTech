// lib/api-handlers/sms-senders.ts
// Handler for GET /api/v2/sms/senders.
// See lib/api-handlers/packages.ts for why handlers live here.
//
// Lists the sender IDs this API key may send under (approved own senders +
// shared pool), so integrators can discover valid `sender` values before
// calling /sms/send, where an unapproved sender is rejected.
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
import { loadUserSmsSettings } from '@/lib/sms-policy'
import { versionMeta } from '@/lib/api-version'

const SENDER_LIMIT = 30

export async function handleSmsSenders(request: NextRequest) {
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
        // Version-agnostic bucket key (was 'v1-sms-senders') — one shared handler
        // means one shared bucket across both base URLs.
        const rl = consumeRateLimit(`sms-senders:${apiKeyId}`, auth.rateLimits.status, 60_000)
        if (!rl.allowed) { done(429, 'Rate limited'); return apiError(429, `Rate limit exceeded (${auth.rateLimits.status}/min)`) }

        const { data: account } = await (supabase as any).from('sms_accounts')
            .select('id, mode, default_sender').eq('user_id', userId).maybeSingle()
        if (!account) {
            done(200)
            return apiSuccess({ mode: null, senders: [], note: 'SMS account not initialised — open the SMS dashboard first' }, meta)
        }

        const [{ data: own }, settings] = await Promise.all([
            // Bounded at 30 for consistency with the list endpoints, but this one is
            // DEFENSIVE only, not a real truncation: the query is already scoped to
            // the caller's own account, and the busiest account in production has 2
            // approved sender IDs (max 2, avg 1.5). It exists so the response cannot
            // grow unbounded if an account ever accumulates them — not to page.
            (supabase as any).from('sms_sender_ids')
                .select('sender_text, is_default').eq('account_id', account.id).eq('status', 'approved')
                .limit(SENDER_LIMIT),
            loadUserSmsSettings(supabase),
        ])

        const senders = [
            ...(((own as any[]) || []).map(r => ({ sender: r.sender_text, type: 'own', isDefault: r.is_default }))),
            ...settings.defaultSenders.map(p => ({ sender: p, type: 'pool', isDefault: false })),
        ]

        done(200)
        return apiSuccess({
            mode: account.mode,
            defaultSender: account.default_sender,
            senders,
            note: account.mode !== 'business'
                ? 'Custom senders require business mode — register your business on the SMS dashboard.'
                : undefined,
        }, meta)
    } catch (e: any) {
        console.error('[API SMS Senders] error:', e?.message)
        done(500, e?.message)
        return apiError(500, 'Internal error')
    }
}
