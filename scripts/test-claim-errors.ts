import { mapClaimError, mapClaimLimiterBlock, GENERIC_CLAIM_ERROR } from '@/lib/claim-errors'

function eq(actual: unknown, expected: unknown, msg: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}
function ok(cond: boolean, msg: string) {
    if (!cond) throw new Error(msg)
}

const ac = mapClaimError({ error: 'already_claimed', is_own_claim: true, claimed_at: '2026-01-01T00:00:00Z' })
eq(ac.status, 409, 'already_claimed status')
eq(ac.body.error, 'already_claimed', 'already_claimed error')
eq(ac.body.is_own_claim, true, 'is_own_claim passthrough')
eq(ac.body.claimed_at, '2026-01-01T00:00:00Z', 'claimed_at passthrough')

const bm = mapClaimError({ error: 'below_minimum', min_claimable: '5' })
eq(bm.status, 400, 'below_minimum status')
ok(String(bm.body.error).includes('5.00'), 'below_minimum message contains 5.00')

eq(mapClaimError({ error: 'account_not_active' }).status, 403, 'account_not_active status')

const generic = { status: 400, body: { error: GENERIC_CLAIM_ERROR } }
for (const e of [
    'Transaction not found',
    'Transaction has been voided by admin',
    'This transaction requires admin review. Please contact support.',
    'Wallet not found',
    undefined,
]) {
    eq(mapClaimError({ error: e }), generic, `generic for ${String(e)}`)
}

const burst = mapClaimLimiterBlock('burst')
eq(burst.status, 429, 'burst status')
ok(/30 seconds/.test(String(burst.body.error)), 'burst mentions 30 seconds')
const hourly = mapClaimLimiterBlock('hourly')
eq(hourly.status, 429, 'hourly status')
ok(/hour/.test(String(hourly.body.error)), 'hourly mentions hour')
