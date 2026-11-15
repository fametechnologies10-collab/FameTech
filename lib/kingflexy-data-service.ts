/**
 * KingFlexyGH Standard-key data API — fulfillment supplier service.
 *
 * The first section is PURE (no top-level I/O or env reads) so it is importable from plain `npx tsx` tests.
 * The HTTP client + circuit breaker follow it; they read env and call fetch only at call time.
 */
import { createHmac, timingSafeEqual } from 'crypto'

export const KF_DATA_NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime'] as const
export type KfDataNetwork = (typeof KF_DATA_NETWORKS)[number]

export function assertSupportedNetwork(network: string): network is KfDataNetwork {
    return (KF_DATA_NETWORKS as readonly string[]).includes(network)
}

/** "5GB" / "1.5GB" / "10 GB" -> GB number; anything else (MB, empty, zero) -> null. */
export function sizeToVolumeGb(size: string): number | null {
    const m = String(size ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*GB$/i)
    if (!m) return null
    const n = Number(m[1])
    return Number.isFinite(n) && n > 0 ? n : null
}

/** Normalises +233/233/0 forms to 10-digit local (0XXXXXXXXX). Prefix not validated beyond shape. */
export function toLocalRecipient(phone: string): string | null {
    let d = String(phone ?? '').replace(/[\s\-()]/g, '')
    if (d.startsWith('+')) d = d.slice(1)
    if (!/^\d+$/.test(d)) return null
    if (d.startsWith('233') && d.length === 12) d = '0' + d.slice(3)
    return /^0\d{9}$/.test(d) ? d : null
}

/**
 * Reference sent to KingFlexy. `attemptNo` must come from orders.retry_count (written only by
 * claim_order_retry) so cron replays reuse the same reference and a deliberate retry gets a new one.
 */
export function buildKingflexyReference(orderId: string, attemptNo?: number): string {
    const n = Number(attemptNo)
    const safe = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    return `${orderId}-r${safe}`
}

export function extractOrderIdFromReference(reference: string): string | null {
    const m = String(reference ?? '').match(/^([0-9a-f-]{36})-r\d+$/i)
    return m ? m[1] : null
}

export function extractAttemptNoFromReference(reference: string): number | null {
    const m = String(reference ?? '').match(/^[0-9a-f-]{36}-r(\d+)$/i)
    if (!m) return null
    const n = Number(m[1])
    return Number.isFinite(n) ? n : null
}

export type KfResolvedStatus = 'processing' | 'completed' | 'failed'

/**
 * KingFlexy data statuses: pending|queued|blacklisted|processing|completed|failed|refunded.
 * `failed` is NOT final (supplier retries automatically); `refunded` is the only terminal failure.
 * Unknown values stay 'processing' — never a false success or failure.
 */
export function mapKingflexyStatus(raw: unknown): KfResolvedStatus {
    const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (s === 'completed') return 'completed'
    if (s === 'refunded') return 'failed'
    return 'processing'
}

export type PurchaseOutcome =
    | 'accepted' | 'rejected' | 'retryable_hold' | 'config_error'
    | 'rate_limited' | 'paused' | 'ambiguous'

/**
 * Classifies a /data/purchase response. Only `ambiguous` (transport faults and 5xx) counts
 * toward the circuit breaker; every other outcome never does.
 */
export function classifyPurchase(httpStatus: number, body: any): { outcome: PurchaseOutcome; status?: string } {
    if (httpStatus === 200) {
        if (body && body.success === true) {
            const st = body.data?.status
            return { outcome: 'accepted', status: typeof st === 'string' ? st : undefined }
        }
        return { outcome: 'ambiguous' }
    }
    if (httpStatus === 400 || httpStatus === 404) return { outcome: 'rejected' }
    if (httpStatus === 401 || httpStatus === 403) return { outcome: 'config_error' }
    if (httpStatus === 409) {
        const msg = body?.error?.message
        return { outcome: typeof msg === 'string' && /registered/i.test(msg) ? 'retryable_hold' : 'rejected' }
    }
    if (httpStatus === 429) return { outcome: 'rate_limited' }
    if (httpStatus === 503) return { outcome: 'paused' }
    return { outcome: 'ambiguous' }
}

/** X-KFT-Signature = lowercase hex HMAC-SHA256 of the exact raw body. Constant-time; never throws. */
export function verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | null | undefined,
    secret: string,
): boolean {
    try {
        if (!secret || typeof signatureHeader !== 'string' || typeof rawBody !== 'string') return false
        const given = signatureHeader.trim().toLowerCase()
        if (!/^[0-9a-f]{64}$/.test(given)) return false
        const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
        const a = Buffer.from(given, 'utf8')
        const b = Buffer.from(expected, 'utf8')
        if (a.length !== b.length) return false
        return timingSafeEqual(a, b)
    } catch {
        return false
    }
}

const ZONELESS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

/** True if the event is < 10 min old. Unparseable -> false. Zone-less timestamps are read as UTC. */
export function shouldRedeliver(eventTimestamp: unknown, nowMs: number): boolean {
    let ms: number
    if (typeof eventTimestamp === 'string') {
        const t = eventTimestamp.trim()
        ms = Date.parse(ZONELESS.test(t) ? t.replace(' ', 'T') + 'Z' : t)
    } else if (eventTimestamp instanceof Date) {
        ms = eventTimestamp.getTime()
    } else {
        return false
    }
    if (!Number.isFinite(ms)) return false
    return nowMs - ms < 10 * 60 * 1000
}

// ─── I/O (HTTP client + circuit breaker) ──────────────────────────────────────────────────────
// Auth is the RAW key in `Authorization` (NO "Bearer"). Key = KINGFLEXY_DATA_API_KEY, read at
// CALL time. Never confuse with KINGFLEXY_API_KEY (SMS) / KINGFLEXY_COMMISSION_API_KEY.
// SECURITY: never log headers/config/key; every error string returned here is generic.

const KF_BASE_URL = 'https://api.kingflexygh.com/api/v2'
const KF_TIMEOUT_MS = 20000

// Breaker: gates ONLY placeOrder. Because purchases carry a client idempotency key (reference),
// only `ambiguous` outcomes (transport faults, 5xx, non-JSON) count; reads are never gated.
let circuitState: 'closed' | 'open' | 'half-open' = 'closed'
let failureCount = 0
let lastFailureTime: number | null = null
const FAILURE_THRESHOLD = 5
const RECOVERY_TIMEOUT = 60000

function checkCircuit(): boolean {
    if (circuitState === 'closed') return true
    if (circuitState === 'open') {
        if (lastFailureTime && Date.now() - lastFailureTime > RECOVERY_TIMEOUT) {
            circuitState = 'half-open'
            return true
        }
        return false
    }
    return true
}

function recordSuccess() {
    failureCount = 0
    circuitState = 'closed'
}

function recordFailure() {
    failureCount++
    lastFailureTime = Date.now()
    if (circuitState === 'half-open' || failureCount >= FAILURE_THRESHOLD) circuitState = 'open'
}

/** Test-only: reset module-level breaker state. */
export function __resetKingflexyBreakerForTests() {
    circuitState = 'closed'
    failureCount = 0
    lastFailureTime = null
}

function getKey(): string {
    return (process.env.KINGFLEXY_DATA_API_KEY || '').trim()
}

/** One request. Never throws. body is null when the response was not parseable JSON. */
async function kfRequest(method: 'GET' | 'POST', path: string, key: string, payload?: unknown): Promise<
    { transportFault: true } | { transportFault: false; status: number; body: any }
> {
    try {
        const headers: Record<string, string> = { Authorization: key, Accept: 'application/json' }
        if (payload !== undefined) headers['Content-Type'] = 'application/json'
        const res = await fetch(`${KF_BASE_URL}${path}`, {
            method,
            headers,
            body: payload !== undefined ? JSON.stringify(payload) : undefined,
            signal: AbortSignal.timeout(KF_TIMEOUT_MS),
        })
        let body: any = null
        try {
            const text = await res.text()
            body = text ? JSON.parse(text) : null
        } catch {
            body = null
        }
        return { transportFault: false, status: res.status, body }
    } catch {
        return { transportFault: true }
    }
}

export interface KingflexySendResult {
    success: boolean
    outcome: PurchaseOutcome
    status?: string
    error?: string
    transportFault?: boolean
    apiResponse?: any
}

export async function placeOrder(input: {
    recipient: string
    network: KfDataNetwork
    volumeGb: number
    reference: string
}): Promise<KingflexySendResult> {
    const key = getKey()
    if (!key) return { success: false, outcome: 'config_error', error: 'KingFlexy data API key not configured' }
    if (!checkCircuit()) {
        return { success: false, outcome: 'paused', error: 'KingFlexy circuit breaker open' }
    }

    const r = await kfRequest('POST', '/data/purchase', key, {
        network: input.network,
        volume_gb: input.volumeGb,
        recipient: input.recipient,
        reference: input.reference,
    })

    if (r.transportFault) {
        recordFailure()
        return { success: false, outcome: 'ambiguous', transportFault: true, error: 'KingFlexy request failed (network/timeout)' }
    }

    const { outcome, status } = classifyPurchase(r.status, r.body)
    if (outcome === 'ambiguous') recordFailure()
    else recordSuccess()

    if (outcome === 'accepted') return { success: true, outcome, status, apiResponse: r.body }
    return {
        success: false,
        outcome,
        error: `KingFlexy purchase ${outcome.replace('_', ' ')} (HTTP ${r.status})`,
        apiResponse: r.body ?? undefined,
    }
}

export interface KingflexyStatusResult {
    success: boolean
    found: boolean
    status?: string
    error?: string
    apiResponse?: any
}

export async function checkOrderStatus(reference: string): Promise<KingflexyStatusResult> {
    const key = getKey()
    if (!key) return { success: false, found: false, error: 'KingFlexy data API key not configured' }

    const r = await kfRequest('GET', `/orders/${encodeURIComponent(reference)}`, key)
    if (r.transportFault) return { success: false, found: false, error: 'KingFlexy request failed (network/timeout)' }

    const env = r.body
    if (r.status === 200 && env && env.success === true && env.data) {
        const st = env.data.status
        return { success: true, found: true, status: typeof st === 'string' ? st : undefined, apiResponse: env }
    }
    // Only a 404 carrying the supplier's own JSON error envelope proves "never arrived".
    if (r.status === 404 && env && env.success === false && env.error && typeof env.error === 'object') {
        return { success: true, found: false, apiResponse: env }
    }
    return { success: false, found: false, error: `KingFlexy status check failed (HTTP ${r.status})`, apiResponse: env ?? undefined }
}

export async function fetchSupplierBalance(): Promise<{ success: boolean; balance?: number; currency?: string; error?: string }> {
    const key = getKey()
    if (!key) return { success: false, error: 'KingFlexy data API key not configured' }

    const r = await kfRequest('GET', '/wallet/balance', key)
    if (r.transportFault) return { success: false, error: 'KingFlexy request failed (network/timeout)' }

    const bal = Number(r.body?.data?.balance)
    if (r.status === 200 && r.body?.success === true && Number.isFinite(bal)) {
        const cur = r.body.data.currency
        return { success: true, balance: bal, currency: typeof cur === 'string' ? cur : undefined }
    }
    return { success: false, error: `KingFlexy balance check failed (HTTP ${r.status})` }
}
