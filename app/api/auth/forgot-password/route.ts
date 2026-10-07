import { cookies } from 'next/headers'
import { createRouteClient } from '@/lib/supabase-server'
import { NextRequest, NextResponse } from 'next/server'
import { getPasswordRecoveryUrl, hasTrustedRequestOrigin } from '@/lib/site-url'
import { emailSchema } from '@/lib/validation'

export async function POST(request: NextRequest) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
    }

    if (!request.headers.get('content-type')?.includes('application/json')) {
      return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 })
    }

    const body = await request.json()
    // Deliberately plain emailSchema, NOT accountEmailSchema: this operates on an
    // EXISTING account's email, not a new one. Gating it by domain allowlist would
    // permanently lock a pre-existing user with a non-allowlisted domain out of
    // password recovery (security-review finding, 2026-09-29).
    const validation = emailSchema.safeParse(body.email)

    if (!validation.success) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 })
    }

    const supabase = await createRouteClient()

    const { error } = await supabase.auth.resetPasswordForEmail(validation.data)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    return NextResponse.json({ message: 'Password reset email sent' })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
