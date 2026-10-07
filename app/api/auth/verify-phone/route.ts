import { NextRequest, NextResponse } from 'next/server'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { hasTrustedRequestOrigin } from '@/lib/site-url'
import { sendPhoneOtp, verifyPhoneOtp } from '@/lib/phone-otp-service'

function getClientIp(request: NextRequest): string {
    return (
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        'unknown'
    )
}

export async function POST(request: NextRequest) {
    // Reject cross-origin requests (same guard as /api/auth/signup)
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

    const normalizedPhone = phoneValidation.normalizedNumber!
    const ip = getClientIp(request)

    if (action === 'send') {
        const result = await sendPhoneOtp(normalizedPhone, ip)
        if (!result.ok) {
            return NextResponse.json({ error: result.error, cooldownSeconds: result.cooldownSeconds }, { status: result.status })
        }
        if (result.requiresOtp === false) {
            return NextResponse.json({ requires_otp: false })
        }
        return NextResponse.json({ requires_otp: true, success: true, cooldownSeconds: result.cooldownSeconds })
    }

    if (action === 'verify') {
        const result = await verifyPhoneOtp(normalizedPhone, String(code), ip)
        if (!result.ok) {
            return NextResponse.json({ error: result.error }, { status: result.status })
        }
        return NextResponse.json({ success: true, verified: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
