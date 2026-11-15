// Tests for lib/kingflexy-apply-outcome.ts + lib/kingflexy-sync.ts using a FAKE supabase client.
// Run: npx tsx scripts/test-kingflexy-apply-outcome.ts
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost:54321'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'test-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key'

import {
    applyKingflexyOutcome, kingflexyReferenceExists, decideWebhookStatus, handleKingflexyWebhookPayload,
} from '../lib/kingflexy-apply-outcome'
import { syncKingflexyProcessingOrders } from '../lib/kingflexy-sync'

let failures = 0
function assertEqual(actual: unknown, expected: unknown, label: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
        failures++
    } else console.log(`ok: ${label}`)
}

type Row = Record<string, any>

/** Minimal chainable fake: update/select/eq/is/not/contains/order/limit/insert, thenable. */
function makeFake(orders: Row[], tracking: Row[] = []) {
    const trackingInserts: Row[] = [...tracking]
    function table(name: string) {
        const rows = name === 'orders' ? orders : trackingInserts
        let mode: 'select' | 'update' = 'select'
        let patch: Row = {}
        const filters: Array<(r: Row) => boolean> = []
        let lim = Infinity
        const chain: any = {
            update(p: Row) { mode = 'update'; patch = p; return chain },
            select() { return chain },
            eq(k: string, v: any) { filters.push(r => r[k] === v); return chain },
            is(k: string, v: any) { filters.push(r => (r[k] ?? null) === v); return chain },
            not(k: string, _op: string, v: any) { filters.push(r => (r[k] ?? null) !== v); return chain },
            contains(k: string, v: Row) { filters.push(r => Object.entries(v).every(([kk, vv]) => r[k]?.[kk] === vv)); return chain },
            order() { return chain },
            limit(n: number) { lim = n; return chain },
            insert(row: Row) { trackingInserts.push(row); return Promise.resolve({ error: null }) },
            then(res: any, rej: any) {
                const matched = rows.filter(r => filters.every(f => f(r))).slice(0, lim)
                if (mode === 'update') matched.forEach(r => Object.assign(r, patch))
                return Promise.resolve({ data: matched.map(r => ({ ...r })), error: null }).then(res, rej)
            },
        }
        return chain
    }
    return { from: (n: string) => table(n), trackingInserts }
}

function makeDeps() {
    const calls = { shop: [] as string[], push: [] as string[], notify: [] as string[] }
    return {
        calls,
        deps: {
            syncShopOrderStatus: async (id: string, s: string) => { calls.shop.push(`${id}:${s}`) },
            sendCompletedPush: async (id: string) => { calls.push.push(id) },
            notifyOrderWebhook: (_s: any, id: string, ev: string) => { calls.notify.push(`${id}:${ev}`) },
        },
    }
}

const OID = '123e4567-e89b-12d3-a456-426614174000'
const REF0 = `${OID}-r0`
const REF1 = `${OID}-r1`

async function main() {
    // 1. processing + completed -> one row, one set of side effects; clears error_message; stamps delivered_at
    {
        const orders: Row[] = [{ id: OID, status: 'processing', fulfillment_method: 'kingflexy', kingflexy_reference: REF0, error_message: 'old' }]
        const fake = makeFake(orders); const { deps, calls } = makeDeps()
        const r = await applyKingflexyOutcome(fake, { reference: REF0, rawStatus: 'completed', source: 'webhook' }, deps)
        assertEqual([r.resolved, r.applied], ['completed', 1], 'completed applies one row')
        assertEqual(orders[0].status, 'completed', 'order marked completed')
        assertEqual(orders[0].error_message, null, 'stale error_message cleared on completed')
        assertEqual(typeof orders[0].delivered_at, 'string', 'delivered_at stamped')
        assertEqual(calls, { shop: [`${OID}:completed`], push: [OID], notify: [`${OID}:order.completed`] }, 'exactly one set of side effects')
        assertEqual(fake.trackingInserts.length, 0, 'no tracking row on completed')

        // 2. same event again -> no-op, zero side effects
        const again = makeDeps()
        const r2 = await applyKingflexyOutcome(fake, { reference: REF0, rawStatus: 'completed', source: 'webhook' }, again.deps)
        assertEqual(r2.applied, 0, 'duplicate event applies 0')
        assertEqual(again.calls, { shop: [], push: [], notify: [] }, 'duplicate event: zero side effects')

        // 3. completed then refunded -> no-op
        const later = makeDeps()
        const r3 = await applyKingflexyOutcome(fake, { reference: REF0, rawStatus: 'refunded', source: 'cron' }, later.deps)
        assertEqual(r3.applied, 0, 'late refunded after completed applies 0')
        assertEqual(orders[0].status, 'completed', 'completed order not flipped to failed')
        assertEqual(later.calls, { shop: [], push: [], notify: [] }, 'late refunded: zero side effects')
        assertEqual(fake.trackingInserts.length, 0, 'late refunded: no tracking row')
    }

    // 4. refunded -> failed; tracking row; error_message untouched; no push
    {
        const orders: Row[] = [{ id: OID, status: 'processing', fulfillment_method: 'kingflexy', kingflexy_reference: REF0, error_message: 'keep me' }]
        const fake = makeFake(orders); const { deps, calls } = makeDeps()
        const r = await applyKingflexyOutcome(fake, { reference: REF0, rawStatus: 'refunded', source: 'webhook' }, deps)
        assertEqual([r.resolved, r.applied], ['failed', 1], 'refunded -> failed')
        assertEqual(orders[0].status, 'failed', 'order failed')
        assertEqual(orders[0].error_message, 'keep me', 'error_message untouched on failure')
        assertEqual(orders[0].delivered_at, undefined, 'no delivered_at on failure')
        assertEqual(fake.trackingInserts.length, 1, 'one tracking row')
        assertEqual(fake.trackingInserts[0].api_response.supplier, 'kingflexy', 'tracking carries supplier detail')
        assertEqual(calls, { shop: [`${OID}:failed`], push: [], notify: [`${OID}:order.failed`] }, 'failed side effects (no completed push)')
    }

    // 5. raw 'failed' (non-terminal) and other non-terminal -> no change
    for (const raw of ['failed', 'queued', 'blacklisted', 'pending', 'processing', 'weird', undefined]) {
        const orders: Row[] = [{ id: OID, status: 'processing', fulfillment_method: 'kingflexy', kingflexy_reference: REF0 }]
        const fake = makeFake(orders); const { deps, calls } = makeDeps()
        const r = await applyKingflexyOutcome(fake, { reference: REF0, rawStatus: raw, source: 'webhook' }, deps)
        assertEqual([r.applied, orders[0].status, calls.shop.length], [0, 'processing', 0], `raw ${String(raw)} is a no-op`)
    }

    // 6. other supplier with the same reference untouched
    {
        const orders: Row[] = [{ id: OID, status: 'processing', fulfillment_method: 'datakazina', kingflexy_reference: REF0 }]
        const fake = makeFake(orders); const { deps, calls } = makeDeps()
        const r = await applyKingflexyOutcome(fake, { reference: REF0, rawStatus: 'completed', source: 'webhook' }, deps)
        assertEqual([r.applied, orders[0].status, calls.shop.length], [0, 'processing', 0], 'non-kingflexy fulfillment_method untouched')
    }

    // 7. fallback leg: reference NULL -> applies and persists reference
    {
        const orders: Row[] = [{ id: OID, status: 'processing', fulfillment_method: 'kingflexy', kingflexy_reference: null }]
        const fake = makeFake(orders); const { deps } = makeDeps()
        const r = await applyKingflexyOutcome(fake, { reference: REF0, rawStatus: 'completed', source: 'webhook' }, deps)
        assertEqual([r.applied, orders[0].status, orders[0].kingflexy_reference], [1, 'completed', REF0], 'fallback leg applies when reference NULL and persists it')
    }

    // 8. fallback leg refuses when reference non-null (stale -r0 event vs current -r1 attempt)
    {
        const orders: Row[] = [{ id: OID, status: 'processing', fulfillment_method: 'kingflexy', kingflexy_reference: REF1 }]
        const fake = makeFake(orders); const { deps, calls } = makeDeps()
        const r = await applyKingflexyOutcome(fake, { reference: REF0, rawStatus: 'refunded', source: 'webhook' }, deps)
        assertEqual([r.applied, orders[0].status, calls.shop.length, fake.trackingInserts.length], [0, 'processing', 0, 0], 'stale event for superseded attempt refused')
    }

    // 9. reference lookup + webhook decision
    {
        const fake = makeFake([{ id: OID, kingflexy_reference: REF0 }])
        assertEqual(await kingflexyReferenceExists(fake, REF0), true, 'referenceExists true')
        assertEqual(await kingflexyReferenceExists(fake, REF1), false, 'referenceExists false')
        const now = Date.parse('2026-11-15T12:00:00Z')
        const recent = '2026-11-15T11:55:00Z', old = '2026-11-15T11:30:00Z'
        assertEqual(decideWebhookStatus({ applied: 0, referenceKnown: false, timestamp: recent, nowMs: now }), 500, 'race + <10min -> 500')
        assertEqual(decideWebhookStatus({ applied: 0, referenceKnown: false, timestamp: old, nowMs: now }), 200, 'race + >10min -> 200')
        assertEqual(decideWebhookStatus({ applied: 0, referenceKnown: false, timestamp: undefined, nowMs: now }), 200, 'race + no timestamp -> 200')
        assertEqual(decideWebhookStatus({ applied: 0, referenceKnown: true, timestamp: recent, nowMs: now }), 200, 'known reference already resolved -> 200')
        assertEqual(decideWebhookStatus({ applied: 1, referenceKnown: false, timestamp: recent, nowMs: now }), 200, 'applied -> 200')
    }

    // 10. sync
    {
        const now = Date.parse('2026-11-15T12:00:00Z')
        const oldTs = '2026-11-15T11:00:00Z', newTs = '2026-11-15T11:55:00Z'
        const mk = (id: string, ref: string, created: string, status = 'processing', fm = 'kingflexy'): Row =>
            ({ id, kingflexy_reference: ref, created_at: created, status, fulfillment_method: fm })
        const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b'
        const C = '00000000-0000-4000-8000-00000000000c', D = '00000000-0000-4000-8000-00000000000d'
        const E = '00000000-0000-4000-8000-00000000000e'
        const orders: Row[] = [
            mk(A, `${A}-r0`, oldTs), mk(B, `${B}-r0`, oldTs), mk(C, `${C}-r0`, oldTs), mk(D, `${D}-r0`, newTs),
            mk(E, `${E}-r0`, oldTs, 'completed'),
        ]
        const fake = makeFake(orders); const { deps, calls } = makeDeps()
        const statuses: Record<string, any> = {
            [`${A}-r0`]: { success: true, found: true, status: 'completed' },
            [`${B}-r0`]: { success: true, found: false },
            [`${C}-r0`]: { success: false, found: false, error: 'x' },
            [`${D}-r0`]: { success: true, found: false },
        }
        const alerts: string[] = []
        const run = () => syncKingflexyProcessingOrders(fake, {
            nowMs: now,
            alertAdmin: async (_s, id, ref, reason) => { alerts.push(`${id}|${ref}|${reason}`) },
            checkStatus: async ref => statuses[ref],
            apply: (s, a) => applyKingflexyOutcome(s, a, deps),
        })
        const r = await run()
        assertEqual([r.checked, r.updated, r.failed], [4, 1, 0], 'sync counts (completed row excluded)')
        assertEqual(orders[0].status, 'completed', 'sync completes A')
        assertEqual(orders[1].status, 'processing', 'sync leaves not-found B processing')
        assertEqual(calls.shop, [`${A}:completed`], 'sync side effects only for A')
        const nf = fake.trackingInserts.filter(t => t.api_response?.note === 'not_found_at_supplier')
        assertEqual(nf.map(t => t.order_id), [B], 'not-found tracking only for >15min order (not D, not API errors)')
        assertEqual(nf[0].api_response.source, 'cron_sweep', 'tracking source cron_sweep')
        assertEqual(nf[0].status, 'pending', 'not-found marker uses neutral status (order still processing)')
        assertEqual(alerts.length, 1, 'one admin alert on first not-found marker')
        assertEqual(alerts[0].startsWith(`${B}|${B}-r0|`), true, 'alert names order id and reference')
        await run()
        assertEqual(fake.trackingInserts.filter(t => t.api_response?.note === 'not_found_at_supplier').length, 1, 'not-found tracking deduped on rerun')
        assertEqual(alerts.length, 1, 'no repeat alert on rerun')
    }

    // 11. webhook handler: errors -> 500 (redelivery), no-ops -> 200
    {
        const now = Date.parse('2026-11-15T12:00:00Z')
        const recent = '2026-11-15T11:55:00Z'
        const p = (o: Row = {}) => ({ event: 'order.completed', product: 'data', reference: REF0, status: 'completed', timestamp: recent, ...o })
        const boom = async () => { throw new Error('db down') }
        const ok = async (applied: number) => ({ resolved: 'completed' as const, applied })
        const h = (payload: any, seams: any) => handleKingflexyWebhookPayload({}, payload, now, seams).then(r => r.status)
        assertEqual(await h(p(), { apply: boom }), 500, 'apply throwing -> 500')
        assertEqual(await h(p(), { apply: () => ok(0), referenceExists: boom }), 500, 'referenceExists throwing -> 500')
        assertEqual(await h(p(), { apply: () => ok(1) }), 200, 'terminal outcome applied -> 200')
        assertEqual(await h(p({ event: 'webhook.test' }), { apply: boom }), 200, 'webhook.test -> 200 without order logic')
        assertEqual(await h(p({ product: 'airtime' }), { apply: boom }), 200, 'non-data product -> 200')
        assertEqual(await h(p({ reference: '' }), { apply: boom }), 200, 'no reference -> 200')
        assertEqual(await h(p(), { apply: () => ok(0), referenceExists: async () => true }), 200, 'already applied (order found) -> 200')
        assertEqual(await h(p(), { apply: () => ok(0), referenceExists: async () => false }), 500, 'race, recent event -> 500')
        assertEqual(await h(p({ timestamp: '2026-11-15T11:00:00Z' }), { apply: () => ok(0), referenceExists: async () => false }), 200, 'stray old event -> 200')
    }

    // 12. late completed after failure: record + alert once, never reverse; no false positives
    {
        const mkAlerts = () => { const a: string[] = []; return { a, f: async (_s: any, id: string, ref: string, reason: string) => { a.push(`${id}|${ref}|${reason}`) } } }
        const run = async (orders: Row[], fake: any, al: any) => {
            const { deps } = makeDeps()
            return applyKingflexyOutcome(fake, { reference: REF0, rawStatus: 'completed', source: 'webhook' }, { ...deps, alertAdmin: al.f })
        }
        // failed kingflexy order -> recorded + alerted once, status untouched, deduped on redelivery
        const orders: Row[] = [{ id: OID, status: 'failed', fulfillment_method: 'kingflexy', kingflexy_reference: REF0 }]
        const fake = makeFake(orders); const al = mkAlerts()
        let r = await run(orders, fake, al)
        assertEqual([r.resolved, r.applied, orders[0].status], ['completed', 0, 'failed'], 'late completed: not applied, order stays failed')
        const rows = fake.trackingInserts.filter(t => t.api_response?.note === 'late_completed_after_failure')
        assertEqual(rows.length, 1, 'late completed: one tracking row')
        assertEqual([rows[0].status, rows[0].api_response.supplier, rows[0].api_response.source, rows[0].api_response.reference], ['pending', 'kingflexy', 'webhook', REF0], 'late completed row shape')
        assertEqual(al.a.length, 1, 'late completed: one alert')
        assertEqual(al.a[0].startsWith(`${OID}|${REF0}|`), true, 'alert names order id and reference')
        await run(orders, fake, al)
        assertEqual([fake.trackingInserts.length, al.a.length], [1, 1], 'redelivery: no second row/alert')

        // no false positives
        for (const [st, fm] of [['completed', 'kingflexy'], ['processing', 'kingflexy'], ['failed', 'datakazina']] as const) {
            const o: Row[] = [{ id: OID, status: st, fulfillment_method: fm, kingflexy_reference: REF0 }]
            const f = makeFake(o); const a2 = mkAlerts()
            await run(o, f, a2)
            assertEqual([f.trackingInserts.length, a2.a.length], [0, 0], `no late-completed record for ${st}/${fm}`)
        }

        // alert/lookup failure never throws or changes the result
        const o3: Row[] = [{ id: OID, status: 'failed', fulfillment_method: 'kingflexy', kingflexy_reference: REF0 }]
        const f3 = makeFake(o3)
        const { deps } = makeDeps()
        const r3 = await applyKingflexyOutcome(f3, { reference: REF0, rawStatus: 'completed', source: 'cron' }, { ...deps, alertAdmin: async () => { throw new Error('push down') } })
        assertEqual([r3.resolved, r3.applied], ['completed', 0], 'alert failure does not throw')
        const broken: any = { from: (t: string) => t === 'orders' ? { update: () => ({ eq: function () { return this }, is: function () { return this }, select: () => Promise.resolve({ data: [], error: null }) }), select: () => { throw new Error('boom') } } : f3.from(t) }
        const r4 = await applyKingflexyOutcome(broken, { reference: REF0, rawStatus: 'completed', source: 'cron' }, deps)
        assertEqual([r4.resolved, r4.applied], ['completed', 0], 'lookup failure does not throw')
    }

    if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
    console.log('\nAll kingflexy apply-outcome tests passed')
}
main().catch(e => { console.error(e); process.exit(1) })
