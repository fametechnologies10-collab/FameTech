import assert from 'node:assert/strict'
import {
    FT_SLATE,
    FT_BLUE,
    FT_INDIGO,
    FT_IRIS,
    FT_CYAN,
    contrastRatio,
    colorDistance,
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

check('slate 500 on clay >= 4.5', () => assert.ok(contrastRatio(FT_SLATE['500'], '#E6ECF5') >= 4.5))
check('slate 600 on clay >= 7', () => assert.ok(contrastRatio(FT_SLATE['600'], '#E6ECF5') >= 7))
check('slate 400 on Night >= 4.5', () => assert.ok(contrastRatio(FT_SLATE['400'], '#0A0F1C') >= 4.5))
check('white on blue 600 >= 4.5', () => assert.ok(contrastRatio('#FFFFFF', FT_BLUE['600']) >= 4.5))
check('white on #0A66FF >= 4.5', () => assert.ok(contrastRatio('#FFFFFF', '#0A66FF') >= 4.5))

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
