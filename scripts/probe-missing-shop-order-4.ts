/**
 * DIAGNOSTIC 4 — owner role + env key mode (read-only, prints NO secrets)
 * Run: npx tsx scripts/probe-missing-shop-order-4.ts
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m || process.env[m[1]] !== undefined) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function main() {
    const out: Record<string, unknown> = {}

    const psk = process.env.PAYSTACK_SECRET_KEY || ''
    out.paystack_key_mode = psk ? psk.slice(0, 8) + '…(' + psk.length + ' chars)' : 'MISSING'

    const { data: owner, error: ownerErr } = await db
        .from('users')
        .select('id, email, role, agent_expires_at, dealer_expires_at')
        .eq('id', '31e9a01c-a517-4d42-93ef-4007b22b6c92')
        .maybeSingle()
    out.owner = { data: owner, error: ownerErr?.message ?? null }

    console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => { console.error('PROBE FAILED:', e?.message ?? e); process.exit(1) })
