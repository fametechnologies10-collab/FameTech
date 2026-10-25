import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createServerClient } from '@/lib/supabase'
import { isBundleFlagEnabled, parseDiscountSetting, validateBundleSettingsInput } from '@/lib/standard-bundles-logic'

const LOG = '[Admin StandardBundles Settings]'
const KEYS = [
    'std_bundles_enabled',
    'std_bundles_enabled_mtn', 'std_bundles_enabled_telecel', 'std_bundles_enabled_at', 'std_bundles_enabled_broadband',
    'std_bundles_discount_mtn', 'std_bundles_discount_telecel', 'std_bundles_discount_at',
]

// Admin only (discounts change what every customer pays). Role check runs before any other work.
async function requireAdmin() {
    const access = await validateAdminAccess(false)
    if (access.error !== null) {
        return NextResponse.json({ success: false, error: access.error }, { status: access.status })
    }
    return null
}

async function readState(supabase: any) {
    const { data, error } = await supabase.from('admin_settings').select('key, value').in('key', KEYS)
    if (error) throw new Error(error.message)
    const m: Record<string, unknown> = {}
    for (const r of data || []) m[r.key] = r.value
    return {
        enabled: isBundleFlagEnabled(m.std_bundles_enabled),
        networks: {
            mtn: isBundleFlagEnabled(m.std_bundles_enabled_mtn),
            telecel: isBundleFlagEnabled(m.std_bundles_enabled_telecel),
            at: isBundleFlagEnabled(m.std_bundles_enabled_at),
            broadband: isBundleFlagEnabled(m.std_bundles_enabled_broadband),
        },
        discounts: {
            mtn: parseDiscountSetting(m.std_bundles_discount_mtn),
            telecel: parseDiscountSetting(m.std_bundles_discount_telecel),
            at: parseDiscountSetting(m.std_bundles_discount_at),
        },
    }
}

export async function GET() {
    try {
        const denied = await requireAdmin()
        if (denied) return denied
        const data = await readState(createServerClient() as any)
        return NextResponse.json({ success: true, data })
    } catch (error) {
        console.error(LOG, 'GET error:', error instanceof Error ? error.message : error)
        return NextResponse.json({ success: false, error: 'Failed to load settings' }, { status: 500 })
    }
}

export async function PUT(request: NextRequest) {
    try {
        const denied = await requireAdmin()
        if (denied) return denied

        let body: unknown
        try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid body' }, { status: 400 }) }

        const v = validateBundleSettingsInput(body)
        if (!v.ok) return NextResponse.json({ success: false, error: v.error }, { status: 400 })

        const supabase = createServerClient() as any
        const rows = Object.entries(v.updates).map(([key, value]) => ({ key, value }))
        const { error } = await supabase.from('admin_settings').upsert(rows, { onConflict: 'key' })
        if (error) {
            console.error(LOG, 'Save error:', error.message)
            return NextResponse.json({ success: false, error: 'Failed to save settings' }, { status: 500 })
        }
        return NextResponse.json({ success: true, data: await readState(supabase) })
    } catch (error) {
        console.error(LOG, 'PUT error:', error instanceof Error ? error.message : error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
