import vm from 'node:vm'
import assert from 'node:assert/strict'
import { FT_LITE_SCRIPT } from '../lib/ft-lite'

interface Env {
    dm?: number
    hc?: number
    saveData?: boolean
    reducedData?: boolean
    stored?: string
    search?: string
    throwStorage?: boolean
}

function run(env: Env) {
    const classes = new Set<string>()
    const store: Record<string, string> = {}
    if (env.stored !== undefined) store['ft-lite'] = env.stored
    const sandbox = {
        document: { documentElement: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } } },
        navigator: { deviceMemory: env.dm, hardwareConcurrency: env.hc, connection: { saveData: !!env.saveData } },
        localStorage: env.throwStorage
            ? { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
            : {
                getItem: (k: string) => (k in store ? store[k] : null),
                setItem: (k: string, v: string) => { store[k] = v },
                removeItem: (k: string) => { delete store[k] },
            },
        location: { search: env.search ?? '' },
        matchMedia: (q: string) => ({ matches: !!env.reducedData && q.includes('prefers-reduced-data') }),
    }
    vm.runInNewContext(FT_LITE_SCRIPT, sandbox)
    return { lite: classes.has('lite'), store }
}

let passed = 0
function t(name: string, fn: () => void) {
    fn()
    passed++
    console.log('ok -', name)
}

t('lite: deviceMemory 2', () => assert.equal(run({ dm: 2, hc: 8 }).lite, true))
t('lite: dm=1, hc=2', () => assert.equal(run({ dm: 1, hc: 2 }).lite, true))
t('lite: dm=4, hc=4', () => assert.equal(run({ dm: 4, hc: 4 }).lite, true))
t('lite: saveData', () => assert.equal(run({ dm: 8, hc: 8, saveData: true }).lite, true))
t('lite: prefers-reduced-data', () => assert.equal(run({ dm: 8, hc: 8, reducedData: true }).lite, true))
t('lite: stored 1 on strong device', () => assert.equal(run({ dm: 8, hc: 8, stored: '1' }).lite, true))
t('full: dm=8, hc=8', () => assert.equal(run({ dm: 8, hc: 8 }).lite, false))
t('full: dm=4, hc=8', () => assert.equal(run({ dm: 4, hc: 8 }).lite, false))
t('full: undefined dm/hc (iOS-like)', () => assert.equal(run({}).lite, false))
t('full: stored 0 overrides weak device', () => assert.equal(run({ dm: 1, hc: 2, saveData: true, stored: '0' }).lite, false))
t('?lite=0 overrides detection and writes storage', () => {
    const r = run({ dm: 1, hc: 2, search: '?lite=0' })
    assert.equal(r.lite, false)
    assert.equal(r.store['ft-lite'], '0')
})
t('?lite=1 forces lite and writes storage', () => {
    const r = run({ dm: 8, hc: 8, search: '?x=1&lite=1' })
    assert.equal(r.lite, true)
    assert.equal(r.store['ft-lite'], '1')
})
t('throwing storage: no crash, detection applies', () => {
    assert.equal(run({ dm: 2, throwStorage: true }).lite, true)
    assert.equal(run({ dm: 8, hc: 8, throwStorage: true }).lite, false)
})
t('throwing storage with ?lite=1 still lite', () => assert.equal(run({ dm: 8, hc: 8, throwStorage: true, search: '?lite=1' }).lite, true))

console.log(`ft-lite: ${passed} passed`)
