import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { DATA_NETWORKS, isDataNetwork, parseAdminStock } from '@/lib/network-stock'

const SETTINGS_KEY = 'data_network_stock'

// POST — admin flips one data network in/out of stock platform-wide.
// Writes the single admin_settings row via the RLS client so the existing
// admin_settings audit trigger records auth.uid(). Does not touch packages.
export async function POST(request: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()
        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: userData } = await supabase
            .from('users').select('role').eq('id', authUser.id).single()
        if (userData?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const body = await request.json().catch(() => ({}))
        const { network, outOfStock } = body as { network?: unknown; outOfStock?: unknown }
        if (!isDataNetwork(network)) {
            return NextResponse.json({ error: 'Invalid network' }, { status: 400 })
        }
        if (typeof outOfStock !== 'boolean') {
            return NextResponse.json({ error: 'outOfStock must be a boolean' }, { status: 400 })
        }

        // Read-modify-write the whole object so the audit trigger captures the change.
        const { data: existing } = await supabase
            .from('admin_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()
        const oos = parseAdminStock((existing as any)?.value)
        const next: Record<string, boolean> = {}
        for (const net of DATA_NETWORKS) next[net] = oos.has(net)
        next[network] = outOfStock

        const { data: updated, error } = await (supabase.from('admin_settings') as any)
            .update({ value: next, updated_at: new Date().toISOString() })
            .eq('key', SETTINGS_KEY)
            .select('key')
            .maybeSingle()
        if (error) throw error
        if (!updated) {
            return NextResponse.json({ error: 'Settings not initialized — run the migration' }, { status: 500 })
        }

        return NextResponse.json({ success: true, network, outOfStock, stock: next })
    } catch (error: any) {
        console.error('Network Stock Update Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
