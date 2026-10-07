import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { invalidateSmsRoutingCache, type SmsProvider } from '@/lib/sms-service'

async function requireAdmin() {
    const client = await createRouteClient()
    const { data: { user }, error } = await client.auth.getUser()
    if (error || !user) return { error: 'Unauthorized', status: 401 }
    const { data } = await client.from('users').select('role').eq('id', user.id).single()
    if (data?.role !== 'admin') return { error: 'Forbidden - Admin only', status: 403 }
    return { user }
}

const VALID_PROVIDERS: SmsProvider[] = ['hubtel', 'moolre', 'mnotify']

// ─── GET /api/admin/sms-settings — read current routing config ────────────────
export async function GET() {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const supabase = createServerClient()
        const { data, error } = await (supabase as any)
            .from('admin_settings')
            .select('key, value')
            .in('key', ['sms_primary_provider', 'sms_fallback_providers'])

        if (error) throw error

        const s: Record<string, string> = {}
        for (const row of (data || [])) s[row.key] = row.value

        const primary: SmsProvider = (s.sms_primary_provider as SmsProvider) || 'hubtel'
        let fallbacks: SmsProvider[] = []
        try { fallbacks = JSON.parse(s.sms_fallback_providers || '[]') } catch { fallbacks = [] }

        return NextResponse.json({ success: true, primary, fallbacks })
    } catch (e: any) {
        console.error('[SMS Settings GET]', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}

// ─── PATCH /api/admin/sms-settings — update routing config ───────────────────
export async function PATCH(request: NextRequest) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const body = await request.json()
        const primary: SmsProvider   = body.primary
        const fallbacks: SmsProvider[] = Array.isArray(body.fallbacks) ? body.fallbacks : []

        if (!VALID_PROVIDERS.includes(primary)) {
            return NextResponse.json({ error: `primary must be one of: ${VALID_PROVIDERS.join(', ')}` }, { status: 400 })
        }
        for (const f of fallbacks) {
            if (!VALID_PROVIDERS.includes(f)) {
                return NextResponse.json({ error: `Invalid fallback provider: ${f}` }, { status: 400 })
            }
        }
        // Ensure primary not in fallbacks
        const cleanFallbacks = fallbacks.filter(f => f !== primary)

        const supabase = createServerClient()
        const updates = [
            { key: 'sms_primary_provider',   value: primary },
            { key: 'sms_fallback_providers',  value: JSON.stringify(cleanFallbacks) },
        ]

        const { error } = await (supabase as any)
            .from('admin_settings')
            .upsert(updates, { onConflict: 'key' })

        if (error) throw error

        // Invalidate the in-memory routing cache so the change takes effect immediately
        invalidateSmsRoutingCache()

        return NextResponse.json({ success: true, primary, fallbacks: cleanFallbacks })
    } catch (e: any) {
        console.error('[SMS Settings PATCH]', e)
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}
