import assert from 'node:assert/strict'
import { checkUserPin, hashPin } from '../lib/pin-verify'

// In-memory stand-in for the service-role client: one users row, with the
// eq()/is() conditions on UPDATE honoured so compare-and-swap is exercised.
function fakeAdmin(row: Record<string, any>) {
    return {
        from() {
            const conds: Array<(r: any) => boolean> = []
            let patch: Record<string, any> | null = null
            let wantRows = false
            const builder: any = {
                select(_cols?: string) { wantRows = true; return builder },
                update(p: Record<string, any>) { patch = p; wantRows = false; return builder },
                eq(col: string, v: any) { conds.push(r => r[col] === v); return builder },
                is(col: string, v: any) { conds.push(r => (r[col] ?? null) === v); return builder },
                async single() { await Promise.resolve(); return { data: { ...row } } },
                then(resolve: any) {
                    // a PostgREST call resolves on a later tick, letting concurrent callers interleave
                    return Promise.resolve().then(() => {
                        if (patch) {
                            if (conds.every(c => c(row))) { Object.assign(row, patch); return { data: [{ id: row.id }] } }
                            return { data: [] }
                        }
                        return { data: { ...row } }
                    }).then(resolve)
                },
            }
            // update(...).select('id') returns the written rows
            const origUpdate = builder.update
            builder.update = (p: any) => { origUpdate(p); wantRows = true; return builder }
            return builder
        },
    }
}

const ID = '00000000-0000-0000-0000-000000000001'
const mk = (extra: Record<string, any> = {}) => ({
    id: ID, pin_salt: 'salt', pin_hash: hashPin('123456', 'salt'), pin_attempts: 0, pin_locked_until: null, ...extra,
})

;(async () => {
    // no PIN set -> nothing to enforce
    assert.deepEqual(await checkUserPin(fakeAdmin({ id: ID, pin_hash: null }), ID, undefined), { status: 'not_set' })
    // PIN set but not supplied
    assert.deepEqual(await checkUserPin(fakeAdmin(mk()), ID, undefined), { status: 'required' })
    // correct PIN
    assert.deepEqual(await checkUserPin(fakeAdmin(mk()), ID, '123456'), { status: 'ok' })
    // correct PIN resets the counter
    const r1 = mk({ pin_attempts: 3 })
    assert.deepEqual(await checkUserPin(fakeAdmin(r1), ID, '123456'), { status: 'ok' })
    assert.equal(r1.pin_attempts, 0)

    // wrong PIN counts down, then locks on the 5th
    const r2 = mk()
    for (let i = 1; i <= 4; i++) {
        assert.deepEqual(await checkUserPin(fakeAdmin(r2), ID, '000000'), { status: 'wrong', attemptsRemaining: 5 - i })
    }
    assert.deepEqual(await checkUserPin(fakeAdmin(r2), ID, '000000'), { status: 'locked' })
    assert.ok(r2.pin_locked_until, 'lock timestamp written')
    // while locked even the right PIN is refused
    assert.deepEqual(await checkUserPin(fakeAdmin(r2), ID, '123456'), { status: 'locked' })

    // an expired lock restarts the counter instead of re-locking immediately
    const r3 = mk({ pin_attempts: 5, pin_locked_until: new Date(Date.now() - 1000).toISOString() })
    assert.deepEqual(await checkUserPin(fakeAdmin(r3), ID, '000000'), { status: 'wrong', attemptsRemaining: 4 })
    assert.equal(r3.pin_locked_until, null)

    // concurrent wrong guesses must not lose increments: 8 parallel guesses end locked, counter >= 5
    const r4 = mk()
    const admin4 = fakeAdmin(r4)
    const results = await Promise.all(Array.from({ length: 8 }, () => checkUserPin(admin4, ID, '000000')))
    assert.ok(r4.pin_attempts >= 5, `counter reached the cap (got ${r4.pin_attempts})`)
    assert.ok(r4.pin_locked_until, 'locked after concurrent guesses')
    assert.ok(results.filter(r => r.status === 'wrong').length <= 4, 'at most 4 guesses are told "wrong" before the lock')

    console.log('pin-verify: all assertions passed')
})()
