import { Redis } from '@upstash/redis'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase-admin'
import {
    shapeGatewaySignals,
    type ChannelView,
    type DownSnapshot,
    type GatewaySignalRow,
} from '@/lib/gateway-estimate'

/** Customer-facing payload: never carries any admin-entered reason text. */
export interface GatewayStatusResult {
    generatedAt: string
    serverNow: string
    networks: ChannelView[]
}

export interface GatewayStatusDeps {
    cacheGet: (key: string) => Promise<unknown>
    cacheSet: (key: string, value: string, ttlSeconds: number) => Promise<void>
    fetchSignals: () => Promise<GatewaySignalRow[]>
    now: () => Date
}

const CACHE_KEY = 'gateway-status:v2'
const CACHE_TTL_SECONDS = 20

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = (REDIS_URL && REDIS_TOKEN) ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null

function strOrNull(v: unknown): string | null {
    return typeof v === 'string' ? v : null
}

function coerceSnapshot(v: unknown): DownSnapshot | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const s = v as Record<string, unknown>
    const secs = s.lastSeconds
    if (!(secs === null || (typeof secs === 'number' && Number.isFinite(secs)))) return null
    const placed = s.lastPlacedAt
    const delivered = s.lastDeliveredAt
    if (!(placed === null || typeof placed === 'string')) return null
    if (!(delivered === null || typeof delivered === 'string')) return null
    return { lastSeconds: secs, lastPlacedAt: placed, lastDeliveredAt: delivered }
}

/** Defensively coerce raw RPC output. Never throws; invalid date strings are kept for the pure module to reject. */
export function coerceSignalRows(raw: unknown): GatewaySignalRow[] {
    if (!Array.isArray(raw)) return []
    const out: GatewaySignalRow[] = []
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const r = item as Record<string, unknown>
        if (typeof r.key !== 'string') continue
        out.push({
            key: r.key,
            c_created_at: strOrNull(r.c_created_at),
            c_delivered_at: strOrNull(r.c_delivered_at),
            p_created_at: strOrNull(r.p_created_at),
            is_manually_down: r.is_manually_down === true,
            down_reason: strOrNull(r.down_reason),
            down_since: strOrNull(r.down_since),
            down_snapshot: coerceSnapshot(r.down_snapshot),
        })
    }
    return out
}

export async function fetchGatewaySignals(): Promise<GatewaySignalRow[]> {
    // Admin client used deliberately: the RPC returns global aggregates only (no per-user data).
    const admin = createAdminClient() as unknown as Pick<SupabaseClient, 'rpc'>
    const { data, error } = await admin.rpc('get_gateway_signals')
    if (error) throw new Error(`get_gateway_signals failed: ${error.message}`)
    return coerceSignalRows(data)
}

const defaultDeps: GatewayStatusDeps = {
    cacheGet: async (key) => (redis ? redis.get(key) : null),
    cacheSet: async (key, value, ttl) => {
        if (redis) await redis.set(key, value, { ex: ttl })
    },
    fetchSignals: fetchGatewaySignals,
    now: () => new Date(),
}

const STATES = new Set(['live', 'none', 'down'])

function parseCached(raw: unknown): { generatedAt: string; networks: ChannelView[] } | null {
    let value = raw
    if (typeof raw === 'string') {
        try { value = JSON.parse(raw) } catch { return null }
    }
    if (!value || typeof value !== 'object') return null
    const v = value as { generatedAt?: unknown; networks?: unknown }
    if (typeof v.generatedAt !== 'string' || !Array.isArray(v.networks)) return null
    for (const n of v.networks) {
        if (!n || typeof n !== 'object') return null
        const e = n as { key?: unknown; state?: unknown }
        if (typeof e.key !== 'string' || typeof e.state !== 'string' || !STATES.has(e.state)) return null
    }
    return { generatedAt: v.generatedAt, networks: v.networks as ChannelView[] }
}

export async function getGatewayStatus(deps?: Partial<GatewayStatusDeps>): Promise<GatewayStatusResult> {
    const d: GatewayStatusDeps = { ...defaultDeps, ...deps }
    const now = d.now()
    const serverNow = now.toISOString()

    try {
        const hit = parseCached(await d.cacheGet(CACHE_KEY))
        if (hit) return { generatedAt: hit.generatedAt, serverNow, networks: hit.networks }
    } catch (err) {
        console.warn('[gateway-status] cache read failed', err instanceof Error ? err.message : 'unknown')
    }

    const rows = await d.fetchSignals()
    const generatedAt = serverNow
    const networks = shapeGatewaySignals(rows, now.getTime())

    try {
        await d.cacheSet(CACHE_KEY, JSON.stringify({ generatedAt, networks }), CACHE_TTL_SECONDS)
    } catch (err) {
        console.warn('[gateway-status] cache write failed', err instanceof Error ? err.message : 'unknown')
    }
    return { generatedAt, serverNow, networks }
}

/** Drop the cached payload (e.g. after an admin toggles a gateway) so customers see it immediately. */
export async function invalidateGatewayStatusCache(): Promise<void> {
    if (!redis) return
    try {
        await redis.del(CACHE_KEY)
    } catch (err) {
        console.warn('[gateway-status] cache invalidate failed', err instanceof Error ? err.message : 'unknown')
    }
}
