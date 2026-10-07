import { NextRequest, NextResponse } from 'next/server'
import { generateAuthenticationOptions } from '@simplewebauthn/server'
import { createAdminClient } from '@/lib/supabase-admin'
import { getPasskeyRpId } from '@/lib/passkey-server'
import { hasTrustedRequestOrigin } from '@/lib/site-url'

// No auth required — this is pre-login. The user is not yet known.
export async function POST(req: NextRequest) {
    if (!hasTrustedRequestOrigin(req)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const origin = req.headers.get('origin')
    const options = await generateAuthenticationOptions({
        rpID: getPasskeyRpId(origin),
        // Empty allowCredentials = discoverable credential flow:
        // the browser shows its own passkey picker which includes the
        // QR code / cross-device option on desktop Chrome/Edge/Safari.
        allowCredentials: [],
        userVerification: 'required',
    })

    const admin = createAdminClient()

    // Store challenge — no user_id yet (unknown pre-login)
    const { error: insertErr } = await (admin as any)
        .from('passkey_challenges')
        .insert({
            challenge: options.challenge,
            user_id: null,
            flow: 'authentication',
        })

    if (insertErr) {
        console.error('[passkey/auth-options] Failed to store challenge:', insertErr)
        return NextResponse.json(
            { error: 'Could not start passkey sign-in. Please try again.' },
            { status: 503 }
        )
    }

    return NextResponse.json(options)
}
