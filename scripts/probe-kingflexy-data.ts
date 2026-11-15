// MANUAL sandbox probe for the KingFlexyGH data API. NOT run in CI.
//   Sandbox key (kf_test_...):  npx tsx scripts/probe-kingflexy-data.ts
//   Live key, read-only:        npx tsx scripts/probe-kingflexy-data.ts --live-readonly
// Refuses to run with a kf_live_ key unless --live-readonly, which ONLY calls GET /packages and
// GET /wallet/balance (never any POST). Never prints the key.
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { randomUUID } from 'crypto'

const BASE = 'https://api.kingflexygh.com/api/v2'

function loadEnvLocal() {
    try {
        const txt = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
        for (const line of txt.split(/\r?\n/)) {
            const m = line.match(/^\s*KINGFLEXY_DATA_API_KEY\s*=\s*(.*)\s*$/)
            if (m && !process.env.KINGFLEXY_DATA_API_KEY) process.env.KINGFLEXY_DATA_API_KEY = m[1].replace(/^["']|["']$/g, '')
        }
    } catch { /* no .env.local */ }
}

async function call(key: string, method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    console.log(`\n${method} ${path} -> HTTP ${res.status}\n${text}`)
}

async function main() {
    loadEnvLocal()
    const key = (process.env.KINGFLEXY_DATA_API_KEY || '').trim()
    const liveReadonly = process.argv.includes('--live-readonly')
    if (!key) { console.error('KINGFLEXY_DATA_API_KEY is not set.'); process.exit(1) }
    const isLive = key.startsWith('kf_live_')
    if (isLive && !liveReadonly) {
        console.error('Refusing to run: a kf_live_ key is configured. Use a kf_test_ sandbox key, or pass --live-readonly (GET /packages and GET /wallet/balance only).')
        process.exit(1)
    }

    await call(key, 'GET', '/packages')
    await call(key, 'GET', '/wallet/balance')
    if (isLive) { console.log('\n--live-readonly: done (no POST calls made).'); return }

    // Sandbox only: recipients ending 0001-0004, replay, payload mismatch, bad network.
    const run = randomUUID()
    for (const suffix of ['0001', '0002', '0003', '0004']) {
        await call(key, 'POST', '/data/purchase', { network: 'MTN', volume_gb: 1, recipient: `024000${suffix}`, reference: `${run}-r${suffix}` })
    }
    const replayRef = `${run}-replay`
    const replay = { network: 'MTN', volume_gb: 1, recipient: '0240000001', reference: replayRef }
    await call(key, 'POST', '/data/purchase', replay)
    await call(key, 'POST', '/data/purchase', replay) // replay: expect same order, no second charge
    await call(key, 'POST', '/data/purchase', { ...replay, volume_gb: 2 }) // reused ref, different volume: expect 409
    await call(key, 'POST', '/data/purchase', { network: 'Vodafone', volume_gb: 1, recipient: '0240000001', reference: `${run}-badnet` })
    await call(key, 'GET', `/orders/${encodeURIComponent(replayRef)}`)
    await call(key, 'GET', `/orders/${encodeURIComponent(`${run}-never`)}`)
}

main().catch(e => { console.error('probe error:', e instanceof Error ? e.message : 'unknown'); process.exit(1) })
