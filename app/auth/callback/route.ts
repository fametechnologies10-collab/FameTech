import { createServerClient } from '@supabase/ssr'
import { createServerClient as createAdminClient } from '@/lib/supabase'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { getAuthCookieOptions } from '@/lib/cookie-domain'

export async function GET(request: NextRequest) {
    const { searchParams, origin } = new URL(request.url)

    // ── 1. Catch errors returned by the OAuth provider / Supabase ─────────────
    // When Google denies access, Supabase configuration is wrong, or the
    // redirect URL is not in the allowlist, Supabase redirects here with
    // ?error=<code>&error_description=<msg> instead of ?code=<auth_code>.
    // Without this check the route silently falls through to !code and hides
    // the real reason (e.g. "access_denied", "provider_email_needs_verification").
    const providerError = searchParams.get('error')
    if (providerError) {
        console.error(
            '[Auth Callback] OAuth provider error:',
            providerError,
            searchParams.get('error_description') ?? ''
        )
        return NextResponse.redirect(`${origin}/auth?error=oauth_failed`)
    }

    const code = searchParams.get('code')

    // ── 2. Validate the optional post-auth redirect destination ───────────────
    // Must be a relative path — blocks open-redirect phishing.
    const rawNext = searchParams.get('next') ?? '/dashboard'
    const next =
        rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.includes(':')
            ? rawNext
            : '/dashboard'

    if (!code) {
        console.error('[Auth Callback] No code in callback URL — possible redirect URL mismatch in Supabase dashboard')
        return NextResponse.redirect(`${origin}/auth?error=oauth_failed`)
    }

    const cookieStore = await cookies()

    // Collect cookies that exchangeCodeForSession writes, then apply them to
    // the final redirect response. We defer building the response so the DB
    // check can influence the destination URL.
    const pendingCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = []

    // IMPORTANT: Must use @supabase/ssr createServerClient (not the admin client
    // from lib/supabase). PKCE stores the code_verifier in a cookie when
    // signInWithOAuth is called (flowType:'pkce' on the browser client). This
    // server client reads that cookie and sends the verifier during the exchange,
    // producing a valid session. Using the admin client instead would fail with
    // "both auth code and code verifier should be non-empty".
    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookieOptions: getAuthCookieOptions(),
            cookies: {
                getAll() {
                    return cookieStore.getAll()
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(c => pendingCookies.push(c as typeof pendingCookies[number]))
                },
            },
        }
    )

    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (error || !data.user) {
        // Log the cookie names present so we can diagnose PKCE verifier issues
        // (look for a cookie matching `sb-*-auth-token-code-verifier`).
        const cookieNames = cookieStore.getAll().map(c => c.name)
        console.error('[Auth Callback] exchangeCodeForSession failed:', {
            message: error?.message,
            status: (error as any)?.status,
            cookiesPresent: cookieNames,
        })
        // If the failure looks like a same-email collision (an email already
        // registered under a different account blocks the new-user insert), send a
        // specific, actionable message instead of the generic OAuth error.
        const msg = (error?.message || '').toLowerCase()
        const emailConflict = msg.includes('already') || msg.includes('duplicate')
            || msg.includes('unique') || msg.includes('exists')
        return NextResponse.redirect(`${origin}/auth?error=${emailConflict ? 'email_exists' : 'oauth_failed'}`)
    }

    // ── SECURITY: enforce Google identity email match ─────────────────────────
    // supabase.auth.linkIdentity() attaches ANY Google account regardless of
    // email — Supabase does not enforce a match. The client-side check in
    // /dashboard/profile is best-effort: if the browser never completes it
    // (tab closed, mobile JS suspension, network failure) a mismatched Google
    // identity would stay attached permanently as a valid sign-in method.
    // Enforcing it here, server-side, makes the guard unskippable.
    //
    // Fail closed: anything that is not a confirmed case-insensitive string
    // match is treated as a mismatch and unlinked.
    let linkOutcome: 'mismatch' | 'mismatch_failed' | null = null
    const googleIdentity = data.user.identities?.find((id: any) => id.provider === 'google')

    // The length guard is a safety net: never attempt to unlink a user's ONLY
    // identity (that would orphan the account). A pure Google signup has a
    // single google identity whose email IS the account email, so it never
    // reaches the unlink path anyway.
    if (googleIdentity && (data.user.identities?.length ?? 0) > 1) {
        const googleEmail = (googleIdentity as any).identity_data?.email
        const accountEmail = data.user.email
        const matches =
            typeof googleEmail === 'string' &&
            typeof accountEmail === 'string' &&
            googleEmail.toLowerCase() === accountEmail.toLowerCase()

        if (!matches) {
            const { error: unlinkError } = await supabase.auth.unlinkIdentity(googleIdentity as any)
            if (unlinkError) {
                console.error('[Auth Callback] failed to unlink mismatched Google identity:', unlinkError.message)
                linkOutcome = 'mismatch_failed'
            } else {
                console.warn('[Auth Callback] unlinked mismatched Google identity for user', data.user.id)
                linkOutcome = 'mismatch'
            }
        }
    }

    // ── 3. Look up the DB profile to decide where to redirect ─────────────────
    // Use the service-role admin client (bypasses RLS) so this works even
    // before the new user's RLS policies have been applied.
    const admin = createAdminClient()
    const { data: dbUser } = await (admin.from('users') as any)
        .select('phone_number')
        .eq('id', data.user.id)
        .single()

    // For Google users, "profile complete" means BOTH:
    //   1. phone_number is saved (from complete-profile step 1)
    //   2. A password has been set — confirmed by the presence of an 'email'
    //      identity in auth.users.identities (from complete-profile step 2)
    const isGoogleUser = data.user.identities?.some((id: any) => id.provider === 'google') ?? false
    // updateUser({ password }) for OAuth users does NOT add an email identity.
    // Check user_metadata.has_password (written by complete-profile on success)
    // and fall back to the email-identity check for pure email/password users.
    const hasPassword  = (data.user.user_metadata?.has_password === true)
        || (data.user.identities?.some((id: any) => id.provider === 'email') ?? false)
    const hasPhone     = !!dbUser?.phone_number

    const profileComplete = hasPhone && (!isGoogleUser || hasPassword)

    let redirectTarget = profileComplete
        ? `${origin}${next}`
        : `${origin}/auth/complete-profile`

    // Surface the link outcome to the client so the user is told what happened.
    // Uses URL/searchParams because `next` may already carry a query string.
    if (linkOutcome) {
        const outcomeUrl = new URL(redirectTarget)
        outcomeUrl.searchParams.set('link', linkOutcome)
        redirectTarget = outcomeUrl.toString()
    }

    const response = NextResponse.redirect(redirectTarget)

    // NOTE: a `kfg_profile_ok` cookie used to be written here as a claimed
    // "middleware fast-path", but middleware never read it — it was write-only
    // dead code. Removed. The profile-completeness gate is enforced by the
    // dashboard layout (which reads dbUser) and complete-profile's own routing.

    // Apply the session cookies to the redirect response so the browser stores
    // them before following the redirect to the dashboard.
    pendingCookies.forEach(({ name, value, options }) => {
        response.cookies.set(name, value, options as Parameters<typeof response.cookies.set>[2])
    })

    return response
}
