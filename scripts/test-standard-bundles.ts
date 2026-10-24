import assert from 'node:assert/strict'
import {
    applyDiscount,
    parseDiscountSetting,
    classifyBundlePurchase,
    mapKfBundleStatus,
    decideBundleWebhook,
    parseCatalog,
    findBundle,
    referenceFromKey,
    isValidIdempotencyKey,
    isValidBeneficiary,
    decideDispatchAction,
} from '../lib/standard-bundles-logic'
import { buildPurchaseBody, isCatalogFresh } from '../lib/kingflexy-bundles-service'

let failed = 0
function test(name: string, fn: () => void) {
    try {
        fn()
        console.log(`ok - ${name}`)
    } catch (err) {
        failed++
        console.error(`FAIL - ${name}`)
        console.error(err)
    }
}

test('applyDiscount', () => {
    assert.equal(applyDiscount(20, 5, 'standard'), 19)
    assert.equal(applyDiscount(20, 5, 'special'), 19)
    assert.equal(applyDiscount(20, 5, 'broadband'), 20)
    assert.ok(applyDiscount(0.5, 50, 'standard') >= 0.01)
    assert.equal(applyDiscount(20, 0, 'standard'), 20)
    assert.equal(applyDiscount(20, 100, 'standard'), 10) // clamped to 50
    assert.equal(applyDiscount(20, -5, 'standard'), 20)
    assert.equal(applyDiscount(NaN, 5, 'standard'), 0.01)
})

test('parseDiscountSetting', () => {
    assert.equal(parseDiscountSetting('abc'), 0)
    assert.equal(parseDiscountSetting('75'), 50)
    assert.equal(parseDiscountSetting('-3'), 0)
    assert.equal(parseDiscountSetting('5'), 5)
    assert.equal(parseDiscountSetting(7.5), 7.5)
    assert.equal(parseDiscountSetting(null), 0)
    assert.equal(parseDiscountSetting(undefined), 0)
    assert.equal(parseDiscountSetting(''), 0)
})

test('classifyBundlePurchase', () => {
    assert.equal(classifyBundlePurchase(400, { error: 'Insufficient wallet balance' }), 'insufficient_balance')
    assert.equal(classifyBundlePurchase(400, { error: 'Invalid number' }), 'definitive_reject')
    assert.equal(classifyBundlePurchase(404, {}), 'definitive_reject')
    assert.equal(classifyBundlePurchase(409, {}), 'in_flight')
    assert.equal(classifyBundlePurchase(503, {}), 'unavailable')
    assert.equal(classifyBundlePurchase(429, {}), 'rate_limited')
    assert.equal(classifyBundlePurchase(401, {}), 'config_error')
    assert.equal(classifyBundlePurchase(403, {}), 'config_error')
    assert.equal(classifyBundlePurchase(200, { success: true, data: { status: 'pending' } }), 'accepted')
    assert.equal(classifyBundlePurchase(200, { success: true, data: { is_duplicate: true } }), 'duplicate')
    assert.equal(classifyBundlePurchase(200, { success: false }), 'transient')
    assert.equal(classifyBundlePurchase(200, null), 'transient')
    assert.equal(classifyBundlePurchase(502, null), 'transient')
})

test('mapKfBundleStatus', () => {
    assert.equal(mapKfBundleStatus('refunded'), 'failed')
    assert.equal(mapKfBundleStatus('failed'), 'failed')
    assert.equal(mapKfBundleStatus('completed'), 'completed')
    assert.equal(mapKfBundleStatus('processing'), 'processing')
    assert.equal(mapKfBundleStatus('pending'), 'pending')
    assert.equal(mapKfBundleStatus('weird'), 'pending')
    assert.equal(mapKfBundleStatus(undefined), 'pending')
})

test('decideBundleWebhook', () => {
    assert.deepEqual(decideBundleWebhook({ product: 'airtime', reference: 'GHD-1', status: 'completed' }), { action: 'ignore' })
    assert.deepEqual(decideBundleWebhook(null), { action: 'ignore' })
    assert.deepEqual(decideBundleWebhook({ product: 'bundles', reference: '', status: 'completed' }), { action: 'ignore' })
    assert.deepEqual(decideBundleWebhook({ product: 'bundles', reference: 'GHD-1', status: 'processing' }), { action: 'ignore' })
    assert.deepEqual(
        decideBundleWebhook({ product: 'bundles', reference: 'GHD-1', status: 'completed', detail: { previously_refunded: true } }),
        { action: 'completed', reference: 'GHD-1', previouslyRefunded: true },
    )
    assert.deepEqual(
        decideBundleWebhook({ product: 'bundles', reference: 'GHD-1', status: 'completed' }),
        { action: 'completed', reference: 'GHD-1', previouslyRefunded: false },
    )
    assert.equal(decideBundleWebhook({ product: 'bundles', reference: 'GHD-1', status: 'refunded' }).action, 'failed')
    assert.equal(decideBundleWebhook({ product: 'bundles', reference: 'GHD-1', status: 'failed' }).action, 'failed')
})

const catalogBody = {
    success: true,
    data: {
        network: 'MTN',
        enabled: true,
        families: [],
        bundles: [
            { value: '1', amount: 5, price: 4.8, size: '1GB', plan: 'x', family: 'std', family_label: 'Standard', validity: '30d', pack_id: null },
            { value: '2', amount: 'oops', price: 4.8, size: '2GB', family: 'std', family_label: 'Standard' },
            { amount: 10, price: 9.5, size: '3GB', family: 'sp', family_label: 'Special', pack_id: 'PK-1' },
            { value: '9', amount: 10, price: -1, size: '9GB', family: 'std', family_label: 'Standard' },
            null,
        ],
        broadband: { network: 'TelecelBroadband', enabled: true, min_amount: 10, max_amount: 500, commission: 1 },
    },
}

test('parseCatalog', () => {
    const c = parseCatalog('MTN', catalogBody)
    assert.equal(c.enabled, true)
    assert.equal(c.bundles.length, 2)
    assert.equal(c.bundles[0].value, '1')
    assert.equal(c.bundles[0].pack_id, null)
    assert.equal(c.bundles[1].pack_id, 'PK-1')
    assert.equal(c.bundles[1].value, null)
    assert.equal(c.bundles[1].network, 'MTN')
    assert.deepEqual(c.broadband, { enabled: true, min: 10, max: 500 })
    const empty = parseCatalog('AT', 'garbage')
    assert.deepEqual(empty, { bundles: [], enabled: false, broadband: null })
})

test('findBundle', () => {
    const { bundles } = parseCatalog('MTN', catalogBody)
    assert.equal(findBundle(bundles, { pack_id: 'PK-1' })?.size, '3GB')
    assert.equal(findBundle(bundles, { value: '1' })?.size, '1GB')
    assert.equal(findBundle(bundles, { value: '1', pack_id: 'PK-1' })?.size, '3GB')
    assert.equal(findBundle(bundles, { value: '1', pack_id: 'GONE' }), null)
    assert.equal(findBundle(bundles, { pack_id: 'GONE' }), null)
    assert.equal(findBundle(bundles, { value: 'nope' }), null)
    assert.equal(findBundle(bundles, {}), null)
})

test('referenceFromKey / isValidIdempotencyKey / isValidBeneficiary', () => {
    const key = '123e4567-e89b-12d3-a456-426614174000'
    assert.equal(referenceFromKey(key), referenceFromKey(key))
    assert.match(referenceFromKey(key), /^GHD-[0-9A-F]{20}$/)
    assert.equal(referenceFromKey(key), 'GHD-123E4567E89B12D3A456')
    assert.equal(isValidIdempotencyKey(key), true)
    assert.equal(isValidIdempotencyKey('nope'), false)
    assert.equal(isValidIdempotencyKey(undefined), false)
    assert.equal(isValidBeneficiary('standard', '0241234567'), true)
    assert.equal(isValidBeneficiary('special', '024123456'), false)
    assert.equal(isValidBeneficiary('broadband', '+233241234567'), false)
})

test('decideDispatchAction', () => {
    assert.equal(decideDispatchAction('accepted'), 'accepted')
    assert.equal(decideDispatchAction('duplicate'), 'accepted')
    assert.equal(decideDispatchAction('definitive_reject'), 'finalize_failed')
    assert.equal(decideDispatchAction('in_flight'), 'stay_processing')
    for (const o of ['insufficient_balance', 'unavailable', 'rate_limited', 'transient', 'config_error'] as const) {
        assert.equal(decideDispatchAction(o), 'revert_pending')
    }
})

test('buildPurchaseBody', () => {
    assert.deepEqual(
        buildPurchaseBody({ kind: 'standard', network: 'MTN', phone: '+233241234567', reference: 'GHD-1', value: '1GB', amount: 5 }),
        { network: 'MTN', beneficiary_phone: '0241234567', value: '1GB', amount: 5, reference: 'GHD-1' },
    )
    assert.deepEqual(
        buildPurchaseBody({ kind: 'special', network: 'MTN', phone: '0241234567', reference: 'GHD-2', packId: 'p9', amount: 12, value: 'x' }),
        { pack_id: 'p9', beneficiary_phone: '0241234567', reference: 'GHD-2' },
    )
    const bb = buildPurchaseBody({ kind: 'broadband', network: 'Telecel', phone: '0201234567', reference: 'GHD-3', amount: 30, value: 'x' })
    assert.deepEqual(bb, { network: 'TelecelBroadband', beneficiary_phone: '0201234567', amount: 30, reference: 'GHD-3' })
    assert.equal('value' in bb, false)
})

test('isCatalogFresh', () => {
    const now = Date.parse('2026-10-24T12:00:00Z')
    assert.equal(isCatalogFresh('2026-10-24T11:50:00Z', now), true)
    assert.equal(isCatalogFresh('2026-10-24T11:45:00Z', now), false)
    assert.equal(isCatalogFresh('garbage', now), false)
    assert.equal(isCatalogFresh(undefined, now), false)
    assert.equal(isCatalogFresh('2026-10-24T12:05:00Z', now), false)
})

if (failed > 0) {
    console.error(`\n${failed} test(s) failed`)
    process.exit(1)
}
console.log('\nAll standard-bundles tests passed')
