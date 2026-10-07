import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { isToggleKey, coerceBool } from '@/lib/admin-settings'

/**
 * Quick-toggle a single critical platform switch from the dashboard.
 *
 * Security:
 *  - validateAdminAccess(false): admin-only. Sub-admins get 403.
 *  - Server-side allowlist (isToggleKey): only the 4 designated kill-switches
 *    can be flipped here; any other key is rejected before touching the DB.
 *  - Writes through the AUTHENTICATED (RLS) client, not service-role, so the
 *    admin_settings audit trigger records auth.uid() and RLS re-checks admin.
 */
export async function POST(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { key, value } = body || {}
        if (!isToggleKey(key)) {
            return NextResponse.json({ error: 'Setting key is not permitted for quick-toggle' }, { status: 400 })
        }

        const coerced = coerceBool(value)

        // Explicit narrow: on the success branch supabase is non-null (the RLS
        // client tied to this admin's session — drives correct audit attribution).
        const supabase = authResult.supabase
        if (!supabase) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { error } = await (supabase.from('admin_settings') as any)
            .upsert({ key, value: coerced }, { onConflict: 'key' })

        if (error) {
            console.error('[SettingsToggle] upsert error:', error.message)
            return NextResponse.json({ error: 'Failed to update setting' }, { status: 500 })
        }

        return NextResponse.json({ success: true, key, value: coerced })
    } catch (error: any) {
        console.error('Settings Toggle Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
