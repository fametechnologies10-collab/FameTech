import { createRouteClient } from '@/lib/supabase-server'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { nameSchema, phoneSchema, accountEmailSchema, passwordSchema } from '@/lib/validation'
import { createServerClient } from '@/lib/supabase'
import { hasTrustedRequestOrigin } from '@/lib/site-url'

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

    const signupSchema = z.object({
      email: accountEmailSchema,
      password: passwordSchema,
      firstName: nameSchema,
      lastName: nameSchema,
      phoneNumber: phoneSchema,
      // Proof THIS browser solved the OTP (see lib/phone-otp-service.ts /
      // supabase/migrations/20261016_add_signup_claim_token_to_phone_otp.sql).
      // Optional: absent when phone verification is switched off.
      // Always exactly 64 hex chars (crypto.randomBytes(32).toString('hex'));
      // bounded even though .eq() below is parameterized either way.
      phoneVerificationToken: z.string().min(1).max(64).optional(),
    })

    const validation = signupSchema.safeParse(body)
    if (!validation.success) {
      const errorDetails = validation.error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
      return NextResponse.json({ error: 'Invalid input', details: errorDetails }, { status: 400 })
    }

    const { email, password, firstName, lastName, phoneNumber, phoneVerificationToken } = validation.data

    // Check for duplicate email or phone number first.
    // Two parallel `.eq` queries instead of one `.or()` so we never build a
    // PostgREST filter string from user input — eliminates the filter-injection
    // footgun even if the validator above ever loosens.
    const supabaseAdmin = createServerClient()
    const [emailResult, phoneResult] = await Promise.all([
        (supabaseAdmin.from('users') as any)
            .select('id')
            .eq('email', email)
            .maybeSingle(),
        (supabaseAdmin.from('users') as any)
            .select('id')
            .eq('phone_number', phoneNumber)
            .maybeSingle(),
    ])

    const existingEmail = !!emailResult.data
    const existingPhone = !!phoneResult.data

    if (existingEmail && existingPhone) {
        return NextResponse.json({ error: 'An account with this email and phone number already exists' }, { status: 400 })
    } else if (existingEmail) {
        return NextResponse.json({ error: 'An account with this email already exists' }, { status: 400 })
    } else if (existingPhone) {
        return NextResponse.json({ error: 'An account with this phone number already exists' }, { status: 400 })
    }

    const supabase = await createRouteClient()

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName,
          phone_number: phoneNumber,
        },
      },
    })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    // The client already completed phone OTP verification for this exact
    // number via /api/auth/verify-phone right before calling this endpoint
    // (see app/auth/_components/sign-up-form.tsx) — but handle_new_user()'s
    // INSERT never sets phone_verified, so it defaults to false on the new
    // row regardless. The dashboard gate (app/dashboard/layout.tsx) then saw
    // phone_verified=false and sent the brand-new user through OTP
    // verification AGAIN on first dashboard visit (reported 2026-10-16).
    //
    // SECURITY (payments-security-reviewer, 2026-10-16): an earlier version of
    // this fix trusted "a used=true row exists for this phone number", which
    // let an attacker who merely knew a victim's phone number hijack the
    // victim's completed-but-abandoned verification and permanently squat
    // that number on the attacker's own account — no SMS interception needed.
    // Must bind the claim to whoever actually solved the code: the row now
    // carries a single-use signup_claim_token minted at verify time, and the
    // DELETE below only succeeds for the exact token the client was handed —
    // atomic, so a second request (even with a stolen but already-redeemed
    // token) finds zero rows. No token presented (verification was off) ->
    // no-op, matching the gate already skipping unverified users in that case.
    //
    // 30-min recency bound (payments-security-reviewer follow-up, 2026-10-16):
    // the token is single-use and high-entropy, so this isn't closing a live
    // exploit — it's defense-in-depth against a claim token sitting valid
    // indefinitely in the DB for a verification that was never followed
    // through on, with no cleanup cron for this table.
    if (data.user && phoneVerificationToken) {
      const { data: claimedRows } = await (supabaseAdmin
        .from('phone_otp_verifications') as any)
        .delete()
        .eq('phone', phoneNumber)
        .eq('used', true)
        .eq('signup_claim_token', phoneVerificationToken)
        .gte('created_at', new Date(Date.now() - 30 * 60 * 1000).toISOString())
        .select('id')

      if (claimedRows && claimedRows.length > 0) {
        await (supabaseAdmin.from('users') as any)
          .update({ phone_verified: true })
          .eq('id', data.user.id)
      }
    }

    return NextResponse.json({ user: data.user, session: data.session })
  } catch (error) {
    console.error('Signup error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
