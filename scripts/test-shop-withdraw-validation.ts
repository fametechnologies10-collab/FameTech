import assert from 'node:assert/strict'
import {
    withdrawSchema,
    parseWithdrawAmount,
    roundMoney,
    checkWithdrawEligibility,
} from '../lib/shop-withdraw-validation'

const base = { amount: 100, momoNumber: '0241234567', network: 'MTN MoMo' }

// ── MoMo only: banks are out ────────────────────────────────────────────────
assert.equal(withdrawSchema.safeParse(base).success, true, 'plain momo request is valid')
assert.equal(withdrawSchema.safeParse({ ...base, network: 'Bank' }).success, false, 'Bank network rejected')
assert.equal(withdrawSchema.safeParse({ ...base, payment_type: 'bank' }).success, false, 'bank payment_type rejected')
assert.equal(withdrawSchema.safeParse({ ...base, payment_type: 'momo' }).success, true, 'explicit momo payment_type accepted (old client)')
assert.equal(withdrawSchema.safeParse({ ...base, network: 'Vodafone' }).success, false, 'unknown network rejected')
// Old clients may still send bank-only fields: they are stripped, never forwarded.
const stripped = withdrawSchema.parse({ ...base, bankId: 'abc', branch: 'x' }) as Record<string, unknown>
assert.equal('bankId' in stripped, false, 'bankId stripped')
assert.equal('branch' in stripped, false, 'branch stripped')

// ── MoMo number format ──────────────────────────────────────────────────────
assert.equal(withdrawSchema.safeParse({ ...base, momoNumber: '024123' }).success, false, 'short number rejected')
assert.equal(withdrawSchema.safeParse({ ...base, momoNumber: '12345678901' }).success, false, 'non-Ghana number rejected')
assert.equal(withdrawSchema.safeParse({ ...base, momoNumber: '0241234567; drop' }).success, false, 'junk rejected')

assert.equal(withdrawSchema.parse({ ...base, momoNumber: '+233241234567' }).momoNumber, '0241234567', 'international form normalised to local')

// ── Amount: positive, finite, at most 2 decimal places ──────────────────────
assert.equal(parseWithdrawAmount(100), 100)
assert.equal(parseWithdrawAmount('100.5'), 100.5)
assert.equal(parseWithdrawAmount(99.99), 99.99)
assert.equal(parseWithdrawAmount(100.004), null, 'sub-cent number rejected')
assert.equal(parseWithdrawAmount('100.123'), null, 'sub-cent string rejected')
assert.equal(parseWithdrawAmount(0), null)
assert.equal(parseWithdrawAmount(-5), null)
assert.equal(parseWithdrawAmount(Number.NaN), null)
assert.equal(parseWithdrawAmount(Number.POSITIVE_INFINITY), null)
assert.equal(parseWithdrawAmount('1e3'), null, 'exponent notation rejected')
assert.equal(parseWithdrawAmount(1e9), null, 'absurdly large amount rejected')
assert.equal(withdrawSchema.safeParse({ ...base, amount: 100.004 }).success, false, 'schema enforces 2dp on numbers')
assert.equal(withdrawSchema.safeParse({ ...base, amount: '100.50' }).success, true)
assert.equal(withdrawSchema.parse({ ...base, amount: '100.50' }).amount, 100.5, 'string amount normalised to number')
assert.equal(roundMoney(1.005 + 1.005), 2.01)

// ── PIN: optional 6 digits ──────────────────────────────────────────────────
assert.equal(withdrawSchema.safeParse({ ...base, pin: '123456' }).success, true)
assert.equal(withdrawSchema.safeParse({ ...base, pin: '12345' }).success, false)
assert.equal(withdrawSchema.safeParse({ ...base, pin: 'abcdef' }).success, false)

// ── Manual name fallback allowlist unchanged ────────────────────────────────
assert.equal(withdrawSchema.safeParse({ ...base, manualAccountName: "Kofi O'Brien-Mensah" }).success, true)
assert.equal(withdrawSchema.safeParse({ ...base, manualAccountName: '<script>alert(1)</script>' }).success, false)
assert.equal(withdrawSchema.safeParse({ ...base, manualAccountName: 'A' }).success, false)

// ── Eligibility: suspended / inactive users and shops cannot withdraw ───────
const ok = { userStatus: 'active', shopApproval: 'approved' }
assert.deepEqual(checkWithdrawEligibility(ok), { ok: true })
assert.equal(checkWithdrawEligibility({ ...ok, userStatus: 'suspended' }).ok, false)
assert.equal(checkWithdrawEligibility({ ...ok, userStatus: 'inactive' }).ok, false)
assert.equal(checkWithdrawEligibility({ ...ok, userStatus: null }).ok, false, 'unknown user status fails closed')
assert.equal(checkWithdrawEligibility({ ...ok, shopApproval: 'suspended' }).ok, false)
assert.equal(checkWithdrawEligibility({ ...ok, shopApproval: 'rejected' }).ok, false)
// Pending/absent shop profile must not block: commission-only owners have a wallet without an approved shop.
assert.equal(checkWithdrawEligibility({ ...ok, shopApproval: 'pending' }).ok, true)
assert.equal(checkWithdrawEligibility({ ...ok, shopApproval: null }).ok, true)

console.log('shop-withdraw-validation: all assertions passed')
