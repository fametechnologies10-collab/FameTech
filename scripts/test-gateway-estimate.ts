import {
    adjustSeconds,
    ageOffsetSeconds,
    buildChannelView,
    estimateHeadline,
    formatDuration,
    liveEstimate,
    shapeGatewaySignals,
    strengthFromMetric1,
    DOWN_HEADLINE,
    NONE_HEADLINE,
    GATEWAY_ORDER,
    type ChannelView,
    type GatewaySignalRow,
} from '@/lib/gateway-estimate'

function eq(actual: unknown, expected: unknown, msg: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}

const now = Date.parse('2026-11-13T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const ago = (sec: number) => iso(now - sec * 1000)

// percent table
const pct: [number, number][] = [
    [0, 100], [10, 100], [10.01, 100], [20, 90], [30, 80], [30.01, 79], [45, 65], [60, 50],
    [60.01, 49], [120, 35], [180, 20], [180.01, 20], [300, 12], [479, 1], [480, 1], [5000, 1],
]
for (const [m, p] of pct) eq(strengthFromMetric1(m).percent, p, `percent m=${m}`)

// tiers at every cut
const tiers: [number, string][] = [
    [0, 'Excellent'], [30, 'Excellent'], [30.01, 'Good'], [60, 'Good'], [60.01, 'Delayed'],
    [180, 'Delayed'], [180.01, 'Critical'], [5000, 'Critical'],
]
for (const [m, t] of tiers) eq(strengthFromMetric1(m).tier, t, `tier m=${m}`)

// totality
for (const bad of [NaN, -5, Infinity]) {
    const s = strengthFromMetric1(bad)
    if (!Number.isFinite(s.percent) || s.percent < 1 || s.percent > 100) throw new Error(`strength bad ${bad}`)
}

// buffer
eq(adjustSeconds(300), 300, 'adj 300')
eq(adjustSeconds(301), 1, 'adj 301')
eq(adjustSeconds(306), 6, 'adj 306')
eq(adjustSeconds(0), 0, 'adj 0')
eq(adjustSeconds(NaN), 0, 'adj NaN')
eq(adjustSeconds(-10), 0, 'adj neg')

// headline thresholds
eq(estimateHeadline(9.99), 'Instant Delivery Ongoing', 'h 9.99')
eq(estimateHeadline(10), 'Delivery Ongoing', 'h 10')
eq(estimateHeadline(59.99), 'Delivery Ongoing', 'h 59.99')
eq(estimateHeadline(60), 'Validation Ongoing', 'h 60')
eq(DOWN_HEADLINE, 'Experiencing delays', 'down headline')
eq(NONE_HEADLINE, 'No recent orders', 'none headline')

// formatDuration
eq(formatDuration(0, 31), '31 sec', 'fd 31')
eq(formatDuration(1, 59), '59 sec', 'fd 59')
eq(formatDuration(1, 60), '1 min', 'fd 60')
eq(formatDuration(0, 0), '1 sec', 'fd 0')
eq(formatDuration(null, null), '', 'fd null')

const row = (o: Partial<GatewaySignalRow> = {}): GatewaySignalRow => ({
    key: 'MTN', c_created_at: null, c_delivered_at: null, p_created_at: null,
    is_manually_down: false, down_reason: null, down_since: null, down_snapshot: null, ...o,
})

// 5.1 min raw -> 6 sec
{
    const v = buildChannelView(row({ c_created_at: ago(1000), c_delivered_at: ago(1000 - 306) }), 'MTN', now)
    eq(v.state, 'live', '5.1min live')
    eq(v.lastDelivery?.seconds, 6, '5.1min seconds')
    eq(formatDuration(v.lastDelivery!.minutes, v.lastDelivery!.seconds), '6 sec', '5.1min shown')
}

// none cases
eq(buildChannelView(undefined, 'MTN', now).state, 'none', 'no row')
eq(buildChannelView(row(), 'MTN', now).state, 'none', 'missing C')
eq(buildChannelView(row({ c_created_at: ago(86_401), c_delivered_at: ago(86_000) }), 'MTN', now).state, 'none', '24h+1s')
eq(buildChannelView(row({ c_created_at: ago(86_400), c_delivered_at: ago(86_000) }), 'MTN', now).state, 'live', 'exactly 24h')
eq(buildChannelView(row({ c_created_at: ago(100), c_delivered_at: ago(200) }), 'MTN', now).state, 'none', 'delivered before created')
eq(buildChannelView(row({ c_created_at: iso(now + 5000), c_delivered_at: iso(now + 9000) }), 'MTN', now).state, 'none', 'future created')
eq(buildChannelView(row({ c_created_at: 'garbage', c_delivered_at: 'junk' }), 'MTN', now).state, 'none', 'garbage')
{
    const n = buildChannelView(undefined, 'MTN', now)
    eq(n, {
        key: 'MTN', label: 'MTN', state: 'none', headline: 'No recent orders', tier: null, strengthPct: 0,
        lastDelivery: null, currentEstimate: null, openOrderAgeSeconds: null,
    }, 'none shape')
}
eq(buildChannelView(undefined, 'standard_bundles', now).label, 'Standard Bundles', 'sb label')
eq(buildChannelView(undefined, 'weird', now).label, 'weird', 'unknown label')

// C valid, no P
{
    const v = buildChannelView(row({ c_created_at: ago(1000), c_delivered_at: ago(400) }), 'MTN', now)
    eq(v.currentEstimate?.source, 'last_delivery', 'no P source')
    eq(v.currentEstimate?.seconds, 300, 'no P equals M1 seconds')
    eq(v.openOrderAgeSeconds, null, 'no P age')
    eq(v.lastDelivery?.placedAt, ago(1000), 'placedAt')
    eq(v.lastDelivery?.deliveredAt, ago(400), 'deliveredAt')
}

// C valid + P 7 min old
{
    const v = buildChannelView(row({ c_created_at: ago(3000), c_delivered_at: ago(2000), p_created_at: ago(420) }), 'MTN', now)
    eq(v.currentEstimate?.source, 'open_order', 'P source')
    eq(v.openOrderAgeSeconds, 420, 'P raw age')
    eq(v.currentEstimate?.seconds, 120, 'P seconds')
}

// P older than C created is ignored
{
    const v = buildChannelView(row({ c_created_at: ago(1000), c_delivered_at: ago(500), p_created_at: ago(2000) }), 'MTN', now)
    eq(v.currentEstimate?.source, 'last_delivery', 'old P ignored')
    eq(v.openOrderAgeSeconds, null, 'old P age null')
}

// documented property: slow C, fresh P
{
    const v = buildChannelView(row({ c_created_at: ago(5000), c_delivered_at: ago(5000 - 3000), p_created_at: ago(30) }), 'MTN', now)
    eq(v.strengthPct, 65, 'slow C strength')
    eq(v.tier, 'Good', 'slow C tier')
    eq(v.headline, 'Instant Delivery Ongoing', 'fresh P headline')
}

// override down
{
    const v = buildChannelView(row({
        is_manually_down: true, down_reason: 'supplier outage', down_since: ago(100),
        down_snapshot: { lastSeconds: 540, lastPlacedAt: ago(900), lastDeliveredAt: ago(360) },
        c_created_at: ago(100), c_delivered_at: ago(50),
    }), 'MTN', now)
    eq(v.state, 'down', 'down state')
    eq(v.strengthPct, 0, 'down pct')
    eq(v.headline, null, 'down headline')
    eq(v.tier, null, 'down tier')
    eq(v.currentEstimate, null, 'down current')
    eq(v.openOrderAgeSeconds, null, 'down age')
    eq(v.lastDelivery, { seconds: 540, minutes: 9, placedAt: ago(900), deliveredAt: ago(360) }, 'down lastDelivery')
    if (JSON.stringify(v).includes('supplier outage') || JSON.stringify(v).includes('reason')) throw new Error('down_reason leaked')
    const v2 = buildChannelView(row({ is_manually_down: true }), 'MTN', now)
    eq(v2.state, 'down', 'down no snapshot')
    eq(v2.lastDelivery, null, 'down no snapshot lastDelivery')
}

// shape
{
    const views = shapeGatewaySignals([row({ key: 'Telecel', c_created_at: ago(600), c_delivered_at: ago(100) })], now)
    eq(views.length, 5, 'five views')
    eq(views.map(v => v.key), GATEWAY_ORDER.map(g => g.key), 'order')
    eq(views.map(v => v.state), ['none', 'live', 'none', 'none', 'none'], 'fills missing')
}

// wording
{
    const views = shapeGatewaySignals([
        row({ key: 'MTN', c_created_at: ago(9000), c_delivered_at: ago(100), p_created_at: ago(8000) }),
        row({ key: 'Telecel', is_manually_down: true, down_reason: 'slow and down' }),
    ], now)
    for (const v of views) {
        if (v.headline && /slow|\bdown\b/i.test(v.headline)) throw new Error(`bad wording ${v.headline}`)
        if (JSON.stringify(v).includes('down_reason')) throw new Error('down_reason key leaked')
    }
    for (const h of ['Instant Delivery Ongoing', 'Delivery Ongoing', 'Validation Ongoing', DOWN_HEADLINE, NONE_HEADLINE]) {
        if (/slow|\bdown\b/i.test(h)) throw new Error(`bad wording ${h}`)
    }
}

// ageOffsetSeconds
eq(ageOffsetSeconds('2026-11-13T12:00:00Z', '2026-11-13T12:00:20Z', 1_000_000, 1_005_000), 25, 'age 20+5')
eq(ageOffsetSeconds('2026-11-13T12:00:00Z', '2026-11-13T12:00:00Z', 1_000_000, 1_000_000), 0, 'age zero')
eq(ageOffsetSeconds('2026-11-13T12:00:10Z', '2026-11-13T12:00:00Z', 1_000_000, 1_000_000), 0, 'negative clamped')
eq(ageOffsetSeconds('garbage', 'junk', 1_000_000, 1_007_000), 7, 'garbage -> receipt-relative')
for (const args of [['x', 'y', NaN, NaN], ['', '', 0, -5], ['2026-11-13T12:00:00Z', 'bad', Infinity, 1]] as [string, string, number, number][]) {
    const r = ageOffsetSeconds(...args)
    if (!Number.isFinite(r) || r < 0) throw new Error(`age offset not finite >= 0: ${r}`)
}

// liveEstimate
{
    const base = buildChannelView(row({ c_created_at: ago(5000), c_delivered_at: ago(4500), p_created_at: ago(120) }), 'MTN', now)
    const snapshot = JSON.stringify(base)
    const l0 = liveEstimate(base, 0)
    eq(l0.currentEstimate, { seconds: 120, minutes: 2, source: 'open_order' }, 'live 0')
    eq(l0.headline, 'Instant Delivery Ongoing', 'live 0 headline')
    const l1 = liveEstimate(base, 600)
    eq(l1.currentEstimate?.seconds, 420, 'live 600')
    eq(l1.headline, 'Instant Delivery Ongoing', 'live 600 headline')
    const l2 = liveEstimate(base, 3000)
    eq(l2.currentEstimate?.seconds, 2820, 'live 3000')
    eq(l2.headline, 'Delivery Ongoing', 'live 3000 headline')
    const l3 = liveEstimate(base, 4000)
    eq(l3.currentEstimate?.seconds, 3820, 'live 4000')
    eq(l3.headline, 'Validation Ongoing', 'live 4000 headline')
    eq(l3.openOrderAgeSeconds, 120, 'base age kept')
    eq(JSON.stringify(base), snapshot, 'no mutation')
    eq(liveEstimate(base, -50).currentEstimate?.seconds, 120, 'negative offset clamped')

    const noP = buildChannelView(row({ c_created_at: ago(1000), c_delivered_at: ago(400) }), 'MTN', now)
    eq(liveEstimate(noP, 9999), noP, 'noop without P')
    const none = buildChannelView(undefined, 'MTN', now)
    eq(liveEstimate(none, 100), none, 'noop none')
}

// JSON round trip (no undefined fields)
for (const v of shapeGatewaySignals([
    row({ key: 'MTN', c_created_at: ago(3000), c_delivered_at: ago(2000), p_created_at: ago(420) }),
    row({ key: 'Telecel', is_manually_down: true }),
], now) as ChannelView[]) {
    eq(JSON.parse(JSON.stringify(v)), v, `roundtrip ${v.key}`)
    if (JSON.stringify(JSON.parse(JSON.stringify(v))) !== JSON.stringify(v)) throw new Error('roundtrip mismatch')
    for (const val of Object.values(v)) if (val === undefined) throw new Error('undefined field')
}
{
    const a = buildChannelView(row({ c_created_at: ago(3000), c_delivered_at: ago(2000), p_created_at: ago(420) }), 'MTN', now)
    if (JSON.stringify(JSON.parse(JSON.stringify(a))) !== JSON.stringify(a)) throw new Error('deep roundtrip')
}

console.log('gateway-estimate: all tests passed')
