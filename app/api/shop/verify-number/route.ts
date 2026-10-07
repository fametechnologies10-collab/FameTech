import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { hasTrustedRequestOrigin } from '@/lib/site-url'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { toMsisdn233 } from '@/lib/hubtel-commission-service'
import { sendVerificationOtp, confirmVerificationOtp } from '@/lib/hubtel-receive/number-verification'

/**
 * Guest, no-auth first-time-number OTP gate for Hubtel Receive Money charges.
 * Mirrors app/api/auth/verify-phone/route.ts's mechanics (6-digit code, sha256
 * hash-only storage, 10-min expiry, 3-attempt cap, atomic mark-used) but writes
 * confirmed numbers to the PERMANENT allowlist (verified_phone_numbers) instead
 * of gating on the signup-only `phone_verification_enabled` admin setting — this
 * anti-fraud OTP is always required for a number Hubtel hasn't seen us confirm
 * before. Once a number clears it once, isNumberVerified() short-circuits every
 * future charge attempt for that number (see step 1 of the 'send' action).
 *
 * The actual OTP send/confirm mechanics live in lib/hubtel-receive/number-verification.ts
 * (sendVerificationOtp/confirmVerificationOtp) — shared with the utility charge route's
 * pre-charge verification step, which reuses them with a stashed replay payload. This
 * route is a thin wrapper that preserves its own pre-existing external behavior exactly.
 */

function getClientIp(request: NextRequest): string {
    return (
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        'unknown'
    )
}

export async function POST(request: NextRequest) {
    // Reject cross-origin requests (same guard as /api/auth/verify-phone)
    if (!hasTrustedRequestOrigin(request)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const contentType = request.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
        return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 })
    }

    let body: any
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { action, phone, code } = body

    if (!action || !phone) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const phoneValidation = validateGhanaianPhone(String(phone))
    if (!phoneValidation.isValid) {
        return NextResponse.json({ error: phoneValidation.error || 'Invalid phone number' }, { status: 400 })
    }

    // Canonical MSISDN — everything downstream (this route, phone_otp_verifications,
    // verified_phone_numbers, and the later storefront charge's CustomerMsisdn) keys
    // on this exact 233XXXXXXXXX string. Never mix in the 0XXXXXXXXX form.
    const phone233 = toMsisdn233(phoneValidation.normalizedNumber!)
    const ip = getClientIp(request)
    const db = createServerClient() as any

    // ── SEND OTP ────────────────────────────────────────────────────────────────
    if (action === 'send') {
        const result = await sendVerificationOtp(db, phone233, ip)
        if (result.alreadyVerified) {
            return NextResponse.json({ verified: true })
        }
        if (!result.ok) {
            return NextResponse.json({ error: result.error }, { status: result.status || 500 })
        }
        return NextResponse.json({ verified: false, otp_sent: true })
    }

    // ── CONFIRM OTP ─────────────────────────────────────────────────────────────
    if (action === 'confirm') {
        // Enforce digit-only 6-char string — rejects spaces, letters, etc.
        if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
            return NextResponse.json({ error: 'Please enter the 6-digit code.' }, { status: 400 })
        }

        const result = await confirmVerificationOtp(db, code, ip, { phone: phone233 })
        if (!result.ok) {
            return NextResponse.json({ error: result.error }, { status: result.status || 500 })
        }
        return NextResponse.json({ verified: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
