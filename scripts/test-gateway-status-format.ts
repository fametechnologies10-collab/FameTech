import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    formatClockTime,
    normalizeClock,
    TIER_FILL_CLASS,
    TIER_TEXT_CLASS,
    COOLDOWN_MS,
    cooldownRemainingMs,
} from '@/lib/gateway-status-format'

function eq(actual: unknown, expected: unknown, msg: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}

// Clock time
eq(formatClockTime('2026-11-13T23:14:00Z'), '11:14 pm', 'time pm')
eq(formatClockTime('2026-11-13T09:05:00Z'), '9:05 am', 'time am')
eq(formatClockTime('not-a-date'), '—', 'time invalid')
eq(formatClockTime(null), '—', 'time null')
eq(formatClockTime(undefined), '—', 'time undefined')
eq(formatClockTime(''), '—', 'time empty')

eq(normalizeClock('11:14\u202fPM'), '11:14 pm', 'normalise narrow nbsp')
eq(normalizeClock('9:05\u00a0AM'), '9:05 am', 'normalise nbsp')
eq(/[\u202f\u00a0]/.test(formatClockTime('2026-11-13T23:14:00Z')), false, 'no invisible spaces in output')

// Cooldown
eq(COOLDOWN_MS, 10_000, 'cooldown constant')
eq(cooldownRemainingMs(5_000, null), 0, 'cooldown null')
eq(cooldownRemainingMs(1_000_000, 1_000_000), 10_000, 'cooldown just ended')
eq(cooldownRemainingMs(1_004_000, 1_000_000), 6_000, 'cooldown 4s later')
eq(cooldownRemainingMs(1_010_000, 1_000_000), 0, 'cooldown exactly 10s')
eq(cooldownRemainingMs(1_060_000, 1_000_000), 0, 'cooldown elapsed')
eq(cooldownRemainingMs(990_000, 1_000_000), 10_000, 'cooldown clock backwards')
eq(cooldownRemainingMs(Number.NaN, 1_000_000), 0, 'cooldown NaN now')
eq(cooldownRemainingMs(1_000_000, Number.NaN), 0, 'cooldown NaN ended')

// Class maps
const keys = ['Excellent', 'Good', 'Delayed', 'Critical', 'down', 'none'] as const
for (const k of keys) {
    if (typeof TIER_FILL_CLASS[k] !== 'string' || !TIER_FILL_CLASS[k]) throw new Error(`empty fill class for ${k}`)
    if (typeof TIER_TEXT_CLASS[k] !== 'string' || !TIER_TEXT_CLASS[k]) throw new Error(`empty text class for ${k}`)
    if (TIER_FILL_CLASS[k].includes('${') || TIER_TEXT_CLASS[k].includes('${')) throw new Error(`interpolation in ${k}`)
}
eq(new Set(keys.slice(0, 4).map(k => TIER_FILL_CLASS[k])).size, 4, 'distinct tier fills')
eq(TIER_FILL_CLASS.none, 'bg-transparent', 'none fill')
eq(TIER_FILL_CLASS.down, 'bg-transparent', 'down fill')

// Widget source guards
const src = readFileSync(join(process.cwd(), 'components/dashboard/home/GatewayStatus.tsx'), 'utf8')
if (src.length < 500) throw new Error('widget source unexpectedly empty')
for (const bad of ['Running slow', 'Delays likely', 'Delivering fast', 'gateway-health', 'Experiencing down', 'is down']) {
    if (src.includes(bad)) throw new Error(`widget source must not contain "${bad}"`)
}

console.log('gateway-status-format: all tests passed')
