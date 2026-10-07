import { createRouteClient } from '@/lib/supabase-server'
import { NextRequest, NextResponse } from 'next/server'
import { hasTrustedRequestOrigin } from '@/lib/site-url'
import { emailSchema } from '@/lib/validation'

/**
 * POST /api/auth/resend-confirmation
 *
 * Resends the signup confirmation email for an unconfirmed account. This is the
 * self-service escape hatch for a user whose confirmation email was delayed,
 * spam-filtered, or missed — without it, an unconfirmed account is a dead end
 * (login is blocked with "confirm your email" and re-signup is blocked because
 * the email/phone already exist).
 *
 * SECURITY (anti-enumeration, mirrors SEC-025 in check-availability): this ALWAYS
 * returns the same generic success message regardless of whether the email exists,
 * is already confirmed, or is unknown. Supabase's resend() leaks that state via its
 * error — we never surface it. Rate-limited in middleware (reuses the signup limiter)
 * and fail-closed on a Redis outage (SIGNUP_FAIL_CLOSED_PATHS).
 */
export async function POST(request: NextRequest) {
    try {
        if (!hasTrustedRequestOrigin(request)) {
            return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
        }

        if (!request.headers.get('content-type')?.includes('application/json')) {
            return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 })
        }

        const body = await request.json().catch(() => ({}))
        // Deliberately plain emailSchema, NOT accountEmailSchema: this operates on an
        // EXISTING account's email. A domain-allowlist failure here is silently
        // swallowed into the generic "sent" response below, which would otherwise
        // strand a pre-existing unconfirmed user on a non-allowlisted domain forever
        // (security-review finding, 2026-09-29).
        const validation = emailSchema.safeParse(body?.email)

        // Uniform generic response used for EVERY outcome below — never disclose
        // whether the address exists or its confirmation state.
        const generic = NextResponse.json({
            message: 'If that email needs confirmation, we have sent a new link. Please check your inbox and spam folder.',
        })

        if (!validation.success) {
            // Even a malformed email gets the generic response (no field-level probing).
            return generic
        }

        const supabase = await createRouteClient()

        // Fire the resend; swallow its result/error entirely so success vs
        // "already confirmed" vs "not found" are indistinguishable to the caller.
        await supabase.auth.resend({ type: 'signup', email: validation.data }).catch(() => {})

        return generic
    } catch {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
