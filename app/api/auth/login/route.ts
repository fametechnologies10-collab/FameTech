import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { NextRequest, NextResponse } from 'next/server'
import { hasTrustedRequestOrigin } from '@/lib/site-url'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { randomUUID } from 'crypto'

// Single generic message for every credential failure — must never differ
// based on whether email or phone was submitted, or whether the identifier
// existed at all. Distinguishing these would let an attacker enumerate
// which emails/phone numbers are registered.
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email, phone number, or password.'

export async function POST(request: NextRequest) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
    }

    const contentType = request.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 })
    }

    const body = await request.json()
    const { email, phone, password } = body

    if (!password || (!email && !phone) || (email && phone)) {
      return NextResponse.json(
        { error: 'Email or phone number, and password, are required' },
        { status: 400 }
      )
    }

    if (typeof password !== 'string' || password.length > 128) {
      return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
    }

    let resolvedEmail: string

    if (email !== undefined) {
      if (typeof email !== 'string' || email.length > 254) {
        return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
      }
      resolvedEmail = email
    } else {
      if (typeof phone !== 'string' || phone.length > 20) {
        return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
      }

      const phoneValidation = validateGhanaianPhone(phone)
      if (!phoneValidation.isValid) {
        // An invalid phone SHAPE must not be distinguishable from a
        // valid-but-unknown one — same generic message either way.
        return NextResponse.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: 401 })
      }

      // Resolve phone -> email server-side only, via the service-role
      // client — this is never exposed as a standalone "does this phone
      // exist" endpoint.
      const supabaseAdmin = createServerClient()
      const { data: match, error: lookupError } = await (supabaseAdmin.from('users') as any)
        .select('email')
        .eq('phone_number', phoneValidation.normalizedNumber)
        .maybeSingle()

      if (lookupError) {
        console.error('[auth/login] phone lookup failed:', lookupError.code ?? lookupError.status, lookupError.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }

      if (!match?.email) {
        // Unknown phone number — collapse into the exact same response as
        // a wrong password so phone existence can't be enumerated.
        return NextResponse.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: 401 })
      }

      resolvedEmail = match.email
    }

    const supabase = await createRouteClient()

    const { data, error } = await supabase.auth.signInWithPassword({
      email: resolvedEmail,
      password
    })

    if (error) {
      // SECURITY (enumeration): never echo Supabase's raw error.message to the
      // client. It distinguishes "wrong password" from "no such user" / leaks
      // internal states ("Email logins are disabled", etc.), letting an attacker
      // enumerate which emails are registered. Collapse all credential failures
      // into ONE generic response; log the real reason server-side only.
      console.error('[auth/login] sign-in failed:', error.code ?? error.status, error.message)

      // Map only on the safe error CODE (stable), not the human message.
      const code = error.code ?? ''

      if (code === 'email_not_confirmed') {
        // Deliberate, accepted trade-off: this confirms the account exists, but
        // the unconfirmed user genuinely needs this hint to proceed, and the
        // same existence signal is already reachable via the signup endpoint.
        // The machine-readable `code` lets the client surface a "Resend
        // confirmation email" affordance without brittle message-string matching.
        return NextResponse.json(
          { error: 'Please confirm your email address before signing in.', code: 'email_not_confirmed' },
          { status: 403 }
        )
      }

      if (code === 'over_request_rate_limit' || error.status === 429) {
        return NextResponse.json(
          { error: 'Too many attempts. Please try again in a few minutes.' },
          { status: 429 }
        )
      }

      // A failed sign-in might be a sub-agent using a freshly-regenerated pending key,
      // which isn't yet their real Supabase Auth password. Check before giving up —
      // this is additive: it changes nothing for anyone whose normal sign-in already
      // succeeded above, and does nothing for a non-sub-agent's wrong password either
      // (tryPromotePendingKey returns false immediately if there's no pending key row).
      //
      // SECURITY (timing side-channel): tryPromotePendingKey is called
      // UNCONDITIONALLY here, even when the email doesn't resolve to any
      // user. When there's no real user, we pass a random UUID that can
      // never match a real sub_agents.user_id, so tryPromotePendingKey still
      // runs its normal sub_agents lookup + a bcrypt-10 compare (against its
      // own DUMMY_HASH, since the lookup finds nothing) before returning
      // false. This equalizes the three failure buckets an attacker could
      // otherwise distinguish by latency: unknown email, known email with no
      // pending key, and known email with a live pending key — all three now
      // pay exactly one users lookup + one sub_agents lookup + one bcrypt-10
      // compare.
      if (code === 'invalid_credentials') {
        const supabaseAdmin = createServerClient()
        const { data: userRow } = await (supabaseAdmin.from('users') as any)
          .select('id').eq('email', resolvedEmail).maybeSingle()
        const { tryPromotePendingKey } = await import('@/lib/sub-agent-key')
        const targetUserId = userRow?.id ?? randomUUID()
        const promoted = await tryPromotePendingKey(supabaseAdmin, supabaseAdmin, targetUserId, password)
        if (promoted) {
          const retry = await supabase.auth.signInWithPassword({ email: resolvedEmail, password })
          if (!retry.error) {
            // This is exactly a sub-agent's first-ever login (their staged pending
            // key was just promoted into a real password) — the most likely moment
            // must_change_password is true. Reuse supabaseAdmin already in scope
            // above rather than creating another client instance.
            const { fetchMustChangePassword } = await import('@/lib/sub-agent-account')
            const mustChangePassword = await fetchMustChangePassword(supabaseAdmin, retry.data.user!.id)
            return NextResponse.json({ user: retry.data.user, session: retry.data.session, mustChangePassword })
          }
        }
      }

      // invalid_credentials, user_not_found, email_logins_disabled, anything
      // else → single uniform message.
      return NextResponse.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: 401 })
    }

    // SECURITY: sub-agent accounts must sign in at agent.kingflexygh.com, not
    // the main apex. Scoped to the two literal production apex hostnames only
    // (never a suffix/endsWith match) — previews, localhost, and every
    // subdomain (including agent.kingflexygh.com itself) must keep working.
    const PROD_APEX_HOSTS = ['kingflexygh.com', 'www.kingflexygh.com']
    const requestHost = request.headers.get('host') || ''
    if (PROD_APEX_HOSTS.includes(requestHost)) {
      const supabaseAdmin = createServerClient()
      const { data: userRow } = await (supabaseAdmin.from('users') as any)
        .select('role')
        .eq('id', data.user!.id)
        .maybeSingle()
      if (userRow?.role === 'subagent') {
        // scope: 'local' — discard only the session this request just minted, not every
        // session this user has on every device (the default 'global' scope would).
        await supabase.auth.signOut({ scope: 'local' })
        return NextResponse.json(
          { error: 'Sub-agent accounts sign in at agent.kingflexygh.com, not here.' },
          { status: 403 },
        )
      }
    }

    // Informational only — see fetchMustChangePassword's doc comment. The real
    // enforcement gate lives in the dashboard layout (a later task) and does
    // its own independent DB read rather than trusting this response field.
    const { fetchMustChangePassword } = await import('@/lib/sub-agent-account')
    const supabaseAdminForFlag = createServerClient()
    const mustChangePassword = await fetchMustChangePassword(supabaseAdminForFlag, data.user!.id)

    return NextResponse.json({ user: data.user, session: data.session, mustChangePassword })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
