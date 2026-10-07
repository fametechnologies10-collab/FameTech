// lib/mtn-whitelist-server-check.ts
// -----------------------------------------------------------------------------
// Checks ONE whitelist server directly — Server 1 (AgentPortal) or Server 2
// (Bundle Portal) — for the checker UI and the public per-server endpoints.
// Unlike lib/mtn-whitelist-merge.ts, this never combines suppliers and ignores
// the Bundle Portal admin toggle: it answers "does THIS server know this number".
// The purchase gate keeps using the merged check and is not touched by this file.
//
// Both servers auto-submit a number they report as not allowed to MTN for
// registration, so a check here has that outward side effect on either server.
//
// Caching mirrors lib/mtn-whitelist-gate.ts: PERMANENT allow-cache per (number,
// server) — once confirmed allowed, never re-checked on that server; a blocked
// result is never cached (always re-checked live). A cache read/write failure
// never fails the check — it just falls through to the live call.
// -----------------------------------------------------------------------------
import { createServerClient } from '@/lib/supabase'
import { normalizeMtnMsisdn, verifyMtnWhitelist, type VerifyResponse, type WhitelistResult } from '@/lib/agentportal-whitelist'
import { verifyBundlePortalWhitelist } from '@/lib/bundleportal-whitelist'

export type WhitelistServer = 1 | 2

export function isWhitelistServer(value: unknown): value is WhitelistServer {
    return value === 1 || value === 2
}

/**
 * Maps a supplier's echoed row back to one of the numbers we actually sent (in our 0XXXXXXXXX
 * form). Their echo format isn't guaranteed, so `input` is tried first and `normalized` only as
 * a fallback — and a row that doesn't resolve to a number we sent is ignored, so a malformed
 * response can never mark an unrelated number as allowed (and get it cached permanently).
 */
function canonicalKey(row: WhitelistResult, sent: Set<string>): string | null {
    for (const candidate of [row.input, row.normalized]) {
        const norm = normalizeMtnMsisdn(candidate)
        if (norm.ok && sent.has(norm.msisdn)) return norm.msisdn
    }
    return null
}

/** Pure: stitches cache hits and live results back into input order. Exported for tests. */
export function combineCachedAndLive(
    msisdns: string[],
    cachedAllowed: Set<string>,
    liveResults: WhitelistResult[],
): WhitelistResult[] {
    const sent = new Set(msisdns)
    const liveAllowed = new Map<string, boolean>()
    for (const row of liveResults) {
        const key = canonicalKey(row, sent)
        if (key !== null) liveAllowed.set(key, row.allowed)
    }
    const combined: WhitelistResult[] = []
    for (const msisdn of msisdns) {
        if (cachedAllowed.has(msisdn)) {
            combined.push({ input: msisdn, normalized: msisdn, allowed: true })
        } else if (liveAllowed.has(msisdn)) {
            combined.push({ input: msisdn, normalized: msisdn, allowed: liveAllowed.get(msisdn) === true })
        }
    }
    return combined
}

async function readAllowedCache(server: WhitelistServer, msisdns: string[]): Promise<Set<string>> {
    try {
        const supabase = createServerClient() as any
        const { data } = await supabase
            .from('mtn_whitelist_server_status')
            .select('phone_number')
            .eq('server', server)
            .in('phone_number', msisdns)
        return new Set((data || []).map((r: any) => r.phone_number as string))
    } catch (e) {
        console.error('[mtn-whitelist-server-check] cache read failed, checking live:', e)
        return new Set()
    }
}

async function writeAllowedCache(server: WhitelistServer, msisdns: string[]): Promise<void> {
    if (msisdns.length === 0) return
    try {
        const supabase = createServerClient() as any
        const now = new Date().toISOString()
        await supabase.from('mtn_whitelist_server_status').upsert(
            msisdns.map(phone_number => ({ phone_number, server, status: 'allowed', checked_at: now })),
            { onConflict: 'phone_number,server' },
        )
    } catch (e) {
        console.error('[mtn-whitelist-server-check] cache write failed (ignored):', e)
    }
}

async function verifyLive(server: WhitelistServer, msisdns: string[]): Promise<VerifyResponse> {
    if (server === 1) return verifyMtnWhitelist(msisdns)

    const bp = await verifyBundlePortalWhitelist(msisdns)
    if (bp.error) return { results: [], allowed_count: 0, total: 0, error: bp.error }
    return { results: bp.results, allowed_count: bp.results.filter(r => r.allowed).length, total: bp.results.length }
}

/**
 * Verifies already-normalized MTN numbers against one server, with the per-server
 * permanent allow-cache. Never throws. `.error` is set only when a live call was needed
 * and failed outright; numbers a server silently omitted are dropped, never guessed.
 */
export async function verifyMtnWhitelistServer(server: WhitelistServer, msisdns: string[]): Promise<VerifyResponse> {
    if (msisdns.length === 0) return { results: [], allowed_count: 0, total: 0 }

    const cachedAllowed = await readAllowedCache(server, msisdns)
    const uncached = msisdns.filter(m => !cachedAllowed.has(m))

    let liveResults: WhitelistResult[] = []
    if (uncached.length > 0) {
        const live = await verifyLive(server, uncached)
        if (live.error) return live
        liveResults = live.results
    }

    const results = combineCachedAndLive(msisdns, cachedAllowed, liveResults)
    const newlyAllowed = results.filter(r => r.allowed && !cachedAllowed.has(r.normalized)).map(r => r.normalized)
    await writeAllowedCache(server, newlyAllowed)

    return { results, allowed_count: results.filter(r => r.allowed).length, total: results.length }
}
