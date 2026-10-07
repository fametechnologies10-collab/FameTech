import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'

// GET /api/passkeys — list the authenticated user's passkeys
export async function GET(req: NextRequest) {
    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const admin = createAdminClient()
    const { data, error } = await (admin as any)
        .from('passkey_credentials')
        .select('id, friendly_name, device_type, backed_up, transports, created_at, last_used_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })

    if (error) return NextResponse.json({ error: 'Failed to fetch passkeys.' }, { status: 500 })

    return NextResponse.json({ passkeys: data ?? [] })
}
