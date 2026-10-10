import assert from 'node:assert/strict'
import {
    FT_SLATE,
    FT_BLUE,
    FT_INDIGO,
    FT_IRIS,
    FT_CYAN,
    contrastRatio,
    colorDistance,
    type FtRamp,
} from '../lib/ft-palette'

let failed = 0

function check(name: string, fn: () => void) {
    try {
        fn()
        console.log(`ok - ${name}`)
    } catch (err) {
        failed++
        console.error(`FAIL - ${name}`)
        console.error(err)
    }
}

const STOPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']

check('slate 500 on page >= 4.5', () => assert.ok(contrastRatio(FT_SLATE['500'], '#F4F7FB') >= 4.5))
check('slate 600 on page >= 7', () => assert.ok(contrastRatio(FT_SLATE['600'], '#F4F7FB') >= 7))
check('slate ramp 50..300 is the Pro ramp', () => assert.deepEqual([FT_SLATE['50'], FT_SLATE['100'], FT_SLATE['200'], FT_SLATE['300']], ['#F7F9FC', '#EEF2F7', '#E2E8F0', '#C9D3E1']))
check('slate 400 on Night >= 4.5', () => assert.ok(contrastRatio(FT_SLATE['400'], '#0A0F1C') >= 4.5))
check('white on blue 600 >= 4.5', () => assert.ok(contrastRatio('#FFFFFF', FT_BLUE['600']) >= 4.5))
check('white on #0A66FF >= 4.5', () => assert.ok(contrastRatio('#FFFFFF', '#0A66FF') >= 4.5))

check('slate 600 on slate 50 >= 7', () => assert.ok(contrastRatio(FT_SLATE['600'], FT_SLATE['50']) >= 7))
check('slate 500 on slate 50 >= 4.5', () => assert.ok(contrastRatio(FT_SLATE['500'], FT_SLATE['50']) >= 4.5))
check('blue 700 on blue 50 >= 4.5', () => assert.ok(contrastRatio(FT_BLUE['700'], FT_BLUE['50']) >= 4.5))
check('indigo 700 on indigo 50 >= 4.5', () => assert.ok(contrastRatio(FT_INDIGO['700'], FT_INDIGO['50']) >= 4.5))
check('cyan 600 on page >= 4.5', () => assert.ok(contrastRatio(FT_CYAN['600'], '#F4F7FB') >= 4.5))
check('cyan 700 on page >= 7', () => assert.ok(contrastRatio(FT_CYAN['700'], '#F4F7FB') >= 7))
check('white on cyan 600 >= 4.5', () => assert.ok(contrastRatio('#FFFFFF', FT_CYAN['600']) >= 4.5))

check('500 stops are pairwise distinct (dE76 >= 15)', () => {
    const stops = { blue: FT_BLUE['500'], indigo: FT_INDIGO['500'], iris: FT_IRIS['500'], cyan: FT_CYAN['500'] }
    const names = Object.keys(stops) as (keyof typeof stops)[]
    for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
            const d = colorDistance(stops[names[i]], stops[names[j]])
            assert.ok(d >= 15, `${names[i]} vs ${names[j]} = ${d.toFixed(1)}`)
        }
    }
})

check('every ramp is monotonic (luminance non-increasing 50 -> 950)', () => {
    const ramps = { slate: FT_SLATE, blue: FT_BLUE, indigo: FT_INDIGO, iris: FT_IRIS, cyan: FT_CYAN }
    for (const [name, ramp] of Object.entries(ramps)) {
        for (let i = 1; i < STOPS.length; i++) {
            // contrast vs white rises as luminance falls
            const prev = contrastRatio('#FFFFFF', ramp[STOPS[i - 1] as keyof FtRamp])
            const cur = contrastRatio('#FFFFFF', ramp[STOPS[i] as keyof FtRamp])
            assert.ok(cur >= prev, `${name} ${STOPS[i - 1]} -> ${STOPS[i]} gets lighter`)
            if (cur - prev < 0.02) console.log(`NOTE near-equal: ${name} ${STOPS[i - 1]}/${STOPS[i]}`)
        }
    }
})

check('every ramp has exactly the 11 keys', () => {
    for (const ramp of [FT_SLATE, FT_BLUE, FT_INDIGO, FT_IRIS, FT_CYAN]) {
        assert.deepEqual(Object.keys(ramp).sort(), [...STOPS].sort())
    }
})

check('every value is uppercase #RRGGBB', () => {
    for (const ramp of [FT_SLATE, FT_BLUE, FT_INDIGO, FT_IRIS, FT_CYAN]) {
        for (const v of Object.values(ramp)) assert.match(v, /^#[0-9A-F]{6}$/)
    }
})

if (failed > 0) process.exit(1)
