/**
 * Hubtel Commission Services — Utility Bills (ECG / Ghana Water / DSTV / GOtv /
 * StarTimes) query + pay HTTP client.
 *
 * Structurally cloned from lib/hubtel-commission-service.ts (the airtime sibling): raw
 * `https.request` (not fetch), Basic auth (HUBTEL_API_ID:HUBTEL_API_KEY), the Fixie
 * static-IP proxy when HUBTEL_PROXY_URL is set, and a module-level circuit breaker. The
 * breaker here is a SEPARATE instance from airtime's — a utility outage must never trip
 * (or count towards) airtime's breaker, and vice versa.
 *
 * `classifyResponseCode` is the single source of truth for Hubtel response-code semantics
 * across the whole utility-bills feature (dispatch pipeline, webhook, cron all import it).
 * Per Hubtel's docs: 0000 = success, 0001 = pending (callback finalizes), 0005 = state
 * UNKNOWN (never terminal-fail — caller must keep the order in-flight + status-check),
 * 4075 = insufficient float, 4101/4103 = credentials/permission problems (not float),
 * 4000/4010 = validation failures (do not retry), anything else non-0000 = FAILED per
 * Hubtel's own convention ("not 0000 = FAILED").
 *
 * This module never throws to callers on provider/network problems — every path returns a
 * typed result so the dispatch pipeline (Task A5) can cleanly decide retry vs fail vs pause.
 */
import https from 'https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { UtilityBiller, UTILITY_BILLERS, serviceIdFor, parseAccountQuery, UtilityAccountInfo } from '@/lib/hubtel-utility/billers'
import { toMsisdn233, parseCommission, buildSignedCallbackUrl } from '@/lib/hubtel-commission-service'
import { buildGuestEmail } from '@/lib/shop-checkout'

const CS_PATH_PREFIX = '/commissionservices'

// ── Response-code classification ─────────────────────────────────────────────

export type CommissionOutcome =
    | 'completed' // rc 0000
    | 'pending' // rc 0001 (callback will finalize)
    | 'unknown' // rc 0005 — state UNKNOWN: caller must keep order in-flight + status-check; NEVER fail/refund
    | 'insufficient_float' // rc 4075 (or message matches /insufficient/i)
    | 'config_error' // rc 4101 | 4103 (auth/permission — credentials problem, NOT float)
    | 'permanent_failure' // rc 4000 | 4010 (validation — do not retry)
    | 'failed' // rc 2000 | 2001 | any other non-0000 rc (terminal per Hubtel: "not 0000 = FAILED")

const RESPONSE_CODE_MAP: Record<string, CommissionOutcome> = {
    '0000': 'completed',
    '0001': 'pending',
    '0005': 'unknown',
    '4075': 'insufficient_float',
    '4101': 'config_error',
    '4103': 'config_error',
    '4000': 'permanent_failure',
    '4010': 'permanent_failure',
}

/**
 * String(rc) exact-match against the table above (default 'failed' for any other code,
 * including non-string/undefined/null rc). A message matching /insufficient/i upgrades the
 * outcome to 'insufficient_float' ONLY when the table classified it as generic 'failed'
 * (Hubtel sometimes signals float exhaustion via a generic failure code like 2000/2001 plus
 * a human-readable message — mirrors the airtime service, where the insufficient check only
 * runs in the failure branch). Specifically-mapped codes always keep their table outcome:
 * '0005' (unknown — the NEVER-fail/refund state), '0000'/'0001' (success/pending) and
 * '4101'/'4103' (config_error) must never be reclassified by message text.
 */
export function classifyResponseCode(rc: unknown, message?: unknown): CommissionOutcome {
    const outcome: CommissionOutcome = RESPONSE_CODE_MAP[String(rc)] ?? 'failed'
    if (outcome === 'failed' && typeof message === 'string' && /insufficient/i.test(message)) {
        return 'insufficient_float'
    }
    return outcome
}

// ── Result shapes ─────────────────────────────────────────────────────────────

export interface UtilityQueryResult {
    success: boolean
    info?: UtilityAccountInfo // parseAccountQuery(biller, response.Data) when rc 0000
    error?: string
    isRateLimited?: boolean // HTTP 429
    isNetworkError?: boolean // socket/timeout/non-JSON — transient
}

export interface UtilityFulfillResult {
    success: boolean // true only for outcome 'completed' | 'pending'
    pending: boolean // true only for outcome 'pending'
    outcome: CommissionOutcome | 'network_error' | 'rate_limited' | 'not_configured'
    transactionId?: string // Data.TransactionId (trimmed — samples contain leading spaces)
    commission?: number // parseCommission(Data.Meta) — sync-response value; callers treat CALLBACK as canonical
    error?: string
    isInsufficientFloat?: boolean // outcome === 'insufficient_float'
    isRateLimited?: boolean // outcome === 'rate_limited' (HTTP 429)
    isPermanentFailure?: boolean // outcome === 'permanent_failure'
    isUnknownState?: boolean // outcome === 'unknown'
    isConfigError?: boolean // outcome === 'config_error'
    apiResponse?: unknown
}

// ── Circuit breaker (separate instance from airtime's — do not share counters) ─

let failureCount = 0
let circuitOpenedAt = 0
const FAILURE_THRESHOLD = 5
const RECOVERY_MS = 60_000

function isBreakerOpen(): boolean {
    return failureCount >= FAILURE_THRESHOLD && Date.now() - circuitOpenedAt < RECOVERY_MS
}
function recordBreakerFailure(): void {
    failureCount++
    if (failureCount >= FAILURE_THRESHOLD) circuitOpenedAt = Date.now()
}
function recordBreakerSuccess(): void {
    failureCount = 0
}

// ── Config ──────────────────────────────────────────────────────────────────

interface UtilityConfig {
    account: string
    serviceId: string
    credentials: string // base64 Basic-auth credentials
}

/**
 * Missing HUBTEL_API_ID/KEY, HUBTEL_DISBURSEMENT_ACCOUNT, or serviceId counts as "not
 * configured" — fail closed rather than firing half-wired requests. The callback-signing
 * secret (HUBTEL_COMMISSION_WEBHOOK_SECRET) is only required for PAY requests
 * (`requireCallbackSecret: true`): read-only account lookups never issue a CallbackUrl,
 * so they must not depend on the inbound-webhook secret.
 */
function getConfig(biller: UtilityBiller, opts?: { requireCallbackSecret?: boolean }): UtilityConfig | null {
    const apiId = process.env.HUBTEL_API_ID
    const apiKey = process.env.HUBTEL_API_KEY
    const account = process.env.HUBTEL_DISBURSEMENT_ACCOUNT
    const serviceId = serviceIdFor(biller)
    if (!apiId || !apiKey || !account || !serviceId) return null
    if (opts?.requireCallbackSecret && !process.env.HUBTEL_COMMISSION_WEBHOOK_SECRET) return null
    return { account, serviceId, credentials: Buffer.from(`${apiId}:${apiKey}`).toString('base64') }
}

// ── Pure request-shaping helpers ────────────────────────────────────────────

/**
 * '/commissionservices/{acct}/{serviceId}?destination=...' (+ '&mobile=...' when `mobile` is
 * given), all values URL-encoded. `destination` is toMsisdn233'd when the biller is queried
 * BY phone (ecg); otherwise passed through verbatim (account/meter/smartcard number). `mobile`
 * (ghana_water's customer phone) is always toMsisdn233'd when present.
 */
export function buildQueryPath(biller: UtilityBiller, destination: string, mobile?: string): string {
    const def = UTILITY_BILLERS[biller]
    const account = process.env.HUBTEL_DISBURSEMENT_ACCOUNT || ''
    const serviceId = serviceIdFor(biller)
    const dest = def.queryBy === 'phone' ? toMsisdn233(destination) : destination
    let path = `${CS_PATH_PREFIX}/${account}/${serviceId}?destination=${encodeURIComponent(dest)}`
    if (mobile) {
        path += `&mobile=${encodeURIComponent(toMsisdn233(mobile))}`
    }
    return path
}

/**
 * Shapes the POST body per Hubtel's per-biller Extradata contract:
 *   - Destination: payDestination === 'phone' -> toMsisdn233(phone) (ecg, ghana_water);
 *                  else trimmed account (dstv, gotv, startimes).
 *   - Amount: 2dp-rounded (Math.round(x*100)/100). CallbackUrl/ClientReference verbatim.
 *   - Extradata by BillerDef.extradata: 'none' omits the key entirely; 'meter' (ecg) ->
 *     { bundle: account }; 'ghana_water' -> { bundle: account, Email, SessionId } (all three
 *     required at the caller layer — this function just passes through whatever it's given).
 */
export function buildPayBody(args: {
    biller: UtilityBiller
    account: string
    phone?: string
    email?: string
    amountGhs: number
    clientReference: string
    callbackUrl: string
    sessionId?: string
}): Record<string, unknown> {
    const def = UTILITY_BILLERS[args.biller]
    const destination = def.payDestination === 'phone' ? toMsisdn233(args.phone || '') : String(args.account || '').trim()

    const body: Record<string, unknown> = {
        Destination: destination,
        Amount: Math.round(args.amountGhs * 100) / 100,
        CallbackUrl: args.callbackUrl,
        ClientReference: args.clientReference,
    }

    if (def.extradata === 'meter') {
        body.Extradata = { bundle: args.account }
    } else if (def.extradata === 'ghana_water') {
        body.Extradata = { bundle: args.account, Email: args.email, SessionId: args.sessionId }
    }
    // 'none' (dstv/gotv/startimes): omit the key entirely.

    return body
}

// ── Proxy-aware https helper (clone of the airtime request shape) ──────────

interface RawResponse {
    status: number
    body: any
    isNetworkError: boolean // socket/timeout/non-JSON — transient, breaker-countable
}

function requestHubtel(method: 'GET' | 'POST', path: string, credentials: string, bodyStr?: string): Promise<RawResponse> {
    const proxyUrl = process.env.HUBTEL_PROXY_URL
    const options: https.RequestOptions = {
        hostname: 'cs.hubtel.com',
        port: 443,
        path,
        method,
        headers: {
            Accept: 'application/json',
            Authorization: `Basic ${credentials}`,
            ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
        ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
    }

    return new Promise<RawResponse>((resolve) => {
        const req = https.request(options, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
                const status = res.statusCode ?? 0
                let body: any = null
                let parseFailed = false
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
                } catch {
                    parseFailed = true
                }
                resolve({ status, body, isNetworkError: parseFailed })
            })
        })
        req.on('error', () => {
            resolve({ status: 0, body: null, isNetworkError: true })
        })
        if (bodyStr) req.write(bodyStr)
        req.end()
    })
}

function isPlausibleEmail(email: string | undefined): email is string {
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

// ── queryUtilityAccount ───────────────────────────────────────────────────────

/** GET + parse core, using an already-resolved config (shared by the exported lookup and
 * fulfillUtilityCommission's ghana_water fresh-session step, which resolves config once). */
async function runAccountQuery(biller: UtilityBiller, destination: string, mobile: string | undefined, config: UtilityConfig): Promise<UtilityQueryResult> {
    const path = buildQueryPath(biller, destination, mobile)
    const res = await requestHubtel('GET', path, config.credentials)

    if (res.status === 429) {
        return { success: false, isRateLimited: true, error: 'Rate limited' }
    }
    if (res.isNetworkError || !res.body) {
        recordBreakerFailure()
        return { success: false, isNetworkError: true, error: 'Network error contacting Hubtel' }
    }

    const rc = String(res.body?.ResponseCode ?? '')
    if (rc === '0000') {
        recordBreakerSuccess()
        return { success: true, info: parseAccountQuery(biller, res.body?.Data) }
    }
    return { success: false, error: res.body?.Message || 'Lookup failed' }
}

/**
 * `destination`: what goes in `?destination=` — ecg: customer phone (toMsisdn233'd); ghana_water:
 * meter number; dstv/gotv/startimes: account number.
 * `mobile`: REQUIRED for ghana_water (customer phone, toMsisdn233'd into &mobile=); ignored for others.
 * Read-only: does NOT require HUBTEL_COMMISSION_WEBHOOK_SECRET (lookups issue no CallbackUrl).
 */
export async function queryUtilityAccount(biller: UtilityBiller, destination: string, mobile?: string): Promise<UtilityQueryResult> {
    const def = UTILITY_BILLERS[biller]
    if (def.queryNeedsMobile && !mobile) {
        return { success: false, error: 'Ghana Water lookup requires customer phone' }
    }

    if (isBreakerOpen()) {
        return { success: false, isNetworkError: true, error: 'Circuit breaker open — retry later' }
    }

    const config = getConfig(biller)
    if (!config) {
        return { success: false, error: 'Hubtel Utility not configured' }
    }

    return runAccountQuery(biller, destination, mobile, config)
}

// ── fulfillUtilityCommission ─────────────────────────────────────────────────

export async function fulfillUtilityCommission(args: {
    biller: UtilityBiller
    account: string // meter / smartcard / GW meter
    phone?: string // customer phone — REQUIRED for ecg + ghana_water
    email?: string // ghana_water Extradata.Email; fallback: synthesize via buildGuestEmail
    amountGhs: number
    clientReference: string
}): Promise<UtilityFulfillResult> {
    const { biller, account, phone, amountGhs, clientReference } = args
    const def = UTILITY_BILLERS[biller]

    // 1. Circuit breaker open -> transient; do NOT count as a new failure.
    if (isBreakerOpen()) {
        return { success: false, pending: false, outcome: 'network_error', error: 'Circuit breaker open — retry later' }
    }

    // 2. Config check — pay requests need the callback-signing secret too (the CallbackUrl we
    // issue is HMAC-signed with it; without it the webhook rejects the callback with 503).
    const config = getConfig(biller, { requireCallbackSecret: true })
    if (!config) {
        return { success: false, pending: false, outcome: 'not_configured', error: 'Hubtel Utility not configured' }
    }

    // 3. ecg/ghana_water without phone -> permanent_failure (validation, caller bug).
    if ((biller === 'ecg' || biller === 'ghana_water') && !phone) {
        return {
            success: false,
            pending: false,
            outcome: 'permanent_failure',
            isPermanentFailure: true,
            error: `${def.label} requires a customer phone number`,
        }
    }

    // 4. ghana_water only: fetch a FRESH sessionId (unique per query, mandatory) before paying.
    // Reuses the config resolved above (same biller) instead of re-deriving it.
    let sessionId: string | undefined
    let email = args.email
    if (biller === 'ghana_water') {
        const queryResult = await runAccountQuery('ghana_water', account, phone, config)
        sessionId = queryResult.info?.sessionId ?? undefined
        if (!sessionId) {
            return {
                success: false,
                pending: false,
                outcome: 'network_error',
                error: 'Could not obtain Ghana Water session — retry',
            }
        }
        if (!isPlausibleEmail(email)) {
            email = buildGuestEmail(`util-${biller}`, phone as string)
        }
    }

    // 5. POST via the proxy-aware https helper.
    const callbackUrl = buildSignedCallbackUrl(clientReference)
    const bodyStr = JSON.stringify(
        buildPayBody({ biller, account, phone, email, amountGhs, clientReference, callbackUrl, sessionId })
    )
    const path = `${CS_PATH_PREFIX}/${config.account}/${config.serviceId}`
    const res = await requestHubtel('POST', path, config.credentials, bodyStr)

    if (res.status === 429) {
        return { success: false, pending: false, outcome: 'rate_limited', isRateLimited: true, error: 'Rate limited', apiResponse: res.body }
    }
    if (res.status === 401) {
        return { success: false, pending: false, outcome: 'config_error', isConfigError: true, error: 'Hubtel credentials rejected' }
    }
    if (res.isNetworkError || !res.body) {
        recordBreakerFailure()
        return { success: false, pending: false, outcome: 'network_error', error: 'Network error contacting Hubtel' }
    }

    // 6. Parse body; classify; map to flags. Breaker: success/pending/unknown reset the failure
    // count; only 'failed' (unclassified rc) and network errors count as breaker failures — float
    // exhaustion and validation mistakes are not provider outages, so they leave the breaker alone.
    const data = res.body
    const outcome = classifyResponseCode(data?.ResponseCode, data?.Message)

    if (outcome === 'completed' || outcome === 'pending' || outcome === 'unknown') {
        recordBreakerSuccess()
    } else if (outcome === 'failed') {
        recordBreakerFailure()
    }

    const rawTransactionId = data?.Data?.TransactionId
    const transactionId = typeof rawTransactionId === 'string' ? rawTransactionId.trim() : rawTransactionId
    const commission = parseCommission(data?.Data?.Meta)
    const success = outcome === 'completed' || outcome === 'pending'

    return {
        success,
        pending: outcome === 'pending',
        outcome,
        transactionId,
        commission,
        error: success ? undefined : data?.Message || `ResponseCode ${data?.ResponseCode}`,
        isInsufficientFloat: outcome === 'insufficient_float',
        isPermanentFailure: outcome === 'permanent_failure',
        isUnknownState: outcome === 'unknown',
        isConfigError: outcome === 'config_error',
        apiResponse: data,
    }
}
