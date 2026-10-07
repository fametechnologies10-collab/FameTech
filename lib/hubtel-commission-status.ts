/**
 * Hubtel Transaction Status Check — resolves orders stuck 'processing' after a missed callback
 * (mandatory >5-min check). Authoritative endpoint (same one our USSD integration uses):
 *   GET https://api-txnstatus.hubtel.com/transactions/{COLLECTION_ACCOUNT}/status?clientReference=...
 * NOTE: status-check is keyed on the COLLECTION account number (HUBTEL_COLLECTION_ACCOUNT), NOT the
 * disbursement account. Basic auth (same HUBTEL_API_ID/KEY). Routes via Fixie (IP already whitelisted
 * for this endpoint). Response: { responseCode, data: { status: 'Paid'|'Unpaid', isFulfilled, ... } }.
 * For airtime we trust data.isFulfilled (service delivered) as the source of truth.
 */
import https from 'https'
import { HttpsProxyAgent } from 'https-proxy-agent'

const STATUS_BASE = 'https://api-txnstatus.hubtel.com/transactions'

export interface CommissionStatusResult {
    configured: boolean
    httpOk: boolean
    found: boolean
    verdict: 'success' | 'failed' | 'pending' | 'unknown'
    raw?: unknown
    error?: string
}

function classify(body: any): CommissionStatusResult['verdict'] {
    const rc = String(body?.responseCode ?? '')
    const d = body?.data
    if (rc !== '0000' || !d) return 'unknown' // e.g. 404 "payment record not found"
    const fulfilled = d?.isFulfilled // boolean | null
    const status = String(d?.status ?? '').toLowerCase()
    if (fulfilled === true) return 'success'                    // service actually delivered
    if (fulfilled === false || status === 'unpaid') return 'failed'
    if (status === 'paid') return 'pending'                     // paid but fulfilment unconfirmed → don't auto-complete
    return 'unknown'
}

/** Look up a Commission Services transaction by the ClientReference we sent (= the order reference_code). */
export async function checkCommissionStatus(clientReference: string): Promise<CommissionStatusResult> {
    const apiId = process.env.HUBTEL_API_ID
    const apiKey = process.env.HUBTEL_API_KEY
    const account = process.env.HUBTEL_COLLECTION_ACCOUNT // status-check uses the COLLECTION account
    if (!apiId || !apiKey || !account || !clientReference) {
        return { configured: false, httpOk: false, found: false, verdict: 'unknown', error: 'status-check not configured' }
    }

    const credentials = Buffer.from(`${apiId}:${apiKey}`).toString('base64')
    const proxyUrl = process.env.HUBTEL_PROXY_URL
    const url = new URL(`${STATUS_BASE}/${encodeURIComponent(account)}/status`)
    url.searchParams.set('clientReference', clientReference)

    const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Basic ${credentials}` },
        ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
    }

    return new Promise<CommissionStatusResult>((resolve) => {
        const req = https.request(options, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
                const status = res.statusCode ?? 0
                let body: any = {}
                try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { /* non-JSON */ }
                const httpOk = status >= 200 && status < 300
                const found = httpOk && String(body?.responseCode ?? '') === '0000' && !!body?.data
                resolve({ configured: true, httpOk, found, verdict: classify(body), raw: body })
            })
        })
        req.on('error', (err) => resolve({ configured: true, httpOk: false, found: false, verdict: 'unknown', error: (err as any)?.message || 'network error' }))
        req.setTimeout(20000, () => { req.destroy(); resolve({ configured: true, httpOk: false, found: false, verdict: 'unknown', error: 'timeout' }) })
        req.end()
    })
}
