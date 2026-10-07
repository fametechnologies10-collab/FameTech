import { NextRequest, NextResponse } from 'next/server'
import { getClientIp } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { isUtilityBiller, UTILITY_BILLERS, sanitizeAccountInfoForClient } from '@/lib/hubtel-utility/billers'
import { queryUtilityAccount } from '@/lib/hubtel-utility/service'

export const dynamic = 'force-dynamic'

const MAX_INPUT_LEN = 30

/**
 * POST /api/shop/utility/lookup — guest name-verification lookup for storefront utility
 * bill purchases (no auth). Structurally a guest-facing sibling of
 * app/api/utilities/lookup/route.ts (the dashboard lookup route): same per-biller
 * destination/mobile mapping, same queryUtilityAccount call, same
 * sanitizeAccountInfoForClient scrub — with a shop-resolution + shop-gate layer in front,
 * mirroring the RC storefront pair's shop-resolution conventions
 * (app/api/shop/results-checker/charge/route.ts).
 *
 * Gate chain: utility_bills_enabled + storefront_utilities_enabled (global) →
 * hubtel_utility_billers[biller] (per-biller) → shop resolved + approved + active →
 * shop_profiles.utilities_enabled (per-shop opt-out).
 */
export async function POST(request: NextRequest) {
    try {
        // ── Rate limit (guest, IP-scoped) — first statement, matching the charge route ──
        const ip = getClientIp(request) || 'unknown'
        const rl = consumeRateLimit(`util-sf-lookup:${ip}`, 6, 60_000)
        if (!rl.allowed) {
            return NextResponse.json(
                { success: false, error: `Too many lookups. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` },
                { status: 429 },
            )
        }

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
        }

        const { shopSlug, biller, account, phone } = body || {}

        if (typeof shopSlug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(shopSlug)) {
            return NextResponse.json({ success: false, error: 'Invalid shop identifier' }, { status: 400 })
        }
        if (!isUtilityBiller(biller)) {
            return NextResponse.json({ success: false, error: 'Invalid biller' }, { status: 400 })
        }
        const def = UTILITY_BILLERS[biller]

        const trimmedAccount = typeof account === 'string' ? account.trim() : ''
        if (!trimmedAccount) {
            return NextResponse.json({ success: false, error: `${def.accountLabel} is required` }, { status: 400 })
        }
        if (trimmedAccount.length > MAX_INPUT_LEN) {
            return NextResponse.json({ success: false, error: `${def.accountLabel} is too long` }, { status: 400 })
        }

        const trimmedPhone = typeof phone === 'string' ? phone.trim() : ''
        if (trimmedPhone.length > MAX_INPUT_LEN) {
            return NextResponse.json({ success: false, error: 'Phone number is too long' }, { status: 400 })
        }
        if (biller === 'ghana_water' && !trimmedPhone) {
            return NextResponse.json({ success: false, error: 'Phone number is required for Ghana Water lookup' }, { status: 400 })
        }

        // ── Shop resolve + active check (service-role read) ─────────────────
        const { createServerClient } = await import('@/lib/supabase')
        const db = createServerClient() as any

        const { data: shop, error: shopError } = await db
            .from('shop_profiles')
            .select('id, shop_name, owner_id, approval_status, is_active, utilities_enabled, owner:users!shop_profiles_owner_id_fkey(role)')
            .eq('shop_slug', shopSlug)
            .single()
        if (shopError || !shop) return NextResponse.json({ success: false, error: 'Shop not found' }, { status: 404 })

        const rawOwnerRole: string = shop.owner?.role || 'customer'
        if (shop.approval_status !== 'approved' || !shop.is_active || !['customer', 'agent', 'dealer', 'subagent', 'admin', 'sub-admin'].includes(rawOwnerRole)) {
            return NextResponse.json({ success: false, error: 'This shop is not currently active' }, { status: 403 })
        }
        // Per-shop opt-out (owner-controlled toggle) — 403, matching computeShopCheckout's
        // equivalent gate in lib/shop-checkout.ts (not the 503 used for global admin gates).
        if (shop.utilities_enabled !== true) {
            return NextResponse.json({ success: false, error: 'This service is not available in this shop' }, { status: 403 })
        }

        // ── Gates (service-role read) ────────────────────────────────────────
        const { data: settingsRows } = await db
            .from('admin_settings')
            .select('key, value')
            .in('key', ['utility_bills_enabled', 'storefront_utilities_enabled', 'hubtel_utility_billers'])
        const settingsMap: Record<string, any> = {}
        for (const s of (settingsRows || [])) settingsMap[s.key] = s.value

        if (settingsMap['utility_bills_enabled'] !== 'true' || settingsMap['storefront_utilities_enabled'] !== 'true') {
            return NextResponse.json({ success: false, error: 'Utility bill payments are currently unavailable' }, { status: 503 })
        }
        const billersMap = settingsMap['hubtel_utility_billers']
        if (!billersMap || typeof billersMap !== 'object' || Array.isArray(billersMap) || billersMap[biller] !== true) {
            return NextResponse.json({ success: false, error: `${def.label} is currently unavailable` }, { status: 503 })
        }

        // ── Map inputs per biller (identical to app/api/utilities/lookup/route.ts) ───
        // ecg: queries BY PHONE — prefer the explicit phone field, falling back to
        // `account` (the UI's generic identifier field may carry the phone for ECG).
        // ghana_water: destination = meter (account), mobile = phone (validated above).
        // dstv/gotv/startimes: destination = account (smartcard/account number).
        let destination: string
        let mobile: string | undefined
        if (biller === 'ecg') {
            destination = trimmedPhone || trimmedAccount
        } else if (biller === 'ghana_water') {
            destination = trimmedAccount
            mobile = trimmedPhone
        } else {
            destination = trimmedAccount
        }

        const result = await queryUtilityAccount(biller, destination, mobile)

        if (!result.success) {
            if (result.isRateLimited || result.isNetworkError) {
                return NextResponse.json(
                    { success: false, error: 'Could not reach the billing provider — please try again shortly' },
                    { status: 502 },
                )
            }
            // Business failure (bad account/meter number etc.) — 200 so the UI can show it inline.
            return NextResponse.json({ success: false, error: result.error || 'Account not found — check the number' })
        }

        return NextResponse.json({ success: true, data: sanitizeAccountInfoForClient(result.info!) })
    } catch (error) {
        console.error('[Shop Utility Lookup] Unexpected error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
