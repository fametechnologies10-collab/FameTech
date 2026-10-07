import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { accountEmailSchema, phoneSchema } from '@/lib/validation'
import { createServerClient } from '@/lib/supabase'
import { hasTrustedRequestOrigin } from '@/lib/site-url'

const schema = z.object({
    email: accountEmailSchema.optional(),
    phoneNumber: phoneSchema.optional(),
}).refine(d => d.email || d.phoneNumber, {
    message: 'At least one of email or phoneNumber is required',
})

export async function POST(request: NextRequest) {
    if (!hasTrustedRequestOrigin(request)) {
        return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
    }

    const contentType = request.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
        return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 })
    }

    let body: unknown
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = schema.safeParse(body)
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid input' }, { status: 400 })
    }

    const { email, phoneNumber } = parsed.data
    const admin = createServerClient()

    const checks = await Promise.all([
        email
            ? (admin.from('users') as any).select('id').eq('email', email).maybeSingle()
            : Promise.resolve({ data: null }),
        phoneNumber
            ? (admin.from('users') as any).select('id').eq('phone_number', phoneNumber).maybeSingle()
            : Promise.resolve({ data: null }),
    ])

    // SEC-025: return a single generic shape that does not disclose which
    // identifier (email/phone/both) is taken, to prevent account enumeration.
    const available = !checks[0].data && !checks[1].data

    return NextResponse.json({ available })
}
