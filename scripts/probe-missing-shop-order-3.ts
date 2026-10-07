/**
 * DIAGNOSTIC 3 — missing shop order SHOP-a402f34f-1783544951270-fb438d18 (read-only)
 * Pulls the Paystack charge-time metadata snapshot + current DB pricing to diff them.
 * Run: npx tsx scripts/probe-missing-shop-order-3.ts
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
const REF = 'SHOP-a402f34f-1783544951270-fb438d18'
const SHOP_ID = 'a402f34f-fb8d-4677-9fae-cdf676aab351'
const OWNER_ID = '31e9a01c-a517-4d42-93ef-4007b22b6c92'

async function main() {
    const out: Record<string, unknown> = {}

    // 1. Paystack: full transaction verify (charge-time metadata snapshot)
    const key = process.env.PAYSTACK_SECRET_KEY
    if (key) {
        const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(REF)}`, {
            headers: { Authorization: `Bearer ${key}` },
        })
        const j: any = await res.json().catch(() => null)
        out.paystack_verify = j?.data ? {
            status: j.data.status,
            amount: j.data.amount,
            paid_at: j.data.paid_at,
            channel: j.data.channel,
            metadata: j.data.metadata,
            log_history_ct: j.data?.log?.history?.length,
        } : j
    } else {
        out.paystack_verify = 'NO PAYSTACK_SECRET_KEY in .env.local'
    }

    // 2. Owner user row — capture the error this time
    const { data: owner, error: ownerErr } = await db
        .from('users')
        .select('id, email, role, agent_expires_at, dealer_expires_at, is_suspended')
        .eq('id', OWNER_ID)
        .maybeSingle()
    out.owner = { data: owner, error: ownerErr?.message ?? null }

    // 3. This shop's pricing rows + package info
    const { data: pricing, error: prErr } = await db
        .from('shop_pricing')
        .select('package_id, selling_price, data_packages(id, network, size, price, agent_price, dealer_price, cost_price, is_available)')
        .eq('shop_id', SHOP_ID)
    out.shop_pricing = prErr?.message ?? pricing

    // 4. Global paystack fee settings
    const { data: fees } = await db
        .from('shop_global_settings')
        .select('key, value')
        .like('key', 'shop_paystack_fee_percent%')
    out.paystack_fee_settings = fees

    // 5. This shop's order history — last 30 days (was it ever working?)
    const { data: hist, error: histErr } = await db
        .from('shop_orders')
        .select('id, guest_phone, network, package_size, selling_price, profit, status, paystack_reference, created_at')
        .eq('shop_id', SHOP_ID)
        .gte('created_at', '2026-06-09')
        .order('created_at', { ascending: false })
        .limit(15)
    out.shop_order_history = histErr?.message ?? hist

    console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => { console.error('PROBE FAILED:', e?.message ?? e); process.exit(1) })
