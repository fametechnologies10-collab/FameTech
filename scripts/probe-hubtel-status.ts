/**
 * READ-ONLY Hubtel status probe — no money moves (GET only).
 * Tries candidate status-check endpoints for a Commission Services transaction so we can see
 * its ACTUAL final state. Routes through Fixie. Run:
 *   npx tsx scripts/probe-hubtel-status.ts <transactionId> <clientReference>
 */
import { readFileSync } from 'fs'
import https from 'https'
import { HttpsProxyAgent } from 'https-proxy-agent'

try {
    for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
        if (!m || process.env[m[1]] !== undefined) continue
        let v = m[2].trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        process.env[m[1]] = v
    }
} catch (e) { console.error('env load failed', (e as any)?.message); process.exit(1) }

const txn = process.argv[2] || '4a14315272c1414dacab45068be9ff42'
const ref = process.argv[3] || 'LIVETEST-1782134463369'
const acct = process.env.HUBTEL_DISBURSEMENT_ACCOUNT || ''
const coll = process.env.HUBTEL_COLLECTION_ACCOUNT || ''
const creds = Buffer.from(`${process.env.HUBTEL_API_ID}:${process.env.HUBTEL_API_KEY}`).toString('base64')
const proxyUrl = process.env.HUBTEL_PROXY_URL

console.log(`(disbursement acct=${acct}, collection acct=${coll})`)
const candidates = [
    `https://api-txnstatus.hubtel.com/transactions/${coll}/status?clientReference=${encodeURIComponent(ref)}`,
    `https://api-txnstatus.hubtel.com/transactions/${coll}/status?hubtelTransactionId=${encodeURIComponent(txn)}`,
]

function get(urlStr: string): Promise<{ status: number; body: string }> {
    const url = new URL(urlStr)
    const options: https.RequestOptions = {
        hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Basic ${creds}` },
        ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
    }
    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString().slice(0, 1500) }))
        })
        req.on('error', (e) => resolve({ status: 0, body: `ERROR: ${(e as any)?.message}` }))
        req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, body: 'ERROR: timeout' }) })
        req.end()
    })
}

async function main() {
    console.log(`Probing txn=${txn} ref=${ref} acct=${acct}\n`)
    for (const url of candidates) {
        const r = await get(url)
        console.log(`── GET ${url}`)
        console.log(`   HTTP ${r.status}`)
        console.log(`   ${r.body.replace(/\n/g, ' ')}\n`)
    }
}
main()
