import { readFileSync } from 'fs'
import { join } from 'path'
import { parseOverrideBody, applyOverride, listOverrides } from '@/lib/gateway-overrides'
import type { DownSnapshot } from '@/lib/gateway-estimate'

/*
 * FAKE admin client. It implements EXACTLY the chained calls lib/gateway-overrides.ts uses:
 *   admin.from(t).select('*').eq('channel', c).maybeSingle()            -> { data, error }
 *   admin.from(t).upsert(row, { onConflict: 'channel' }).select('*').single() -> { data, error }
 *   admin.from(t).select('*').order('channel')                          -> awaited { data, error }
 * upsert merges the given columns into the existing row (Postgres ON CONFLICT DO UPDATE semantics).
 */
function makeFake(initial: Record<string, unknown>[] = [], opts: { fail?: boolean } = {}) {
    const rows = new Map<string, Record<string, unknown>>(initial.map((r) => [r.channel as string, { ...r }]))
    const err = { message: 'boom' }
    const admin = {
        from(_t: string) {
            return {
                select(_cols: string) {
                    return {
                        eq(_c: string, v: string) {
                            return { maybeSingle: async () => opts.fail ? { data: null, error: err } : { data: rows.get(v) ?? null, error: null } }
                        },
                        order(_c: string) {
                            const data = [...rows.values()].sort((a, b) => String(a.channel).localeCompare(String(b.channel)))
                            return Promise.resolve(opts.fail ? { data: null, error: err } : { data, error: null })
                        },
                    }
                },
                upsert(row: Record<string, unknown>, o: { onConflict: string }) {
                    assert(o.onConflict === 'channel', 'onConflict channel')
                    return {
                        select(_c: string) {
                            return {
                                single: async () => {
                                    if (opts.fail) return { data: null, error: err }
                                    const merged = { ...(rows.get(row.channel as string) ?? {}), ...row }
                                    rows.set(row.channel as string, merged)
                                    return { data: merged, error: null }
                                },
                            }
                        },
                    }
                },
            }
        },
    }
    return { admin: admin as any, rows }
}

function assert(cond: unknown, msg: string) {
    if (!cond) throw new Error(`FAIL: ${msg}`)
}

async function main() {
    // (a) parseOverrideBody
    let p = parseOverrideBody({ channel: 'MTN', down: true, reason: 'Supplier outage' })
    assert(p.ok && p.value.channel === 'MTN' && p.value.down === true && p.value.reason === 'Supplier outage', 'valid ON')
    p = parseOverrideBody({ channel: 'Telecel', down: false })
    assert(p.ok && p.value.down === false && p.value.reason === null, 'valid OFF no reason')
    p = parseOverrideBody({ channel: 'MTN', down: true, reason: '  hi  ' })
    assert(p.ok && p.value.reason === 'hi', 'trimmed')
    p = parseOverrideBody({ channel: 'MTN', down: true, reason: '   ' })
    assert(p.ok && p.value.reason === null, 'whitespace -> null')
    p = parseOverrideBody({ channel: 'MTN', down: true, reason: '' })
    assert(p.ok && p.value.reason === null, 'empty -> null')
    p = parseOverrideBody({ channel: 'MTN', down: true, reason: 'x'.repeat(200) })
    assert(p.ok, '200 chars ok')
    assert(!parseOverrideBody({ channel: 'MTN', down: true, reason: 'x'.repeat(201) }).ok, '201 chars rejected')
    assert(!parseOverrideBody({ channel: 'Vodafone', down: true }).ok, 'unknown channel')
    assert(!parseOverrideBody({ channel: 'MTN', down: 'true' }).ok, 'down string')
    assert(!parseOverrideBody({ channel: 'MTN' }).ok, 'down missing')
    assert(!parseOverrideBody({ channel: 'MTN', down: true, reason: 5 }).ok, 'reason non-string')
    for (const bad of [null, 'str', [], 5, undefined]) assert(!parseOverrideBody(bad).ok, `non-object ${String(bad)}`)
    assert(!parseOverrideBody({ channel: 'MTN', down: true, reason: '<script>alert(1)</script>' }).ok, 'script reason')
    p = parseOverrideBody({ channel: 'standard_bundles', down: true, reason: 'a < b & c > d' })
    assert(p.ok && p.value.reason === 'a < b & c > d', '<>& accepted')
    const bad = parseOverrideBody({ channel: 'Vodafone', down: true })
    assert(!bad.ok && typeof bad.error === 'string' && bad.error.length > 0, 'error message present')

    // (b) applyOverride
    const snap: DownSnapshot = { lastSeconds: 120, lastPlacedAt: '2026-11-13T10:00:00Z', lastDeliveredAt: '2026-11-13T10:02:00Z' }
    let snapCalls = 0
    const makeSnapshot = async () => { snapCalls++; return snap }
    const f = makeFake()
    const on = await applyOverride(f.admin, { channel: 'MTN', down: true, reason: 'r1', adminId: 'admin-1', makeSnapshot })
    assert(on.is_manually_down === true && on.reason === 'r1', 'ON state')
    assert(JSON.stringify(on.snapshot) === JSON.stringify(snap), 'ON snapshot')
    assert(typeof on.since === 'string' && !Number.isNaN(Date.parse(on.since!)), 'ON since')
    assert(on.updated_by === 'admin-1' && typeof on.updated_at === 'string', 'ON updated_by')
    assert(snapCalls === 1, 'snapshot called once')

    const since0 = on.since
    const on2 = await applyOverride(f.admin, { channel: 'MTN', down: true, reason: 'r2', adminId: 'admin-2', makeSnapshot })
    assert(on2.reason === 'r2' && on2.updated_by === 'admin-2', 'ON again reason/updated_by')
    assert(on2.since === since0, 'since unchanged')
    assert(JSON.stringify(on2.snapshot) === JSON.stringify(snap), 'snapshot unchanged')
    assert(snapCalls === 1, 'snapshot NOT called again')

    const off = await applyOverride(f.admin, { channel: 'MTN', down: false, reason: 'ignored', adminId: 'admin-3', makeSnapshot })
    assert(off.is_manually_down === false && off.reason === null && off.since === null && off.snapshot === null, 'OFF clears')
    assert(off.updated_by === 'admin-3', 'OFF updated_by')
    assert(snapCalls === 1, 'snapshot NOT called on OFF')

    const off2 = await applyOverride(f.admin, { channel: 'MTN', down: false, reason: null, adminId: 'admin-3', makeSnapshot })
    assert(off2.is_manually_down === false && off2.snapshot === null, 'OFF idempotent')
    const f2 = makeFake()
    const off3 = await applyOverride(f2.admin, { channel: 'Telecel', down: false, reason: null, adminId: 'a', makeSnapshot })
    assert(off3.is_manually_down === false, 'OFF on missing row works')

    const all = await listOverrides(f.admin)
    assert(all.length === 1 && all[0].channel === 'MTN', 'list')

    let threw = false
    try { await applyOverride(makeFake([], { fail: true }).admin, { channel: 'MTN', down: true, reason: null, adminId: 'a', makeSnapshot }) } catch { threw = true }
    assert(threw, 'DB error throws')
    threw = false
    try { await listOverrides(makeFake([], { fail: true }).admin) } catch { threw = true }
    assert(threw, 'list DB error throws')

    // (c) static assertions
    const root = join(__dirname, '..')
    const route = readFileSync(join(root, 'app/api/admin/gateway-status/override/route.ts'), 'utf8')
    assert(route.includes('validateAdminAccess(false'), 'route admin-only gate')
    assert(!route.includes('validateAdminAccess(true'), 'route not sub-admin')
    assert(route.includes('invalidateGatewayStatusCache'), 'route invalidates cache')
    assert(!/console\.log\(/.test(route), 'route has no console.log')
    assert(!/console\.(info|error|warn)\([^)]*reason/.test(route), 'route does not log reason')
    const shared = readFileSync(join(root, 'lib/gateway-override-shared.ts'), 'utf8')
    assert(!/from\s+['"]@\/lib\/supabase(-admin|-server)?['"]/.test(shared), 'shared has no supabase import')
    assert(!/from\s+['"]next\//.test(shared), 'shared has no next/ import')

    console.log('gateway-overrides: all checks passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
