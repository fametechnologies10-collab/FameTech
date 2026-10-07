import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

export async function PATCH(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: adminData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (adminData?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const body = await request.json()
        const { promoRole } = body

        if (promoRole !== 'dealer' && promoRole !== 'agent' && promoRole !== null) {
            return NextResponse.json({ error: 'promoRole must be "dealer", "agent", or null' }, { status: 400 })
        }

        const supabase = createServerClient()

        const { error: upsertError } = await (supabase as any)
            .from('admin_settings')
            .upsert({ key: 'signup_promo_role', value: promoRole }, { onConflict: 'key' })

        if (upsertError) throw new Error(upsertError.message)

        return NextResponse.json({ success: true, promoRole })
    } catch (error: any) {
        console.error('[AdminSignupPromo]', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
