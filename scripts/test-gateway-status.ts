import { getGatewayStatus, coerceRpcRows } from '@/lib/gateway-status'
import type { RawGatewayRow } from '@/lib/gateway-health'

function assert(cond: unknown, msg: string) {
    if (!cond) throw new Error(`FAIL: ${msg}`)
}

const NOW = new Date('2026-11-13T10:00:00.000Z')
const rows: RawGatewayRow[] = [
    { key: 'MTN', last_placed_at: '2026-11-13T09:50:00Z', last_delivered_at: '2026-11-13T09:55:00Z', delivery_minutes: [5, 6, 4], resolved_count: 3, failed_count: 0 },
]

function makeDeps(over: Record<string, unknown> = {}) {
    const calls = { get: 0, set: [] as unknown[][], fetch: 0 }
    const deps = {
        cacheGet: async () => { calls.get++; return null },
        cacheSet: async (k: string, v: string, t: number) => { calls.set.push([k, v, t]) },
        fetchRows: async () => { calls.fetch++; return rows },
        now: () => NOW,
        ...over,
    }
    return { deps: deps as Parameters<typeof getGatewayStatus>[0], calls }
}

async function main() {
    // 1. cache hit
    const cached = { generatedAt: 'x', networks: [{ key: 'MTN' }] }
    {
        const { deps, calls } = makeDeps({ cacheGet: async () => JSON.stringify(cached) })
        const r = await getGatewayStatus(deps)
        assert(JSON.stringify(r) === JSON.stringify(cached), 'hit returns cached')
        assert(calls.fetch === 0, 'hit does not call fetchRows')
    }
    // 2. miss
    {
        const { deps, calls } = makeDeps()
        const r = await getGatewayStatus(deps)
        assert(calls.fetch === 1, 'miss calls fetchRows once')
        assert(r.networks.length === 5, 'five networks')
        assert(r.generatedAt === NOW.toISOString(), 'generatedAt')
        assert(calls.set.length === 1, 'cacheSet once')
        const [k, v, t] = calls.set[0] as [string, string, number]
        assert(k === 'gateway-status:v1', 'cache key')
        assert(t === 60, 'ttl 60')
        assert(JSON.stringify(JSON.parse(v)) === JSON.stringify(r), 'round trip')
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
    // 5. fetchRows rejects
    {
        const { deps } = makeDeps({ fetchRows: async () => { throw new Error('rpc') } })
        let rejected = false
        try { await getGatewayStatus(deps) } catch { rejected = true }
        assert(rejected, 'rpc error rejects')
    }
    // 6. parsed object accepted
    {
        const full = { generatedAt: 'g', networks: [{ key: 'MTN' }] }
        const { deps, calls } = makeDeps({ cacheGet: async () => full })
        const r = await getGatewayStatus(deps)
        assert(JSON.stringify(r) === JSON.stringify(full) && calls.fetch === 0, 'parsed object accepted')
    }
    // 7. malformed = miss
    for (const bad of ['not json', { foo: 1 }, JSON.stringify({ generatedAt: 'g' }), 42]) {
        const { deps, calls } = makeDeps({ cacheGet: async () => bad })
        const r = await getGatewayStatus(deps)
        assert(calls.fetch === 1 && r.networks.length === 5, `malformed treated as miss: ${String(bad)}`)
    }
    // 8. coerceRpcRows
    {
        assert(coerceRpcRows(null).length === 0 && coerceRpcRows('x').length === 0 && coerceRpcRows({}).length === 0, 'non-array input -> []')
        const out = coerceRpcRows([
            { key: 'MTN', last_placed_at: 5, last_delivered_at: '2026-11-13T09:55:00Z', delivery_minutes: [null, undefined, '', true, '12.5', 'abc', NaN, -3, 0, 7], resolved_count: '4', failed_count: 'x' },
            { key: 'Telecel', delivery_minutes: 'oops', resolved_count: -2, failed_count: 1.9, last_placed_at: null },
            { key: 42, delivery_minutes: [1] },
            null,
            'str',
            { delivery_minutes: [1] },
        ])
        assert(out.length === 2, 'rows without string key / non-objects skipped')
        assert(JSON.stringify(out[0].delivery_minutes) === JSON.stringify([12.5, 0, 7]), `minutes coerced: ${JSON.stringify(out[0].delivery_minutes)}`)
        assert(out[0].resolved_count === 4 && out[0].failed_count === 0, 'counts coerced')
        assert(out[0].last_placed_at === null && out[0].last_delivered_at === '2026-11-13T09:55:00Z', 'timestamps')
        assert(Array.isArray(out[1].delivery_minutes) && out[1].delivery_minutes.length === 0, 'non-array minutes -> []')
        assert(out[1].resolved_count === 0 && out[1].failed_count === 1, 'count floor/negative')
    }
    console.log('gateway-status: all assertions passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
