import crypto from 'crypto'
import type { UtilityBiller, UtilityAccountInfo, UtilityMeter } from '@/lib/hubtel-utility/billers'

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
