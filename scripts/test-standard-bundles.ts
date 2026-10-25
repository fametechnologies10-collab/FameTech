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
    isBundleFlagEnabled,
    bundleKillSwitchKeys,
    decideAlertThrottle,
    BUNDLE_FAILURE_CUSTOMER_MESSAGE,
    shouldAlertExhausted,
    normalizeBundleNetwork,
    validateBroadbandAmount,
    computeBundlePrice,
    resolveBundleForPurchase,
    isDefinitiveOutcome,
    isValidPurchaseSuccess,
    decideAttemptKeyAction,
    validateBundleSettingsInput,
    decideAdminRefundGate,
    isConfirmedNotFound,
} from '../lib/standard-bundles-logic'
import { buildPurchaseBody, isCatalogFresh, pickNewerCatalogCopy } from '../lib/kingflexy-bundles-service'

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

test('pickNewerCatalogCopy', () => {
    const older = { etag: 'a', fetched_at: '2026-10-24T10:00:00Z', body: {} }
    const newer = { etag: 'b', fetched_at: '2026-10-24T11:00:00Z', body: {} }
    assert.equal(pickNewerCatalogCopy(older, null), older)
    assert.equal(pickNewerCatalogCopy(null, newer), newer)
    assert.equal(pickNewerCatalogCopy(older, newer), newer)
    assert.equal(pickNewerCatalogCopy(newer, older), newer)
    const tie = { etag: 'c', fetched_at: older.fetched_at, body: {} }
    assert.equal(pickNewerCatalogCopy(older, tie), older)
    assert.equal(pickNewerCatalogCopy(null, null), null)
})

test('isBundleFlagEnabled: only explicit false disables', () => {
    assert.equal(isBundleFlagEnabled('true'), true)
    assert.equal(isBundleFlagEnabled(true), true)
    assert.equal(isBundleFlagEnabled('false'), false)
    assert.equal(isBundleFlagEnabled(false), false)
    assert.equal(isBundleFlagEnabled(undefined), true)
    assert.equal(isBundleFlagEnabled(null), true)
})

test('bundleKillSwitchKeys', () => {
    assert.deepEqual(bundleKillSwitchKeys('MTN', 'standard'), ['std_bundles_enabled', 'std_bundles_enabled_mtn'])
    assert.deepEqual(bundleKillSwitchKeys('Telecel', 'special'), ['std_bundles_enabled', 'std_bundles_enabled_telecel'])
    assert.deepEqual(bundleKillSwitchKeys('AT', 'standard'), ['std_bundles_enabled', 'std_bundles_enabled_at'])
    assert.deepEqual(bundleKillSwitchKeys('Telecel', 'broadband'), ['std_bundles_enabled', 'std_bundles_enabled_broadband'])
})

test('decideAlertThrottle: once per hour per outcome', () => {
    const now = Date.parse('2026-10-24T12:00:00Z')
    assert.equal(decideAlertThrottle(null, 'unavailable', now).send, true)
    assert.equal(decideAlertThrottle({}, 'unavailable', now).send, true)
    const recent = { last_alert_at: '2026-10-24T11:30:00Z', last_alert_outcome: 'unavailable' }
    assert.equal(decideAlertThrottle(recent, 'unavailable', now).send, false)
    assert.equal(decideAlertThrottle(recent, 'transient', now).send, true) // different outcome
    const old = { last_alert_at: '2026-10-24T10:59:00Z', last_alert_outcome: 'unavailable' }
    assert.equal(decideAlertThrottle(old, 'unavailable', now).send, true)
    assert.equal(decideAlertThrottle({ last_alert_at: 'garbage', last_alert_outcome: 'unavailable' }, 'unavailable', now).send, true)
    const future = { last_alert_at: '2026-10-24T13:00:00Z', last_alert_outcome: 'unavailable' }
    assert.equal(decideAlertThrottle(future, 'unavailable', now).send, true) // clock skew: don't suppress forever
    const d = decideAlertThrottle({ keep: 1 }, 'transient', now)
    assert.deepEqual(d.meta, { keep: 1, last_alert_at: '2026-10-24T12:00:00.000Z', last_alert_outcome: 'transient' })
    assert.deepEqual(decideAlertThrottle(recent, 'unavailable', now).meta, recent)
})

test('customer failure message is fixed and supplier-free', () => {
    assert.equal(BUNDLE_FAILURE_CUSTOMER_MESSAGE, "We couldn't deliver your bundle. Your wallet has been refunded.")
})

test('shouldAlertExhausted: only at/over cap and not yet alerted', () => {
    assert.equal(shouldAlertExhausted(5, 5, null), true)
    assert.equal(shouldAlertExhausted(7, 5, {}), true)
    assert.equal(shouldAlertExhausted(4, 5, {}), false)
    assert.equal(shouldAlertExhausted(5, 5, { exhausted_at: '2026-10-24T12:00:00Z' }), false)
    assert.equal(shouldAlertExhausted(5, 5, { other: 1 }), true)
})

test('normalizeBundleNetwork', () => {
    assert.equal(normalizeBundleNetwork('standard', 'MTN'), 'MTN')
    assert.equal(normalizeBundleNetwork('special', 'AT'), 'AT')
    assert.equal(normalizeBundleNetwork('standard', 'Telecel'), 'Telecel')
    assert.equal(normalizeBundleNetwork('broadband', 'Telecel'), 'TelecelBroadband')
    assert.equal(normalizeBundleNetwork('broadband', 'TelecelBroadband'), 'TelecelBroadband')
    assert.equal(normalizeBundleNetwork('broadband', 'MTN'), null)
    assert.equal(normalizeBundleNetwork('standard', 'TelecelBroadband'), null)
    assert.equal(normalizeBundleNetwork('standard', 'Vodafone'), null)
    assert.equal(normalizeBundleNetwork('bogus', 'MTN'), null)
    assert.equal(normalizeBundleNetwork('standard', undefined), null)
})

test('validateBroadbandAmount', () => {
    assert.equal(validateBroadbandAmount(50, 10, 500), 50)
    assert.equal(validateBroadbandAmount('50', 10, 500), 50)
    assert.equal(validateBroadbandAmount(10, 10, 500), 10)
    assert.equal(validateBroadbandAmount(500, 10, 500), 500)
    assert.equal(validateBroadbandAmount(9.99, 10, 500), null)
    assert.equal(validateBroadbandAmount(501, 10, 500), null)
    assert.equal(validateBroadbandAmount(NaN, 10, 500), null)
    assert.equal(validateBroadbandAmount(Infinity, 10, 500), null)
    assert.equal(validateBroadbandAmount('abc', 10, 500), null)
    assert.equal(validateBroadbandAmount('', 10, 500), null)
    assert.equal(validateBroadbandAmount(undefined, 10, 500), null)
    assert.equal(validateBroadbandAmount(null, 10, 500), null)
    assert.equal(validateBroadbandAmount(10.555, 10, 500), null)
})

test('computeBundlePrice', () => {
    assert.equal(computeBundlePrice({ catalogPrice: 20, discountSetting: '5', kind: 'standard' }), 19)
    assert.equal(computeBundlePrice({ catalogPrice: 20, discountSetting: 5, kind: 'special' }), 19)
    assert.equal(computeBundlePrice({ catalogPrice: 20, discountSetting: '5', kind: 'broadband' }), 20)
    assert.equal(computeBundlePrice({ catalogPrice: 20, discountSetting: 'abc', kind: 'standard' }), 20)
    assert.equal(computeBundlePrice({ catalogPrice: 20, discountSetting: undefined, kind: 'standard' }), 20)
    assert.equal(computeBundlePrice({ catalogPrice: 20, discountSetting: '100', kind: 'standard' }), 10)
    assert.equal(computeBundlePrice({ catalogPrice: 0.01, discountSetting: '50', kind: 'standard' }), 0.01)
    assert.equal(computeBundlePrice({ catalogPrice: 0, discountSetting: 0, kind: 'standard' }), null)
    assert.equal(computeBundlePrice({ catalogPrice: -5, discountSetting: 0, kind: 'standard' }), null)
    assert.equal(computeBundlePrice({ catalogPrice: NaN, discountSetting: 0, kind: 'standard' }), null)
})

test('resolveBundleForPurchase', () => {
    const std = { value: '1', pack_id: null, amount: 10, price: 10 } as any
    assert.deepEqual(resolveBundleForPurchase('standard', std), { ok: true, catalogPrice: 10 })
    assert.deepEqual(resolveBundleForPurchase('standard', { ...std, amount: 10.004 }), { ok: true, catalogPrice: 10 })
    assert.deepEqual(resolveBundleForPurchase('standard', { ...std, amount: 12 }), { ok: false })
    assert.deepEqual(resolveBundleForPurchase('standard', { ...std, pack_id: 'p1' }), { ok: false })
    assert.deepEqual(resolveBundleForPurchase('standard', { ...std, value: null }), { ok: false })
    const sp = { value: null, pack_id: 'p1', amount: 12, price: 10 } as any
    assert.deepEqual(resolveBundleForPurchase('special', sp), { ok: true, catalogPrice: 10 })
    assert.deepEqual(resolveBundleForPurchase('special', { ...sp, pack_id: null }), { ok: false })
})

test('isDefinitiveOutcome (non-ok responses only; 200 is handled by the success path)', () => {
    for (const st of [400, 401, 403, 404, 503]) assert.equal(isDefinitiveOutcome(st, true), true, String(st))
    for (const st of [500, 502, 504, 408, 409, 429]) assert.equal(isDefinitiveOutcome(st, true), false, String(st))
    for (const st of [400, 401, 403, 404, 503, 500, 504]) assert.equal(isDefinitiveOutcome(st, false), false, 'unparsed ' + st)
})

test('isValidPurchaseSuccess', () => {
    assert.equal(isValidPurchaseSuccess({ success: true, data: { order: { reference_code: 'SB-1' } } }), true)
    assert.equal(isValidPurchaseSuccess({ success: true }), false)
    assert.equal(isValidPurchaseSuccess({ success: true, data: {} }), false)
    assert.equal(isValidPurchaseSuccess({ success: true, data: { order: {} } }), false)
    assert.equal(isValidPurchaseSuccess({ success: true, data: { order: { reference_code: '' } } }), false)
    assert.equal(isValidPurchaseSuccess({ success: false, data: { order: { reference_code: 'x' } } }), false)
    assert.equal(isValidPurchaseSuccess(null), false)
    assert.equal(isValidPurchaseSuccess('ok'), false)
})

test('isValidPurchaseSuccess rejects an array order', () => {
    assert.equal(isValidPurchaseSuccess({ success: true, data: { order: [] } }), false)
    assert.equal(isValidPurchaseSuccess({ success: true, data: { order: Object.assign([], { reference_code: 'x' }) } }), false)
})

test('decideAttemptKeyAction', () => {
    const d = decideAttemptKeyAction
    assert.equal(d({ ok: true, status: 200, bodyParsed: true, validSuccess: true }), 'clear')
    assert.equal(d({ ok: true, status: 200, bodyParsed: true, validSuccess: false }), 'keep')
    assert.equal(d({ ok: true, status: 200, bodyParsed: false, validSuccess: false }), 'keep')
    assert.equal(d({ ok: false, status: 400, bodyParsed: true, validSuccess: false }), 'clear')
    assert.equal(d({ ok: false, status: 503, bodyParsed: true, validSuccess: false }), 'clear')
    assert.equal(d({ ok: false, status: 500, bodyParsed: true, validSuccess: false }), 'keep')
    assert.equal(d({ ok: false, status: 504, bodyParsed: false, validSuccess: false }), 'keep')
    assert.equal(d({ ok: false, status: 400, bodyParsed: false, validSuccess: false }), 'keep')
    assert.equal(d({ ok: false, status: 429, bodyParsed: true, validSuccess: false }), 'keep')
})

test('validateBundleSettingsInput accepts valid partial bodies', () => {
    const r = validateBundleSettingsInput({ enabled: false, networks: { mtn: true, broadband: false }, discounts: { mtn: 7.5, at: 0 } })
    assert.deepEqual(r, {
        ok: true,
        updates: {
            std_bundles_enabled: 'false',
            std_bundles_enabled_mtn: 'true',
            std_bundles_enabled_broadband: 'false',
            std_bundles_discount_mtn: '7.5',
            std_bundles_discount_at: '0',
        },
    })
    assert.equal((validateBundleSettingsInput({ discounts: { telecel: 50 } }) as any).updates.std_bundles_discount_telecel, '50')
})

test('validateBundleSettingsInput rejects bad discounts, unknown keys, non-booleans, empty', () => {
    for (const bad of [51, -1, 'abc', NaN, Infinity, 1.234, null, '', '5', true]) {
        assert.equal(validateBundleSettingsInput({ discounts: { mtn: bad } }).ok, false, String(bad))
    }
    assert.equal(validateBundleSettingsInput({ discounts: { broadband: 5 } }).ok, false)
    assert.equal(validateBundleSettingsInput({ networks: { gtp: true } }).ok, false)
    assert.equal(validateBundleSettingsInput({ evil: 1 }).ok, false)
    assert.equal(validateBundleSettingsInput({ enabled: 'yes' }).ok, false)
    assert.equal(validateBundleSettingsInput({ networks: { mtn: 1 } }).ok, false)
    assert.equal(validateBundleSettingsInput({}).ok, false)
    assert.equal(validateBundleSettingsInput(null).ok, false)
    assert.equal(validateBundleSettingsInput([]).ok, false)
    assert.equal(validateBundleSettingsInput({ discounts: [] }).ok, false)
})

test('decideAdminRefundGate', () => {
    const g = decideAdminRefundGate
    const now = 1_000_000_000_000
    const min = 60_000
    const ctx = (status: string, agoMin: number) => ({ orderStatus: status, updatedAtMs: now - agoMin * min, nowMs: now })
    const base = { configured: true, httpOk: true }
    const old = ctx('processing', 60)
    assert.equal(g({ ...base, found: true, state: 'completed', ...old }), 'mark_completed')
    assert.equal(g({ ...base, found: true, state: 'pending', ...old }), 'block_in_flight')
    assert.equal(g({ ...base, found: true, state: 'processing', ...old }), 'block_in_flight')
    assert.equal(g({ ...base, found: true, state: 'failed', ...ctx('processing', 1) }), 'refund')
    assert.equal(g({ ...base, found: true, state: 'unknown', ...old }), 'block_unverifiable')
    assert.equal(g({ configured: true, httpOk: false, found: false, state: 'unknown', ...old }), 'block_unverifiable')
    assert.equal(g({ configured: false, httpOk: false, found: false, state: 'unknown', ...old }), 'block_unverifiable')
    assert.equal(g({ configured: false, httpOk: true, found: false, state: 'unknown', ...old }), 'block_unverifiable')
    // found:false (no record) needs a settled order for pending/processing
    for (const st of ['pending', 'processing']) {
        assert.equal(g({ ...base, found: false, state: 'unknown', ...ctx(st, 2) }), 'block_too_recent', st)
        assert.equal(g({ ...base, found: false, state: 'unknown', ...ctx(st, 11) }), 'refund', st)
    }
    assert.equal(g({ ...base, found: false, state: 'unknown', ...ctx('failed', 0) }), 'refund')
    // never-dispatched pending order (attempts 0) skips the freshness window
    assert.equal(g({ ...base, found: false, state: 'unknown', fulfillmentAttempts: 0, ...ctx('pending', 1) }), 'refund')
    assert.equal(g({ ...base, found: false, state: 'unknown', fulfillmentAttempts: 1, ...ctx('pending', 2) }), 'block_too_recent')
    assert.equal(g({ ...base, found: false, state: 'unknown', fulfillmentAttempts: 0, ...ctx('processing', 1) }), 'block_too_recent')
    assert.equal(g({ ...base, found: false, state: 'unknown', fulfillmentAttempts: 3, ...ctx('failed', 0) }), 'refund')
    assert.equal(g({ ...base, found: false, state: 'unknown', orderStatus: 'pending', updatedAtMs: NaN, nowMs: now }), 'block_too_recent')
})

test('isConfirmedNotFound', () => {
    assert.equal(isConfirmedNotFound(404, { success: false, error: 'not found' }), true)
    for (const body of ['<html>404</html>', null, undefined, [], [{ success: false }], {}, { success: true }, { error: 'x' }]) {
        assert.equal(isConfirmedNotFound(404, body), false, JSON.stringify(body))
    }
    assert.equal(isConfirmedNotFound(500, { success: false }), false)
    assert.equal(isConfirmedNotFound(200, { success: false }), false)
})

if (failed > 0) {
    console.error(`\n${failed} test(s) failed`)
    process.exit(1)
}
console.log('\nAll standard-bundles tests passed')
