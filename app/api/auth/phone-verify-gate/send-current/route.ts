import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { sendPhoneOtp } from '@/lib/phone-otp-service'

export const dynamic = 'force-dynamic'

function getClientIp(request: Request): string {
    return (
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        'unknown'
    )
}

// Sends an OTP to the CALLER'S OWN on-file phone_number, resolved entirely
// server-side — the browser never receives or supplies the real number for
// this flow. Only the recovery flow's brand-new-number step takes a
// client-supplied phone (see /recover/complete), which is a fine input since
// that number isn't a stored secret yet.
export async function POST(request: Request) {
    const supabase = await createRouteClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const admin = createAdminClient()
    const { data: profile } = await (admin.from('users') as any)
        .select('phone_number')
        .eq('id', user.id)
        .single()

    if (!profile?.phone_number) {
        return NextResponse.json({ success: false, error: 'No phone number on file' }, { status: 400 })
    }

    const result = await sendPhoneOtp(profile.phone_number, getClientIp(request))
    if (!result.ok) {
        return NextResponse.json({ success: false, error: result.error, data: { cooldownSeconds: result.cooldownSeconds } }, { status: result.status })
    }

    return NextResponse.json({ success: true, data: { cooldownSeconds: result.cooldownSeconds } })
}
