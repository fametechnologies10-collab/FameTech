/**
 * EGRESS — shared, cached reader for `admin_settings`.
 *
 * Measured 2026-09-01: admin_settings GET accounted for 16,570 requests/day —
 * 26% of all REST traffic — because no shared reader existed. 91 files each ran
 * their own fresh `.from('admin_settings')` query on every request that touched
 * them, including four root layouts (app/page.tsx, app/dashboard/layout.tsx,
 * app/admin/layout.tsx, app/auth/layout.tsx) that run on EVERY page view in
 * their section.
 *
 * Pattern mirrors the one already accepted for `isMtnExpressEnabled` in
 * lib/fulfillment-service.ts: an in-memory, per-container-instance cache with a
 * bounded TTL. Same tradeoff, made explicit here too — after an admin changes a
 * setting, a warm serverless instance may serve the old value for up to the
 * TTL in effect for that key. A fresh cold start always reads current.
 * Confirmed acceptable for CRITICAL_TOGGLE_KEYS (fulfillment/signup kill
 * switches included) at the 60s default, matching the existing precedent —
 * see .claude/../CLAUDE.md.
 *
 * Do NOT use this for a value that must be correct within the SAME request as a
 * write to it (e.g. a route that flips a setting and then must immediately act
 * on the new value) — call the DB directly in that one spot instead.
 *
 * TTL is per-call, not global. Both readers accept an optional `ttlMs` (default
 * DEFAULT_TTL_MS = 60s, the accepted bound for CRITICAL_TOGGLE_KEYS / anything
 * an admin might need to change and see take effect quickly). Pure-display
 * content that's edited rarely — footer text, WhatsApp links, terms metadata,
 * landing-page copy — can safely use a longer TTL; see the call sites in
 * app/page.tsx and app/{admin,auth,dashboard}/layout.tsx (2026-09-24: raised
 * to 5 minutes there per explicit product decision, after admin_settings GET
 * was measured at 26,737 req/day, the single largest REST query on the
 * platform). Never do this for fulfillment-routing or money-gating keys
 * (auto_fulfillment_enabled, fulfillment_settings, mtn_*_gate_enabled,
 * mtn_*_fallback, data_network_stock) — those stay on the 60s default or
 * uncached entirely; see lib/mtn-whitelist-gate.ts for why a blind TTL is
 * the wrong tool for a value AgentPortal itself can flip at any moment.
 */
import { createServerClient } from '@/lib/supabase'

const DEFAULT_TTL_MS = 60_000

type CacheEntry = { value: string | null; at: number }
const singleCache = new Map<string, CacheEntry>()

type BatchEntry = { rows: Record<string, string>; at: number }
const batchCache = new Map<string, BatchEntry>()

/** Cache key for a batched fetch — sorted so key order in the caller never matters. */
function batchCacheKey(keys: readonly string[]): string {
    return [...keys].sort().join(',')
}

/**
 * Read a single admin_settings value, cached for `ttlMs` (default 60s) per
 * instance. Returns null if the row doesn't exist or on a read error (matches
 * the `.maybeSingle()` behavior every existing call site already assumed).
 */
export async function getAdminSetting(key: string, ttlMs: number = DEFAULT_TTL_MS): Promise<string | null> {
    const cached = singleCache.get(key)
    if (cached && Date.now() - cached.at < ttlMs) {
        return cached.value
    }

    try {
        const supabase = createServerClient()
        const { data } = await supabase
            .from('admin_settings')
            .select('value')
            .eq('key', key)
            .maybeSingle()

        const value = (data as { value: string } | null)?.value ?? null
        singleCache.set(key, { value, at: Date.now() })
        return value
    } catch (e) {
        console.error(`[admin-settings-cache] read failed for key=${key}:`, e)
        // Serve stale-but-known over a hard failure; genuinely unknown -> null,
        // matching what a fresh maybeSingle() would have returned.
        return cached?.value ?? null
    }
}

/**
 * Batched equivalent of the widespread
 *   .from('admin_settings').select('key, value').in('key', [...])
 * pattern. Cached as one unit per exact key-set for `ttlMs` (default 60s) —
 * callers that always request the same set of keys (the common case: a
 * layout's footer/terms keys) get a single shared cache entry. Pass a longer
 * `ttlMs` for a key-set that's ALL slow-changing display content — never mix
 * a money/routing key into a long-TTL batch.
 */
export async function getAdminSettings(keys: readonly string[], ttlMs: number = DEFAULT_TTL_MS): Promise<Record<string, string>> {
    const cacheKey = batchCacheKey(keys)
    const cached = batchCache.get(cacheKey)
    if (cached && Date.now() - cached.at < ttlMs) {
        return cached.rows
    }

    try {
        const supabase = createServerClient()
        const { data } = await supabase
            .from('admin_settings')
            .select('key, value')
            .in('key', keys as string[])

        const rows: Record<string, string> = {}
        for (const row of (data ?? []) as { key: string; value: string }[]) {
            rows[row.key] = row.value
        }
        batchCache.set(cacheKey, { rows, at: Date.now() })
        return rows
    } catch (e) {
        console.error(`[admin-settings-cache] batch read failed for keys=${cacheKey}:`, e)
        return cached?.rows ?? {}
    }
}
