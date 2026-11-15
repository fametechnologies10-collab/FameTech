/**
 * KingFlexyGH Standard-key data API — fulfillment supplier service.
 *
 * This section is PURE: no top-level I/O, no fetch, no env reads at import time, so it is
 * importable from plain `npx tsx` tests. The HTTP client is added below it in a later task.
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
