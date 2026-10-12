import { mapCreditResult } from '@/lib/wallet-credit'

function eq(actual: unknown, expected: unknown, msg: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}

eq(mapCreditResult(null), { success: false, transient: true, error: 'Failed to credit wallet' }, 'null result')

eq(mapCreditResult({ success: true, already_processed: true }), { success: true, alreadyProcessed: true }, 'already processed')

const ok = mapCreditResult({ success: true, user_id: 'u', amount: '10.50', new_balance: '30' })
eq(ok.success, true, 'ok success')
eq(ok.userId, 'u', 'ok userId')
eq(ok.amount, 10.5, 'ok amount')
eq(ok.newBalance, 30, 'ok newBalance')

const mismatch = mapCreditResult({ success: false, error: 'amount_mismatch' })
eq(mismatch.success, false, 'mismatch success')
eq(mismatch.error, 'Amount mismatch', 'mismatch error literal')
eq(!!mismatch.transient, false, 'mismatch not transient')

eq(mapCreditResult({ success: false, error: 'amount_unverified' }).transient, true, 'amount_unverified transient')
eq(mapCreditResult({ success: false, error: 'wallet_not_found' }).transient, true, 'wallet_not_found transient')

const nf = mapCreditResult({ success: false, error: 'not_found' })
eq(nf.error, 'Payment not found', 'not_found error')
eq(!!nf.transient, false, 'not_found not transient')

const np = mapCreditResult({ success: false, error: 'not_pending' })
eq(np, { success: false, error: 'Payment not pending' }, 'not_pending')
eq(!!np.transient, false, 'not_pending not transient')
eq(!!np.alreadyProcessed, false, 'not_pending not alreadyProcessed')

const unk = mapCreditResult({ success: false, error: 'something_weird' })
eq(unk.success, false, 'unknown success')
eq(unk.transient, true, 'unknown transient')
