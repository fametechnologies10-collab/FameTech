// lib/mtn-whitelist-merge.ts
// -----------------------------------------------------------------------------
// The whitelist verdict the PURCHASE GATE enforces, also returned by the merged
// checker route and the public merged /api/v2/data/verify-number endpoint (so a
// developer's checkout check can never disagree with what /data/purchase does).
//
// Which servers are consulted is decided by the two admin toggles:
//   mtn_agentportal_whitelist_gate_enabled   -> Server 1 is an ACTIVE server
//   mtn_bundleportal_whitelist_gate_enabled  -> Server 2 is an ACTIVE server
//   neither on                               -> the gate is off; nothing is blocked
// A number is allowed when it is registered on ANY active server, and blocked only
// when EVERY active server answered and said no. If an active server could not answer
// for a number, that number is left out of the results (the callers fail open on a
// missing row) — a verdict is never guessed.
//
// Active servers are checked in order (1, then 2); a later server is only asked about
// numbers the earlier ones did not confirm. Each per-server check has its own
// permanent allow-cache (lib/mtn-whitelist-server-check.ts), so a number cached as
// allowed on one server can never satisfy the gate on a different one.
// -----------------------------------------------------------------------------
import { createServerClient } from '@/lib/supabase'
import type { VerifyResponse, WhitelistResult } from '@/lib/agentportal-whitelist'
import { verifyMtnWhitelistServer, type WhitelistServer } from '@/lib/mtn-whitelist-server-check'

export const SERVER_1_GATE_KEY = 'mtn_agentportal_whitelist_gate_enabled'
export const SERVER_2_GATE_KEY = 'mtn_bundleportal_whitelist_gate_enabled'
const GATE_CACHE_MS = 60_000

let enabledCache: { value: WhitelistServer[]; at: number } | null = null

const isOn = (v: unknown) => v === true || v === 'true'

/** Active whitelist servers per the admin toggles (60s cache; on a read failure keeps the last known value, else none). */
export async function getEnabledWhitelistServers(): Promise<WhitelistServer[]> {
    const now = Date.now()
    if (enabledCache && now - enabledCache.at < GATE_CACHE_MS) return enabledCache.value
    try {
        const supabase = createServerClient()
        const { data, error } = await (supabase.from('admin_settings') as any)
            .select('key, value')
            .in('key', [SERVER_1_GATE_KEY, SERVER_2_GATE_KEY])
        // supabase-js reports query failures in `error` instead of throwing. Treating that as
        // "no rows" would cache "gate off" and overwrite a good last-known value.
        if (error) throw error
        const byKey = new Map<string, unknown>(((data as any[]) || []).map(r => [r.key, r.value]))
        const enabled: WhitelistServer[] = []
        if (isOn(byKey.get(SERVER_1_GATE_KEY))) enabled.push(1)
        if (isOn(byKey.get(SERVER_2_GATE_KEY))) enabled.push(2)
        enabledCache = { value: enabled, at: now }
        return enabled
    } catch (e) {
        console.error('[mtn-whitelist-merge] failed to read whitelist toggles:', e)
        return enabledCache?.value ?? []
    }
}

/**
 * Pure verdict rule — exported for unit tests. `verdicts[i]` is what active server i said:
 * a map of number -> allowed, or null when that server could not answer at all. Later servers
 * are only asked about numbers earlier ones did not allow, so a missing entry is not an answer.
 */
export function combineServerVerdicts(msisdns: string[], verdicts: Array<Map<string, boolean> | null>): WhitelistResult[] {
    const results: WhitelistResult[] = []
    for (const msisdn of msisdns) {
        const anyAllowed = verdicts.some(v => v?.get(msisdn) === true)
        const everyDenied = verdicts.length > 0 && verdicts.every(v => v?.get(msisdn) === false)
        if (anyAllowed) results.push({ input: msisdn, normalized: msisdn, allowed: true })
        else if (everyDenied) results.push({ input: msisdn, normalized: msisdn, allowed: false })
    }
    return results
}

const summarize = (results: WhitelistResult[]): VerifyResponse => ({
    results,
    allowed_count: results.filter(r => r.allowed).length,
    total: results.length,
})

/**
 * Verifies already-normalized MTN numbers against the ACTIVE whitelist server(s). Never throws.
 * With no active server the gate is off, so every number is reported allowed (nothing can block it).
 */
export async function verifyMtnWhitelistMerged(msisdns: string[]): Promise<VerifyResponse> {
    if (msisdns.length === 0) return summarize([])

    const enabled = await getEnabledWhitelistServers()
    if (enabled.length === 0) {
        return summarize(msisdns.map(m => ({ input: m, normalized: m, allowed: true })))
    }

    const verdicts: Array<Map<string, boolean> | null> = []
    let remaining = msisdns
    let firstError: string | undefined

    for (const server of enabled) {
        if (remaining.length === 0) {
            verdicts.push(new Map())
            continue
        }
        const response = await verifyMtnWhitelistServer(server, remaining)
        if (response.error) {
            verdicts.push(null)
            firstError ??= response.error
            continue
        }
        const verdict = new Map<string, boolean>(response.results.map(r => [r.normalized, r.allowed]))
        verdicts.push(verdict)
        remaining = remaining.filter(m => verdict.get(m) !== true)
    }

    const results = combineServerVerdicts(msisdns, verdicts)
    if (results.length === 0 && firstError) {
        return { results: [], allowed_count: 0, total: 0, error: firstError }
    }
    return summarize(results)
}
