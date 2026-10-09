import assert from 'node:assert/strict'
import { evaluatePasswordStrength } from '../lib/password-strength'
import { isStrongPassword } from '../lib/password-validation'

let passed = 0
function check(name: string, fn: () => void) {
    try {
        fn()
        passed++
        console.log(`ok - ${name}`)
    } catch (err) {
        console.error(`FAIL - ${name}`)
        console.error(err)
        process.exit(1)
    }
}

check('empty string is empty/0', () => {
    const r = evaluatePasswordStrength('')
    assert.equal(r.level, 'empty')
    assert.equal(r.score, 0)
})

check('abc is weak', () => {
    assert.equal(evaluatePasswordStrength('abc').level, 'weak')
})

check('password1 is never good/strong', () => {
    const r = evaluatePasswordStrength('password1')
    assert.ok(r.level !== 'good' && r.level !== 'strong', r.level)
})

check('Password1 meets rule but is not strong', () => {
    const r = evaluatePasswordStrength('Password1')
    assert.ok(r.level === 'fair' || r.level === 'good', r.level)
    assert.ok(r.rules.length && r.rules.upper && r.rules.lower && r.rules.number)
})

check('passphrase is strong with score 4', () => {
    const r = evaluatePasswordStrength('Tr4vel-Mango-Lagoon!')
    assert.equal(r.level, 'strong')
    assert.equal(r.score, 4)
})

check('whitespace-only is weak and does not throw', () => {
    const r = evaluatePasswordStrength('   ')
    assert.equal(r.level, 'weak')
    assert.ok(r.score <= 1)
})

check('128-char valid string', () => {
    const p = 'Aa1' + 'x'.repeat(125)
    assert.equal(p.length, 128)
    const r = evaluatePasswordStrength(p)
    assert.equal(r.rules.length, true)
})

check('unicode/emoji does not throw', () => {
    evaluatePasswordStrength('pässwörd😀😀Ünï1')
    evaluatePasswordStrength('😀'.repeat(20))
})

check('common patterns are never strong', () => {
    assert.notEqual(evaluatePasswordStrength('aaaaaaaaaaaaaaaaaaaa').level, 'strong')
    assert.notEqual(evaluatePasswordStrength('Qwerty-Mango-Lagoon1!').level, 'strong')
    assert.notEqual(evaluatePasswordStrength('Tr4vel-1234-Lagoon!').level, 'strong')
})

check('invariant: strong implies isStrongPassword (200 random strings)', () => {
    const alphabet = 'abcXYZ019!@ -_é😀'
    const chars = Array.from(alphabet)
    for (let i = 0; i < 200; i++) {
        const len = Math.floor(Math.random() * 40)
        let p = ''
        for (let j = 0; j < len; j++) p += chars[Math.floor(Math.random() * chars.length)]
        const r = evaluatePasswordStrength(p)
        if (r.level === 'strong') assert.ok(isStrongPassword(p), p)
        if (!isStrongPassword(p)) assert.ok(r.score <= 2, p)
    }
})

console.log(`${passed} passed`)
