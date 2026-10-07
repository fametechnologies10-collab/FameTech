/**
 * ONE-OFF Hubtel Direct Receive Money fee-bearer probe.
 * Fires a single 1.00 GHS Receive Money charge to a test number so we can read the
 * fee breakdown (Amount vs AmountCharged) from the sync response — which reveals whether
 * Hubtel adds its fee ON TOP of the customer (customer-bears) or nets it from us
 * (merchant-bears). The customer must approve on their phone for money to actually move;
 * this probe only fires the prompt. Routes through Fixie (HUBTEL_PROXY_URL) for IP-allowlisting.
 *
 * Run: npx tsx scripts/probe-hubtel-receive-test.ts [phone] [amount]
 *   default phone 0551617309, default amount 1.00
 */
import { readFileSync } from 'fs'
import https from 'https'
import { HttpsProxyAgent } from 'https-proxy-agent'

// ── Load .env.local (same loader as scripts/probe-hubtel-status.ts) ──────────
try {
    for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
        if (!m || process.env[m[1]] !== undefined) continue
        let v = m[2].trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        process.env[m[1]] = v
    }
} catch (e) { console.error('env load failed:', (e as any)?.message); process.exit(1) }

function toMsisdn233(phone: string): string {
    const p = String(phone).replace(/\s+/g, '')
    if (/^233\d{9}$/.test(p)) return p
    if (/^0\d{9}$/.test(p)) return '233' + p.slice(1)
    if (/^\d{9}$/.test(p)) return '233' + p
    return p
}

// 024/025/053/054/055/059 = MTN, 020/050 = Telecel, 026/027/056/057 = AirtelTigo
function channelForPhone(msisdn: string): string {
    const local = '0' + msisdn.slice(3) // 233XXXXXXXXX -> 0XXXXXXXXX
    const p3 = local.slice(0, 3)
    if (['024', '025', '053', '054', '055', '059'].includes(p3)) return 'mtn-gh'
    if (['020', '050'].includes(p3)) return 'vodafone-gh'
    if (['026', '027', '056', '057'].includes(p3)) return 'tigo-gh'
    return 'mtn-gh'
}

const rawPhone = process.argv[2] || '0551617309'
const amount = Number(process.argv[3] || '1.00')
const msisdn = toMsisdn233(rawPhone)
const channel = channelForPhone(msisdn)

const apiId = process.env.HUBTEL_API_ID
const apiKey = process.env.HUBTEL_API_KEY
const coll = process.env.HUBTEL_COLLECTION_ACCOUNT || ''
const proxyUrl = process.env.HUBTEL_PROXY_URL

// ── Config presence check (never prints secret values) ───────────────────────
const missing: string[] = []
if (!apiId) missing.push('HUBTEL_API_ID')
if (!apiKey) missing.push('HUBTEL_API_KEY')
if (!coll) missing.push('HUBTEL_COLLECTION_ACCOUNT')
console.log('── Config:')
console.log('   HUBTEL_API_ID:', apiId ? 'present' : 'MISSING')
console.log('   HUBTEL_API_KEY:', apiKey ? 'present' : 'MISSING')
console.log('   HUBTEL_COLLECTION_ACCOUNT:', coll ? coll : 'MISSING')
console.log('   HUBTEL_PROXY_URL (Fixie):', proxyUrl ? 'present (routing through it)' : 'MISSING (will egress from local IP — likely 403)')
if (missing.length) { console.error('\nCannot fire probe — missing:', missing.join(', ')); process.exit(1) }

const creds = Buffer.from(`${apiId}:${apiKey}`).toString('base64')
const clientReference = 'TEST-RCV-' + Date.now()
const cbBase = process.env.NEXT_PUBLIC_APP_URL || 'https://kingflexygh.com'
const bodyStr = JSON.stringify({
    CustomerName: 'KFT Fee Test',
    CustomerMsisdn: msisdn,
    Channel: channel,
    Amount: Number(amount.toFixed(2)),
    PrimaryCallbackUrl: `${cbBase}/api/webhooks/hubtel-receive-money`,
    Description: 'KFT Receive Money fee-bearer test',
    ClientReference: clientReference,
})

const url = new URL(`https://rmp.hubtel.com/merchantaccount/merchants/${coll}/receive/mobilemoney`)
const options: https.RequestOptions = {
    hostname: url.hostname, port: url.port || 443, path: url.pathname, method: 'POST',
    headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        Authorization: `Basic ${creds}`, 'Content-Length': Buffer.byteLength(bodyStr),
    },
    ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
}

console.log('\n── Request:')
console.log('   POST', url.href)
console.log('   msisdn', msisdn, '| channel', channel, '| amount', amount.toFixed(2), '| ref', clientReference)

const req = https.request(options, (res) => {
    const chunks: Buffer[] = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        console.log('\n── Response: HTTP', res.statusCode)
        let data: any = {}
        try { data = JSON.parse(raw || '{}') } catch { console.log('   (non-JSON):', raw.slice(0, 800)); return }
        console.log('   ResponseCode:', data?.ResponseCode, '| Message:', data?.Message)
        const d = data?.Data || {}
        console.log('   Data.Amount:', d.Amount, '| Charges:', d.Charges, '| AmountAfterCharges:', d.AmountAfterCharges, '| AmountCharged:', d.AmountCharged)
        console.log('   Data.TransactionId:', d.TransactionId)
        // ── Fee-bearer interpretation ────────────────────────────────────────
        const amt = Number(d.Amount), charged = Number(d.AmountCharged), afterCharges = Number(d.AmountAfterCharges)
        if (Number.isFinite(amt) && Number.isFinite(charged)) {
            if (charged > amt + 1e-9) {
                console.log(`\n   ➜ CUSTOMER BEARS THE FEE: requested ${amt}, customer debited ${charged} (fee +${(charged - amt).toFixed(2)} on top); we receive ${afterCharges}.`)
            } else if (Number.isFinite(afterCharges) && afterCharges < amt - 1e-9) {
                console.log(`\n   ➜ MERCHANT BEARS THE FEE: customer debited ${charged} (= requested), we net ${afterCharges} after a ${(amt - afterCharges).toFixed(2)} fee.`)
            } else {
                console.log('\n   ➜ Fee split unclear from these values — inspect the raw fields above.')
            }
        } else {
            console.log('\n   (No Amount/AmountCharged in response — likely an error/blocked response; see ResponseCode/Message above.)')
            if (String(data?.ResponseCode) === '4101') console.log('   4101 → scope "mobilemoney-receive-direct" not enabled on the account (RSE must enable).')
        }
        console.log('\n   Raw:', raw.slice(0, 1200))
    })
})
req.on('error', (e) => {
    console.error('\n── ERROR:', (e as any)?.message)
    console.error('   (A 403/timeout here usually means our egress IP is NOT whitelisted for the Receive Money service — RSE must whitelist the Fixie IP for THIS service specifically.)')
})
req.setTimeout(25000, () => { req.destroy(); console.error('\n── TIMEOUT after 25s (often = IP not whitelisted for the Receive Money service).') })
req.write(bodyStr)
req.end()
