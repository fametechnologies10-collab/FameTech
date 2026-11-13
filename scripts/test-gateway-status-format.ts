import {
    formatMinutes,
    formatClockTime,
    BAND_HEADLINE,
    BAND_FILL_CLASS,
} from '@/lib/gateway-status-format'
import type { GatewayBand } from '@/lib/gateway-health'

function eq(actual: unknown, expected: unknown, msg: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}

eq(formatMinutes(0.4), '0.4 min', 'fmt 0.4')
eq(formatMinutes(1), '1 min', 'fmt 1')
eq(formatMinutes(59.9), '59.9 min', 'fmt 59.9')
eq(formatMinutes(60), '1hr', 'fmt 60')
eq(formatMinutes(61), '1hr 1min', 'fmt 61')
eq(formatMinutes(125), '2hr 5min', 'fmt 125')
eq(formatMinutes(null), '—', 'fmt null')

eq(formatClockTime('2026-11-13T23:14:00Z'), '11:14 pm', 'time pm')
eq(formatClockTime('2026-11-13T09:05:00Z'), '9:05 am', 'time am')
eq(formatClockTime('not-a-date'), '—', 'time invalid')
eq(formatClockTime(null), '—', 'time null')

const bands: GatewayBand[] = ['excellent', 'good', 'slow', 'degraded', 'none']
const fills = new Set<string>()
for (const b of bands) {
    if (!BAND_HEADLINE[b]) throw new Error(`empty headline for ${b}`)
    if (!BAND_FILL_CLASS[b]) throw new Error(`empty fill class for ${b}`)
    fills.add(BAND_FILL_CLASS[b])
}
eq(fills.size, bands.length, 'distinct bar classes')

console.log('gateway-status-format: all tests passed')
