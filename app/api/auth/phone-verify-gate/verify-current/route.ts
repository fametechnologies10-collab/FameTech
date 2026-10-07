import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { verifyPhoneOtp } from '@/lib/phone-otp-service'

export const dynamic = 'force-dynamic'

function getClientIp(request: Request): string {
    return (
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        'unknown'
    )
}

// Verifies the code against the CALLER'S OWN on-file phone_number (resolved
// server-side, never supplied by the client) and, on success, flips
// phone_verified in the same call. Supersedes the old two-step
// verify-phone(action:verify) + phone-verify-gate/confirm pairing, which
// required the browser to hold and transmit the real phone number.
export async function POST(request: Request) {
    const supabase = await createRouteClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    const code = typeof body?.code === 'string' ? body.code : ''

    const admin = createAdminClient()
    const { data: profile } = await (admin.from('users') as any)
        .select('phone_number, phone_verified')
        .eq('id', user.id)
        .single()

    if (!profile?.phone_number) {
        return NextResponse.json({ success: false, error: 'No phone number on file' }, { status: 400 })
    }
    if (profile.phone_verified) {
        return NextResponse.json({ success: true })
    }

    const result = await verifyPhoneOtp(profile.phone_number, code, getClientIp(request))
    if (!result.ok) {
        return NextResponse.json({ success: false, error: result.error }, { status: result.status })
    }

    const { error: updateError } = await (admin.from('users') as any)
        .update({ phone_verified: true })
        .eq('id', user.id)

    if (updateError) {
        return NextResponse.json({ success: false, error: 'Could not save verification. Please try again.' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
}
