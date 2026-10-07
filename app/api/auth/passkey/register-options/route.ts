import { NextRequest, NextResponse } from 'next/server'
import { generateRegistrationOptions } from '@simplewebauthn/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { getPasskeyRpId, getPasskeyRpName } from '@/lib/passkey-server'
import { hasTrustedRequestOrigin } from '@/lib/site-url'

export async function POST(req: NextRequest) {
    if (!hasTrustedRequestOrigin(req)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const admin = createAdminClient()

    // Fetch existing credentials so the authenticator won't register the same
    // device twice (the browser raises InvalidStateError if it tries).
    const { data: existingCreds } = await (admin as any)
        .from('passkey_credentials')
        .select('credential_id, transports')
        .eq('user_id', user.id)

    const excludeCredentials = (existingCreds ?? []).map((c: any) => ({
        id: c.credential_id,
        transports: c.transports ?? [],
    }))

    const origin = req.headers.get('origin')
    const options = await generateRegistrationOptions({
        rpName: getPasskeyRpName(),
        rpID: getPasskeyRpId(origin),
        userName: user.email ?? user.id,
        userDisplayName: user.user_metadata?.full_name ?? user.email ?? 'User',
        excludeCredentials,
        authenticatorSelection: {
            // residentKey required = discoverable credential stored on authenticator
            // (needed for passwordless / empty-allowCredentials flow)
            residentKey: 'required',
            userVerification: 'required',
            // No authenticatorAttachment constraint → platform + roaming + cross-device QR
        },
        attestationType: 'none',
    })

    // Store challenge — delete any stale registration challenge for this user first
    await (admin as any)
        .from('passkey_challenges')
        .delete()
        .eq('user_id', user.id)
        .eq('flow', 'registration')

    const { error: insertErr } = await (admin as any)
        .from('passkey_challenges')
        .insert({
            challenge: options.challenge,
            user_id: user.id,
            flow: 'registration',
        })

    if (insertErr) {
        console.error('[passkey/register-options] Failed to store challenge:', insertErr)
        return NextResponse.json(
            { error: 'Could not start passkey registration. Please try again.' },
            { status: 503 }
        )
    }

    return NextResponse.json(options)
}
