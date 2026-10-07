import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { isUtilityBiller, UTILITY_BILLERS, sanitizeAccountInfoForClient } from '@/lib/hubtel-utility/billers'
import { queryUtilityAccount } from '@/lib/hubtel-utility/service'

export const dynamic = 'force-dynamic'

const MAX_INPUT_LEN = 30

/**
 * POST /api/utilities/lookup — name-verification lookup for the utility bills dashboard.
 *
 * SECURITY: Ghana Water's `sessionId` (and any raw provider row that echoes it back under
 * Display "SessionId") must NEVER reach the client — the dispatch pipeline always re-queries
 * a fresh session at pay-time (lib/hubtel-utility/service.ts), so nothing downstream needs the
 * one returned here. `sanitizeAccountInfoForClient` (lib/hubtel-utility/billers.ts) scrubs both
 * the parsed field and the raw array; the storefront guest lookup route reuses the same helper.
 */

export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        // ── Rate limit ───────────────────────────────────────────────────────
        // Runs immediately after auth succeeds, before any DB read — an attacker
        // spamming this route can't burn Supabase reads/RPCs before being throttled.
        const rl = consumeRateLimit(`util-lookup:${authUser.id}`, 10, 60_000)
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

        const { biller, account, phone } = body || {}

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

        // ── Gates (service-role read) ───────────────────────────────────────
        const supabase = createServerClient()
        const { data: settingsRows } = await (supabase.from('admin_settings') as any)
            .select('key, value')
            .in('key', ['utility_bills_enabled', 'hubtel_utility_billers'])

        const settingsMap: Record<string, any> = {}
        for (const s of (settingsRows || [])) settingsMap[s.key] = s.value

        if (settingsMap['utility_bills_enabled'] !== 'true') {
            return NextResponse.json({ success: false, error: 'Utility bill payments are currently unavailable' }, { status: 503 })
        }
        const billersMap = settingsMap['hubtel_utility_billers']
        if (!billersMap || typeof billersMap !== 'object' || Array.isArray(billersMap) || billersMap[biller] !== true) {
            return NextResponse.json({ success: false, error: `${def.label} is currently unavailable` }, { status: 503 })
        }

        // ── Map inputs per biller ───────────────────────────────────────────
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
        console.error('[Utilities Lookup] Unexpected error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
