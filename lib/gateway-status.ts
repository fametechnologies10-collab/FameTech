import { Redis } from '@upstash/redis'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase-admin'
import { shapeGatewayStats, type GatewayNetwork, type RawGatewayRow } from '@/lib/gateway-health'

export interface GatewayStatusResult {
    generatedAt: string
    networks: GatewayNetwork[]
}

export interface GatewayStatusDeps {
    cacheGet: (key: string) => Promise<unknown>
    cacheSet: (key: string, value: string, ttlSeconds: number) => Promise<void>
    fetchRows: () => Promise<RawGatewayRow[]>
    now: () => Date
}

const CACHE_KEY = 'gateway-status:v1'
const CACHE_TTL_SECONDS = 60

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = (REDIS_URL && REDIS_TOKEN) ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null

function toCount(v: unknown): number {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

function toTimestamp(v: unknown): string | null {
    return typeof v === 'string' ? v : null
}

/** Defensively coerce raw RPC output: null/garbage minutes are dropped (never read as 0). */
export function coerceRpcRows(raw: unknown): RawGatewayRow[] {
    if (!Array.isArray(raw)) return []
    const out: RawGatewayRow[] = []
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const r = item as Record<string, unknown>
        if (typeof r.key !== 'string') continue
        const minutes = (Array.isArray(r.delivery_minutes) ? r.delivery_minutes : [])
            .filter((m) => m !== null && m !== undefined && m !== '' && typeof m !== 'boolean')
            .map(Number)
            .filter((n) => Number.isFinite(n) && n >= 0)
        out.push({
            key: r.key,
            last_placed_at: toTimestamp(r.last_placed_at),
            last_delivered_at: toTimestamp(r.last_delivered_at),
            delivery_minutes: minutes,
            resolved_count: toCount(r.resolved_count),
            failed_count: toCount(r.failed_count),
        })
    }
    return out
}

const defaultDeps: GatewayStatusDeps = {
    cacheGet: async (key) => (redis ? redis.get(key) : null),
    cacheSet: async (key, value, ttl) => {
        if (redis) await redis.set(key, value, { ex: ttl })
    },
    fetchRows: async () => {
        // Admin client used deliberately: the RPC returns global aggregates only (no per-user data).
        const admin = createAdminClient() as unknown as Pick<SupabaseClient, 'rpc'>
        const { data, error } = await admin.rpc('get_gateway_delivery_stats')
        if (error) throw new Error(`get_gateway_delivery_stats failed: ${error.message}`)
        return coerceRpcRows(data)
    },
    now: () => new Date(),
}

function parseCached(raw: unknown): GatewayStatusResult | null {
    let value = raw
    if (typeof raw === 'string') {
        try { value = JSON.parse(raw) } catch { return null }
    }
    if (!value || typeof value !== 'object') return null
    const v = value as Partial<GatewayStatusResult>
    if (typeof v.generatedAt !== 'string' || !Array.isArray(v.networks)) return null
    return { generatedAt: v.generatedAt, networks: v.networks }
}

export async function getGatewayStatus(deps?: Partial<GatewayStatusDeps>): Promise<GatewayStatusResult> {
    const d: GatewayStatusDeps = { ...defaultDeps, ...deps }

    try {
        const hit = parseCached(await d.cacheGet(CACHE_KEY))
        if (hit) return hit
    } catch (err) {
        console.warn('[gateway-status] cache read failed', err instanceof Error ? err.message : 'unknown')
    }

    const rows = await d.fetchRows()
    const result: GatewayStatusResult = {
        generatedAt: d.now().toISOString(),
        networks: shapeGatewayStats(rows),
    }

    try {
        await d.cacheSet(CACHE_KEY, JSON.stringify(result), CACHE_TTL_SECONDS)
    } catch (err) {
        console.warn('[gateway-status] cache write failed', err instanceof Error ? err.message : 'unknown')
    }
    return result
}
