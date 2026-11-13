import { deliveredAtPatch } from '@/lib/delivery-stamp'

function eq(actual: unknown, expected: unknown, msg: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}

const now = new Date('2026-11-13T12:00:00Z')
const NOW_ISO = '2026-11-13T12:00:00.000Z'
const valid = '2026-11-13T11:50:00Z'
const VALID_ISO = '2026-11-13T11:50:00.000Z'
const at = (ms: number) => new Date(now.getTime() + ms)

// non-completed -> {}
eq(deliveredAtPatch('failed', { supplierTime: valid, allowNowFallback: true, now }), {}, 'failed')
eq(deliveredAtPatch('processing', { supplierTime: valid, allowNowFallback: true, now }), {}, 'processing')

// valid supplier time
eq(deliveredAtPatch('completed', { supplierTime: valid, allowNowFallback: false, now }), { delivered_at: VALID_ISO }, 'string')
eq(deliveredAtPatch('completed', { supplierTime: new Date(valid), allowNowFallback: false, now }), { delivered_at: VALID_ISO }, 'Date')

// no supplier time
eq(deliveredAtPatch('completed', { allowNowFallback: true, now }), { delivered_at: NOW_ISO }, 'no time, fallback')
eq(deliveredAtPatch('completed', { allowNowFallback: false, now }), {}, 'no time, no fallback')
eq(deliveredAtPatch('completed', { supplierTime: null, allowNowFallback: true, now }), { delivered_at: NOW_ISO }, 'null, fallback')

// garbage
eq(deliveredAtPatch('completed', { supplierTime: 'not a date', allowNowFallback: true, now }), { delivered_at: NOW_ISO }, 'garbage fallback')
eq(deliveredAtPatch('completed', { supplierTime: 'not a date', allowNowFallback: false, now }), {}, 'garbage no fallback')
eq(deliveredAtPatch('completed', { supplierTime: new Date(NaN), allowNowFallback: true, now }), { delivered_at: NOW_ISO }, 'NaN fallback')
eq(deliveredAtPatch('completed', { supplierTime: new Date(NaN), allowNowFallback: false, now }), {}, 'NaN no fallback')

// future / skew
eq(deliveredAtPatch('completed', { supplierTime: at(5 * 60_000), allowNowFallback: false, now }), {}, '+5min invalid')
eq(deliveredAtPatch('completed', { supplierTime: at(5 * 60_000), allowNowFallback: true, now }), { delivered_at: NOW_ISO }, '+5min fallback')
eq(deliveredAtPatch('completed', { supplierTime: at(30_000), allowNowFallback: false, now }), { delivered_at: at(30_000).toISOString() }, '+30s accepted')
eq(deliveredAtPatch('completed', { supplierTime: at(60_000), allowNowFallback: false, now }), { delivered_at: at(60_000).toISOString() }, '+60s accepted')
eq(deliveredAtPatch('completed', { supplierTime: at(61_000), allowNowFallback: false, now }), {}, '+61s rejected')

// age
const DAY = 86_400_000
eq(deliveredAtPatch('completed', { supplierTime: at(-8 * DAY), allowNowFallback: false, now }), {}, '8d old invalid')
eq(deliveredAtPatch('completed', { supplierTime: at(-8 * DAY), allowNowFallback: true, now }), { delivered_at: NOW_ISO }, '8d old fallback')
eq(deliveredAtPatch('completed', { supplierTime: at(-7 * DAY), allowNowFallback: false, now }), { delivered_at: at(-7 * DAY).toISOString() }, 'exactly 7d accepted')
eq(deliveredAtPatch('completed', { supplierTime: at(-7 * DAY - 1), allowNowFallback: false, now }), {}, '7d+1ms rejected')

// never throws
const anyOpts = (o: unknown) => o as Parameters<typeof deliveredAtPatch>[1]
for (const bad of [null, undefined, {}, 123, [], Symbol('x')]) {
    deliveredAtPatch('completed', anyOpts({ supplierTime: bad, allowNowFallback: true, now }))
}
eq(deliveredAtPatch('completed', anyOpts({ supplierTime: {}, allowNowFallback: false, now })), {}, '{} invalid')
eq(deliveredAtPatch('completed', anyOpts({ supplierTime: undefined, allowNowFallback: true, now })), { delivered_at: NOW_ISO }, 'undefined fallback')
deliveredAtPatch('completed', anyOpts(undefined))
deliveredAtPatch('completed', anyOpts(null))
// default now
eq(typeof deliveredAtPatch('completed', { allowNowFallback: true }).delivered_at, 'string', 'default now')

console.log('delivery-stamp: all tests passed')
