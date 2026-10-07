import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { verifyRecoveryToken } from '@/lib/phone-recovery'

export const dynamic = 'force-dynamic'

// See app/api/auth/phone-verify-gate/confirm/route.ts for why this is 30 minutes,
// not the OTP's own 10-minute send expiry.
const OTP_FRESHNESS_MS = 30 * 60 * 1000

export async function POST(request: Request) {
    const supabase = await createRouteClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    const token = typeof body?.token === 'string' ? body.token : ''
    if (!verifyRecoveryToken(token, user.id)) {
        return NextResponse.json({ success: false, error: 'Recovery session expired. Please confirm your old number again.' }, { status: 401 })
    }

    const validation = validateGhanaianPhone(String(body?.newPhone || ''))
    if (!validation.isValid) {
        return NextResponse.json({ success: false, error: validation.error || 'Invalid phone number' }, { status: 400 })
    }
    const newPhone = validation.normalizedNumber!

    const admin = createAdminClient()

    const { data: otpRow } = await (admin.from('phone_otp_verifications') as any)
        .select('used, created_at')
        .eq('phone', newPhone)
        .eq('used', true)
        .single()

    if (!otpRow) {
        return NextResponse.json({ success: false, error: 'Please verify the code sent to your new number first.' }, { status: 400 })
    }
    if (Date.now() - new Date(otpRow.created_at).getTime() > OTP_FRESHNESS_MS) {
        return NextResponse.json({ success: false, error: 'Verification expired. Please request a new code.' }, { status: 400 })
    }

    // A pre-existing trigger (enforce_subagent_contact_lock) blocks any direct
    // UPDATE of phone_number/email for a "root" sub-agent account unless the
    // per-transaction app.subagent_contact_override flag is set — it exists to
    // stop a subagent's contact info from being silently rerouted outside a
    // controlled channel. This OTP-verified recovery flow IS that controlled
    // channel, so it uses the existing admin_update_subagent_contact RPC
    // (already audited as phone-safe — see supabase/migrations/20260914_
    // subagent_auth.sql) rather than a raw update, which the trigger let
    // through silently for every non-subagent account but rejected (23514)
    // for subagents, surfacing as a generic 500 with no useful message.
    const { error: phoneUpdateError } = await admin.rpc('admin_update_subagent_contact', {
        p_user_id: user.id,
        p_new_email: null,
        p_new_phone: newPhone,
    })

    if (phoneUpdateError) {
        const msg = String(phoneUpdateError.message || '')
        if (phoneUpdateError.code === '23505' || msg.toLowerCase().includes('unique')) {
            return NextResponse.json({ success: false, error: 'This number is already linked to another account.' }, { status: 409 })
        }
        return NextResponse.json({ success: false, error: 'Could not update your number. Please try again.' }, { status: 500 })
    }

    // Separate call: phone_verified isn't gated by the contact-lock trigger
    // (it only checks email/phone_number changes), so a plain update is fine.
    const { error: verifiedUpdateError } = await (admin.from('users') as any)
        .update({ phone_verified: true })
        .eq('id', user.id)

    if (verifiedUpdateError) {
        return NextResponse.json({ success: false, error: 'Could not finish verification. Please try again.' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
}
