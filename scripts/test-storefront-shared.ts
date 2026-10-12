// Pure-logic test for the storefront shared helpers + trusted guest IP extraction.
// Run: npx tsx scripts/test-storefront-shared.ts
import { toClientShop, isShopLive, resolveUtilityStorefrontConfig } from '../lib/storefront-shared'
import { getGuestIp } from '../lib/client-ip'

let failed = 0
function check(name: string, ok: boolean) {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

// ── toClientShop: allowlist, never a row spread ───────────────────────────────
const row = {
    id: 'shop-1', shop_name: 'Kofi Data', shop_slug: 'kofi-data', description: 'd', owner_phone: '0241234567',
    owner_email: 'o@x.com', whatsapp_number: '233241234567', logo_url: null, community_link: null, divider_style: null,
    brand_color: '#2563eb', brand_accent: '#111111', airtime_fee_mtn: 1, airtime_fee_telecel: 1, airtime_fee_at: 1,
    mashup_fee_percent: 1, ussd_code: 'ABCD', ussd_active: true, afa_selling_price: 10, paystack_fee_percent: null,
    // server-only columns that must never reach the browser
    owner_id: 'uuid-owner', approval_status: 'approved', pricing_status: 'approved', is_active: true,
    results_checker_markup_customer: 3, oos_networks: ['MTN'], utilities_enabled: true, fulfillment_mode: 'auto',
    withdrawal_fee_percent: 1, min_withdrawal_amount: 5,
}
const client = toClientShop(row, 'agent') as unknown as Record<string, unknown>
for (const k of ['owner_id', 'approval_status', 'pricing_status', 'is_active', 'results_checker_markup_customer', 'oos_networks', 'utilities_enabled', 'fulfillment_mode', 'withdrawal_fee_percent', 'min_withdrawal_amount']) {
    check(`toClientShop omits ${k}`, !(k in client))
}
check('toClientShop keeps displayed contact + branding', client.owner_phone === '0241234567' && client.brand_color === '#2563eb' && client.shop_slug === 'kofi-data')
check('toClientShop carries ownerRole', client.ownerRole === 'agent')

// ── isShopLive ────────────────────────────────────────────────────────────────
check('live: approved + active', isShopLive({ approval_status: 'approved', is_active: true }))
check('not live: approved but inactive', !isShopLive({ approval_status: 'approved', is_active: false }))
check('not live: pending', !isShopLive({ approval_status: 'pending', is_active: true }))
check('not live: suspended', !isShopLive({ approval_status: 'suspended', is_active: true }))
check('not live: null', !isShopLive(null))

// ── resolveUtilityStorefrontConfig ────────────────────────────────────────────
const base = { utility_bills_enabled: 'true', storefront_utilities_enabled: 'true', hubtel_utility_billers: { ecg: true } as Record<string, boolean>, utility_min_amount: '2', utility_max_amount: '500' }
check('utilities on when all gates open', resolveUtilityStorefrontConfig(base, true).utilitiesEnabled === true)
check('utilities off when shop opted out', resolveUtilityStorefrontConfig(base, false).utilitiesEnabled === false)
check('utilities off when global flag off', resolveUtilityStorefrontConfig({ ...base, utility_bills_enabled: 'false' }, true).utilitiesEnabled === false)
check('utilities off when no biller enabled', resolveUtilityStorefrontConfig({ ...base, hubtel_utility_billers: {} }, true).utilitiesEnabled === false)
check('utilities off when biller map malformed', resolveUtilityStorefrontConfig({ ...base, hubtel_utility_billers: ['ecg'] as any }, true).utilitiesEnabled === false)
const cfg = resolveUtilityStorefrontConfig(base, true)
check('min/max parsed from settings', cfg.utilityMinAmount === 2 && cfg.utilityMaxAmount === 500)
check('ecg biller flagged enabled', cfg.enabledUtilityBillers.ecg === true)

// ── getGuestIp: never trust the caller-controlled leftmost XFF hop ────────────
const req = (h: Record<string, string>) => new Request('http://localhost/x', { headers: h })
check('x-real-ip wins', getGuestIp(req({ 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '9.9.9.9, 2.2.2.2' })) === '1.1.1.1')
check('xff rightmost hop (not leftmost forged)', getGuestIp(req({ 'x-forwarded-for': '6.6.6.6, 2.2.2.2' })) === '2.2.2.2')
check('forged leftmost cannot rotate the key', getGuestIp(req({ 'x-forwarded-for': '1.2.3.4, 2.2.2.2' })) === getGuestIp(req({ 'x-forwarded-for': '5.6.7.8, 2.2.2.2' })))
check('no headers → unknown', getGuestIp(req({})) === 'unknown')

if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
}
console.log('\nAll storefront-shared checks passed')
