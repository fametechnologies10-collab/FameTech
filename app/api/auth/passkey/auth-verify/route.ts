import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthenticationResponse } from '@simplewebauthn/server'
import { createAdminClient } from '@/lib/supabase-admin'
import { createRouteClient } from '@/lib/supabase-server'
import { getPasskeyRpId, getPasskeyOrigins } from '@/lib/passkey-server'
import { hasTrustedRequestOrigin } from '@/lib/site-url'

// No auth required — this is pre-login.
export async function POST(req: NextRequest) {
    if (!hasTrustedRequestOrigin(req)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { credential } = await req.json()
    if (!credential?.rawId) {
        return NextResponse.json({ error: 'Missing credential' }, { status: 400 })
    }

    const admin = createAdminClient()

    // Look up the stored credential by rawId (base64url).
    // email column was added in 20260605_add_passkey_email migration — used below
    // to skip a getUserById round-trip when generating the session link.
    const { data: stored } = await (admin as any)
        .from('passkey_credentials')
        .select('id, user_id, email, public_key, counter, transports, credential_id')
        .eq('credential_id', credential.rawId)
        .single()

    if (!stored) {
        return NextResponse.json({ error: 'Passkey not recognized on this platform.' }, { status: 404 })
    }

    // Decode the challenge from clientDataJSON
    let expectedChallenge: string
    try {
        const clientData = JSON.parse(
            Buffer.from(credential.response.clientDataJSON, 'base64url').toString()
        )
        expectedChallenge = clientData.challenge
    } catch {
        return NextResponse.json({ error: 'Invalid credential data.' }, { status: 400 })
    }

    // Look up the challenge (user_id is null for auth challenges)
    const { data: challengeRow } = await (admin as any)
        .from('passkey_challenges')
        .select('id, challenge, expires_at')
        .eq('challenge', expectedChallenge)
        .eq('flow', 'authentication')
        .single()

    if (!challengeRow) {
        return NextResponse.json({ error: 'Sign-in session not found. Please try again.' }, { status: 400 })
    }
    if (new Date(challengeRow.expires_at) < new Date()) {
        return NextResponse.json({ error: 'Sign-in session expired. Please try again.' }, { status: 400 })
    }

    // Delete challenge immediately (single-use)
    await (admin as any)
        .from('passkey_challenges')
        .delete()
        .eq('id', challengeRow.id)

    // Lazy cleanup of other expired challenges
    ;(admin as any)
        .from('passkey_challenges')
        .delete()
        .lt('expires_at', new Date().toISOString())
        .then(() => {}, () => {})

    let verification
    try {
        const origin = req.headers.get('origin')
        // PostgREST returns bytea as base64 in JSON responses.
        // Also handle the older \x-prefixed hex format for forward compatibility.
        const rawPK = stored.public_key
        const pkBytes: Uint8Array = typeof rawPK === 'string'
            ? rawPK.startsWith('\\x')
                ? new Uint8Array(Buffer.from(rawPK.slice(2), 'hex'))
                : new Uint8Array(Buffer.from(rawPK, 'base64'))
            : new Uint8Array(Buffer.from(rawPK as any))
        // v10: authenticator replaces credential; credentialID is Base64URLString
        verification = await verifyAuthenticationResponse({
            response: credential,
            expectedChallenge: challengeRow.challenge,
            expectedOrigin: getPasskeyOrigins(origin),
            expectedRPID: getPasskeyRpId(origin),
            requireUserVerification: true,
            authenticator: {
                credentialID: stored.credential_id,
                credentialPublicKey: pkBytes,
                counter: stored.counter,
                transports: stored.transports ?? [],
            },
        })
    } catch (err: any) {
        console.error('[passkey/auth-verify]', err?.message)
        return NextResponse.json({ error: 'Verification failed.' }, { status: 401 })
    }

    if (!verification.verified) {
        return NextResponse.json({ error: 'Passkey verification failed.' }, { status: 401 })
    }

    const newCounter = verification.authenticationInfo.newCounter

    // Clone detection: counter must advance (unless it's a synced passkey with counter=0)
    if (newCounter <= stored.counter && stored.counter > 0) {
        console.error('[passkey/auth-verify] Counter regression — possible cloned credential', {
            credentialId: stored.credential_id,
            stored: stored.counter,
            received: newCounter,
        })
        return NextResponse.json({ error: 'Security alert: credential anomaly detected.' }, { status: 401 })
    }

    // Update counter and last_used_at
    await (admin as any)
        .from('passkey_credentials')
        .update({ counter: newCounter, last_used_at: new Date().toISOString() })
        .eq('id', stored.id)

    // Session creation: auth-js v2.106 has no createSession.
    // 1. Resolve the user's email — use the value stored at registration to avoid
    //    a getUserById round-trip. Fall back to getUserById for passkeys registered
    //    before the email column was added or if the user changed their email.
    // 2. generateLink (admin-only, no email sent) produces a single-use hashed_token.
    // 3. verifyOtp exchanges the token for a real access + refresh token pair.
    let userEmail: string | null = stored.email ?? null
    if (!userEmail) {
        const { data: userData, error: userErr } = await admin.auth.admin.getUserById(stored.user_id)
        if (userErr || !userData.user?.email) {
            console.error('[passkey/auth-verify] getUserById failed:', userErr)
            return NextResponse.json({ error: 'Failed to create session.' }, { status: 500 })
        }
        userEmail = userData.user.email
    }

    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type: 'magiclink',
        email: userEmail,
    })
    if (linkErr || !linkData?.properties?.hashed_token) {
        console.error('[passkey/auth-verify] generateLink failed:', linkErr)
        return NextResponse.json({ error: 'Failed to create session.' }, { status: 500 })
    }

    const { data: sessionData, error: sessionErr } = await admin.auth.verifyOtp({
        token_hash: linkData.properties.hashed_token,
        type: 'magiclink',
    })

    if (sessionErr || !sessionData?.session) {
        console.error('[passkey/auth-verify] Session exchange failed:', sessionErr)
        return NextResponse.json({ error: 'Failed to create session.' }, { status: 500 })
    }

    // Write the Supabase auth cookie into the HTTP response so the dashboard
    // server component's getUser() call succeeds immediately on navigation.
    // Without this, setSession is client-side only and the server-side SSR
    // layout sees no cookie → redirects to /auth → infinite loading loop.
    const routeClient = await createRouteClient()
    await routeClient.auth.setSession({
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
    })

    // Also return the tokens so passkey-client.ts can hydrate the browser-side
    // Supabase client (triggers onAuthStateChange → auth context updates).
    return NextResponse.json({
        success: true,
        session: {
            access_token: sessionData.session.access_token,
            refresh_token: sessionData.session.refresh_token,
            expires_in: sessionData.session.expires_in,
        },
    })
}
