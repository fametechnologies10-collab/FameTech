import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { getBundleCatalog } from '@/lib/kingflexy-bundles-service'
import {
    applyDiscount,
    parseDiscountSetting,
    isBundleFlagEnabled,
    bundleKillSwitchKeys,
} from '@/lib/standard-bundles-logic'

const NETWORKS = ['MTN', 'Telecel', 'AT'] as const

export async function GET(request: NextRequest) {
    try {
        const routeClient = await createRouteClient()
        const { data: { user }, error: authError } = await routeClient.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const network = request.nextUrl.searchParams.get('network')
        if (!network || !(NETWORKS as readonly string[]).includes(network)) {
            return NextResponse.json({ success: false, error: 'Invalid network' }, { status: 400 })
        }
        const net = network as (typeof NETWORKS)[number]
        const netKey = net.toLowerCase()

        const supabase = createServerClient()
        const stdKeys = bundleKillSwitchKeys(net, 'standard')
        const bbKeys = bundleKillSwitchKeys(net, 'broadband')
        const discountKey = `std_bundles_discount_${netKey}`
        const [settingsRes, catalog] = await Promise.all([
            (supabase.from('admin_settings') as any)
                .select('key, value')
                .in('key', [...stdKeys, ...bbKeys, discountKey]),
            getBundleCatalog(net),
        ])

        if (!catalog.ok || !catalog.data) {
            return NextResponse.json(
                { success: false, error: 'Bundles are temporarily unavailable. Please try again shortly.' },
                { status: 503 },
            )
        }

        const settings: Record<string, unknown> = {}
        for (const s of (settingsRes.data || []) as any[]) settings[s.key] = s.value

        const moduleOn = isBundleFlagEnabled(settings[stdKeys[0]])
        const networkOn = isBundleFlagEnabled(settings[stdKeys[1]])
        const enabled = moduleOn && networkOn && catalog.data.enabled
        const discountPct = parseDiscountSetting(settings[discountKey])

        const bundles = catalog.data.bundles.map((b) => {
            const kind = b.pack_id ? ('special' as const) : ('standard' as const)
            return {
                value: b.value,
                pack_id: b.pack_id,
                size: b.size,
                family: b.family,
                family_label: b.family_label,
                kind,
                original_price: b.price,
                price: applyDiscount(b.price, discountPct, kind),
                discount_pct: discountPct,
            }
        })

        const families: { family: string; family_label: string }[] = []
        for (const b of bundles) {
            if (!families.some((f) => f.family === b.family)) {
                families.push({ family: b.family, family_label: b.family_label })
            }
        }

        const bb = catalog.data.broadband
        const broadband = bb
            ? {
                enabled: moduleOn
                    && isBundleFlagEnabled(settings[bbKeys[1]])
                    && catalog.data.enabled
                    && bb.enabled,
                min: bb.min,
                max: bb.max,
            }
            : null

        return NextResponse.json({
            success: true,
            data: { network: net, enabled, stale: catalog.stale, families, bundles, broadband },
        })
    } catch (e) {
        console.error('[StandardBundles] catalog unexpected error:', e)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
