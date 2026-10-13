import assert from 'node:assert/strict'
import {
    isPlanValidForType,
    normalizeIdempotencyKey,
    pricesMatch,
    resolveUpgradePrice,
    applyWalletUpgrade,
    addMonthsClamped,
    UpgradePriceError,
} from '../lib/wallet-upgrade'

let passed = 0
async function check(name: string, fn: () => void | Promise<void>) {
    try {
        await fn()
        passed++
        console.log(`ok - ${name}`)
    } catch (err) {
        console.error(`FAIL - ${name}`)
        console.error(err)
        process.exit(1)
    }
}

type RpcCall = { fn: string; args: Record<string, unknown> }

/** Stub with ONLY `rpc` — any direct `.from(...)` table write from applyWalletUpgrade would throw. */
function stubClient(reply: { data?: unknown; error?: { message: string } | null }) {
    const calls: RpcCall[] = []
    const client = {
        rpc: async (fn: string, args: Record<string, unknown>) => {
            calls.push({ fn, args })
            return { data: reply.data ?? null, error: reply.error ?? null }
        },
    }
    return { client: client as any, calls }
}

const baseParams = {
    userId: '11111111-1111-4111-8111-111111111111',
    upgradeType: 'agent' as const,
    plan: '30d' as const,
    price: 99.99,
    planLabel: '30 Days Agent Pass',
    idempotencyKey: '22222222-2222-4222-8222-222222222222',
}

async function main() {
    // ── plan validation ────────────────────────────────────────────────
    await check('agent plans are valid only for agent upgrades', () => {
        for (const p of ['3d', '14d', '30d', 'permanent']) {
            assert.equal(isPlanValidForType('agent', p), true, p)
            assert.equal(isPlanValidForType('dealer', p), false, p)
        }
    })
    await check('dealer plans are valid only for dealer upgrades', () => {
        for (const p of ['1m', '3m', '6m']) {
            assert.equal(isPlanValidForType('dealer', p), true, p)
            assert.equal(isPlanValidForType('agent', p), false, p)
        }
    })
    await check('unknown / non-string plans are rejected for both types', () => {
        for (const p of ['', '7d', 'PERMANENT', undefined, null, 30, {}, ['30d']]) {
            assert.equal(isPlanValidForType('agent', p), false, String(p))
            assert.equal(isPlanValidForType('dealer', p), false, String(p))
        }
    })

    // ── idempotency key ────────────────────────────────────────────────
    await check('a well-formed UUID key is kept (lowercased)', () => {
        const k = '2222222A-2222-4222-8222-222222222222'
        assert.equal(normalizeIdempotencyKey(k), k.toLowerCase())
    })
    await check('malformed / hostile keys are replaced by a fresh server UUID', () => {
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        for (const bad of ['', 'abc', "x'; drop table users;--", 'a'.repeat(500), undefined, null, 42, {}]) {
            const k = normalizeIdempotencyKey(bad)
            assert.match(k, uuidRe, String(bad))
        }
        assert.notEqual(normalizeIdempotencyKey('nope'), normalizeIdempotencyKey('nope'))
    })

    // ── expected price (consent) check ─────────────────────────────────
    await check('omitted expected price skips the check (non-UI callers)', () => {
        assert.equal(pricesMatch(undefined, 99.99), true)
    })
    await check('matching price passes, within half a pesewa', () => {
        assert.equal(pricesMatch(99.99, 99.99), true)
        assert.equal(pricesMatch(99.994, 99.99), true)
    })
    await check('a changed price is a mismatch', () => {
        assert.equal(pricesMatch(79.99, 99.99), false)
        assert.equal(pricesMatch(99.98, 99.99), false)
    })
    await check('non-numeric expected price is a mismatch, never a pass', () => {
        for (const bad of ['99.99', null, NaN, Infinity, {}, []]) {
            assert.equal(pricesMatch(bad, 99.99), false, String(bad))
        }
    })

    // ── price resolution fails closed ──────────────────────────────────
    await check('missing setting falls back to the documented default', () => {
        const r = resolveUpgradePrice([], 'agent', '30d')
        assert.equal(r.price, 99.99)
        assert.equal(r.planLabel, '30 Days Agent Pass')
        assert.equal(r.planDays, 30)
    })
    await check('jsonb number and numeric-string settings are both accepted', () => {
        assert.equal(resolveUpgradePrice([{ key: 'agent_upgrade_price_3d', value: 12.5 }], 'agent', '3d').price, 12.5)
        assert.equal(resolveUpgradePrice([{ key: 'dealer_upgrade_price_6m', value: '350.00' }], 'dealer', '6m').price, 350)
    })
    await check('NaN, zero, negative and infinite settings throw instead of charging', () => {
        for (const v of ['abc', '', 0, '0', -5, '-1', 'Infinity', null, {}, true]) {
            assert.throws(
                () => resolveUpgradePrice([{ key: 'agent_upgrade_price_14d', value: v }], 'agent', '14d'),
                UpgradePriceError,
                String(v)
            )
        }
    })
    await check('resolveUpgradePrice rejects an invalid plan for the type', () => {
        assert.throws(() => resolveUpgradePrice([], 'agent', '1m'), UpgradePriceError)
        assert.throws(() => resolveUpgradePrice([], 'dealer', '3d'), UpgradePriceError)
    })
    await check('permanent plan has null days; dealer plans have day counts', () => {
        assert.equal(resolveUpgradePrice([], 'agent', 'permanent').planDays, null)
        assert.equal(resolveUpgradePrice([], 'dealer', '3m').planDays, 90)
    })

    // ── month arithmetic matches Postgres interval (clamps month-ends) ──
    await check('addMonthsClamped clamps month-ends instead of overflowing like setMonth', () => {
        const iso = (d: Date) => d.toISOString()
        assert.equal(iso(addMonthsClamped(new Date('2026-01-31T10:30:00Z'), 1)), '2026-02-28T10:30:00.000Z')
        assert.equal(iso(addMonthsClamped(new Date('2028-01-31T10:30:00Z'), 1)), '2028-02-29T10:30:00.000Z') // leap year
        assert.equal(iso(addMonthsClamped(new Date('2026-08-31T00:00:00Z'), 6)), '2027-02-28T00:00:00.000Z')
        assert.equal(iso(addMonthsClamped(new Date('2026-10-12T08:00:00Z'), 3)), '2027-01-12T08:00:00.000Z')
        assert.equal(iso(addMonthsClamped(new Date('2026-10-31T08:00:00Z'), 1)), '2026-11-30T08:00:00.000Z')
    })
    await check('addMonthsClamped does not mutate its input', () => {
        const d = new Date('2026-01-31T00:00:00Z')
        addMonthsClamped(d, 1)
        assert.equal(d.toISOString(), '2026-01-31T00:00:00.000Z')
    })

    // ── applyWalletUpgrade → single atomic RPC ─────────────────────────
    await check('success calls ONE rpc with the full argument set and maps the expiry', async () => {
        const { client, calls } = stubClient({
            data: { status: 'ok', new_expiry: '2026-11-12T00:00:00Z', new_balance: 10, was_extension: false, previous_role: 'customer', previous_agent_expires_at: null },
        })
        const r = await applyWalletUpgrade(client, baseParams)
        assert.equal(r.success, true)
        assert.equal(r.newExpiry, '2026-11-12T00:00:00Z')
        assert.equal(r.newBalance, 10)
        assert.equal(calls.length, 1)
        assert.equal(calls[0].fn, 'process_wallet_upgrade')
        assert.deepEqual(calls[0].args, {
            p_user_id: baseParams.userId,
            p_upgrade_type: 'agent',
            p_plan: '30d',
            p_price: 99.99,
            p_plan_label: '30 Days Agent Pass',
            p_reference: `upgrade_agent_${baseParams.idempotencyKey}`,
            p_only_if_due: false,
            p_is_auto: false,
        })
    })
    await check('auto-upgrade passes p_only_if_due / p_is_auto through', async () => {
        const { client, calls } = stubClient({ data: { status: 'ok', new_expiry: null } })
        await applyWalletUpgrade(client, { ...baseParams, isAutoUpgrade: true, onlyIfDue: true })
        assert.equal(calls[0].args.p_only_if_due, true)
        assert.equal(calls[0].args.p_is_auto, true)
    })
    await check('already_processed is a success flagged as a replay (no second charge)', async () => {
        const { client } = stubClient({ data: { status: 'already_processed', new_expiry: '2026-11-12T00:00:00Z' } })
        const r = await applyWalletUpgrade(client, baseParams)
        assert.equal(r.success, true)
        assert.equal(r.alreadyProcessed, true)
    })
    await check('insufficient balance carries balance + required amount', async () => {
        const { client } = stubClient({ data: { status: 'insufficient_balance', current_balance: 5, required_amount: 99.99 } })
        const r = await applyWalletUpgrade(client, baseParams)
        assert.equal(r.success, false)
        assert.equal(r.insufficientBalance, true)
        assert.equal(r.currentBalance, 5)
        assert.equal(r.requiredAmount, 99.99)
        assert.equal(r.code, 'insufficient_balance')
    })
    await check('already_permanent / not_eligible / account_inactive / not_due surface a code and no charge', async () => {
        for (const status of ['already_permanent', 'not_eligible', 'account_inactive', 'not_due']) {
            const { client } = stubClient({ data: { status } })
            const r = await applyWalletUpgrade(client, baseParams)
            assert.equal(r.success, false, status)
            assert.equal(r.code, status)
            assert.ok(r.error && r.error.length > 0, status)
        }
    })
    await check('an rpc transport error is a generic failure that does not leak the DB message', async () => {
        const { client } = stubClient({ error: { message: 'relation "secret_table" does not exist' } })
        const r = await applyWalletUpgrade(client, baseParams)
        assert.equal(r.success, false)
        assert.equal(r.code, 'rpc_error')
        assert.ok(!/secret_table/.test(r.error ?? ''))
    })
    await check('an unrecognised rpc status is a failure, never a success', async () => {
        const { client } = stubClient({ data: { status: 'weird' } })
        const r = await applyWalletUpgrade(client, baseParams)
        assert.equal(r.success, false)
    })
    await check('a null rpc payload is a failure, never a success', async () => {
        const { client } = stubClient({ data: null })
        const r = await applyWalletUpgrade(client, baseParams)
        assert.equal(r.success, false)
    })

    console.log(`\n${passed} checks passed`)
}

main()
