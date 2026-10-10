import assert from 'node:assert/strict'
import {
    LOW_BALANCE_GHS,
    POLL_INTERVAL_MS,
    trackerStep,
    isLowBalance,
    spendFor,
    sparkHeights,
    shouldPoll,
    normalizeSummary,
    fetchDashboardSummary,
    type DashboardSummary,
} from '../lib/dashboard-summary'

let failed = 0
const pending: Promise<void>[] = []

function check(name: string, fn: () => void | Promise<void>) {
    const run = (async () => {
        try {
            await fn()
            console.log(`ok - ${name}`)
        } catch (err) {
            failed++
            console.error(`FAIL - ${name}`)
            console.error(err)
        }
    })()
    pending.push(run)
}

const withActive: DashboardSummary = {
    ...normalizeSummary({}),
    active_order: {
        id: 'o1',
        network: 'MTN',
        size: '5GB',
        phone_masked: '024****678',
        status: 'processing',
        created_at: '2026-10-10T00:00:00Z',
        updated_at: '2026-10-10T00:01:00Z',
    },
}

check('constants', () => {
    assert.equal(LOW_BALANCE_GHS, 10)
    assert.equal(POLL_INTERVAL_MS, 15000)
})

check('trackerStep', () => {
    assert.equal(trackerStep('pending'), 0)
    assert.equal(trackerStep('queued'), 1)
    assert.equal(trackerStep('processing'), 2)
    assert.equal(trackerStep('completed'), 3)
    assert.equal(trackerStep('weird'), 0)
})

check('isLowBalance', () => {
    assert.equal(isLowBalance(10), false)
    assert.equal(isLowBalance(9.99), true)
    assert.equal(isLowBalance(undefined), false)
    assert.equal(isLowBalance(null), false)
    assert.equal(isLowBalance(0), true)
    assert.equal(isLowBalance(20, 50), true)
})

check('sparkHeights', () => {
    assert.deepEqual(sparkHeights([0, 0, 0], 40), [0, 0, 0])
    assert.deepEqual(sparkHeights([1, 100], 40), [2, 40])
    assert.deepEqual(sparkHeights([0, 50, 100], 40), [0, 20, 40])
})

check('shouldPoll', () => {
    assert.equal(shouldPoll(null, false), false)
    assert.equal(shouldPoll(withActive, true), false)
    assert.equal(shouldPoll(withActive, false), true)
    assert.equal(shouldPoll(normalizeSummary({}), false), false)
})

check('normalizeSummary of empty object', () => {
    const s = normalizeSummary({})
    assert.equal(s.counts.total, 0)
    assert.equal(s.spend.last7.length, 7)
    assert.deepEqual(s.spend.last7, [0, 0, 0, 0, 0, 0, 0])
    assert.equal(s.active_order, null)
    assert.equal(s.wallet_balance, 0)
    assert.equal(s.spend.top_network, null)
    assert.equal(normalizeSummary(null).counts.pending, 0)
})

check('normalizeSummary coerces numeric strings and bad values', () => {
    const s = normalizeSummary({
        counts: { total: '5', pending: 'abc' },
        wallet_balance: '42.50',
        spend: { last7: ['1', 2], total7: '3', total30: null, top_network: 'MTN' },
    })
    assert.equal(s.counts.total, 5)
    assert.equal(s.counts.pending, 0)
    assert.equal(s.wallet_balance, 42.5)
    assert.equal(s.spend.last7.length, 7)
    assert.equal(s.spend.last7[0], 1)
    assert.equal(s.spend.last7[6], 0)
    assert.equal(s.spend.total7, 3)
    assert.equal(s.spend.total30, 0)
    assert.equal(s.spend.top_network, 'MTN')
})

check('normalizeSummary keeps active order', () => {
    const s = normalizeSummary({ active_order: { id: 'x', network: 'MTN', size: '1GB', phone_masked: '02***', status: 'queued', created_at: 'a', updated_at: 'b' } })
    assert.equal(s.active_order?.id, 'x')
    assert.equal(s.active_order?.status, 'queued')
})

check('spendFor', () => {
    const s = normalizeSummary({ spend: { total7: 7, total30: 30 } })
    assert.equal(spendFor(s, '7d'), 7)
    assert.equal(spendFor(s, '30d'), 30)
})

check('fetchDashboardSummary throws on rpc error', async () => {
    const client = { rpc: async () => ({ data: null, error: { message: 'boom' } }) }
    await assert.rejects(() => fetchDashboardSummary(client as never))
})

check('fetchDashboardSummary normalizes data', async () => {
    let called = ''
    const client = {
        rpc: async (name: string) => {
            called = name
            return { data: { wallet_balance: '12.5' }, error: null }
        },
    }
    const s = await fetchDashboardSummary(client as never)
    assert.equal(called, 'get_dashboard_summary')
    assert.equal(s.wallet_balance, 12.5)
    assert.equal(s.spend.last7.length, 7)
})

Promise.all(pending).then(() => {
    if (failed > 0) {
        console.error(`\n${failed} check(s) failed`)
        process.exit(1)
    }
})
