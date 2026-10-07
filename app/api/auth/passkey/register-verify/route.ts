import { NextRequest, NextResponse } from 'next/server'
import { verifyRegistrationResponse } from '@simplewebauthn/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { getPasskeyRpId, getPasskeyOrigins, inferPasskeyName } from '@/lib/passkey-server'
import { hasTrustedRequestOrigin } from '@/lib/site-url'

export async function POST(req: NextRequest) {
    if (!hasTrustedRequestOrigin(req)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { credential, friendlyName } = await req.json()
    if (!credential) return NextResponse.json({ error: 'Missing credential' }, { status: 400 })

    const admin = createAdminClient()

    // Retrieve the stored challenge for this user
    const { data: challengeRow } = await (admin as any)
        .from('passkey_challenges')
        .select('challenge, expires_at')
        .eq('user_id', user.id)
        .eq('flow', 'registration')
        .single()

    if (!challengeRow) {
        return NextResponse.json({ error: 'Registration session not found. Please try again.' }, { status: 400 })
    }
    if (new Date(challengeRow.expires_at) < new Date()) {
        return NextResponse.json({ error: 'Registration session expired. Please try again.' }, { status: 400 })
    }

    // Always delete the challenge (single-use regardless of verification outcome)
    await (admin as any)
        .from('passkey_challenges')
        .delete()
        .eq('user_id', user.id)
        .eq('flow', 'registration')

    const origin = req.headers.get('origin')
    let verification
    try {
        verification = await verifyRegistrationResponse({
            response: credential,
            expectedChallenge: challengeRow.challenge,
            expectedOrigin: getPasskeyOrigins(origin),
            expectedRPID: getPasskeyRpId(origin),
            requireUserVerification: true,
        })
    } catch (err: any) {
        console.error('[passkey/register-verify]', err?.message)
        return NextResponse.json({ error: 'Verification failed: ' + (err?.message ?? 'unknown') }, { status: 400 })
    }

    if (!verification.verified || !verification.registrationInfo) {
        return NextResponse.json({ error: 'Registration could not be verified.' }, { status: 400 })
    }

    const info = verification.registrationInfo
    // v10: credentialID is a Base64URLString directly on info (not info.credential.id)
    const credentialId = info.credentialID
    const transports: string[] = credential.response?.transports ?? []
    const deviceType = info.credentialDeviceType // 'singleDevice' | 'multiDevice'
    const name = friendlyName?.trim() || inferPasskeyName(transports, deviceType)

    const { data: newPasskey, error: insertErr } = await (admin as any)
        .from('passkey_credentials')
        .insert({
            user_id: user.id,
            email: user.email,
            credential_id: credentialId,
            // Send as \x-prefixed hex so PostgREST stores raw bytes, not JSON text.
            // Buffer.toJSON() returns {type,data} which JSON.stringify serializes as
            // an object — PostgreSQL would store the ASCII of that string, not the key.
            public_key: `\\x${Buffer.from(info.credentialPublicKey).toString('hex')}`,
            counter: info.counter,
            device_type: deviceType,
            backed_up: info.credentialBackedUp,
            transports,
            friendly_name: name,
        })
        .select('id, friendly_name, device_type, backed_up, transports, created_at, last_used_at')
        .single()

    if (insertErr) {
        console.error('[passkey/register-verify] DB insert error:', insertErr)
        return NextResponse.json({ error: 'Failed to save passkey.' }, { status: 500 })
    }

    return NextResponse.json({ success: true, passkey: newPasskey })
}
