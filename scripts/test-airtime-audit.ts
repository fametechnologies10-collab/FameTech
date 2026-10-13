// scripts/test-airtime-audit.ts
//
// Regression tests for the 2026-10-12 airtime / mashup audit. Pure logic only (no network, no DB):
//   - quote hardening (decimals, negative / zero / out-of-range fees, bad limits)
//   - admin settings validation
//   - admin status-transition rules
//   - CSV formula-injection guard
//   - shop-mirror reference guard + LIKE-wildcard escaping
//   - wallet ledger helper (checks the `{ error }` result the old .catch() could never see)
import {
    normaliseAmount, quoteAirtime, quoteAirtimeCommission, resolveFeeRate, resolveAirtimeLimits,
    validateAirtimeSettings, isAirtimePriceKey,
} from '@/lib/airtime-pricing'
import { canAdminTransition, allowedSourceStatuses, isAdminTargetStatus } from '@/lib/airtime-transitions'
import { csvSafeText } from '@/lib/csv-safe'
import { recordAirtimeDebitLedger } from '@/lib/airtime-ledger'

function assert(cond: boolean, label: string) {
    if (!cond) throw new Error(`FAILED: ${label}`)
}

async function main() {
    // ── normaliseAmount ───────────────────────────────────────────────────────
    assert(normaliseAmount(10) === 10, 'whole amount passes')
    assert(normaliseAmount(10.5) === 10.5, 'one decimal passes')
    assert(normaliseAmount(10.55) === 10.55, 'two decimals pass')
    assert(normaliseAmount(0.1 + 0.2) === 0.3, 'float noise (0.30000000000000004) is normalised, not rejected')
    assert(normaliseAmount(10.005) === null, 'three decimals are rejected')
    assert(normaliseAmount(0) === null, 'zero is rejected')
    assert(normaliseAmount(-5) === null, 'negative is rejected')
    assert(normaliseAmount(Infinity) === null, 'Infinity is rejected')
    assert(normaliseAmount(NaN) === null, 'NaN is rejected')
    assert(normaliseAmount('5' as any) === null, 'a string is rejected')

    // ── quoteAirtime: the wallet debit, order row and airtime must agree ──────
    const base = { airtime_min_amount_customer: '1', airtime_max_amount_customer: '500', airtime_fee_mtn_customer: '5' }
    {
        const r = quoteAirtime({ settings: base, network: 'MTN', role: 'customer', amount: 10.005, useExactAmount: false })
        assert(!r.ok && r.reason === 'invalid_amount', 'quote rejects a 3-decimal amount')
    }
    {
        const r = quoteAirtime({ settings: base, network: 'MTN', role: 'customer', amount: NaN, useExactAmount: true })
        assert(!r.ok && r.reason === 'invalid_amount', 'quote rejects NaN')
    }
    {
        const r = quoteAirtimeCommission({ settings: {}, network: 'MTN', role: 'customer', amount: 12.345 })
        assert(!r.ok && r.reason === 'invalid_amount', 'commission quote rejects a 3-decimal amount too')
    }

    // A NEGATIVE fee used to hand the beneficiary more airtime than the customer paid for.
    {
        const settings = { ...base, airtime_fee_mtn_customer: '-50' }
        const r = quoteAirtime({ settings, network: 'MTN', role: 'customer', amount: 100, useExactAmount: false })
        assert(r.ok, 'negative fee still quotes')
        if (r.ok) {
            assert(r.quote.feeRate === 5, 'negative fee falls back to the 5% default')
            assert(r.quote.airtimeAmount <= r.quote.totalPaid, 'beneficiary never receives more than was paid')
        }
    }
    assert(resolveFeeRate({ airtime_fee_mtn_customer: '0' }, 'MTN', 'customer') === 0, 'a configured 0% fee is honoured (not replaced by a default)')
    assert(resolveFeeRate({ airtime_fee_mtn_customer: '250' }, 'MTN', 'customer') === 5, 'a fee above 100% falls back to the default')
    assert(resolveFeeRate({ airtime_fee_mtn_customer: 'abc' }, 'MTN', 'customer') === 5, 'an unparseable fee falls back to the default')
    assert(resolveFeeRate({ mashup_fee_mtn_dealer: '1.5' }, 'MTN', 'dealer', 'mashup') === 1.5, 'mashup fee uses its own key')
    assert(resolveFeeRate({}, 'MTN', 'dealer') === 2, 'dealer default fee')

    {
        const l = resolveAirtimeLimits({ airtime_max_amount_customer: '0', airtime_min_amount_customer: '-3' }, 'customer')
        assert(l.maxAmount === 500 && l.minAmount === 1, 'a 0 max / negative min fall back to defaults instead of blocking or opening the limits')
    }
    {
        const l = resolveAirtimeLimits({}, 'customer', 'mashup')
        assert(l.minAmount === 5, 'mashup default min is 5')
    }

    // ── validateAirtimeSettings ───────────────────────────────────────────────
    {
        const v = validateAirtimeSettings({ airtime_fee_mtn_customer: '4.5', airtime_enabled_at: true, hubtel_commission_paused: 'false' })
        assert(v.ok, 'valid payload accepted')
        if (v.ok) {
            assert(v.values.airtime_fee_mtn_customer === '4.5', 'fee normalised')
            assert(v.values.airtime_enabled_at === 'true', 'boolean toggle normalised to a string')
        }
    }
    for (const bad of ['-1', '100', '1000', 'abc', 'NaN']) {
        assert(!validateAirtimeSettings({ airtime_fee_mtn_customer: bad }).ok, `fee "${bad}" rejected`)
    }
    assert(!validateAirtimeSettings({ airtime_max_amount_customer: '0' }).ok, 'max of 0 rejected')
    assert(!validateAirtimeSettings({ airtime_min_amount_customer: '-1' }).ok, 'negative min rejected')
    assert(!validateAirtimeSettings({ airtime_max_amount_customer: '99999999' }).ok, 'absurd max rejected')
    assert(!validateAirtimeSettings({ airtime_min_amount_customer: '50', airtime_max_amount_customer: '10' }).ok, 'min above max rejected')
    assert(validateAirtimeSettings({ airtime_min_amount_customer: '10', airtime_max_amount_customer: '10' }).ok, 'min equal to max allowed')
    assert(!validateAirtimeSettings({ airtime_enabled_mtn: 'maybe' }).ok, 'toggle must be true/false')
    assert(!validateAirtimeSettings({ hubtel_airtime_networks: '{"Vodafone":true}' }).ok, 'unknown network in network map rejected')
    assert(!validateAirtimeSettings({ hubtel_airtime_networks: '{"MTN":"yes"}' }).ok, 'non-boolean network flag rejected')
    assert(!validateAirtimeSettings({ hubtel_airtime_networks: 'not json' }).ok, 'non-JSON network map rejected')
    {
        const v = validateAirtimeSettings({ hubtel_airtime_networks: { MTN: true, AT: false } })
        assert(v.ok && v.values.hubtel_airtime_networks === '{"MTN":true,"AT":false}', 'object network map accepted and serialised')
    }
    {
        const v = validateAirtimeSettings({ airtime_fee_mtn_customer: '', airtime_enabled_mtn: 'true' })
        assert(v.ok && !('airtime_fee_mtn_customer' in v.values), 'a blank field is skipped, not written and not an error')
    }
    assert(isAirtimePriceKey('airtime_fee_at_agent') && isAirtimePriceKey('mashup_max_amount_dealer'), 'fee/limit keys are price keys')
    assert(!isAirtimePriceKey('airtime_enabled_mtn') && !isAirtimePriceKey('hubtel_commission_paused'), 'toggles are not price keys')

    // ── admin status transitions ──────────────────────────────────────────────
    assert(canAdminTransition('pending', 'completed') && canAdminTransition('processing', 'completed'), 'pending/processing can complete')
    assert(canAdminTransition('failed', 'completed'), 'a failed order delivered out of band can be completed')
    assert(!canAdminTransition('refunded', 'completed'), 'a REFUNDED order can never be completed (customer would hold refund + delivery)')
    assert(!canAdminTransition('refunded', 'failed') && !canAdminTransition('refunded', 'processing'), 'refunded is terminal')
    assert(!canAdminTransition('completed', 'failed'), 'a completed order is never failed after the fact')
    assert(canAdminTransition('pending', 'failed') && canAdminTransition('processing', 'failed'), 'pending/processing can fail')
    assert(canAdminTransition('pending', 'processing') && !canAdminTransition('processing', 'processing'), 'only pending (or failed) can start processing')
    assert(allowedSourceStatuses('completed').every(s => s !== 'refunded'), 'completed never sources from refunded')
    assert(isAdminTargetStatus('failed') && !isAdminTargetStatus('refunded') && !isAdminTargetStatus('pending'), 'admin targets are processing/completed/failed only')

    // ── CSV formula injection ─────────────────────────────────────────────────
    assert(csvSafeText('=HYPERLINK("http://x")') === `'=HYPERLINK("http://x")`, '= is neutralised')
    assert(csvSafeText('+1+1') === `'+1+1` && csvSafeText('-2+3') === `'-2+3` && csvSafeText('@SUM(A1)') === `'@SUM(A1)`, '+ - @ are neutralised')
    assert(csvSafeText('\tcmd') === `'\tcmd` && csvSafeText('\rcmd') === `'\rcmd`, 'tab / CR lead are neutralised')
    assert(csvSafeText('GHD-ABC123') === 'GHD-ABC123', 'ordinary references are untouched')
    assert(csvSafeText('Kofi Mensah') === 'Kofi Mensah', 'ordinary names are untouched')
    assert(csvSafeText(null) === '' && csvSafeText(undefined) === '', 'null/undefined become empty')
    assert(csvSafeText(244123456) === "244123456", 'numbers stringify')

    // ── shop mirror: only strictly-shaped references may reach another table ──
    {
        // lib/supabase.ts builds a browser client at import time; dummy values are enough because
        // syncAirtimeShopMirror only ever talks to the fake client passed in below.
        process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
        const { syncAirtimeShopMirror } = await import('@/lib/airtime-fulfillment')
        const calls: string[] = []
        const likeArgs: string[] = []
        const chain: any = {
            update: (v: any) => { calls.push(`update:${JSON.stringify(v.status)}`); return chain },
            select: () => chain,
            eq: (col: string, val: string) => { calls.push(`eq:${col}=${val}`); return chain },
            ilike: (_c: string, pattern: string) => { likeArgs.push(pattern); return chain },
            maybeSingle: async () => ({ data: null }),
            single: async () => ({ data: null }),
        }
        const fake = { from: () => chain }

        await syncAirtimeShopMirror(fake, 'SHOP-%', 'completed')
        assert(calls.length === 0 && likeArgs.length === 0, 'a reference containing % is rejected before any query')
        await syncAirtimeShopMirror(fake, "SHOP-a b", 'completed')
        assert(calls.length === 0, 'a reference containing whitespace is rejected')
        await syncAirtimeShopMirror(fake, 'SHOP-x,y', 'completed')
        assert(calls.length === 0, 'a reference containing a comma is rejected')
        await syncAirtimeShopMirror(fake, 'SHOP-' + 'a'.repeat(200), 'completed')
        assert(calls.length === 0, 'an over-long reference is rejected')
        await syncAirtimeShopMirror(fake, 'GHD-ABCDEF1234567890ABCD', 'completed')
        assert(calls.length === 0, 'a plain web reference never touches the shop tables')
        await syncAirtimeShopMirror(fake, 'SHOP-ab_c1', 'completed')
        assert(likeArgs.length === 1 && likeArgs[0] === '%ab\\_c1', `underscore is escaped so it matches literally (got ${likeArgs[0]})`)
    }

    // ── wallet ledger helper ──────────────────────────────────────────────────
    {
        const row = { wallet_id: 'w', user_id: 'u', amount: 5, description: 'd', reference: 'GHD-1' }
        const make = (results: Array<{ error: any } | 'throw'>) => {
            let n = 0
            const inserted: any[] = []
            const fake = {
                from: () => ({
                    insert: async (v: any) => {
                        inserted.push(v)
                        const r = results[Math.min(n++, results.length - 1)]
                        if (r === 'throw') throw new Error('boom')
                        return r
                    },
                }),
            }
            return { fake, inserted, calls: () => n }
        }
        const silence = console.error
        console.error = () => {}
        try {
            const ok = make([{ error: null }])
            assert(await recordAirtimeDebitLedger(ok.fake, row) === true && ok.calls() === 1, 'success on the first try is not retried')
            assert(ok.inserted[0].type === 'debit' && ok.inserted[0].source === 'airtime' && ok.inserted[0].status === 'completed', 'row is a completed airtime debit')

            const retry = make([{ error: { message: 'x', code: '57014' } }, { error: null }])
            assert(await recordAirtimeDebitLedger(retry.fake, row) === true && retry.calls() === 2, 'a returned { error } (not a throw) is detected and retried once')

            const dup = make([{ error: { message: 'dup', code: '23505' } }])
            assert(await recordAirtimeDebitLedger(dup.fake, row) === true, 'a unique violation means it is already recorded')

            const threw = make(['throw', { error: null }])
            assert(await recordAirtimeDebitLedger(threw.fake, row) === true && threw.calls() === 2, 'a thrown error is retried')

            const dead = make([{ error: { message: 'down', code: '08006' } }])
            assert(await recordAirtimeDebitLedger(dead.fake, row) === false && dead.calls() === 2, 'persistent failure returns false after exactly two attempts and never throws')
        } finally {
            console.error = silence
        }
    }

    console.log('All airtime-audit tests passed.')
}

main().catch(e => { console.error(e); process.exit(1) })
