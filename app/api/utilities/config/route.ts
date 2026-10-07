import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { parseSettingNumber } from '@/lib/paystack-fees'
import { UTILITY_BILLER_KEYS, type UtilityBiller } from '@/lib/hubtel-utility/billers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/utilities/config — dashboard gate + amount-limit config for the
 * Utility Bills page (feature flag, per-biller availability, min/max amount).
 *
 * Auth'd (not public) — mirrors the exact settings keys read by
 * /api/utilities/lookup and /api/utilities/create so the page can never show
 * a biller as "on" when the mutating routes would reject it, or vice versa.
 */
export async function GET() {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const rl = consumeRateLimit(`util-config:${user.id}`, 30, 60_000)
        if (!rl.allowed) {
            return NextResponse.json(
                { success: false, error: 'Too many requests. Try again shortly.' },
                { status: 429 },
            )
        }

        const supabase = createServerClient()
        const { data: settingsRows, error } = await (supabase.from('admin_settings') as any)
            .select('key, value')
            .in('key', ['utility_bills_enabled', 'hubtel_utility_billers', 'utility_min_amount', 'utility_max_amount'])

        if (error) {
            console.error('[Utilities Config] DB error:', error)
            return NextResponse.json({ success: false, error: 'Failed to load configuration' }, { status: 500 })
        }

        const settingsMap: Record<string, any> = {}
        for (const s of (settingsRows || [])) settingsMap[s.key] = s.value

        const enabled = settingsMap['utility_bills_enabled'] === 'true'

        const billersRaw = settingsMap['hubtel_utility_billers']
        const billers = {} as Record<UtilityBiller, boolean>
        for (const key of UTILITY_BILLER_KEYS) {
            billers[key] = !!(
                billersRaw &&
                typeof billersRaw === 'object' &&
                !Array.isArray(billersRaw) &&
                billersRaw[key] === true
            )
        }

        const minAmount = parseSettingNumber(settingsMap['utility_min_amount'], 1)
        const maxAmount = parseSettingNumber(settingsMap['utility_max_amount'], 1000)

        return NextResponse.json({
            success: true,
            data: { enabled, billers, minAmount, maxAmount },
        })
    } catch (error) {
        console.error('[Utilities Config] Unexpected error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
