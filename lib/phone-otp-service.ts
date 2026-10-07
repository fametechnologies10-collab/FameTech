import { createServerClient } from '@/lib/supabase'
import { sendPhoneOTPSms } from '@/lib/sms-service'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import crypto from 'crypto'

function generateOTP(): string {
    return Math.floor(100000 + Math.random() * 900000).toString()
}

// Store hashed OTP — raw code is never written to DB
function hashOTP(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex')
}

export interface OtpResult {
    ok: boolean
    status: number
    error?: string
    requiresOtp?: boolean
    // Seconds the client should disable "resend" for. 60s for the first two
    // sends in the rolling hour; once the 3rd (last allowed) send goes out,
    // this jumps to however long is actually left on the per-phone hourly
    // cap — so the UI stops inviting a tap that the server will just reject,
    // and stops burning SMS budget on sends nobody can act on for an hour.
    cooldownSeconds?: number
}

// Extracted from app/api/auth/verify-phone/route.ts (2026-09-30) so the phone-verify-gate
// routes can send/verify OTPs for a SERVER-RESOLVED phone number without that route's
// client-supplied `phone` parameter ever needing to touch the browser for the primary
// "verify your own on-file number" flow. Behavior is unchanged from the original route.
export async function sendPhoneOtp(normalizedPhone: string, ip: string): Promise<OtpResult> {
    const supabase = createServerClient()

    const ipLimit = consumeRateLimit(`otp-send-ip:${ip}`, 5, 10 * 60 * 1000)
    if (!ipLimit.allowed) {
        return { ok: false, status: 429, error: 'Too many requests. Please try again later.' }
    }

    const phoneLimit = consumeRateLimit(`otp-send-phone:${normalizedPhone}`, 3, 60 * 60 * 1000)
    if (!phoneLimit.allowed) {
        return {
            ok: false,
            status: 429,
            error: 'Too many codes sent to this number. Please wait before requesting another.',
            cooldownSeconds: Math.ceil(phoneLimit.retryAfterMs / 1000),
        }
    }
    // This send used up the last of the 3-per-hour budget: the next tap
    // would just be rejected by the check above, so tell the client to wait
    // out the real reset instead of the usual 60s.
    const cooldownSeconds = phoneLimit.remaining === 0 ? Math.ceil(phoneLimit.retryAfterMs / 1000) : 60

    const { data: setting } = await (supabase
        .from('admin_settings') as any)
        .select('value')
        .eq('key', 'phone_verification_enabled')
        .single()

    const isEnabled = setting?.value === true || setting?.value === 'true'
    if (!isEnabled) {
        return { ok: true, status: 200, requiresOtp: false }
    }

    const { data: existing } = await (supabase
        .from('phone_otp_verifications') as any)
        .select('created_at')
        .eq('phone', normalizedPhone)
        .eq('used', false)
        .single()

    if (existing) {
        const sinceCreated = Date.now() - new Date(existing.created_at).getTime()
        if (sinceCreated < 60 * 1000) {
            const secondsLeft = Math.ceil((60 * 1000 - sinceCreated) / 1000)
            return {
                ok: false,
                status: 429,
                error: `Please wait ${secondsLeft}s before requesting another code.`,
                cooldownSeconds: Math.max(secondsLeft, cooldownSeconds),
            }
        }
    }

    const otpCode = generateOTP()
    const otpHash = hashOTP(otpCode)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    // created_at is set explicitly on every send, not left to a DB default —
    // upsert's onConflict path only touches the columns listed here, so on a
    // resend for a phone number that already has a row, an omitted created_at
    // would freeze at that row's very first-ever creation time instead of
    // reflecting the code actually just sent. That stale timestamp fed both
    // the 60s resend-cooldown check above and every freshness check
    // downstream (phone-verify-gate's confirm/recover-complete routes),
    // causing a just-received code to be reported as long expired.
    const { error: dbError } = await (supabase
        .from('phone_otp_verifications') as any)
        .upsert(
            { phone: normalizedPhone, code: otpHash, expires_at: expiresAt, attempts: 0, used: false, created_at: new Date().toISOString() },
            { onConflict: 'phone' }
        )

    if (dbError) {
        console.error('[phone-otp-service] DB upsert error:', dbError.message)
        return { ok: false, status: 500, error: 'Failed to create verification. Please try again.' }
    }

    const smsResult = await sendPhoneOTPSms(normalizedPhone, otpCode)
    if (!smsResult.success) {
        console.error('[phone-otp-service] SMS failed:', smsResult.error)
        return { ok: false, status: 500, error: 'Could not send SMS. Please check the number and try again.' }
    }

    return { ok: true, status: 200, requiresOtp: true, cooldownSeconds }
}

export async function verifyPhoneOtp(normalizedPhone: string, code: string, ip: string): Promise<OtpResult> {
    const supabase = createServerClient()

    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        return { ok: false, status: 400, error: 'Please enter the 6-digit code.' }
    }

    const ipLimit = consumeRateLimit(`otp-verify-ip:${ip}`, 10, 5 * 60 * 1000)
    if (!ipLimit.allowed) {
        return { ok: false, status: 429, error: 'Too many attempts. Please try again later.' }
    }

    const { data: record, error: fetchError } = await (supabase
        .from('phone_otp_verifications') as any)
        .select('*')
        .eq('phone', normalizedPhone)
        .eq('used', false)
        .single()

    if (fetchError || !record) {
        return { ok: false, status: 400, error: 'No active verification found. Please request a new code.' }
    }

    if (new Date(record.expires_at) < new Date()) {
        await (supabase.from('phone_otp_verifications') as any).delete().eq('phone', normalizedPhone)
        return { ok: false, status: 400, error: 'Code expired. Please request a new one.' }
    }

    const newAttempts = (record.attempts ?? 0) + 1

    if (newAttempts > 3) {
        await (supabase.from('phone_otp_verifications') as any).delete().eq('phone', normalizedPhone)
        return { ok: false, status: 400, error: 'Too many wrong attempts. Please request a new code.' }
    }

    const inputHash = hashOTP(code)

    if (record.code !== inputHash) {
        await (supabase
            .from('phone_otp_verifications') as any)
            .update({ attempts: newAttempts })
            .eq('phone', normalizedPhone)
        const remaining = 3 - newAttempts
        return { ok: false, status: 400, error: `Wrong code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` }
    }

    // Atomic mark-as-used: the extra .eq('used', false) means a concurrent
    // request that already flipped the flag will match 0 rows, preventing
    // the same OTP from being accepted twice (TOCTOU fix).
    const { data: updated } = await (supabase
        .from('phone_otp_verifications') as any)
        .update({ used: true })
        .eq('phone', normalizedPhone)
        .eq('used', false)
        .select('id')

    if (!updated || updated.length === 0) {
        return { ok: false, status: 400, error: 'Verification already used. Please request a new code.' }
    }

    return { ok: true, status: 200 }
}
