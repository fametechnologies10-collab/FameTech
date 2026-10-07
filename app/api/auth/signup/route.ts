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
      phoneNumber: phoneSchema
    })

    const validation = signupSchema.safeParse(body)
    if (!validation.success) {
      const errorDetails = validation.error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
      return NextResponse.json({ error: 'Invalid input', details: errorDetails }, { status: 400 })
    }

    const { email, password, firstName, lastName, phoneNumber } = validation.data

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

    return NextResponse.json({ user: data.user, session: data.session })
  } catch (error) {
    console.error('Signup error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
