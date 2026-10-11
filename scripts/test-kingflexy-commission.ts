import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
    classifyKfOrderStatus,
    classifyKfSendResponse,
    verifyKingFlexySignature,
    toLocalPhone,
    kfIdempotencyKey,
    baseReferenceFromKey,
    kfKeyForOrder,
    decideKfWebhookAction,
    parseKfLookup,
} from '../lib/kingflexy-commission-service'

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

console.log('OK')
