import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { getAdminSettings } from '@/lib/admin-settings-cache'

const PAGE_ACCESS_KEYS = [
    'page_access_dashboard',
    'page_access_data_packages',
    'page_access_orders',
    'page_access_wallet',
    'page_access_complaints',
    'page_access_notifications',
    'page_access_profile',
    'page_access_shop',
    'page_access_storefront',
    'page_access_airtime',
    'page_access_results_checker',  // Fixed: was 'results_checker_enabled' (wrong key)
    'page_access_upgrade',          // NEW: Membership/Upgrade page
    'page_access_transactions',     // NEW: Transactions page
    'page_access_afa_orders',       // NEW: AFA Application page
    'page_access_recruit',          // NEW: Sub-Agents (recruit) page
    'page_access_commission',       // NEW: Commission Wallet page
    'page_access_sms',              // NEW: SMS Platform page
    'page_access_developer_api',    // NEW: Developer API page
] as const

export async function GET(request: NextRequest) {
    try {
        // ── Priority 3 security fix: require an active session ────
        // Page-access flags are internal configuration — only authenticated
        // users (any role) should be able to read them.
        const cookieStore = await cookies()
        const supabaseUser = await createRouteClient()
        const { data: { user }, error: authError } = await supabaseUser.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // ── Fetch page-access flags (shared 60s cache) ─────────────
        // PERF (2026-09-27): ~1,600 reads/day on every dashboard load. On a read
        // error the cache serves the last known flags, or {} — which the client
        // (hooks/use-page-access.ts) treats exactly like its own error fallback:
        // every page accessible.
        const settingsMap = await getAdminSettings(PAGE_ACCESS_KEYS)

        return NextResponse.json(settingsMap)
    } catch (error) {
        console.error('Error in page-access API:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
