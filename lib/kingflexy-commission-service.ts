import crypto from 'crypto'
import type { UtilityBiller, UtilityAccountInfo, UtilityMeter } from '@/lib/hubtel-utility/billers'
import type { CommissionFulfillResult } from '@/lib/hubtel-commission-service'
import type { UtilityFulfillResult, UtilityQueryResult } from '@/lib/hubtel-utility/service'

// ---------------------------------------------------------------------------
// Pure helpers (no I/O)
// ---------------------------------------------------------------------------

export type KfOrderState = 'completed' | 'pending' | 'failed'

export function classifyKfOrderStatus(status: unknown): KfOrderState {
    if (status === 'completed') return 'completed'
    if (status === 'failed' || status === 'refunded') return 'failed'
    return 'pending'
}

export type KfSendOutcome =
    | 'accepted'
    | 'insufficient_balance'
    | 'rejected'
    | 'config_error'
    | 'rate_limited'
    | 'conflict'
    | 'biller_unavailable'
    | 'transient'

export function classifyKfSendResponse(httpStatus: number, body: unknown): KfSendOutcome {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    if (httpStatus >= 200 && httpStatus < 300) return b.success === true ? 'accepted' : 'transient'
    if (httpStatus === 401 || httpStatus === 403) return 'config_error'
    if (httpStatus === 409) return 'conflict'
    if (httpStatus === 429) return 'rate_limited'
    if (httpStatus === 503) return 'biller_unavailable'
    if (httpStatus === 400) {
        const msg = String(b.error ?? b.message ?? '')
        if (/insufficient/i.test(msg)) return 'insufficient_balance'
        if (/disabled/i.test(msg)) return 'biller_unavailable'
        return 'rejected'
    }
    if (httpStatus >= 400 && httpStatus < 500) return 'rejected'
    return 'transient'
}

export function verifyKingFlexySignature(
    rawBody: string,
    signatureHeader: string | null | undefined,
    secret: string,
): boolean {
    if (!signatureHeader || !secret) return false
    const provided = signatureHeader.trim().toLowerCase()
    if (!/^[0-9a-f]+$/.test(provided) || provided.length % 2 !== 0) return false
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest()
    const given = Buffer.from(provided, 'hex')
    if (given.length !== expected.length) return false
    return crypto.timingSafeEqual(given, expected)
}

export function toLocalPhone(phone: string): string {
    const digits = String(phone ?? '').replace(/\D/g, '')
    if (digits.startsWith('233') && digits.length === 12) return '0' + digits.slice(3)
    if (digits.length === 9) return '0' + digits
    return digits
}

const KF_KEY_MAX = 64

export function kfIdempotencyKey(referenceCode: string, generation: number): string {
    const suffix = generation > 0 ? `-m${generation}` : ''
    const base = referenceCode.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, KF_KEY_MAX - suffix.length)
    return base + suffix
}

export function baseReferenceFromKey(key: string): string {
    return key.replace(/-m\d+$/, '')
}

export function kfKeyForOrder(
    order: { reference_code: string; status: string; fulfillment_metadata: Record<string, any> | null },
    opts: { bumpAfterFailure: boolean },
): { key: string; generation: number } {
    const prev = Number(order.fulfillment_metadata?.kf_generation ?? 0) || 0
    const generation = prev + (opts.bumpAfterFailure && order.status === 'failed' ? 1 : 0)
    return { key: kfIdempotencyKey(order.reference_code, generation), generation }
}

// A webhook for an earlier attempt (e.g. a provider retry of an old order.failed) must not finalize the live one.
export function isStaleAirtimeReference(
    order: { reference_code: string; fulfillment_metadata: Record<string, any> | null },
    reference: string,
): boolean {
    const current = order.fulfillment_metadata?.client_reference || kfIdempotencyKey(order.reference_code, 0)
    return reference !== current
}

export function decideKfWebhookAction(payload: unknown): {
    action: 'completed' | 'failed' | 'ignore'
    product?: 'airtime' | 'utilities'
    reference?: string
} {
    if (!payload || typeof payload !== 'object') return { action: 'ignore' }
    const p = payload as Record<string, unknown>
    if (p.product !== 'airtime' && p.product !== 'utilities') return { action: 'ignore' }
    if (typeof p.reference !== 'string' || p.reference.length === 0) return { action: 'ignore' }
    const state = classifyKfOrderStatus(p.status)
    if (state === 'pending') return { action: 'ignore' }
    return { action: state, product: p.product, reference: p.reference }
}

export function parseKfLookup(biller: UtilityBiller, data: unknown): UtilityAccountInfo {
    void biller
    const info: UtilityAccountInfo = {
        accountName: null,
        accountNumber: null,
        amountDue: null,
        bouquet: null,
        sessionId: null,
        meters: [],
        raw: [],
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return info
    const d = data as Record<string, unknown>
    const str = (v: unknown): string | null => {
        if (v === null || v === undefined) return null
        const s = String(v).trim()
        return s.length > 0 ? s : null
    }
    const num = (v: unknown): number | null => {
        if (typeof v === 'number' && Number.isFinite(v)) return v
        if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
        return null
    }
    info.accountName = str(d.account_name)
    info.accountNumber = str(d.account_number)
    info.amountDue = num(d.amount_due)
    info.bouquet = str(d.bouquet)
    if (Array.isArray(d.meters)) {
        for (const m of d.meters) {
            if (!m || typeof m !== 'object') continue
            const r = m as Record<string, unknown>
            const meterNumber = str(r.meterNumber)
            if (!meterNumber) continue
            const meter: UtilityMeter = {
                name: str(r.name) ?? '',
                meterNumber,
                outstanding: num(r.outstanding) ?? 0,
            }
            info.meters.push(meter)
        }
    }
    return info
}

// ---------------------------------------------------------------------------
// Network (KingFlexyGH HTTP client)
// ---------------------------------------------------------------------------

const KF_BASE_URL = 'https://api.kingflexygh.com/api/v2'
const KF_TIMEOUT_MS = 20_000
const KF_AIRTIME_MAX_GHS = 100
const KF_NETWORKS = new Set(['MTN', 'Telecel', 'AT'])
const KF_PHONE_BILLERS = new Set<string>(['ecg', 'ghana_water'])

class KfBreaker {
    private failures = 0
    private openedAt = 0
    private readonly threshold = 5
    private readonly recoveryMs = 60_000

    isOpen(): boolean {
        return this.failures >= this.threshold && Date.now() - this.openedAt < this.recoveryMs
    }
    record(outcome: KfSendOutcome): void {
        if (outcome === 'accepted') {
            this.failures = 0
        } else if (outcome === 'transient' || outcome === 'config_error') {
            this.failures++
            if (this.failures >= this.threshold) this.openedAt = Date.now()
        }
    }
}

const airtimeBreaker = new KfBreaker()
const utilityBreaker = new KfBreaker()

type KfHttp = { ok: boolean; status: number; body: any }

function getKfKey(): string | undefined {
    return process.env.KINGFLEXY_COMMISSION_API_KEY || undefined
}

async function kfRequest(method: 'GET' | 'POST', path: string, apiKey: string, body?: unknown): Promise<KfHttp> {
    const res = await fetch(`${KF_BASE_URL}${path}`, {
        method,
        headers: {
            Authorization: apiKey,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(KF_TIMEOUT_MS),
    })
    const parsed = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, body: parsed }
}

function kfErrorMessage(body: any, fallback: string): string {
    const m = body && typeof body === 'object' ? (body.error ?? body.message) : undefined
    return typeof m === 'string' && m.length > 0 ? m : fallback
}

function describeKfFailure(err: unknown, apiKey: string): string {
    const raw = err instanceof Error ? err.message : String(err)
    return `KingFlexyGH request failed: ${raw.split(apiKey).join('[redacted]')}`
}

export async function fulfillAirtimeKingFlexy(
    network: string,
    beneficiaryPhone: string,
    amountGhs: number,
    key: string,
): Promise<CommissionFulfillResult> {
    const apiKey = getKfKey()
    if (!apiKey) return { success: false, pending: false, error: 'KingFlexyGH commission not configured' }
    if (!KF_NETWORKS.has(network)) {
        return { success: false, pending: false, isPermanentFailure: true, error: `No KingFlexyGH airtime network for ${network}` }
    }
    if (amountGhs > KF_AIRTIME_MAX_GHS) {
        return { success: false, pending: false, isPermanentFailure: true, error: 'Airtime exceeds KingFlexyGH 100 GHS per-request cap' }
    }
    if (airtimeBreaker.isOpen()) return { success: false, pending: false, error: 'KingFlexyGH airtime circuit open' }

    try {
        const res = await kfRequest('POST', '/airtime/purchase', apiKey, {
            network,
            beneficiary_phone: toLocalPhone(beneficiaryPhone),
            amount: Number(amountGhs.toFixed(2)),
            reference: key,
        })
        const outcome = classifyKfSendResponse(res.status, res.body)
        airtimeBreaker.record(outcome)
        const data = res.body?.data
        switch (outcome) {
            case 'accepted': {
                const state = classifyKfOrderStatus(data?.status)
                if (state === 'failed') {
                    return { success: false, pending: false, isPermanentFailure: true, error: kfErrorMessage(data, 'KingFlexyGH airtime order failed'), apiResponse: res.body }
                }
                return {
                    success: true,
                    pending: state === 'pending',
                    transactionId: data?.order_id != null ? String(data.order_id) : undefined,
                    apiResponse: res.body,
                }
            }
            case 'insufficient_balance':
                return { success: false, pending: false, isInsufficientFloat: true, error: kfErrorMessage(res.body, 'Insufficient KingFlexyGH balance'), apiResponse: res.body }
            case 'rejected':
                return { success: false, pending: false, isPermanentFailure: true, error: kfErrorMessage(res.body, 'KingFlexyGH rejected the request'), apiResponse: res.body }
            case 'rate_limited':
                return { success: false, pending: false, isRateLimited: true, error: 'KingFlexyGH rate limited', apiResponse: res.body }
            case 'config_error':
                return { success: false, pending: false, error: `KingFlexyGH auth error (HTTP ${res.status})`, apiResponse: res.body }
            case 'conflict':
                return { success: false, pending: false, error: 'KingFlexyGH reference conflict (order may be in flight)', apiResponse: res.body }
            case 'biller_unavailable':
                return { success: false, pending: false, error: kfErrorMessage(res.body, 'KingFlexyGH airtime unavailable'), apiResponse: res.body }
            default:
                return { success: false, pending: false, error: `KingFlexyGH error (HTTP ${res.status})`, apiResponse: res.body }
        }
    } catch (err) {
        airtimeBreaker.record('transient')
        return { success: false, pending: false, error: describeKfFailure(err, apiKey) }
    }
}

export type KfStatusResult = {
    configured: boolean
    httpOk: boolean
    found: boolean
    state: KfOrderState | 'unknown'
    providerReference?: string
    commissionEarned?: number | null
    reason?: string
    raw?: unknown
    error?: string
}

async function checkOrderStatus(path: string, withCommission: boolean): Promise<KfStatusResult> {
    const apiKey = getKfKey()
    if (!apiKey) {
        return { configured: false, httpOk: false, found: false, state: 'unknown', error: 'KingFlexyGH commission not configured' }
    }
    try {
        const res = await kfRequest('GET', path, apiKey)
        if (res.status === 404) return { configured: true, httpOk: true, found: false, state: 'unknown', raw: res.body }
        if (!res.ok || res.body?.success !== true || !res.body?.data) {
            return { configured: true, httpOk: false, found: false, state: 'unknown', raw: res.body, error: `KingFlexyGH status error (HTTP ${res.status})` }
        }
        const data = res.body.data
        const out: KfStatusResult = {
            configured: true,
            httpOk: true,
            found: true,
            state: classifyKfOrderStatus(data.status),
            providerReference: typeof data.reference === 'string' ? data.reference : undefined,
            reason: typeof data.reason === 'string' ? data.reason : undefined,
            raw: res.body,
        }
        if (withCommission) {
            const c = data.commission_earned
            out.commissionEarned = c === undefined || c === null || !Number.isFinite(Number(c)) ? null : Number(c)
        }
        return out
    } catch (err) {
        return { configured: true, httpOk: false, found: false, state: 'unknown', error: describeKfFailure(err, apiKey) }
    }
}

export function checkAirtimeOrderStatus(key: string): Promise<KfStatusResult> {
    return checkOrderStatus(`/airtime/orders/${encodeURIComponent(key)}`, false)
}

export function checkUtilityOrderStatus(providerReference: string): Promise<KfStatusResult> {
    return checkOrderStatus(`/utilities/orders/${encodeURIComponent(providerReference)}`, true)
}

export async function lookupUtilityAccountKingFlexy(
    biller: UtilityBiller,
    destination: string,
    mobile?: string,
): Promise<UtilityQueryResult> {
    const apiKey = getKfKey()
    if (!apiKey) return { success: false, error: 'KingFlexyGH commission not configured' }

    const params = new URLSearchParams({ biller, account: destination })
    if (biller === 'ecg') params.set('phone', destination)
    else if (biller === 'ghana_water' && mobile) params.set('phone', mobile)

    try {
        const res = await kfRequest('GET', `/utilities/lookup?${params.toString()}`, apiKey)
        if (res.status === 404) return { success: false, error: 'Account not found — check the number' }
        if (res.status === 429) return { success: false, isRateLimited: true, error: 'Rate limited — try again shortly' }
        if (res.status >= 500) {
            return { success: false, isNetworkError: true, error: 'Provider unreachable — try again shortly' }
        }
        if (!res.ok || res.body?.success !== true) {
            return { success: false, error: kfErrorMessage(res.body, `Lookup failed (HTTP ${res.status})`) }
        }
        return { success: true, info: parseKfLookup(biller, res.body.data) }
    } catch (err) {
        return { success: false, isNetworkError: true, error: describeKfFailure(err, apiKey) }
    }
}

export async function payUtilityKingFlexy(args: {
    biller: UtilityBiller
    account: string
    phone?: string
    amountGhs: number
    key: string
}): Promise<UtilityFulfillResult> {
    const apiKey = getKfKey()
    if (!apiKey) {
        return { success: false, pending: false, outcome: 'not_configured', error: 'KingFlexyGH commission not configured' }
    }
    if (utilityBreaker.isOpen()) {
        return { success: false, pending: false, outcome: 'network_error', error: 'KingFlexyGH utility circuit open' }
    }

    const body: Record<string, unknown> = {
        biller: args.biller,
        account: args.account,
        amount: Number(args.amountGhs.toFixed(2)),
        reference: args.key,
    }
    if (args.phone && KF_PHONE_BILLERS.has(args.biller)) body.phone = toLocalPhone(args.phone)

    try {
        const res = await kfRequest('POST', '/utilities/pay', apiKey, body)
        const outcome = classifyKfSendResponse(res.status, res.body)
        utilityBreaker.record(outcome)
        const data = res.body?.data
        switch (outcome) {
            case 'accepted': {
                const state = classifyKfOrderStatus(data?.status)
                const transactionId = typeof data?.reference === 'string' ? data.reference : undefined
                if (state === 'failed') {
                    return { success: false, pending: false, outcome: 'failed', transactionId, error: kfErrorMessage(data, 'KingFlexyGH utility order failed'), apiResponse: res.body }
                }
                return {
                    success: true,
                    pending: state === 'pending',
                    outcome: state,
                    transactionId,
                    apiResponse: res.body,
                }
            }
            case 'insufficient_balance':
                return { success: false, pending: false, outcome: 'insufficient_float', isInsufficientFloat: true, error: kfErrorMessage(res.body, 'Insufficient KingFlexyGH balance'), apiResponse: res.body }
            case 'rejected':
                return { success: false, pending: false, outcome: 'permanent_failure', isPermanentFailure: true, error: kfErrorMessage(res.body, 'KingFlexyGH rejected the request'), apiResponse: res.body }
            case 'config_error':
                return { success: false, pending: false, outcome: 'config_error', isConfigError: true, error: `KingFlexyGH auth error (HTTP ${res.status})`, apiResponse: res.body }
            case 'rate_limited':
                return { success: false, pending: false, outcome: 'rate_limited', isRateLimited: true, error: 'KingFlexyGH rate limited', apiResponse: res.body }
            case 'biller_unavailable':
                return { success: false, pending: false, outcome: 'not_configured', error: kfErrorMessage(res.body, 'KingFlexyGH biller unavailable'), apiResponse: res.body }
            case 'conflict':
                return { success: false, pending: false, outcome: 'unknown', isUnknownState: true, error: 'KingFlexyGH reference conflict (order may be in flight)', apiResponse: res.body }
            default:
                return { success: false, pending: false, outcome: 'network_error', error: `KingFlexyGH error (HTTP ${res.status})`, apiResponse: res.body }
        }
    } catch (err) {
        utilityBreaker.record('transient')
        return { success: false, pending: false, outcome: 'network_error', error: describeKfFailure(err, apiKey) }
    }
}
