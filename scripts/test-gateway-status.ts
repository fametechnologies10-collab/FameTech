import { getGatewayStatus, coerceSignalRows } from '@/lib/gateway-status'
import type { GatewaySignalRow } from '@/lib/gateway-estimate'

function assert(cond: unknown, msg: string) {
    if (!cond) throw new Error(`FAIL: ${msg}`)
}

const NOW = new Date('2026-11-13T12:00:00.000Z')
const rows: GatewaySignalRow[] = [
    {
        key: 'MTN',
        c_created_at: '2026-11-13T11:00:00Z',
        c_delivered_at: '2026-11-13T11:08:00Z',
        p_created_at: null,
        is_manually_down: false,
        down_reason: null,
        down_since: null,
        down_snapshot: null,
    },
]

function makeDeps(over: Record<string, unknown> = {}) {
    const calls = { get: 0, set: [] as unknown[][], fetch: 0 }
    const deps = {
        cacheGet: async () => { calls.get++; return null },
        cacheSet: async (k: string, v: string, t: number) => { calls.set.push([k, v, t]) },
        fetchSignals: async () => { calls.fetch++; return rows },
        now: () => NOW,
        ...over,
    }
    return { deps: deps as Parameters<typeof getGatewayStatus>[0], calls }
}

const KEYS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'standard_bundles']

async function main() {
    // 1. cache hit
    {
        const cached = { generatedAt: '2026-11-13T11:59:50.000Z', networks: [{ key: 'MTN', state: 'none' }] }
        const { deps, calls } = makeDeps({ cacheGet: async () => JSON.stringify(cached) })
        const r = await getGatewayStatus(deps)
        assert(calls.fetch === 0, 'hit does not call fetchSignals')
        assert(JSON.stringify(r.networks) === JSON.stringify(cached.networks), 'hit returns cached networks')
        assert(r.generatedAt === cached.generatedAt, 'hit keeps cached generatedAt')
        assert(r.serverNow === NOW.toISOString(), 'serverNow is fresh now')
        assert(r.serverNow !== r.generatedAt, 'serverNow is not cached generatedAt')
    }
    // 2. miss
    {
        const { deps, calls } = makeDeps()
        const r = await getGatewayStatus(deps)
        assert(calls.fetch === 1, 'miss calls fetchSignals once')
        assert(r.networks.length === 5 && r.networks.map(n => n.key).join() === KEYS.join(), 'five views in order')
        assert(r.generatedAt === NOW.toISOString(), 'generatedAt = now')
        assert(r.serverNow === NOW.toISOString(), 'serverNow = now')
        assert(calls.set.length === 1, 'cacheSet once')
        const [k, v, t] = calls.set[0] as [string, string, number]
        assert(k === 'gateway-status:v2', 'cache key')
        assert(t === 20, 'ttl 20')
        const parsed = JSON.parse(v)
        assert(!('serverNow' in parsed), 'cached payload has no serverNow')
        assert(JSON.stringify(parsed) === JSON.stringify({ generatedAt: r.generatedAt, networks: r.networks }), 'round trip')
        assert(r.networks[0].state === 'live', 'MTN live')
    }
    // 3. cacheGet throws
    {
        const { deps } = makeDeps({ cacheGet: async () => { throw new Error('redis down') } })
        const r = await getGatewayStatus(deps)
        assert(r.networks.length === 5, 'get throw falls through')
    }
    // 4. cacheSet throws
    {
        const { deps } = makeDeps({ cacheSet: async () => { throw new Error('redis down') } })
        const r = await getGatewayStatus(deps)
        assert(r.networks.length === 5, 'set throw still returns')
    }
    // 5. fetchSignals rejects
    {
        const { deps } = makeDeps({ fetchSignals: async () => { throw new Error('rpc') } })
        let rejected = false
        try { await getGatewayStatus(deps) } catch { rejected = true }
        assert(rejected, 'rpc error rejects')
    }
    // 6. parsed object accepted
    {
        const full = { generatedAt: 'g', networks: [{ key: 'MTN', state: 'live' }] }
        const { deps, calls } = makeDeps({ cacheGet: async () => full })
        const r = await getGatewayStatus(deps)
        assert(calls.fetch === 0 && r.networks.length === 1 && r.generatedAt === 'g', 'parsed object accepted')
    }
    // 7. malformed = miss
    const malformed: unknown[] = [
        'not json',
        {},
        { generatedAt: 'x' },
        { generatedAt: 'x', networks: [{}] },
        { generatedAt: 'x', networks: [{ key: 'MTN', state: 'weird' }] },
    ]
    for (const bad of malformed) {
        const { deps, calls } = makeDeps({ cacheGet: async () => bad })
        const r = await getGatewayStatus(deps)
        assert(calls.fetch === 1 && r.networks.length === 5, `malformed treated as miss: ${JSON.stringify(bad)}`)
    }
    // 8. no leak of down_reason
    {
        const leak = [{
            key: 'MTN',
            c_created_at: null,
            c_delivered_at: null,
            p_created_at: null,
            is_manually_down: true,
            down_reason: 'SECRET-REASON',
            down_since: '2026-11-13T11:30:00Z',
            down_snapshot: { lastSeconds: 90, lastPlacedAt: '2026-11-13T11:00:00Z', lastDeliveredAt: '2026-11-13T11:01:30Z' },
        }] as GatewaySignalRow[]
        const { deps, calls } = makeDeps({ fetchSignals: async () => leak })
        const r = await getGatewayStatus(deps)
        assert(r.networks[0].state === 'down', 'MTN down')
        assert(!JSON.stringify(r).includes('SECRET-REASON'), 'result has no reason')
        assert(calls.set.length === 1 && !(calls.set[0][1] as string).includes('SECRET-REASON'), 'cached string has no reason')
    }
    // 9. coerceSignalRows
    {
        assert(coerceSignalRows(null).length === 0 && coerceSignalRows('x').length === 0 && coerceSignalRows({}).length === 0, 'non-array -> []')
        const out = coerceSignalRows([
            null, 'str', 5, { c_created_at: 'x' }, { key: 42 },
            { key: 'MTN', c_created_at: 'garbage', c_delivered_at: 'also-bad', p_created_at: 12, down_since: {}, down_reason: 7, is_manually_down: 'true', down_snapshot: 'nope' },
            { key: 'Telecel', c_created_at: '2026-11-13T11:00:00Z', is_manually_down: true, down_reason: 'r', down_since: '2026-11-13T11:30:00Z',
              down_snapshot: { lastSeconds: 90, lastPlacedAt: 'a', lastDeliveredAt: null } },
            { key: 'AT-iShare', down_snapshot: { lastSeconds: '90', lastPlacedAt: 'a', lastDeliveredAt: 'b' } },
            { key: 'AT-BigTime', down_snapshot: { lastSeconds: NaN, lastPlacedAt: 'a', lastDeliveredAt: 'b' } },
            { key: 'standard_bundles', down_snapshot: { lastSeconds: null, lastPlacedAt: null, lastDeliveredAt: null } },
            { key: 'X', down_snapshot: { lastSeconds: 1, lastPlacedAt: 5, lastDeliveredAt: 'b' } },
            { key: 'Y', down_snapshot: [] },
        ])
        assert(out.length === 7, `skipped bad entries, got ${out.length}`)
        const [mtn, tel, ish, big, std, x, y] = out
        assert(mtn.c_created_at === 'garbage' && mtn.c_delivered_at === 'also-bad', 'garbage timestamps kept')
        assert(mtn.p_created_at === null && mtn.down_since === null && mtn.down_reason === null, 'non-string -> null')
        assert(mtn.is_manually_down === false, "'true' string -> false")
        assert(mtn.down_snapshot === null, 'string snapshot -> null')
        assert(tel.is_manually_down === true && tel.down_reason === 'r' && tel.down_since === '2026-11-13T11:30:00Z', 'valid manual-down kept')
        assert(tel.down_snapshot?.lastSeconds === 90 && tel.down_snapshot.lastDeliveredAt === null, 'valid snapshot')
        assert(ish.down_snapshot === null, 'string lastSeconds -> null')
        assert(big.down_snapshot === null, 'NaN lastSeconds -> null')
        assert(std.down_snapshot !== null && std.down_snapshot.lastSeconds === null, 'all-null snapshot valid')
        assert(x.down_snapshot === null, 'bad timestamp type -> null')
        assert(y.down_snapshot === null, 'array snapshot -> null')
    }
    console.log('gateway-status: all assertions passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
