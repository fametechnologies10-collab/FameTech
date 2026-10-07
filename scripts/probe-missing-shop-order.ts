/**
 * DIAGNOSTIC — trace missing shop order for Paystack ref SHOP-a402f34f-1783544951270-fb438d18
 * Read-only. Run from project root: npx tsx <path-to-this-file>
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
const REF_CODE = `SHOP-${REF.slice(-10)}`
const GUEST_PHONE = '0550806248'

async function main() {
    const out: Record<string, unknown> = { ref: REF, refCode: REF_CODE }

    // 1. The shop (id starts with a402f34f)
    const { data: shops, error: shopErr } = await db
        .from('shop_profiles')
        .select('id, shop_name, shop_slug, owner_id, fulfillment_mode, oos_networks, paystack_fee_percent')
        .like('id', 'a402f34f%')
    out.shop = shopErr?.message ?? shops

    // 2. shop_orders by reference
    const { data: so, error: soErr } = await db
        .from('shop_orders')
        .select('*')
        .eq('paystack_reference', REF)
    out.shop_order_by_ref = soErr?.message ?? so

    // 3. orders ledger by reference_code
    const { data: ord, error: ordErr } = await db
        .from('orders')
        .select('id, user_id, phone_number, network, size, price, status, reference_code, shop_order_id, created_at')
        .eq('reference_code', REF_CODE)
    out.orders_by_refcode = ordErr?.message ?? ord

    // 4. security_events for this reference (amount mismatch / underwater block)
    const { data: sec, error: secErr } = await db
        .from('security_events')
        .select('*')
        .eq('reference', REF)
    out.security_events = secErr?.message ?? sec

    // 5. Any recent shop_orders for the guest phone (did they retry successfully?)
    const { data: guestOrders, error: gErr } = await db
        .from('shop_orders')
        .select('id, shop_id, guest_phone, network, package_size, selling_price, status, paystack_reference, created_at')
        .eq('guest_phone', GUEST_PHONE)
        .gte('created_at', '2026-07-01')
        .order('created_at', { ascending: false })
    out.guest_recent_shop_orders = gErr?.message ?? guestOrders

    // 6. Current global OOS switch
    const { data: oos } = await db.from('admin_settings').select('value, updated_at').eq('key', 'data_network_stock').maybeSingle()
    out.admin_oos_now = oos

    // 7. Any audit trail of the OOS switch flipping around Jul 8
    const { data: audit, error: auditErr } = await db
        .from('admin_settings_audit')
        .select('*')
        .eq('key', 'data_network_stock')
        .gte('created_at', '2026-07-05')
        .order('created_at', { ascending: false })
        .limit(20)
    out.oos_audit = auditErr?.message ?? audit

    // 8. Shop pricing for MTN 2GB in this shop (does a price row exist?)
    if (shops && shops.length === 1) {
        const shopId = shops[0].id
        const { data: pkgs, error: pkgErr } = await db
            .from('data_packages')
            .select('id, network, size, price, agent_price, dealer_price, cost_price, is_available, category')
            .eq('network', 'MTN')
            .ilike('size', '%2%GB%')
        out.mtn_2gb_packages = pkgErr?.message ?? pkgs

        const { data: sp, error: spErr } = await db
            .from('shop_pricing')
            .select('package_id, selling_price, updated_at')
            .eq('shop_id', shopId)
        out.shop_pricing_all = spErr?.message ?? sp
    }

    console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => { console.error('PROBE FAILED:', e?.message ?? e); process.exit(1) })
