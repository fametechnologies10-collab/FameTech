import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { maskPhoneHint } from '@/lib/phone-recovery'

export const dynamic = 'force-dynamic'

export async function GET() {
    const supabase = await createRouteClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const admin = createAdminClient()
    const { data: profile } = await (admin.from('users') as any)
        .select('phone_number, phone_verified')
        .eq('id', user.id)
        .single()

    if (!profile?.phone_number) {
        return NextResponse.json({ success: false, error: 'No phone number on file' }, { status: 400 })
    }

    return NextResponse.json({
        success: true,
        data: { hint: maskPhoneHint(profile.phone_number), phoneVerified: !!profile.phone_verified },
    })
}
