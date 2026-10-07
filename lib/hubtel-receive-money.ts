/**
 * Hubtel Direct Receive Money — server-initiated Mobile Money charge provider
 * (like Paystack's Charge API — there is NO checkoutUrl/redirect; the customer
 * approves a USSD/MoMo prompt on their phone). Outbound calls route through the
 * Fixie static-IP proxy (HUBTEL_PROXY_URL) for IP-allowlisting, mirroring
 * lib/hubtel-commission-service.ts. Reference: Hubtel's official Receive Money doc.
 *
 * Endpoints:
 *   Charge: POST https://rmp.hubtel.com/merchantaccount/merchants/{account}/receive/mobilemoney
 *   Status: GET  https://api-txnstatus.hubtel.com/transactions/{account}/status?clientReference={ref}
 */
import https from 'https'
import { createHmac, timingSafeEqual } from 'crypto'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { toMsisdn233 } from './hubtel-commission-service'

const RECEIVE_BASE = 'https://rmp.hubtel.com/merchantaccount/merchants'
const STATUS_BASE = 'https://api-txnstatus.hubtel.com/transactions'

/**
 * Map an msisdn (233XXXXXXXXX, or any format toMsisdn233 accepts) to the Hubtel
 * Receive Money channel for that network. 024/025/053/054/055/059 -> MTN,
 * 020/050 -> Telecel (vodafone-gh), 026/027/056/057 -> AirtelTigo. Unrecognized
 * prefixes (and anything that doesn't normalize to a valid 233 msisdn) -> null.
 */
export function channelForMsisdn(msisdn: string): 'mtn-gh' | 'vodafone-gh' | 'tigo-gh' | null {
    const m233 = toMsisdn233(msisdn)
    if (!/^233\d{9}$/.test(m233)) return null
    const local = '0' + m233.slice(3)
    const prefix = local.slice(0, 3)
    if (['024', '025', '053', '054', '055', '059'].includes(prefix)) return 'mtn-gh'
    if (['020', '050'].includes(prefix)) return 'vodafone-gh'
    if (['026', '027', '056', '057'].includes(prefix)) return 'tigo-gh'
    return null
}

/**
 * Authoritative Hubtel Receive Money charge ResponseCode -> outcome table.
 * 0000 paid, 0001 pending (callback to follow), 2001 failed (customer-side, no
 * money moved), 4000 validation, 4070 fees, 4101/4103 blocked (scope not enabled).
 * Anything else is unknown (treat conservatively — do not assume paid).
 */
export function classifyReceiveCode(
    rc: string
): 'paid' | 'pending' | 'failed' | 'validation' | 'fees' | 'blocked' | 'unknown' {
    switch (rc) {
        case '0000':
            return 'paid'
        case '0001':
            return 'pending'
        case '2001':
            return 'failed'
        case '4000':
            return 'validation'
        case '4070':
            return 'fees'
        case '4101':
        case '4103':
            return 'blocked'
        default:
            return 'unknown'
    }
}

/**
 * Interpret the sync charge response's fee breakdown to determine who bears
 * Hubtel's fee: if AmountCharged > Amount, the customer was debited extra (fee
 * on top). If AmountCharged == Amount but AmountAfterCharges < Amount, we net
 * less than requested (merchant bears it). Otherwise unclear.
 */
export function interpretFeeBearer(d: {
    Amount: number
    AmountCharged: number
    AmountAfterCharges: number
}): 'customer' | 'merchant' | 'unclear' {
    const EPS = 1e-9
    const { Amount, AmountCharged, AmountAfterCharges } = d
    if (AmountCharged > Amount + EPS) return 'customer'
    if (Math.abs(AmountCharged - Amount) <= EPS && AmountAfterCharges < Amount - EPS) return 'merchant'
    return 'unclear'
}

/**
 * Build the HMAC-signed PrimaryCallbackUrl Hubtel will hit on async completion.
 * Hubtel sends NO auth header on callbacks, so we authenticate via a per-request
 * HMAC carried in the URL itself (the SECRET is never transmitted):
 * sig = HMAC(secret, ref.ts). Mirrors buildSignedCallbackUrl in
 * lib/hubtel-commission-service.ts but uses its own secret + webhook path so the
 * Receive Money rail is independent of the Commission Services rail.
 */
export function buildSignedReceiveCallbackUrl(reference: string): string {
    const cbBase = process.env.NEXT_PUBLIC_APP_URL || 'https://kingflexygh.com'
    const cbSecret = process.env.HUBTEL_RECEIVE_WEBHOOK_SECRET || ''
    let callbackUrl = `${cbBase}/api/webhooks/hubtel-receive-money`
    if (cbSecret) {
        const ts = Date.now().toString()
        const sig = createHmac('sha256', cbSecret).update(`${reference}.${ts}`).digest('hex')
        callbackUrl += `?ref=${encodeURIComponent(reference)}&ts=${ts}&sig=${sig}`
    } else {
        console.warn(
            '[HubtelReceive] HUBTEL_RECEIVE_WEBHOOK_SECRET not set — callback will be unsigned and rejected (503) by the webhook.'
        )
    }
    return callbackUrl
}

/**
 * Recompute the HMAC over `${reference}.${ts}` and compare it against the
 * callback's `sig` param using a constant-time comparison. Returns false (never
 * throws) if the secret is unset, `sig` isn't well-formed hex, or the digest
 * doesn't match.
 */
export function verifyReceiveCallbackSig(reference: string, ts: string, sig: string): boolean {
    const secret = process.env.HUBTEL_RECEIVE_WEBHOOK_SECRET || ''
    if (!secret || !sig || !/^[0-9a-f]+$/i.test(sig)) return false
    const expected = createHmac('sha256', secret).update(`${reference}.${ts}`).digest('hex')
    if (expected.length !== sig.length) return false
    try {
        return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))
    } catch {
        return false
    }
}

export interface ReceiveInitResult {
    status: 'pending' | 'paid' | 'failed' | 'blocked'
    responseCode: string
    providerRef?: string // Data.TransactionId
    charges?: number
    amountCharged?: number
    message?: string
    raw?: any
    // True ONLY when the init call's outcome is ambiguous — a request TIMEOUT or a
    // NETWORK ERROR where no definitive HTTP response body was ever received from
    // Hubtel. Hubtel may have already queued the on-phone prompt before/around the
    // failure, so the customer could still approve and be debited. Callers MUST NOT
    // treat this like a definitive failure (no money moved) — the charge must stay
    // recoverable (status 'pending') so the poll + reconcile cron can re-verify it.
    ambiguous?: boolean
}

// Module-level circuit breaker (mirrors lib/hubtel-commission-service.ts / lib/fulfillment-service.ts).
let failureCount = 0
let circuitOpenedAt = 0
const FAILURE_THRESHOLD = 5
const RECOVERY_MS = 60_000

/**
 * Initiate a Direct Receive Money charge (server-initiated MoMo debit — the
 * customer approves a prompt on their phone; there is no checkoutUrl/redirect).
 */
export async function initiateReceiveMoney(args: {
    channel: string
    msisdn: string
    amount: number
    description: string
    clientReference: string
    customerName?: string
    customerEmail?: string
}): Promise<ReceiveInitResult> {
    const apiId = process.env.HUBTEL_API_ID
    const apiKey = process.env.HUBTEL_API_KEY
    const account = process.env.HUBTEL_COLLECTION_ACCOUNT

    if (!apiId || !apiKey || !account) {
        return { status: 'failed', responseCode: 'config', message: 'Hubtel Receive Money not configured' }
    }
    if (failureCount >= FAILURE_THRESHOLD && Date.now() - circuitOpenedAt < RECOVERY_MS) {
        return { status: 'failed', responseCode: 'circuit_open', message: 'Hubtel circuit open' }
    }

    const credentials = Buffer.from(`${apiId}:${apiKey}`).toString('base64')
    const callbackUrl = buildSignedReceiveCallbackUrl(args.clientReference)
    const bodyStr = JSON.stringify({
        ...(args.customerName ? { CustomerName: args.customerName } : {}),
        CustomerMsisdn: toMsisdn233(args.msisdn),
        ...(args.customerEmail ? { CustomerEmail: args.customerEmail } : {}),
        Channel: args.channel,
        Amount: Number(args.amount.toFixed(2)),
        PrimaryCallbackUrl: callbackUrl,
        Description: args.description,
        ClientReference: args.clientReference,
    })
    const proxyUrl = process.env.HUBTEL_PROXY_URL
    const url = new URL(`${RECEIVE_BASE}/${account}/receive/mobilemoney`)
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

    return new Promise<ReceiveInitResult>((resolve) => {
        const req = https.request(options, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
                const rawBody = Buffer.concat(chunks).toString()
                let data: any = {}
                let parseFailed = false
                try {
                    data = JSON.parse(rawBody || '{}')
                } catch {
                    parseFailed = true
                }
                const rc = String(data?.ResponseCode ?? '')
                const outcome = classifyReceiveCode(rc)
                const d = data?.Data || {}

                if (outcome === 'paid' || outcome === 'pending') {
                    failureCount = 0
                } else {
                    failureCount++
                    if (failureCount >= FAILURE_THRESHOLD) circuitOpenedAt = Date.now()
                }

                // validation/fees/failed/unknown all resolve to 'failed'; 'blocked' stays distinct.
                let status: ReceiveInitResult['status']
                if (outcome === 'paid') status = 'paid'
                else if (outcome === 'pending') status = 'pending'
                else if (outcome === 'blocked') status = 'blocked'
                else status = 'failed'

                // Log every non-success outcome — this was previously silent, which is why a
                // customer-facing "Could not start payment" (the generic fallback used whenever
                // Hubtel's response doesn't carry a Message, e.g. a non-Hubtel-shaped body such
                // as a gateway/proxy auth-rejection page) left no trace of the actual cause.
                // Truncated to keep a malformed/huge body from flooding logs.
                if (status !== 'paid' && status !== 'pending') {
                    console.error('[HubtelReceive] Non-success charge response:', JSON.stringify({
                        httpStatus: res.statusCode,
                        responseCode: rc,
                        outcome,
                        parseFailed,
                        message: data?.Message,
                        rawBodySnippet: rawBody.slice(0, 500),
                    }))
                }

                resolve({
                    status,
                    responseCode: rc,
                    providerRef: d.TransactionId,
                    charges: d.Charges,
                    amountCharged: d.AmountCharged,
                    message: data?.Message,
                    raw: data,
                })
            })
        })
        req.on('error', (err) => {
            failureCount++
            if (failureCount >= FAILURE_THRESHOLD) circuitOpenedAt = Date.now()
            // Ambiguous: no definitive response body was received — Hubtel may still have
            // queued the on-phone prompt. Must not be treated as "no money moved".
            resolve({
                status: 'failed',
                responseCode: 'network_error',
                message: (err as any)?.message || 'network error',
                ambiguous: true,
            })
        })
        req.setTimeout(25000, () => {
            req.destroy()
            // Ambiguous for the same reason as the network-error path above.
            resolve({
                status: 'failed',
                responseCode: 'timeout',
                message: 'Hubtel request timed out after 25s',
                ambiguous: true,
            })
        })
        req.write(bodyStr)
        req.end()
    })
}

/**
 * Query the final state of a Receive Money charge by ClientReference. `ok`
 * reflects whether the QUERY itself succeeded (HTTP 200 + responseCode 0000) —
 * money should only be treated as received when `paid` is true
 * (data.status === 'Paid'), never from `ok`/responseCode alone.
 */
export async function checkReceiveMoneyStatus(clientReference: string): Promise<{
    ok: boolean
    paid: boolean
    status?: 'Paid' | 'Unpaid' | 'Refunded'
    raw?: any
}> {
    const apiId = process.env.HUBTEL_API_ID
    const apiKey = process.env.HUBTEL_API_KEY
    const account = process.env.HUBTEL_COLLECTION_ACCOUNT

    if (!apiId || !apiKey || !account) {
        return { ok: false, paid: false }
    }

    const credentials = Buffer.from(`${apiId}:${apiKey}`).toString('base64')
    const proxyUrl = process.env.HUBTEL_PROXY_URL
    const url = new URL(`${STATUS_BASE}/${account}/status?clientReference=${encodeURIComponent(clientReference)}`)
    const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Basic ${credentials}` },
        ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
    }

    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
                const httpStatus = res.statusCode ?? 0
                let data: any = {}
                try {
                    data = JSON.parse(Buffer.concat(chunks).toString() || '{}')
                } catch {
                    /* non-JSON */
                }
                const rc = String(data?.responseCode ?? '')
                const dataStatus = data?.data?.status
                resolve({
                    ok: httpStatus === 200 && rc === '0000',
                    paid: dataStatus === 'Paid',
                    status: dataStatus,
                    raw: data,
                })
            })
        })
        req.on('error', (err) => {
            resolve({ ok: false, paid: false, raw: { error: (err as any)?.message || 'network error' } })
        })
        req.setTimeout(25000, () => {
            req.destroy()
            resolve({ ok: false, paid: false, raw: { error: 'timeout' } })
        })
        req.end()
    })
}
