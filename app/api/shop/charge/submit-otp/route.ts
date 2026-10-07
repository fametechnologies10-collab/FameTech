import { NextRequest, NextResponse } from 'next/server'
import { confirmVerificationOtp, cacheChargeResult } from '@/lib/hubtel-receive/number-verification'
import { runHubtelUtilityCharge, type HubtelUtilityChargeParams } from '@/lib/hubtel-checkout'

// Minimal runtime shape guard for a jsonb round-trip — pending_charge is always
// server-written (see app/api/shop/utility/charge/route.ts), but this turns a future
// schema-drift/manual-edit bug into the existing "session expired" branch instead of an
// unhandled exception when runHubtelUtilityCharge dereferences metadataPayload fields.
function isPlausiblePendingCharge(v: unknown): v is HubtelUtilityChargeParams {
    if (!v || typeof v !== 'object') return false
    const p = v as Record<string, unknown>
    return (
        !!p.shop && typeof p.shop === 'object' &&
        typeof p.momo233 === 'string' &&
        !!p.metadataPayload && typeof p.metadataPayload === 'object' &&
        typeof (p.metadataPayload as any).biller === 'string' &&
        typeof (p.metadataPayload as any).account_number === 'string' &&
        typeof p.totalAmountPesewas === 'number'
    )
}

const otpRateLimit = new Map<string, { count: number; resetTime: number }>()
function otpCleanup() { const now = Date.now(); for (const [k, v] of otpRateLimit.entries()) if (v.resetTime < now) otpRateLimit.delete(k) }

export async function POST(request: NextRequest) {
    try {
        otpCleanup()
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
        const rl = otpRateLimit.get(ip) || { count: 0, resetTime: Date.now() + 60000 }
        if (rl.count >= 10 && rl.resetTime > Date.now()) {
            return NextResponse.json({ error: 'Too many attempts. Please wait a minute.' }, { status: 429 })
        }
        rl.count++; otpRateLimit.set(ip, rl)

        const body = await request.json().catch(() => null)
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }
        const { reference, otp } = body
        if (!reference || typeof reference !== 'string' || !/^(SHOP-|RC-|SHOPAFA-|UTLP-|UTLV-)[A-Za-z0-9-]{1,90}$/.test(reference) || reference.length > 100) {
            return NextResponse.json({ error: 'Invalid reference' }, { status: 400 })
        }
        if (!otp || typeof otp !== 'string' || otp.trim() === '' || otp.length > 12) {
            return NextResponse.json({ error: 'OTP is required' }, { status: 400 })
        }

        // ── UTLV- : Hubtel pre-charge MoMo-number verification, NOT a Paystack OTP ──
        // This reference never reaches Paystack — it identifies a phone_otp_verifications
        // row (see lib/hubtel-receive/number-verification.ts). On a correct code, replay
        // the stashed Hubtel charge (runHubtelUtilityCharge) using the SAME shared 'otp'
        // step ServiceChargeSheet already has for Paystack's send_otp.
        if (reference.startsWith('UTLV-')) {
            const { createServerClient } = await import('@/lib/supabase')
            const db = createServerClient() as any
            const confirmResult = await confirmVerificationOtp(db, otp, ip, { verifyReference: reference })

            if (!confirmResult.ok) {
                // A wrong code is retryable in-place (stays on the same UTLV- reference);
                // everything else (expired, too many attempts, not found, already-processing) is
                // terminal — the row is gone (or the winning request is still in flight), so a
                // retry would just error again.
                const retryable = confirmResult.error?.startsWith('Wrong code')
                return NextResponse.json({
                    status: retryable ? 'send_otp' : 'failed',
                    display_text: confirmResult.error || 'Verification failed',
                })
            }

            // Replay of a confirm that already succeeded (the original response never made it
            // back to the browser) — return the cached outcome instead of re-running the charge.
            if (confirmResult.alreadyProcessed) {
                const cached = confirmResult.cachedResult as { body: Record<string, unknown>; httpStatus: number } | undefined
                if (cached && typeof cached.httpStatus === 'number') {
                    return NextResponse.json(cached.body, { status: cached.httpStatus })
                }
                return NextResponse.json({ status: 'failed', display_text: 'This verification code was already used.' })
            }

            const pending = confirmResult.pendingCharge
            if (!isPlausiblePendingCharge(pending)) {
                return NextResponse.json({ status: 'failed', display_text: 'Verification session expired. Please try again.' })
            }

            const result = await runHubtelUtilityCharge(db, pending)
            if (confirmResult.recordId) await cacheChargeResult(db, confirmResult.recordId, result)
            return NextResponse.json(result.body, { status: result.httpStatus })
        }

        const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
        if (!PAYSTACK_SECRET_KEY) {
            return NextResponse.json({ error: 'Payment service unavailable' }, { status: 503 })
        }

        const res = await fetch('https://api.paystack.co/charge/submit_otp', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reference, otp }),
        })
        const data = await res.json()
        if (!data.status || !data.data) {
            console.error('[Shop ChargeOTP] OTP submission failed:', data)
            const safeMessage = typeof data.message === 'string' && data.message.length > 0 && data.message.length < 200
                ? data.message
                : 'OTP submission failed'
            return NextResponse.json({ error: safeMessage }, { status: 502 })
        }
        return NextResponse.json({
            status: data.data.status,
            display_text: data.data.display_text || data.data.message || '',
        })
    } catch (error) {
        console.error('[Shop ChargeOTP] Unhandled error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
