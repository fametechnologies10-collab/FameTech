// Pure-logic tests for lib/kingflexy-data-service.ts (KingFlexyGH data supplier).
// Run: npx tsx scripts/test-kingflexy-data.ts
process.env.TZ = 'America/New_York' // shouldRedeliver must be zone-independent (zone-less = UTC)

import { createHmac } from 'crypto'
import {
    KF_DATA_NETWORKS, assertSupportedNetwork, sizeToVolumeGb, toLocalRecipient,
    buildKingflexyReference, extractOrderIdFromReference, extractAttemptNoFromReference,
    mapKingflexyStatus, classifyPurchase, verifyWebhookSignature, shouldRedeliver,
    placeOrder, checkOrderStatus, fetchSupplierBalance, __resetKingflexyBreakerForTests,
} from '../lib/kingflexy-data-service'

let failures = 0
function assertEqual(actual: unknown, expected: unknown, label: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
        failures++
    } else console.log(`ok: ${label}`)
}

// networks
assertEqual([...KF_DATA_NETWORKS], ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime'], 'network list')
assertEqual(assertSupportedNetwork('MTN'), true, 'MTN supported')
assertEqual(assertSupportedNetwork('AT-BigTime'), true, 'AT-BigTime supported')
assertEqual(assertSupportedNetwork('mtn'), false, 'lowercase not supported')
assertEqual(assertSupportedNetwork('Vodafone'), false, 'unknown not supported')

// reference
const uuid = '123e4567-e89b-12d3-a456-426614174000'
assertEqual(extractOrderIdFromReference(buildKingflexyReference(uuid, 2)), uuid, 'reference round-trip order id')
assertEqual(extractAttemptNoFromReference(buildKingflexyReference(uuid, 2)), 2, 'reference attempt 2')
assertEqual(extractAttemptNoFromReference(buildKingflexyReference(uuid)), 0, 'default attempt 0')
assertEqual(extractOrderIdFromReference('garbage'), null, 'garbage order id null')
assertEqual(extractAttemptNoFromReference('garbage'), null, 'garbage attempt null')
assertEqual(extractOrderIdFromReference(undefined as any), null, 'undefined order id null')

// status
assertEqual(mapKingflexyStatus('completed'), 'completed', 'completed')
assertEqual(mapKingflexyStatus('refunded'), 'failed', 'refunded -> failed')
assertEqual(mapKingflexyStatus('failed'), 'processing', 'failed not final')
assertEqual(mapKingflexyStatus('FAILED'), 'processing', 'FAILED not final')
assertEqual(mapKingflexyStatus('COMPLETED'), 'completed', 'COMPLETED case-insens')
for (const s of ['pending', 'queued', 'blacklisted', 'processing', 'weird', '', null, undefined, 5]) {
    assertEqual(mapKingflexyStatus(s), 'processing', `status ${String(s)} -> processing`)
}

// classifyPurchase
const MSG409 = "This number isn't registered to receive MTN data yet. We've submitted it for registration — please try again soon."
assertEqual(classifyPurchase(200, { success: true, data: { status: 'pending' } }), { outcome: 'accepted', status: 'pending' }, '200 success accepted')
assertEqual(classifyPurchase(200, { success: false }).outcome, 'ambiguous', '200 success:false ambiguous')
assertEqual(classifyPurchase(400, { success: false, error: { code: 400, message: 'bad' } }).outcome, 'rejected', '400')
assertEqual(classifyPurchase(401, {}).outcome, 'config_error', '401')
assertEqual(classifyPurchase(403, {}).outcome, 'config_error', '403')
assertEqual(classifyPurchase(404, {}).outcome, 'rejected', '404')
assertEqual(classifyPurchase(409, { success: false, error: { code: 409, message: MSG409 } }).outcome, 'retryable_hold', '409 unregistered')
assertEqual(classifyPurchase(409, { success: false, error: { code: 409, message: 'Duplicate reference' } }).outcome, 'rejected', '409 other')
assertEqual(classifyPurchase(409, null).outcome, 'rejected', '409 no body')
assertEqual(classifyPurchase(429, {}).outcome, 'rate_limited', '429')
assertEqual(classifyPurchase(503, {}).outcome, 'paused', '503')
assertEqual(classifyPurchase(500, {}).outcome, 'ambiguous', '500')
assertEqual(classifyPurchase(502, {}).outcome, 'ambiguous', '502')
assertEqual(classifyPurchase(504, {}).outcome, 'ambiguous', '504')
assertEqual(classifyPurchase(200, null).outcome, 'ambiguous', 'non-JSON body')
assertEqual(classifyPurchase(418, {}).outcome, 'ambiguous', 'other status')

// sizeToVolumeGb
assertEqual(sizeToVolumeGb('5GB'), 5, '5GB')
assertEqual(sizeToVolumeGb('1.5GB'), 1.5, '1.5GB')
assertEqual(sizeToVolumeGb('10 GB'), 10, '10 GB')
assertEqual(sizeToVolumeGb('500MB'), null, '500MB')
assertEqual(sizeToVolumeGb(''), null, 'empty')
assertEqual(sizeToVolumeGb('0GB'), null, '0GB')

// toLocalRecipient
for (const p of ['+233240000000', '233240000000', '0240000000', '024 000 0000']) {
    assertEqual(toLocalRecipient(p), '0240000000', `recipient ${p}`)
}
assertEqual(toLocalRecipient('12345'), null, 'short recipient')

// webhook signature
const secret = 'whsec_test'
const body = '{"event":"order.completed","order_id":"x"}'
const sig = createHmac('sha256', secret).update(body).digest('hex')
assertEqual(verifyWebhookSignature(body, sig, secret), true, 'valid signature')
assertEqual(verifyWebhookSignature(body, sig, 'other'), false, 'wrong secret')
assertEqual(verifyWebhookSignature(body + ' ', sig, secret), false, 'body changed')
assertEqual(verifyWebhookSignature(body, null, secret), false, 'header null')
assertEqual(verifyWebhookSignature(body, undefined, secret), false, 'header undefined')
assertEqual(verifyWebhookSignature(body, '', secret), false, 'header empty')
assertEqual(verifyWebhookSignature(body, sig.slice(0, 10), secret), false, 'header short')
assertEqual(verifyWebhookSignature(body, sig + 'ab', secret), false, 'header long')
assertEqual(verifyWebhookSignature(body, 'zz'.repeat(32), secret), false, 'non-hex header')
assertEqual(verifyWebhookSignature(body, sig.toUpperCase(), secret), true, 'uppercase accepted')
assertEqual(verifyWebhookSignature(body, sig, ''), false, 'empty secret')

// shouldRedeliver (TZ forced to America/New_York above)
const now = Date.UTC(2026, 10, 15, 20, 30, 0)
assertEqual(shouldRedeliver(new Date(now - 60_000).toISOString(), now), true, '1 min old')
assertEqual(shouldRedeliver(new Date(now - 30 * 60_000).toISOString(), now), false, '30 min old')
assertEqual(shouldRedeliver('2026-11-15 20:23:45', now), true, 'zone-less 6m old treated as UTC')
// A naive local read of this would land 5h in the future (=> true); correct UTC read is 20m old (=> false).
assertEqual(shouldRedeliver('2026-11-15 20:10:00', now), false, 'zone-less 20m old treated as UTC')
assertEqual(shouldRedeliver('2026-11-15T20:10:00', now), false, 'T zone-less treated as UTC')
assertEqual(shouldRedeliver('2026-11-15T15:25:00-05:00', now), true, 'explicit offset respected (5m old)')
assertEqual(shouldRedeliver('garbage', now), false, 'garbage')
assertEqual(shouldRedeliver(undefined, now), false, 'undefined')
assertEqual(shouldRedeliver(null, now), false, 'null')

// ─── I/O (fetch stubbed; no real network) ───
const KEY = 'kf_test_SECRETKEY123'
const realFetch = globalThis.fetch
let calls: { url: string; init: any }[] = []
function stub(fn: (url: string, init: any) => Response | Promise<Response>) {
    calls = []
    globalThis.fetch = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return fn(String(url), init) }) as any
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const input = { recipient: '0240000001', network: 'MTN' as const, volumeGb: 5, reference: buildKingflexyReference(uuid, 0) }
const noKey = (s: unknown) => !JSON.stringify(s ?? '').includes(KEY)

async function ioTests() {
    // missing key
    delete process.env.KINGFLEXY_DATA_API_KEY
    __resetKingflexyBreakerForTests()
    stub(() => json(200, {}))
    let r = await placeOrder(input)
    assertEqual([r.success, r.outcome, calls.length], [false, 'config_error', 0], 'missing key -> config_error, no fetch')

    process.env.KINGFLEXY_DATA_API_KEY = KEY // set AFTER import: proves call-time read

    // accepted
    stub(() => json(200, { success: true, data: { order_id: 'o1', reference: input.reference, status: 'pending', network: 'MTN', size: '5GB', recipient: input.recipient, price: 1, new_balance: 9 } }))
    r = await placeOrder(input)
    assertEqual([r.success, r.outcome, r.status], [true, 'accepted', 'pending'], '200 accepted')
    assertEqual(calls[0].url, 'https://api.kingflexygh.com/api/v2/data/purchase', 'purchase url')
    assertEqual(calls[0].init.method, 'POST', 'purchase method')
    assertEqual(calls[0].init.headers.Authorization, KEY, 'raw key, no Bearer')
    assertEqual(calls[0].init.headers['Content-Type'], 'application/json', 'content type')
    assertEqual(JSON.parse(calls[0].init.body), { network: 'MTN', volume_gb: 5, recipient: input.recipient, reference: input.reference }, 'purchase body')

    // 409 unregistered x6 -> hold, breaker stays closed
    const MSG = "This number isn't registered to receive MTN data yet. We've submitted it for registration — please try again soon."
    stub(() => json(409, { success: false, error: { code: 409, message: MSG } }))
    for (let i = 0; i < 6; i++) r = await placeOrder(input)
    assertEqual([r.success, r.outcome], [false, 'retryable_hold'], '409 unregistered -> retryable_hold')
    assertEqual(calls.length, 6, '6 hold calls all hit fetch (breaker closed)')
    assertEqual((r.apiResponse as any)?.error?.message, MSG, 'apiResponse preserves supplier reason')

    // 409 other -> rejected
    stub(() => json(409, { success: false, error: { code: 409, message: 'Reference reused with different payload' } }))
    r = await placeOrder(input)
    assertEqual(r.outcome, 'rejected', '409 other -> rejected')
    assertEqual((r.apiResponse as any)?.error?.message, 'Reference reused with different payload', 'rejected keeps reason')

    // 6x 502 -> breaker opens; next call no fetch
    __resetKingflexyBreakerForTests()
    stub(() => json(502, { error: 'bad gateway' }))
    for (let i = 0; i < 6; i++) r = await placeOrder(input)
    assertEqual(calls.length, 5, 'breaker opened after exactly 5 failures (6th made no fetch)')
    const before = calls.length
    r = await placeOrder(input)
    assertEqual([r.success, calls.length], [false, before], 'breaker open: no fetch on next call')
    // reads never gated while open
    stub(() => json(200, { success: true, data: { balance: 124.5, currency: 'GHS' } }))
    const b = await fetchSupplierBalance()
    assertEqual([b.success, b.balance, b.currency, calls.length], [true, 124.5, 'GHS', 1], 'reads not gated by open breaker')
    assertEqual(calls[0].url, 'https://api.kingflexygh.com/api/v2/wallet/balance', 'balance url')
    assertEqual(calls[0].init.headers.Authorization, KEY, 'balance raw key')

    // non-JSON 502 -> ambiguous
    __resetKingflexyBreakerForTests()
    stub(() => new Response('<html>oops</html>', { status: 502 }))
    r = await placeOrder(input)
    assertEqual([r.success, r.outcome], [false, 'ambiguous'], 'non-JSON 502 ambiguous')

    // thrown fetch -> ambiguous + transportFault, key never leaked
    __resetKingflexyBreakerForTests()
    stub(() => { throw new Error(`socket hang up Authorization: ${KEY}`) })
    r = await placeOrder(input)
    assertEqual([r.success, r.outcome, r.transportFault], [false, 'ambiguous', true], 'thrown fetch -> ambiguous transportFault')
    assertEqual(noKey(r), true, 'transport error does not leak key')

    // transport faults trip breaker too (1 already counted)
    for (let i = 0; i < 4; i++) await placeOrder(input)
    const c = calls.length
    await placeOrder(input)
    assertEqual(calls.length, c, 'transport faults open breaker')

    // 401 / 429 / 503 never trip
    for (const [st, out] of [[401, 'config_error'], [429, 'rate_limited'], [503, 'paused']] as const) {
        __resetKingflexyBreakerForTests()
        stub(() => json(st, { success: false, error: { code: st, message: 'nope' } }))
        for (let i = 0; i < 7; i++) r = await placeOrder(input)
        assertEqual([r.outcome, calls.length], [out, 7], `${st} never trips breaker`)
        assertEqual(noKey(r), true, `${st} no key leak`)
    }

    // checkOrderStatus
    stub(() => json(200, { success: true, data: { order_id: 'o1', reference: 'a/b', status: 'completed' } }))
    let s = await checkOrderStatus('a/b')
    assertEqual([s.success, s.found, s.status], [true, true, 'completed'], 'status found')
    assertEqual(calls[0].url, 'https://api.kingflexygh.com/api/v2/orders/a%2Fb', 'status url encoded')
    assertEqual(calls[0].init.headers.Authorization, KEY, 'status raw key')
    stub(() => json(404, { success: false, error: { code: 404, message: 'No order with this reference on your account.' } }))
    s = await checkOrderStatus('x')
    assertEqual([s.success, s.found], [true, false], '404 envelope -> found:false')
    stub(() => new Response('<html>nginx 404</html>', { status: 404 }))
    s = await checkOrderStatus('x')
    assertEqual([s.success, s.found], [false, false], '404 non-JSON -> success:false')
    stub(() => json(502, { error: 'x' }))
    s = await checkOrderStatus('x')
    assertEqual([s.success, s.found], [false, false], '502 -> success:false')
    stub(() => { throw new Error('timeout') })
    s = await checkOrderStatus('x')
    assertEqual([s.success, s.found], [false, false], 'thrown -> success:false')
    delete process.env.KINGFLEXY_DATA_API_KEY
    stub(() => json(200, {}))
    s = await checkOrderStatus('x')
    assertEqual([s.success, calls.length], [false, 0], 'status w/o key -> no fetch')
    const bb = await fetchSupplierBalance()
    assertEqual([bb.success, calls.length], [false, 0], 'balance w/o key -> no fetch')
    globalThis.fetch = realFetch
}

ioTests().then(() => {
    console.log(failures === 0 ? '\nAll tests passed' : `\n${failures} test(s) failed`)
    process.exit(failures > 0 ? 1 : 0)
}).catch(e => { console.error('test crash', e); process.exit(1) })
