/**
 * One-time re-verification of saved shop payout accounts (shop_payment_details).
 *
 * Why: until 2026-09-25 owners could insert/update these rows straight from the
 * browser, yet /api/shop/withdraw trusts a saved row's account_name as already
 * provider-verified (it skips the name lookup for a savedDetailId). Rows created
 * before that fix were never guaranteed to be verified — nothing records which were.
 * This script looks each saved number up with the same provider chain the app uses
 * (lib/momo-verify resolveNameSingle) and compares it with the stored name.
 *
 *   - READ-ONLY. It never writes to the database.
 *   - Console output is masked (last 4 digits, no names). The full detail (with
 *     names) is written to --out (default: the OS temp dir) — never inside the repo.
 *   - Makes one live provider lookup per row, sequentially, with a small delay.
 *
 * Usage (from the repo root, which holds .env.local — or set ENV_FILE):
 *   npx tsx scripts/reverify-saved-payout-accounts.ts [--out <file.json>]
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createClient } from '@supabase/supabase-js'

for (const line of readFileSync(process.env.ENV_FILE || '.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m || process.env[m[1]] !== undefined) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
}

type Verdict = 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'UNRESOLVED'

/** Uppercase letter-only tokens, ignoring 1-letter initials. */
function nameTokens(name: string): Set<string> {
    return new Set(
        name.toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(t => t.length > 1)
    )
}

/**
 * MATCH    — every stored token appears in the provider name, or vice versa
 *            (tolerates word order and extra/missing middle names).
 * PARTIAL  — at least one shared token (e.g. surname matches, first name differs).
 * MISMATCH — no shared token.
 */
export function compareNames(stored: string, resolved: string): Exclude<Verdict, 'UNRESOLVED'> {
    const a = nameTokens(stored)
    const b = nameTokens(resolved)
    if (a.size === 0 || b.size === 0) return 'MISMATCH'
    const shared = [...a].filter(t => b.has(t)).length
    if (shared === a.size || shared === b.size) return 'MATCH'
    return shared > 0 ? 'PARTIAL' : 'MISMATCH'
}

const outIdx = process.argv.indexOf('--out')
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : join(tmpdir(), `payout-reverify-${Date.now()}.json`)
const mask = (n: string | null | undefined) => (n ? `***${String(n).slice(-4)}` : '-')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
    // Imported after .env.local is loaded — these modules read env at import time.
    const { resolveNameSingle } = await import('@/lib/momo-verify')
    const { normalizeGhanaPhone } = await import('@/lib/sms-service')

    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data: rows, error } = await db
        .from('shop_payment_details')
        .select('id, shop_owner_id, account_name, momo_number, network, payment_type, created_at')
        .order('created_at', { ascending: true })
    if (error) throw error

    console.log(`--- READ-ONLY: re-verifying ${rows!.length} saved payout accounts. Nothing is written. ---`)
    const detail: any[] = []
    const counts: Record<Verdict, number> = { MATCH: 0, PARTIAL: 0, MISMATCH: 0, UNRESOLVED: 0 }

    for (const r of rows as any[]) {
        const normalized = normalizeGhanaPhone(r.momo_number)
        const resolved = normalized ? await resolveNameSingle(normalized) : null
        const verdict: Verdict = resolved?.fullName ? compareNames(r.account_name, resolved.fullName) : 'UNRESOLVED'
        counts[verdict]++
        detail.push({
            id: r.id, shop_owner_id: r.shop_owner_id, network: r.network, created_at: r.created_at,
            momo_number: r.momo_number, stored_name: r.account_name,
            provider_name: resolved?.fullName ?? null, provider: resolved?.provider ?? null, verdict,
        })
        if (verdict !== 'MATCH') {
            console.log(`${verdict.padEnd(10)} row ${String(r.id).slice(0, 8)} owner ${String(r.shop_owner_id).slice(0, 8)} ${r.network} ${mask(r.momo_number)}`)
        }
        await sleep(300)
    }

    writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), counts, rows: detail }, null, 2))
    console.log(`\nSummary: ${JSON.stringify(counts)}`)
    console.log(`Full detail (contains names — keep private): ${OUT}`)
}

main().catch(err => { console.error('reverify failed:', err); process.exit(1) })
