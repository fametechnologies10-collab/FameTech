/**
 * DIAGNOSTIC 2 — missing shop order SHOP-a402f34f-1783544951270-fb438d18 (read-only)
 * Run: npx tsx scripts/probe-missing-shop-order-2.ts
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

    // 1. Shop by name (id starts a402f34f per the Paystack ref)
    const { data: shop, error: shopErr } = await db
        .from('shop_profiles')
        .select('id, shop_name, shop_slug, owner_id, fulfillment_mode, oos_networks, paystack_fee_percent, created_at')
        .ilike('shop_name', '%SpecialDataHub%')
    out.shop = shopErr?.message ?? shop
    const s = Array.isArray(shop) && shop.length ? shop[0] as any : null

    if (s) {
        // 2. Owner user + role (role determines cost + fee tier)
        const { data: owner } = await db
            .from('users')
            .select('id, email, phone, role, agent_expires_at, dealer_expires_at')
            .eq('id', s.owner_id).maybeSingle()
        out.owner = owner

        // 3. This shop's pricing rows joined to packages — look for MTN 2GB + updated_at
        const { data: pricing, error: prErr } = await db
            .from('shop_pricing')
            .select('package_id, selling_price, updated_at, created_at, data_packages(network, size, price, agent_price, dealer_price, cost_price, is_available)')
            .eq('shop_id', s.id)
        out.shop_pricing = prErr?.message ?? pricing
    }

    // 4. Pipeline health: platform-wide shop orders Jul 8 18:00 → Jul 9 06:00 UTC
    const { data: nearby, error: nbErr } = await db
        .from('shop_orders')
        .select('id, shop_id, network, package_size, selling_price, status, paystack_reference, created_at')
        .gte('created_at', '2026-07-08T18:00:00Z')
        .lte('created_at', '2026-07-09T06:00:00Z')
        .order('created_at', { ascending: true })
    out.shop_orders_that_evening = nbErr?.message ?? nearby

    // 5. admin_settings_audit shape + any data_network_stock changes
    const { data: audit, error: aErr } = await db
        .from('admin_settings_audit')
        .select('*')
        .eq('key', 'data_network_stock')
        .limit(10)
    out.oos_audit = aErr?.message ?? audit

    console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => { console.error('PROBE FAILED:', e?.message ?? e); process.exit(1) })
