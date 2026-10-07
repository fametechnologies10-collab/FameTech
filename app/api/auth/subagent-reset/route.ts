import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { hasTrustedRequestOrigin } from '@/lib/site-url'
import { emailSchema } from '@/lib/validation'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { beginSelfServiceReset, padToResponseFloor } from '@/lib/sub-agent-key'
import { sendSMS } from '@/lib/sms-service'
import { sendEmail } from '@/lib/email-service'

function genericResponse() {
    return NextResponse.json({
        success: true,
        message: "If that account exists, reset instructions have been sent.",
    })
}

export async function POST(request: NextRequest) {
    const startedAt = Date.now()

    if (!hasTrustedRequestOrigin(request)) {
        return NextResponse.json({ success: false, error: 'Invalid request origin' }, { status: 403 })
    }

    const body = await request.json().catch(() => null)
    const channel = body?.channel === 'sms' ? 'sms' : body?.channel === 'email' ? 'email' : null
    if (!channel) {
        return NextResponse.json({ success: false, error: 'channel must be "email" or "sms"' }, { status: 400 })
    }

    let identifier: { type: 'email' | 'phone'; value: string } | null = null
    if (channel === 'email') {
        // Deliberately plain emailSchema, NOT accountEmailSchema: this looks up an
        // EXISTING sub-agent's email. Gating by domain allowlist would permanently
        // strand a pre-existing sub-agent on a non-allowlisted domain with no way to
        // self-service reset (security-review finding, 2026-09-29).
        const parsed = emailSchema.safeParse(body?.identifier)
        if (parsed.success) identifier = { type: 'email', value: parsed.data }
    } else {
        const parsed = validateGhanaianPhone(String(body?.identifier ?? ''))
        if (parsed.isValid) identifier = { type: 'phone', value: parsed.normalizedNumber }
    }

    if (!identifier) {
        // Still generic — do not reveal that validation (vs. lookup) is what
        // failed. Also pad to the same response floor beginSelfServiceReset's
        // exit paths use below — otherwise a malformed identifier would
        // return measurably faster than every other outcome from this route,
        // a distinguishable (if not account-specific) timing class.
        await padToResponseFloor(startedAt)
        return genericResponse()
    }

    const db = createServerClient()
    await beginSelfServiceReset(db, identifier, channel, { sendSms: sendSMS, sendEmail })

    return genericResponse()
}
