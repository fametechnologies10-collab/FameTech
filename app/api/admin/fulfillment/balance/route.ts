import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { fetchSupplierBalance } from '@/lib/fulfillment-service'

export async function GET(request: NextRequest) {
    try {
        // 1. Authenticate user
        const supabase = await createRouteClient()
        const { data: { user: authUser } } = await supabase.auth.getUser()

        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // 2. Verify admin role
        const { data: userData } = await supabase
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (userData?.role !== 'admin') {
            return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
        }

        // 3. Handle individual supplier fetch
        const supplier = new URL(request.url).searchParams.get('supplier')

        if (supplier === 'datakazina') {
            const result = await fetchSupplierBalance()
            if (!result.success) {
                return NextResponse.json({ error: result.error || 'Failed to fetch DataKazina balance' }, { status: 502 })
            }
            return NextResponse.json({ balance: result.balance || 0, currency: result.currency || 'GHS' })
        }
        if (supplier === 'codecraft') {
            const { fetchSupplierBalance: fetchCC } = await import('@/lib/codecraft-service')
            const result = await fetchCC()
            if (!result.success) {
                return NextResponse.json({ error: result.error || 'Failed to fetch CodeCraft balance' }, { status: 502 })
            }
            return NextResponse.json({ codecraft_balance: result.balance || 0, codecraft_currency: result.currency || 'GHS' })
        }
        if (supplier === 'xpress') {
            const { fetchSupplierBalance: fetchXP } = await import('@/lib/xpress-service')
            const result = await fetchXP()
            if (!result.success) {
                return NextResponse.json({ error: result.error || 'Failed to fetch Xpress balance' }, { status: 502 })
            }
            return NextResponse.json({ xpress_balance: result.balance || 0, xpress_currency: result.currency || 'GHS' })
        }
        if (supplier === 'ghdata') {
            const { fetchGhDataBalance } = await import('@/lib/ghdata-service')
            const result = await fetchGhDataBalance()
            if (!result.success) {
                return NextResponse.json({ error: result.error || 'Failed to fetch GhData balance' }, { status: 502 })
            }
            return NextResponse.json({ ghdata_balance: result.balance || 0, ghdata_currency: result.currency || 'GHS' })
        }
        if (supplier === 'agentportal') {
            const { fetchSupplierBalance: fetchAP } = await import('@/lib/agentportal-service')
            const result = await fetchAP()
            if (!result.success) {
                return NextResponse.json({ error: result.error || 'Failed to fetch AgentPortal balance' }, { status: 502 })
            }
            return NextResponse.json({ agentportal_balance: result.balance || 0, agentportal_currency: result.currency || 'GHS' })
        }
        if (supplier === 'bundleportal') {
            const { fetchSupplierBalance: fetchBP } = await import('@/lib/bundleportal-service')
            const result = await fetchBP()
            if (!result.success) {
                return NextResponse.json({ error: result.error || 'Failed to fetch Bundle Portal balance' }, { status: 502 })
            }
            return NextResponse.json({ bundleportal_balance: result.balance || 0, bundleportal_currency: result.currency || 'GHS' })
        }
        if (supplier === 'hendylinks') {
            const { fetchSupplierBalance: fetchHL } = await import('@/lib/hendylinks-service')
            const result = await fetchHL()
            if (!result.success) {
                return NextResponse.json({ error: result.error || 'Failed to fetch HendyLinks balance' }, { status: 502 })
            }
            return NextResponse.json({ hendylinks_balance: result.balance || 0, hendylinks_currency: result.currency || 'GHS' })
        }
        if (supplier === 'spfastit') {
            const { fetchSupplierBalance: fetchSF } = await import('@/lib/spfastit-service')
            const result = await fetchSF()
            if (!result.success) {
                return NextResponse.json({ error: result.error || 'Failed to fetch SPFastIT balance' }, { status: 502 })
            }
            return NextResponse.json({ spfastit_balance: result.balance || 0, spfastit_currency: result.currency || 'GHS' })
        }
        if (supplier === 'atishare_console') {
            const { fetchConsoleBalance } = await import('@/lib/atishare-console-service')
            const result = await fetchConsoleBalance()
            if (!result.success) {
                return NextResponse.json({ error: result.error || 'Failed to fetch AT-iShare Console balance' }, { status: 502 })
            }
            // This supplier is denominated in DATA, not currency. Deliberately NOT mapped
            // into the { balance, currency } shape the other suppliers use — the admin UI
            // renders that shape as money, so 95 GB would display as "GHS 95".
            return NextResponse.json({
                atishare_console_wallet_mb: result.walletMb ?? 0,
                atishare_console_reserved_mb: result.reservedMb ?? 0,
                atishare_console_available_mb: result.availableMb ?? 0,
            })
        }

        // 4. Fetch balances from all suppliers concurrently
        const { fetchSupplierBalance: fetchCodeCraftBalance } = await import('@/lib/codecraft-service')
        const { fetchSupplierBalance: fetchXpressBalance } = await import('@/lib/xpress-service')
        const { fetchGhDataBalance } = await import('@/lib/ghdata-service')
        const { fetchSupplierBalance: fetchAgentPortalBalance } = await import('@/lib/agentportal-service')
        const { fetchSupplierBalance: fetchBundlePortalBalance } = await import('@/lib/bundleportal-service')
        const { fetchSupplierBalance: fetchHendyLinksBalance } = await import('@/lib/hendylinks-service')
        const { fetchSupplierBalance: fetchSpfastitBalance } = await import('@/lib/spfastit-service')

        const [dakazinaResult, codecraftResult, xpressResult, ghdataResult, agentportalResult, bundleportalResult, hendylinksResult, spfastitResult] = await Promise.all([
            fetchSupplierBalance(),
            fetchCodeCraftBalance(),
            fetchXpressBalance(),
            fetchGhDataBalance(),
            fetchAgentPortalBalance(),
            fetchBundlePortalBalance(),
            fetchHendyLinksBalance(),
            fetchSpfastitBalance(),
        ])

        if (!dakazinaResult.success && !codecraftResult.success && !xpressResult.success && !ghdataResult.success && !agentportalResult.success && !bundleportalResult.success && !hendylinksResult.success && !spfastitResult.success) {
            return NextResponse.json({ error: 'Failed to fetch balances from all suppliers' }, { status: 500 })
        }

        return NextResponse.json({
            balance: dakazinaResult.balance || 0,
            currency: dakazinaResult.currency || 'GHS',
            codecraft_balance: codecraftResult.balance || 0,
            codecraft_currency: codecraftResult.currency || 'GHS',
            xpress_balance: xpressResult.balance || 0,
            xpress_currency: xpressResult.currency || 'GHS',
            ghdata_balance: ghdataResult.balance || 0,
            ghdata_currency: ghdataResult.currency || 'GHS',
            agentportal_balance: agentportalResult.balance || 0,
            agentportal_currency: agentportalResult.currency || 'GHS',
            bundleportal_balance: bundleportalResult.balance || 0,
            bundleportal_currency: bundleportalResult.currency || 'GHS',
            hendylinks_balance: hendylinksResult.balance || 0,
            hendylinks_currency: hendylinksResult.currency || 'GHS',
            spfastit_balance: spfastitResult.balance || 0,
            spfastit_currency: spfastitResult.currency || 'GHS',
        })

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
