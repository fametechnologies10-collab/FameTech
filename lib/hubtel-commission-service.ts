/**
 * Hubtel Commission Services — airtime reseller provider.
 * We pre-fund a Disbursement Account; each top-up debits the float and returns a
 * live commission (Meta.Commission) on the async callback. Outbound calls route
 * through the Fixie static-IP proxy (HUBTEL_PROXY_URL) for IP-allowlisting, exactly
 * like lib/ussd/hubtel-callback.ts. Reference: docs/reference/hubtel-commission-services.md
 */
import https from 'https'
import { createHmac } from 'crypto'
import { HttpsProxyAgent } from 'https-proxy-agent'

const CS_BASE = 'https://cs.hubtel.com/commissionservices'

// Airtime ServiceIDs. Defaults are Hubtel's PUBLIC doc values — CONFIRM the real
// GUIDs for OUR Disbursement Account before enabling in production (override via env).
const AIRTIME_SERVICE_IDS: Record<string, string | undefined> = {
    MTN: process.env.HUBTEL_AIRTIME_SERVICEID_MTN || 'fdd76c884e614b1c8f669a3207b09a98',
    Telecel: process.env.HUBTEL_AIRTIME_SERVICEID_TELECEL || 'f4be83ad74c742e185224fdae1304800',
    AT: process.env.HUBTEL_AIRTIME_SERVICEID_AT || 'dae2142eb5a14c298eace60240c09e4b',
}

export interface CommissionFulfillResult {
    success: boolean
    pending: boolean
    transactionId?: string
    commission?: number
    error?: string
    isInsufficientFloat?: boolean
    isRateLimited?: boolean
    isPermanentFailure?: boolean
    apiResponse?: any
}

export function toMsisdn233(phone: string): string {
    const p = String(phone).replace(/\s+/g, '')
    if (/^233\d{9}$/.test(p)) return p
    if (/^0\d{9}$/.test(p)) return '233' + p.slice(1)
    if (/^\d{9}$/.test(p)) return '233' + p
    return p
}

export function serviceIdForNetwork(network: string): string | undefined {
    return AIRTIME_SERVICE_IDS[network]
}

export function parseCommission(meta: any): number | undefined {
    const c = meta?.Commission ?? meta?.commission
    if (c === undefined || c === null) return undefined
    const n = Number(c)
    return Number.isFinite(n) ? n : undefined
}

/**
 * Build the HMAC-signed CallbackUrl Hubtel will hit on async completion. Hubtel sends NO auth
 * header on callbacks, so we authenticate via a per-request HMAC carried in the URL itself (the
 * SECRET is never transmitted): sig = HMAC(secret, ref.ts). Order-bound + time-bounded, so a
 * logged URL can't forge other orders or replay after expiry. Shared by every Commission Services
 * integration (airtime + utility bills) so callback auth stays identical across products.
 */
export function buildSignedCallbackUrl(clientReference: string): string {
    const cbBase = process.env.NEXT_PUBLIC_APP_URL || 'https://kingflexygh.com'
    const cbSecret = process.env.HUBTEL_COMMISSION_WEBHOOK_SECRET || ''
    let callbackUrl = `${cbBase}/api/webhooks/hubtel-commission`
    if (cbSecret) {
        const ts = Date.now().toString()
        const sig = createHmac('sha256', cbSecret).update(`${clientReference}.${ts}`).digest('hex')
        callbackUrl += `?ref=${encodeURIComponent(clientReference)}&ts=${ts}&sig=${sig}`
    } else {
        console.warn('[HubtelCommission] HUBTEL_COMMISSION_WEBHOOK_SECRET not set — callback will be unsigned and rejected (503) by the webhook.')
    }
    return callbackUrl
}

// Module-level circuit breaker (mirrors lib/fulfillment-service.ts).
let failureCount = 0
let circuitOpenedAt = 0
const FAILURE_THRESHOLD = 5
const RECOVERY_MS = 60_000

export async function fulfillAirtimeCommission(
    network: string,
    beneficiaryPhone: string,
    amountGhs: number,
    clientReference: string,
): Promise<CommissionFulfillResult> {
    const apiId = process.env.HUBTEL_API_ID
    const apiKey = process.env.HUBTEL_API_KEY
    const account = process.env.HUBTEL_DISBURSEMENT_ACCOUNT
    const serviceId = serviceIdForNetwork(network)
    // Hubtel sends NO auth header on callbacks; buildSignedCallbackUrl carries a per-request HMAC
    // in the URL itself (the SECRET is never transmitted). See its doc comment for the scheme.
    const callbackUrl = buildSignedCallbackUrl(clientReference)

    if (!apiId || !apiKey || !account) {
        return { success: false, pending: false, error: 'Hubtel Commission not configured' }
    }
    if (!serviceId) {
        return { success: false, pending: false, isPermanentFailure: true, error: `No Hubtel airtime ServiceID for ${network}` }
    }
    if (amountGhs > 100) {
        // Hubtel caps airtime at 100 GHS per request ("maximum airtime top-up amount per request is 100 cedis").
        return { success: false, pending: false, isPermanentFailure: true, error: 'Airtime exceeds Hubtel 100 GHS per-request cap' }
    }
    if (failureCount >= FAILURE_THRESHOLD && Date.now() - circuitOpenedAt < RECOVERY_MS) {
        return { success: false, pending: false, error: 'Hubtel circuit open' }
    }

    const credentials = Buffer.from(`${apiId}:${apiKey}`).toString('base64')
    const bodyStr = JSON.stringify({
        Destination: toMsisdn233(beneficiaryPhone),
        Amount: Number(amountGhs.toFixed(2)),
        CallbackUrl: callbackUrl,
        ClientReference: clientReference,
    })
    const proxyUrl = process.env.HUBTEL_PROXY_URL
    const url = new URL(`${CS_BASE}/${account}/${serviceId}`)
    const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Basic ${credentials}`,
            'Content-Length': Buffer.byteLength(bodyStr),
        },
        ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
    }

    return new Promise<CommissionFulfillResult>((resolve) => {
        const req = https.request(options, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
                const status = res.statusCode ?? 0
                let data: any = {}
                try { data = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { /* non-JSON */ }
                const rc = String(data?.ResponseCode ?? '')

                if (status === 429) {
                    resolve({ success: false, pending: false, isRateLimited: true, error: 'Rate limited', apiResponse: data })
                    return
                }
                if (rc === '0001' || rc === '0000') {
                    failureCount = 0
                    resolve({
                        success: true,
                        pending: rc === '0001',
                        transactionId: data?.Data?.TransactionId,
                        commission: parseCommission(data?.Data?.Meta),
                        apiResponse: data,
                    })
                    return
                }
                failureCount++
                if (failureCount >= FAILURE_THRESHOLD) circuitOpenedAt = Date.now()
                const insufficient = rc.startsWith('4') || /insufficient/i.test(String(data?.Message || ''))
                resolve({
                    success: false,
                    pending: false,
                    isInsufficientFloat: insufficient,
                    error: data?.Message || `ResponseCode ${rc || status}`,
                    apiResponse: data,
                })
            })
        })
        req.on('error', (err) => {
            failureCount++
            if (failureCount >= FAILURE_THRESHOLD) circuitOpenedAt = Date.now()
            resolve({ success: false, pending: false, error: (err as any)?.message || 'network error' })
        })
        req.write(bodyStr)
        req.end()
    })
}
