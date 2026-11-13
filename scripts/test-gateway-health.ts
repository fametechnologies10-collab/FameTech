import {
    median,
    classifyGateway,
    shapeGatewayStats,
    GATEWAY_ORDER,
    BAND_BAR_PCT,
    BAND_LABEL,
    type RawGatewayRow,
} from '@/lib/gateway-health'

function eq(actual: unknown, expected: unknown, msg: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}

const c = (medianMinutes: number | null, resolvedCount: number, failedCount: number) =>
    classifyGateway({ medianMinutes, resolvedCount, failedCount })

// median
eq(median([]), null, 'median empty')
eq(median([5]), 5, 'median single')
eq(median([3, 1, 2]), 2, 'median odd')
eq(median([4, 1, 3, 2]), 2.5, 'median even')

// bands / boundaries
eq(c(10, 0, 0), 'excellent', '10')
eq(c(10.01, 0, 0), 'good', '10.01')
eq(c(30, 0, 0), 'good', '30')
eq(c(30.01, 0, 0), 'slow', '30.01')
eq(c(60, 0, 0), 'slow', '60')
eq(c(60.01, 0, 0), 'degraded', '60.01')

// failure rule
eq(c(5, 10, 3), 'excellent', '3/10 no drop')
eq(c(5, 10, 4), 'good', '4/10 drops excellent->good')
eq(c(20, 10, 4), 'slow', 'good->slow')
eq(c(40, 10, 4), 'degraded', 'slow->degraded')
eq(c(5, 3, 2), 'excellent', '2/3 below min sample')
eq(c(5, 4, 4), 'excellent', '4/4 below min sample')
eq(c(5, 5, 2), 'good', '2/5 at min sample drops')
eq(c(90, 10, 9), 'degraded', 'degraded stays degraded')

// null median
eq(c(null, 6, 4), 'degraded', 'null median 4/6')
eq(c(null, 2, 2), 'none', 'null median 2/2')
eq(c(null, 0, 0), 'none', 'null median no resolved')
eq(c(null, 10, 3), 'none', 'null median 3/10 not >0.3')
eq(c(null, 3, 3), 'degraded', 'null median 3/3')

// constants
eq(BAND_BAR_PCT, { excellent: 100, good: 70, slow: 40, degraded: 15, none: 0 }, 'bar pct')
eq(BAND_LABEL, { excellent: 'Excellent', good: 'Good', slow: 'Slow', degraded: 'Degraded', none: 'No recent orders' }, 'labels')
eq(
    GATEWAY_ORDER,
    [
        { key: 'MTN', label: 'MTN' },
        { key: 'Telecel', label: 'Telecel' },
        { key: 'AT-iShare', label: 'AT-iShare' },
        { key: 'AT-BigTime', label: 'AT-BigTime' },
        { key: 'standard_bundles', label: 'Standard Bundles' },
    ],
    'order',
)

// shapeGatewayStats
const empty = shapeGatewayStats([])
eq(empty.map((n) => n.key), GATEWAY_ORDER.map((g) => g.key), 'empty keys')
for (const n of empty) {
    eq(
        n,
        {
            key: n.key,
            label: GATEWAY_ORDER.find((g) => g.key === n.key)!.label,
            band: 'none',
            barPct: 0,
            medianMinutes: null,
            lastMinutes: null,
            lastPlacedAt: null,
            lastDeliveredAt: null,
            sampleSize: 0,
        },
        'empty entry ' + n.key,
    )
}

const rows: RawGatewayRow[] = [
    {
        key: 'Telecel',
        last_placed_at: '2026-11-13T11:00:00Z',
        last_delivered_at: '2026-11-13T11:08:00Z',
        delivery_minutes: [8.123, 4, 12, 6],
        resolved_count: 4,
        failed_count: 0,
    },
    {
        key: 'MTN',
        last_placed_at: null,
        last_delivered_at: null,
        delivery_minutes: [],
        resolved_count: 6,
        failed_count: 4,
    },
]
const shaped = shapeGatewayStats(rows)
eq(shaped.length, 5, 'five entries')
eq(shaped.map((n) => n.key), ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'standard_bundles'], 'shaped order')
eq(shaped[0].band, 'degraded', 'MTN degraded via null median')
eq(shaped[0].barPct, 15, 'MTN barPct')
eq(shaped[0].sampleSize, 0, 'MTN sample')
eq(shaped[1].medianMinutes, 7.1, 'Telecel median rounded (mean of 6 and 8.123 = 7.0615)')
eq(shaped[1].lastMinutes, 8.1, 'Telecel last rounded')
eq(shaped[1].sampleSize, 4, 'Telecel sample')
eq(shaped[1].band, 'excellent', 'Telecel band')
eq(shaped[1].barPct, 100, 'Telecel barPct')
eq(shaped[1].lastPlacedAt, '2026-11-13T11:00:00Z', 'Telecel placed')
eq(shaped[2].band, 'none', 'missing none')

// JSON round trip (no undefined)
const rt = JSON.parse(JSON.stringify(shaped))
if (JSON.stringify(rt) !== JSON.stringify(shaped)) throw new Error('round-trip mismatch')
for (const n of shaped) {
    for (const [k, v] of Object.entries(n)) {
        if (v === undefined) throw new Error(`undefined field ${k}`)
    }
    if (Object.keys(JSON.parse(JSON.stringify(n))).length !== Object.keys(n).length) throw new Error('field lost in round trip')
}

console.log('gateway-health: all assertions passed')
