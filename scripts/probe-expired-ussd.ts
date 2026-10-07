/**
 * READ-ONLY forensic probe: for each expired USSD pending-order session, ask Hubtel's
 * transaction-status API whether the MoMo payment was actually PAID.
 * GET only — no money moves. Routes through Fixie (HUBTEL_PROXY_URL) like
 * scripts/probe-hubtel-status.ts. Reads sessions from expired-sessions.json.
 * Run from repo root: npx tsx <scratchpad>/probe-expired-ussd.ts
 */
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import https from 'https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const HERE = dirname(fileURLToPath(import.meta.url))

try {
    for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
        if (!m || process.env[m[1]] !== undefined) continue
        let v = m[2].trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        process.env[m[1]] = v
    }
} catch (e) { console.error('env load failed', (e as any)?.message); process.exit(1) }

const coll = process.env.HUBTEL_COLLECTION_ACCOUNT!
const creds = Buffer.from(`${process.env.HUBTEL_API_ID}:${process.env.HUBTEL_API_KEY}`).toString('base64')
const proxyUrl = process.env.HUBTEL_PROXY_URL
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Row { session_id: string; created_at: string; price: string; mobile: string; shop_name: string }

const LIMIT = Number(process.argv[2] ?? '0') // 0 = all

async function loadRows(): Promise<Row[]> {
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    let q = db
        .from('ussd_pending_orders')
        .select('session_id, created_at, price, mobile, shop_id, shop_profiles(shop_name)')
        .eq('status', 'expired')
        .not('shop_id', 'is', null)
        .order('created_at', { ascending: false })
    if (LIMIT > 0) q = q.limit(LIMIT)
    const { data, error } = await q
    if (error) { console.error('DB error:', error.message); process.exit(1) }
    return (data as any[]).map((r) => ({
        session_id: r.session_id, created_at: r.created_at, price: r.price,
        mobile: r.mobile, shop_name: r.shop_profiles?.shop_name ?? r.shop_id,
    }))
}

function get(urlStr: string): Promise<{ status: number; body: string }> {
    const url = new URL(urlStr)
    const options: https.RequestOptions = {
        hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Basic ${creds}` },
        ...(agent ? { agent } : {}),
    }
    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
        })
        req.on('error', (e) => resolve({ status: 0, body: `ERROR: ${(e as any)?.message}` }))
        req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: 'ERROR: timeout' }) })
        req.end()
    })
}

async function main() {
    const rows = await loadRows()
    console.log(`Probing ${rows.length} expired sessions against Hubtel (read-only)...`)
    const results: any[] = []
    let paid = 0, unpaid = 0, notfound = 0, errors = 0

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        const url = `https://api-txnstatus.hubtel.com/transactions/${coll}/status?clientReference=${encodeURIComponent(r.session_id)}`
        const res = await get(url)
        let verdict = 'error'
        let detail = ''
        if (res.status === 200) {
            try {
                const j = JSON.parse(res.body)
                const st = (j?.data?.status ?? '').toLowerCase()
                if (st === 'paid') { verdict = 'PAID'; paid++; detail = `txn=${j.data.transactionId ?? ''} net=${j.data.amountAfterCharges ?? j.data.amount ?? ''}` }
                else if (st === 'unpaid') { verdict = 'unpaid'; unpaid++ }
                else if (st === 'refunded') { verdict = 'REFUNDED'; detail = JSON.stringify(j.data).slice(0, 200) }
                else { verdict = `other:${st || 'none'}`; detail = res.body.slice(0, 200) }
            } catch { verdict = 'parse-error'; detail = res.body.slice(0, 150); errors++ }
        } else if (res.status === 404) { verdict = 'not-found'; notfound++ }
        else { verdict = `http-${res.status}`; detail = res.body.slice(0, 150); errors++ }

        results.push({ ...r, verdict, detail })
        const flag = verdict === 'PAID' ? ' <<<< PAID-BUT-LOST' : ''
        console.log(`${String(i + 1).padStart(3)}/${rows.length} ${r.created_at.slice(0, 16)} GHS ${String(r.price).padStart(6)} ${r.shop_name.padEnd(24).slice(0, 24)} ${verdict}${flag}`)
        await sleep(300)
    }

    writeFileSync(join(HERE, 'probe-results.json'), JSON.stringify(results, null, 2))
    console.log(`\nSUMMARY: paid=${paid} unpaid=${unpaid} not-found=${notfound} errors=${errors} of ${rows.length}`)
    const paidRows = results.filter((x) => x.verdict === 'PAID')
    if (paidRows.length) {
        console.log('\nPAID-BUT-LOST (customer charged, nothing delivered, shop not credited):')
        for (const p of paidRows) console.log(`  ${p.created_at} GHS ${p.price} ${p.shop_name} mobile=${p.mobile} session=${p.session_id} ${p.detail}`)
        const total = paidRows.reduce((s: number, x: any) => s + Number(x.price), 0)
        console.log(`  TOTAL: GHS ${total.toFixed(2)} across ${paidRows.length} orders`)
    }
}
main().catch((e) => { console.error('Script error:', e); process.exit(1) })
