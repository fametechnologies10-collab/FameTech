/**
 * DIAGNOSTIC — capture Hubtel's FINAL callback to learn why airtime isn't delivering.
 * Points CallbackUrl at a webhook.site inspector (what Hubtel's own docs use), sends one
 * GHS 1 MTN top-up via Fixie, then polls webhook.site for the final callback body.
 * Run: npx tsx scripts/diag-hubtel-callback.ts
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

const ACCOUNT = process.env.HUBTEL_DISBURSEMENT_ACCOUNT!
const SERVICE_ID = 'fdd76c884e614b1c8f669a3207b09a98' // MTN airtime
const creds = Buffer.from(`${process.env.HUBTEL_API_ID}:${process.env.HUBTEL_API_KEY}`).toString('base64')
const proxyUrl = process.env.HUBTEL_PROXY_URL
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function postHubtel(callbackUrl: string, ref: string): Promise<{ status: number; body: string }> {
    const bodyStr = JSON.stringify({ Destination: '233551617309', Amount: 1, CallbackUrl: callbackUrl, ClientReference: ref })
    const url = new URL(`https://cs.hubtel.com/commissionservices/${ACCOUNT}/${SERVICE_ID}`)
    const options: https.RequestOptions = {
        hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Basic ${creds}`, 'Content-Length': Buffer.byteLength(bodyStr) },
        ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
    }
    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
        })
        req.on('error', (e) => resolve({ status: 0, body: `ERROR ${(e as any)?.message}` }))
        req.write(bodyStr); req.end()
    })
}

async function main() {
    // 1. Create a webhook.site inspector token (direct, no proxy)
    const tok = await fetch('https://webhook.site/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_status: 200, default_content: '{"ok":true}', default_content_type: 'application/json' }),
    }).then((r) => r.json()) as any
    const uuid = tok.uuid
    const callbackUrl = `https://webhook.site/${uuid}`
    const ref = `DIAG-${Date.now()}`
    console.log(`Inspector: https://webhook.site/#!/${uuid}`)
    console.log(`CallbackUrl: ${callbackUrl}\nClientReference: ${ref}\n`)

    // 2. Send the top-up
    const sync = await postHubtel(callbackUrl, ref)
    console.log(`── Hubtel sync response (HTTP ${sync.status}) ──\n${sync.body}\n`)

    // 3. Poll webhook.site for Hubtel's FINAL callback
    console.log('── Polling webhook.site for the final callback (up to ~80s) ──')
    for (let i = 0; i < 8; i++) {
        await sleep(10000)
        const reqs = await fetch(`https://webhook.site/token/${uuid}/requests?sorting=newest`).then((r) => r.json()).catch(() => null) as any
        const items = reqs?.data || []
        if (items.length > 0) {
            console.log(`\n✅ CALLBACK(S) RECEIVED (${items.length}):`)
            for (const it of items) console.log(`\n[${it.created_at}] from ${it.ip}\n${it.content}`)
            return
        }
        console.log(`  ...no callback yet (${(i + 1) * 10}s)`)
    }
    console.log(`\n⚠️ No callback within ~80s. Check the inspector: https://webhook.site/#!/${uuid}`)
}

main().catch((e) => { console.error('Script error:', e); process.exit(1) })
