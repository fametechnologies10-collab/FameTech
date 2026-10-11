import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
    classifyKfOrderStatus,
    classifyKfSendResponse,
    verifyKingFlexySignature,
    toLocalPhone,
    kfIdempotencyKey,
    baseReferenceFromKey,
    isStaleAirtimeReference,
    kfKeyForOrder,
    decideKfWebhookAction,
    parseKfLookup,
} from '../lib/kingflexy-commission-service'
import {
    finalizeKfAirtime, finalizeKfUtility, buildLateSuccessAlert, buildAirtimeCompletedDetail,
    buildAirtimeFailedDetail, buildUtilityCompletedDetail, buildUtilityFailedDetail,
} from '../lib/kingflexy-finalize'

// classifyKfOrderStatus
assert.equal(classifyKfOrderStatus('completed'), 'completed')
assert.equal(classifyKfOrderStatus('pending'), 'pending')
assert.equal(classifyKfOrderStatus('processing'), 'pending')
assert.equal(classifyKfOrderStatus('failed'), 'failed')
assert.equal(classifyKfOrderStatus('refunded'), 'failed')
assert.equal(classifyKfOrderStatus('weird'), 'pending')
assert.equal(classifyKfOrderStatus(undefined), 'pending')
assert.equal(classifyKfOrderStatus(null), 'pending')

// classifyKfSendResponse
assert.equal(classifyKfSendResponse(200, { success: true }), 'accepted')
assert.equal(classifyKfSendResponse(200, { success: false }), 'transient')
assert.equal(classifyKfSendResponse(400, { success: false, error: 'Insufficient wallet balance' }), 'insufficient_balance')
assert.equal(classifyKfSendResponse(400, { error: 'Invalid amount' }), 'rejected')
assert.equal(classifyKfSendResponse(400, { error: 'Network MTN is currently disabled' }), 'biller_unavailable')
assert.equal(classifyKfSendResponse(401, {}), 'config_error')
assert.equal(classifyKfSendResponse(403, {}), 'config_error')
assert.equal(classifyKfSendResponse(409, {}), 'conflict')
assert.equal(classifyKfSendResponse(429, {}), 'rate_limited')
assert.equal(classifyKfSendResponse(503, {}), 'biller_unavailable')
assert.equal(classifyKfSendResponse(500, {}), 'transient')
assert.equal(classifyKfSendResponse(502, {}), 'transient')

// verifyKingFlexySignature
const body = '{"event":"order.completed"}'
const secret = 'whsec_test'
const sig = crypto.createHmac('sha256', secret).update(body).digest('hex')
assert.equal(verifyKingFlexySignature(body, sig, secret), true)
assert.equal(verifyKingFlexySignature(body, sig.toUpperCase(), secret), true)
assert.equal(verifyKingFlexySignature(body + ' ', sig, secret), false)
assert.equal(verifyKingFlexySignature(body, sig, 'other'), false)
assert.equal(verifyKingFlexySignature(body, null, secret), false)
assert.equal(verifyKingFlexySignature(body, '', secret), false)
assert.equal(verifyKingFlexySignature(body, 'abc', secret), false)
assert.equal(verifyKingFlexySignature(body, 'zz'.repeat(32), secret), false)

// toLocalPhone
for (const p of ['233551617309', '0551617309', '551617309', '+233 55 161 7309']) {
    assert.equal(toLocalPhone(p), '0551617309')
}

// idempotency keys
assert.equal(kfIdempotencyKey('UTIL-ECG-a1b2c3d4e5f60718', 0), 'UTIL-ECG-a1b2c3d4e5f60718')
assert.equal(kfIdempotencyKey('UTIL-ECG-a1b2c3d4e5f60718', 2), 'UTIL-ECG-a1b2c3d4e5f60718-m2')
assert.equal(kfIdempotencyKey('API-a/b c', 0), 'API-a-b-c')
const long = 'A'.repeat(100)
const k0 = kfIdempotencyKey(long, 0)
const k3 = kfIdempotencyKey(long, 3)
assert.ok(k0.length <= 64 && k3.length <= 64)
assert.notEqual(k0, k3)

assert.equal(baseReferenceFromKey('X-m3'), 'X')
assert.equal(baseReferenceFromKey('X'), 'X')

// isStaleAirtimeReference
assert.equal(isStaleAirtimeReference({ reference_code: 'REF', fulfillment_metadata: { client_reference: 'REF' } }, 'REF'), false)
assert.equal(isStaleAirtimeReference({ reference_code: 'REF', fulfillment_metadata: { client_reference: 'REF-m1', kf_generation: 1 } }, 'REF'), true)
assert.equal(isStaleAirtimeReference({ reference_code: 'REF', fulfillment_metadata: { client_reference: 'REF-m1', kf_generation: 1 } }, 'REF-m1'), false)
assert.equal(isStaleAirtimeReference({ reference_code: 'REF', fulfillment_metadata: null }, 'REF'), false)
assert.equal(isStaleAirtimeReference({ reference_code: 'REF', fulfillment_metadata: {} }, 'REF-m1'), true)
assert.equal(isStaleAirtimeReference({ reference_code: 'A B/C', fulfillment_metadata: null }, 'A-B-C'), false)
assert.equal(isStaleAirtimeReference({ reference_code: 'A B/C', fulfillment_metadata: null }, 'A B/C'), true)

// kfKeyForOrder
assert.deepEqual(
    kfKeyForOrder({ reference_code: 'R1', status: 'pending', fulfillment_metadata: null }, { bumpAfterFailure: false }),
    { key: 'R1', generation: 0 },
)
assert.equal(
    kfKeyForOrder({ reference_code: 'R1', status: 'failed', fulfillment_metadata: { kf_generation: 1 } }, { bumpAfterFailure: true }).generation,
    2,
)
assert.equal(
    kfKeyForOrder({ reference_code: 'R1', status: 'pending', fulfillment_metadata: { kf_generation: 1 } }, { bumpAfterFailure: false }).generation,
    1,
)

// decideKfWebhookAction
assert.deepEqual(
    decideKfWebhookAction({ event: 'order.completed', product: 'airtime', reference: 'R', status: 'completed' }),
    { action: 'completed', product: 'airtime', reference: 'R' },
)
assert.equal(decideKfWebhookAction({ event: 'order.failed', product: 'utilities', reference: 'U', status: 'refunded' }).action, 'failed')
assert.equal(decideKfWebhookAction({ event: 'order.failed', status: 'failed', product: 'airtime', reference: 'R' }).action, 'failed')
assert.equal(decideKfWebhookAction({ event: 'order.completed', product: 'data', reference: 'R', status: 'completed' }).action, 'ignore')
assert.equal(decideKfWebhookAction({ event: 'order.completed', product: 'airtime', status: 'completed' }).action, 'ignore')
assert.equal(decideKfWebhookAction({ event: 'order.completed', product: 'airtime', reference: 'R', status: 'weird' }).action, 'ignore')

// parseKfLookup
const ecg = parseKfLookup('ecg', { account_name: null, meters: [{ name: 'KWAME', meterNumber: '3701', outstanding: 245.8 }] })
assert.equal(ecg.meters.length, 1)
assert.equal(ecg.meters[0].meterNumber, '3701')
assert.equal(ecg.sessionId, null)
const dstv = parseKfLookup('dstv', { account_name: 'A', account_number: '7041', amount_due: -5, bouquet: null, meters: [] })
assert.equal(dstv.accountName, 'A')
assert.equal(dstv.amountDue, -5)
const bad = parseKfLookup('dstv', 'garbage')
assert.equal(bad.accountName, null)
assert.equal(bad.accountNumber, null)
assert.equal(bad.amountDue, null)
assert.equal(bad.bouquet, null)
assert.equal(bad.sessionId, null)
assert.deepEqual(bad.meters, [])
assert.deepEqual(bad.raw, [])

// ---------------------------------------------------------------------------
// Network section (stubbed fetch)
// ---------------------------------------------------------------------------

type Call = { url: string; init: any }
const calls: Call[] = []
let queue: Array<{ status: number; body: unknown } | 'throw'> = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    const next = queue.shift()
    if (!next || next === 'throw') throw new Error('socket hang up kf_cs_live_test')
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

function stub(status: number, body: unknown) {
    queue.push({ status, body })
}
function reset() {
    calls.length = 0
    queue = []
}

async function networkTests() {
    process.env.KINGFLEXY_COMMISSION_API_KEY = 'kf_cs_live_test'
    const kf = await import('../lib/kingflexy-commission-service')

    // airtime accepted
    reset()
    stub(200, { success: true, data: { order_id: 'o1', status: 'pending' } })
    let r = await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, 'REF-1')
    assert.deepEqual({ s: r.success, p: r.pending, t: r.transactionId }, { s: true, p: true, t: 'o1' })
    assert.ok(calls[0].url.endsWith('/airtime/purchase'))
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers.Authorization, 'kf_cs_live_test')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
        network: 'MTN', beneficiary_phone: '0551617309', amount: 10, reference: 'REF-1',
    })

    reset()
    stub(200, { success: true, data: { order_id: 'o2', status: 'completed' } })
    r = await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, 'REF-2')
    assert.equal(r.success, true)
    assert.equal(r.pending, false)

    reset()
    stub(200, { success: true, data: { order_id: 'o2f', status: 'failed' } })
    r = await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, 'REF-2F')
    assert.equal(r.success, false)
    assert.equal(r.isPermanentFailure, true)

    reset()
    stub(400, { success: false, error: 'Insufficient wallet balance' })
    r = await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, 'REF-3')
    assert.equal(r.success, false)
    assert.equal(r.isInsufficientFloat, true)

    reset()
    stub(400, { success: false, error: 'Invalid amount' })
    r = await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, 'REF-4')
    assert.equal(r.isPermanentFailure, true)

    reset()
    stub(429, {})
    r = await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, 'REF-5')
    assert.equal(r.isRateLimited, true)

    reset()
    stub(401, { error: 'bad key kf_cs_live_test' })
    r = await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, 'REF-6')
    assert.equal(r.success, false)
    assert.ok(!r.isPermanentFailure && !r.isInsufficientFloat)
    assert.ok(!String(r.error).includes('kf_cs_live_test'))

    reset()
    r = await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 150, 'REF-7')
    assert.equal(r.isPermanentFailure, true)
    assert.equal(calls.length, 0)
    r = await kf.fulfillAirtimeKingFlexy('Glo', '0551617309', 10, 'REF-8')
    assert.equal(r.isPermanentFailure, true)
    assert.equal(calls.length, 0)

    reset()
    stub(200, { success: true, data: { order_id: 'o9', status: 'pending' } })
    await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, 'REF-9')
    reset()
    queue.push('throw')
    r = await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, 'REF-10')
    assert.equal(r.success, false)
    assert.ok(!String(r.error).includes('kf_cs_live_test'))

    // missing key
    const savedKey = process.env.KINGFLEXY_COMMISSION_API_KEY
    delete process.env.KINGFLEXY_COMMISSION_API_KEY
    reset()
    r = await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, 'REF-11')
    assert.equal(r.success, false)
    assert.ok(!r.isPermanentFailure && !r.isInsufficientFloat && !r.isRateLimited)
    assert.equal(calls.length, 0)
    process.env.KINGFLEXY_COMMISSION_API_KEY = savedKey

    // utility pay
    const pay = (extra: Record<string, unknown> = {}) =>
        kf.payUtilityKingFlexy({ biller: 'dstv', account: '7041', amountGhs: 50, key: 'UTIL-1', ...extra } as any)

    reset()
    stub(200, { success: true, data: { reference: 'UTIL-DSTV-abc', status: 'pending' } })
    let u = await pay()
    assert.equal(u.outcome, 'pending')
    assert.equal(u.success, true)
    assert.equal(u.pending, true)
    assert.equal(u.transactionId, 'UTIL-DSTV-abc')
    assert.ok(calls[0].url.endsWith('/utilities/pay'))
    assert.equal(calls[0].init.headers.Authorization, 'kf_cs_live_test')
    let sent = JSON.parse(calls[0].init.body)
    assert.deepEqual(sent, { biller: 'dstv', account: '7041', amount: 50, reference: 'UTIL-1' })

    reset()
    stub(200, { success: true, data: { reference: 'UTIL-DSTV-abc', status: 'refunded', already_processed: true } })
    u = await pay()
    assert.equal(u.outcome, 'failed')
    assert.equal(u.success, false)

    reset()
    stub(200, { success: true, data: { reference: 'UTIL-DSTV-abc', status: 'completed' } })
    u = await pay({ biller: 'ecg', phone: '0551617309' })
    assert.equal(u.outcome, 'completed')
    assert.equal(JSON.parse(calls[0].init.body).phone, '0551617309')

    reset()
    stub(400, { error: 'Insufficient wallet balance' })
    assert.equal((await pay()).outcome, 'insufficient_float')
    reset()
    stub(400, { error: 'Invalid account' })
    assert.equal((await pay()).outcome, 'permanent_failure')
    reset()
    stub(403, {})
    u = await pay()
    assert.equal(u.outcome, 'config_error')
    reset()
    stub(429, {})
    u = await pay()
    assert.equal(u.outcome, 'rate_limited')
    assert.equal(u.isRateLimited, true)
    reset()
    stub(503, {})
    assert.equal((await pay()).outcome, 'not_configured')
    reset()
    stub(500, {})
    assert.equal((await pay()).outcome, 'network_error')
    reset()
    queue.push('throw')
    u = await pay()
    assert.equal(u.outcome, 'network_error')
    assert.ok(!String(u.error).includes('kf_cs_live_test'))

    // lookup
    reset()
    stub(200, { success: true, data: { account_name: null, meters: [{ name: 'K', meterNumber: '3701', outstanding: 5 }] } })
    let l = await kf.lookupUtilityAccountKingFlexy('ecg', '0551617309')
    assert.equal(l.success, true)
    assert.equal(l.info?.meters[0].meterNumber, '3701')
    let q = new URL(calls[0].url)
    assert.ok(q.pathname.endsWith('/utilities/lookup'))
    assert.equal(q.searchParams.get('biller'), 'ecg')
    assert.equal(q.searchParams.get('account'), '0551617309')
    assert.equal(q.searchParams.get('phone'), '0551617309')
    assert.equal(calls[0].init.headers.Authorization, 'kf_cs_live_test')

    reset()
    stub(200, { success: true, data: { account_name: 'A' } })
    await kf.lookupUtilityAccountKingFlexy('ghana_water', 'GW1', '0551617309')
    q = new URL(calls[0].url)
    assert.equal(q.searchParams.get('account'), 'GW1')
    assert.equal(q.searchParams.get('phone'), '0551617309')

    reset()
    stub(200, { success: true, data: { account_name: 'A' } })
    await kf.lookupUtilityAccountKingFlexy('dstv', '7041')
    q = new URL(calls[0].url)
    assert.equal(q.searchParams.get('account'), '7041')
    assert.equal(q.searchParams.has('phone'), false)

    reset()
    stub(404, {})
    assert.deepEqual(await kf.lookupUtilityAccountKingFlexy('dstv', '7041'), {
        success: false, error: 'Account not found — check the number',
    })
    reset()
    stub(502, {})
    l = await kf.lookupUtilityAccountKingFlexy('dstv', '7041')
    assert.equal(l.success, false)
    assert.equal(l.isNetworkError, true)
    reset()
    stub(429, {})
    l = await kf.lookupUtilityAccountKingFlexy('dstv', '7041')
    assert.equal(l.isRateLimited, true)

    // status checks
    reset()
    stub(200, { success: true, data: { status: 'refunded', reason: 'x' } })
    let s = await kf.checkAirtimeOrderStatus('REF-1')
    assert.equal(s.state, 'failed')
    assert.equal(s.found, true)
    assert.equal(s.httpOk, true)
    assert.equal(s.reason, 'x')
    assert.ok(calls[0].url.endsWith('/airtime/orders/REF-1'))
    assert.equal(calls[0].init.headers.Authorization, 'kf_cs_live_test')
    reset()
    stub(404, {})
    s = await kf.checkAirtimeOrderStatus('REF-1')
    assert.equal(s.found, false)
    assert.equal(s.state, 'unknown')
    reset()
    stub(200, { success: true, data: { status: 'completed', commission_earned: 12.5, reference: 'UTIL-X' } })
    s = await kf.checkUtilityOrderStatus('UTIL-X')
    assert.ok(calls[0].url.endsWith('/utilities/orders/UTIL-X'))
    assert.equal(s.commissionEarned, 12.5)
    assert.equal(s.state, 'completed')
    reset()
    stub(200, { success: true, data: { status: 'pending', commission_earned: null } })
    s = await kf.checkUtilityOrderStatus('UTIL-X')
    assert.equal(s.commissionEarned, null)
    reset()
    queue.push('throw')
    s = await kf.checkUtilityOrderStatus('UTIL-X')
    assert.equal(s.httpOk, false)
    assert.equal(s.state, 'unknown')
    assert.ok(!String(s.error).includes('kf_cs_live_test'))

    // utility breaker (independent of airtime): 5 failures then open
    reset()
    stub(200, { success: true, data: { reference: 'R', status: 'pending' } })
    await pay()
    reset()
    for (let i = 0; i < 5; i++) stub(500, {})
    for (let i = 0; i < 5; i++) await pay()
    reset()
    u = await pay()
    assert.ok(/circuit open/.test(String(u.error)))
    assert.equal(calls.length, 0)

    // airtime breaker: rejection (400) does not count; 5 transient failures open it
    reset()
    stub(200, { success: true, data: { order_id: 'o', status: 'pending' } })
    await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, 'B-0')
    reset()
    for (let i = 0; i < 4; i++) stub(500, {})
    stub(400, { error: 'Invalid amount' })
    stub(500, {})
    for (let i = 0; i < 6; i++) await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, `B-${i}`)
    assert.equal(calls.length, 6)
    reset()
    r = await kf.fulfillAirtimeKingFlexy('MTN', '0551617309', 10, 'B-X')
    assert.ok(/circuit open/.test(String(r.error)))
    assert.equal(calls.length, 0)
}

type StubLog = { table: string; op: string }[]
function makeStub(opts: { updateRows: { id: string }[]; freshRow?: { status: string } | null }) {
    const log: StubLog = []
    const mkBuilder = (table: string) => {
        let mode = 'select'
        const b: any = {
            update: () => { mode = 'update'; log.push({ table, op: 'update' }); return b },
            insert: () => { log.push({ table, op: 'insert' }); return Promise.resolve({ data: null, error: null }) },
            select: () => { if (mode === 'select') log.push({ table, op: 'select' }); return b },
            eq: () => b, in: () => b, neq: () => b, is: () => b,
            maybeSingle: () => { log.push({ table, op: 'select' }); return Promise.resolve({ data: opts.freshRow ?? null }) },
            single: () => Promise.resolve({ data: opts.freshRow ?? null }),
            then: (res: any, rej: any) => Promise.resolve({ data: mode === 'update' ? opts.updateRows : opts.freshRow ?? null, error: null }).then(res, rej),
        }
        return b
    }
    const client = {
        from: (table: string) => mkBuilder(table),
        rpc: (fn: string) => { log.push({ table: fn, op: 'rpc' }); return Promise.resolve({ data: null, error: null }) },
    }
    return { client, log }
}

async function finalizeTests() {
    const airOrder = { id: 'a1', reference_code: 'API-R1', network: 'MTN', airtime_amount: 10, user_id: 'u1', source: 'api', api_key_id: 'k1', fulfillment_metadata: null }
    const utilOrder = { id: 'u1', reference_code: 'API-R2', biller: 'ecg', account_number: '123', amount: 20, user_id: 'u1', shop_id: null, source: 'api', api_key_id: 'k1', destination_phone: null, fulfillment_metadata: null }
    for (const state of ['completed', 'failed'] as const) {
        let { client, log } = makeStub({ updateRows: [], freshRow: { status: 'completed' } })
        let r = await finalizeKfAirtime(client, airOrder, { state })
        assert.deepEqual(r, { transitioned: false })
        assert.ok(!log.some((l) => l.op === 'rpc' || l.op === 'insert'))
        assert.equal(log.filter((l) => l.op === 'update').length, 1)
        ;({ client, log } = makeStub({ updateRows: [], freshRow: { status: 'completed' } }))
        r = await finalizeKfUtility(client, utilOrder, { state, commissionEarned: 1.5 })
        assert.deepEqual(r, { transitioned: false })
        assert.ok(!log.some((l) => l.op === 'rpc' || l.op === 'insert'))
        assert.equal(log.filter((l) => l.op === 'update').length, 1)
    }
    // late success on a refunded order re-reads the fresh status for the admin alert
    let { client, log } = makeStub({ updateRows: [], freshRow: { status: 'refunded' } })
    let r = await finalizeKfAirtime(client, airOrder, { state: 'completed' })
    assert.equal(r.transitioned, false)
    assert.ok(log.some((l) => l.table === 'airtime_orders' && l.op === 'select'))
    assert.ok(!log.some((l) => l.op === 'rpc' || l.op === 'insert'))
    ;({ client, log } = makeStub({ updateRows: [], freshRow: { status: 'refunded' } }))
    r = await finalizeKfUtility(client, utilOrder, { state: 'completed' })
    assert.equal(r.transitioned, false)
    assert.ok(log.some((l) => l.table === 'utility_orders' && l.op === 'select'))
    // late success on a failed order: alert path attempted, no side effects
    ;({ client, log } = makeStub({ updateRows: [], freshRow: { status: 'failed' } }))
    r = await finalizeKfAirtime(client, airOrder, { state: 'completed' })
    assert.equal(r.transitioned, false)
    assert.ok(log.some((l) => l.table === 'airtime_orders' && l.op === 'select'))
    assert.ok(!log.some((l) => l.op === 'rpc' || l.op === 'insert'))
    ;({ client, log } = makeStub({ updateRows: [], freshRow: { status: 'failed' } }))
    r = await finalizeKfUtility(client, utilOrder, { state: 'completed' })
    assert.equal(r.transitioned, false)
    assert.ok(log.some((l) => l.table === 'utility_orders' && l.op === 'select'))
    assert.ok(!log.some((l) => l.op === 'rpc' || l.op === 'insert'))

    assert.equal(buildLateSuccessAlert('airtime', 'completed', 'R'), null)
    assert.equal(buildLateSuccessAlert('utility', 'pending', 'R'), null)
    assert.match(buildLateSuccessAlert('airtime', 'refunded', 'R')!.title, /already-refunded airtime/)
    assert.match(buildLateSuccessAlert('utility', 'failed', 'R')!.title, /already-failed utility order — do NOT refund/)
    assert.equal(buildLateSuccessAlert('utility', 'failed', 'R')!.url, '/admin/utilities')

    const refunded = { refunded: true, amount: 10, newBalance: 50 }
    assert.deepEqual(buildAirtimeCompletedDetail({ network: 'MTN', airtime_amount: '10' }), { network: 'MTN', airtime_amount: 10 })
    assert.deepEqual(buildUtilityCompletedDetail({ biller: 'ecg', amount: '20' }), { biller: 'ecg', amount: 20 })
    assert.deepEqual(buildAirtimeFailedDetail({ network: 'MTN', airtime_amount: '10' }, 'c', 'm', { refunded: false }),
        { network: 'MTN', airtime_amount: 10, reason_code: 'c', reason: 'm' })
    assert.deepEqual(buildAirtimeFailedDetail({ network: 'MTN', airtime_amount: 10 }, 'c', 'm', refunded),
        { network: 'MTN', airtime_amount: 10, reason_code: 'c', reason: 'm', refunded: true, refund_amount: 10, new_balance: 50 })
    assert.deepEqual(buildUtilityFailedDetail({ biller: 'ecg', amount: '20' }, 'c', 'm', { refunded: false }),
        { biller: 'ecg', amount: 20, reason_code: 'c', reason: 'm' })
    assert.deepEqual(buildUtilityFailedDetail({ biller: 'ecg', amount: 20 }, 'c', 'm', refunded),
        { biller: 'ecg', amount: 20, reason_code: 'c', reason: 'm', refunded: true, refund_amount: 10, new_balance: 50 })
}

networkTests()
    .then(finalizeTests)
    .then(() => {
        globalThis.fetch = realFetch
        console.log('OK')
    })
    .catch((e) => {
        globalThis.fetch = realFetch
        console.error(e)
        process.exit(1)
    })
