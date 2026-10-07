/**
 * Hubtel Receive Money — first-time-number OTP anti-fraud gate.
 *
 * Hubtel's Direct Receive Money rail requires that we confirm a first-time
 * payer actually owns the MoMo number being charged (server-initiated debit —
 * there is no checkoutUrl/redirect for the customer to confirm on). This module
 * mirrors app/api/auth/verify-phone/route.ts's OTP mechanics (6-digit code,
 * sha256 hash-only storage, 10-min expiry, 3-attempt cap, atomic mark-used) but
 * against a SEPARATE, PERMANENT allowlist table (`verified_phone_numbers`) so a
 * number only ever needs to clear this gate once.
 *
 * CRITICAL: every phone value that touches this module — and every caller of
 * isNumberVerified — MUST be the canonical 233XXXXXXXXX MSISDN produced by
 * toMsisdn233 (lib/hubtel-commission-service.ts). The storefront charge (a
 * later task) looks up isNumberVerified(db, cleanPhone233) using the SAME
 * string it sends Hubtel as CustomerMsisdn — mixing 0XXXXXXXXX and 233...
 * forms here would silently break that lookup.
 */
import crypto from 'crypto'
import { sendPhoneOTPSms } from '@/lib/sms-service'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

// Store hashed OTP — raw code is never written to DB. Identical algorithm to
// verify-phone's hashOTP so a reader auditing either table sees the same format.
export function hashOtp(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex')
}

function generateOTP(): string {
    return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/**
 * True iff `phone233` already has a row in the permanent allowlist
 * (verified_phone_numbers). `db` is typed `any` so both the real Supabase
 * service-role client and a stubbed test double can be passed.
 */
export async function isNumberVerified(db: any, phone233: string): Promise<boolean> {
    const { data } = await db
        .from('verified_phone_numbers')
        .select('phone')
        .eq('phone', phone233)
        .maybeSingle()

    return !!data
}

/**
 * Permanently allowlist `phone233` after a successful OTP confirmation.
 * ON CONFLICT (phone) DO NOTHING — idempotent, never overwrites
 * first_verified_at/verified_via for a number that's already trusted.
 */
export async function markNumberVerified(db: any, phone233: string): Promise<void> {
    const { error } = await db
        .from('verified_phone_numbers')
        .upsert(
            { phone: phone233, verified_via: 'sms_otp' },
            { onConflict: 'phone', ignoreDuplicates: true }
        )

    if (error) {
        // Best-effort: the OTP itself already succeeded (phone_otp_verifications
        // row is marked used), so a failure to write the allowlist row should not
        // fail the confirm request — the caller returns { verified: true }
        // regardless and the number is simply re-OTP'd on the payer's next charge.
        console.error('[number-verification] markNumberVerified upsert error:', error.message)
    }
}

/**
 * Shared OTP-send core, extracted from app/api/shop/verify-number's 'send' action so
 * a second caller — the Hubtel utility charge route's pre-charge verification step —
 * can reuse the exact same rate-limiting/cooldown/storage mechanics without duplicating
 * them. `opts.verifyReference`/`opts.pendingCharge` are the charge-route's addition:
 * stashing a transient UTLV- reference + the exact params needed to replay the charge
 * once the OTP is confirmed (see runHubtelUtilityCharge in lib/hubtel-checkout.ts).
 * verify-number's own 'send' action calls this with no opts and behaves identically
 * to before this extraction.
 */
export async function sendVerificationOtp(
    db: any,
    phone233: string,
    ip: string,
    opts?: { verifyReference?: string; pendingCharge?: unknown },
): Promise<{ ok: boolean; status?: number; error?: string; alreadyVerified?: boolean }> {
    // Already-trusted number — never re-OTP a repeat payer, and don't burn
    // rate-limit budget doing so.
    if (await isNumberVerified(db, phone233)) {
        return { ok: true, alreadyVerified: true }
    }

    // Per-IP: max 5 send attempts per 10 minutes
    const ipLimit = consumeRateLimit(`verify-number-send-ip:${ip}`, 5, 10 * 60 * 1000)
    if (!ipLimit.allowed) {
        return { ok: false, status: 429, error: 'Too many requests. Please try again later.' }
    }

    // Per-phone: max 3 OTPs per hour
    const phoneLimit = consumeRateLimit(`verify-number-send-phone:${phone233}`, 3, 60 * 60 * 1000)
    if (!phoneLimit.allowed) {
        return { ok: false, status: 429, error: 'Too many codes sent to this number. Please wait before requesting another.' }
    }

    // NOTE: deliberately does NOT gate on admin_settings.phone_verification_enabled
    // — that toggle is signup-only. This anti-fraud OTP is always required here.

    // Server-side 60s resend cooldown — prevents bypassing a client-side timer
    const { data: existing } = await db
        .from('phone_otp_verifications')
        .select('created_at')
        .eq('phone', phone233)
        .eq('used', false)
        .maybeSingle()

    if (existing) {
        const sinceCreated = Date.now() - new Date(existing.created_at).getTime()
        if (sinceCreated < 60 * 1000) {
            const secondsLeft = Math.ceil((60 * 1000 - sinceCreated) / 1000)
            return { ok: false, status: 429, error: `Please wait ${secondsLeft}s before requesting another code.` }
        }
    }

    const otpCode = generateOTP()
    const otpHash = hashOtp(otpCode) // Never store raw OTP
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    const { error: dbError } = await db
        .from('phone_otp_verifications')
        .upsert(
            {
                phone: phone233, code: otpHash, expires_at: expiresAt, attempts: 0, used: false,
                verify_reference: opts?.verifyReference ?? null,
                pending_charge: opts?.pendingCharge ?? null,
            },
            { onConflict: 'phone' },
        )

    if (dbError) {
        console.error('[number-verification] sendVerificationOtp upsert error:', dbError.message)
        return { ok: false, status: 500, error: 'Failed to create verification. Please try again.' }
    }

    const smsResult = await sendPhoneOTPSms(phone233, otpCode)
    if (!smsResult.success) {
        console.error('[number-verification] sendVerificationOtp SMS error:', smsResult.error)
        return { ok: false, status: 500, error: 'Could not send SMS. Please check the number and try again.' }
    }

    return { ok: true }
}

// `includeUsed` lets the verify_reference lookup path (only) see an already-used row —
// needed so a retried confirm against a charge that already went through can be answered
// from its cached result instead of a bare "already used" error. The phone-keyed lookup
// (verify-number's own 'confirm' action) never sets this — unchanged from before this file
// grew a replay concern of its own.
async function loadOtpRecord(db: any, where: { phone?: string; verifyReference?: string }, includeUsed = false): Promise<any> {
    let q = db.from('phone_otp_verifications').select('*')
    if (!includeUsed) q = q.eq('used', false)
    q = where.phone ? q.eq('phone', where.phone) : q.eq('verify_reference', where.verifyReference)
    const { data } = await q.maybeSingle()
    return data
}

/**
 * Persists the result of replaying a stashed charge (runHubtelUtilityCharge) onto the
 * now-used OTP row, so a retried submit-otp call against the same verify_reference can
 * return this cached result instead of erroring — see confirmVerificationOtp's
 * alreadyProcessed branch and app/api/shop/charge/submit-otp's UTLV- branch.
 */
export async function cacheChargeResult(db: any, recordId: string, result: unknown): Promise<void> {
    const { error } = await db.from('phone_otp_verifications').update({ charge_result: result }).eq('id', recordId)
    if (error) console.error('[number-verification] cacheChargeResult error:', error.message)
}

/**
 * Shared OTP-confirm core, extracted from app/api/shop/verify-number's 'confirm'
 * action. Looks up the active row either by phone (verify-number's own caller,
 * which already knows the phone) or by verify_reference (the Hubtel charge route's
 * submit-otp replay, which only has the transient UTLV- reference + the code —
 * never the phone itself, since submit-otp is shared across every storefront
 * product's OTP step and only ever forwards {reference, otp}).
 *
 * Mutates by row id (not by phone) so the verify_reference lookup path is race-safe
 * even though it doesn't know the phone up front.
 */
export async function confirmVerificationOtp(
    db: any,
    code: string,
    ip: string,
    where: { phone?: string; verifyReference?: string },
): Promise<{
    ok: boolean; status?: number; error?: string; phone233?: string; pendingCharge?: unknown
    recordId?: string; alreadyProcessed?: boolean; cachedResult?: unknown
}> {
    // Per-IP: max 10 verify attempts per 5 minutes (cross-session brute-force guard)
    const ipLimit = consumeRateLimit(`verify-number-verify-ip:${ip}`, 10, 5 * 60 * 1000)
    if (!ipLimit.allowed) {
        return { ok: false, status: 429, error: 'Too many attempts. Please try again later.' }
    }

    // The verify_reference lookup path includes already-used rows (see loadOtpRecord) — a
    // retried confirm against a charge that already replayed successfully lands here.
    const record = await loadOtpRecord(db, where, !!where.verifyReference)
    if (!record) {
        return { ok: false, status: 400, error: 'No active verification found. Please request a new code.' }
    }

    if (record.used) {
        // Still require proof of knowing the code before handing back a cached result —
        // otherwise anyone who obtains the verify_reference by some other means (shared-device
        // history, a logging layer, a pasted support screenshot) could read a completed
        // charge's result without ever knowing the OTP. verify_reference is high-entropy
        // (64 random bits) so this isn't practically brute-forceable, but the code check
        // costs nothing and closes the gap architecturally.
        if (record.charge_result && hashOtp(code) === record.code) {
            return { ok: true, alreadyProcessed: true, cachedResult: record.charge_result, recordId: record.id }
        }
        // Either the code doesn't match, or it's used but not yet cached — the winning request
        // may still be mid-flight (between marking used and finishing the charge/caching its
        // result) or it crashed before caching. Either way there is nothing to replay yet; tell
        // the caller to wait rather than claim outright failure for a charge that may still
        // succeed, and never reveal whether the supplied code was actually correct on an
        // already-used row.
        return { ok: false, status: 409, error: 'This payment is already being processed. Please wait a moment before retrying.' }
    }

    if (new Date(record.expires_at) < new Date()) {
        await db.from('phone_otp_verifications').delete().eq('id', record.id)
        return { ok: false, status: 400, error: 'Code expired. Please request a new one.' }
    }

    // Fast-path only — a row already at the cap from a genuinely earlier request. The
    // authoritative cap enforcement is the atomic RPC below, which is what actually closes
    // the concurrent-wrong-guess race (two parallel submissions can no longer both read the
    // same starting `attempts` and both under-count the increment).
    if ((record.attempts ?? 0) >= 3) {
        await db.from('phone_otp_verifications').delete().eq('id', record.id)
        return { ok: false, status: 400, error: 'Too many wrong attempts. Please request a new code.' }
    }

    const inputHash = hashOtp(code)
    if (record.code !== inputHash) {
        const { data: bumped, error: bumpError } = await db.rpc('bump_otp_attempts', { p_id: record.id })
        if (bumpError) {
            // Fail CLOSED, never open: falling back to a locally-computed attempts+1 here would
            // both under-report to the caller AND never persist (the write that would have
            // recorded it failed), so a persistently-failing RPC would silently reintroduce the
            // exact race this fix exists to close — every subsequent guess would re-read the
            // same stale `attempts` and the cap would never actually bind. Treat any RPC failure
            // as exhausted instead.
            console.error('[number-verification] bump_otp_attempts error:', bumpError.message)
            await db.from('phone_otp_verifications').delete().eq('id', record.id)
            return { ok: false, status: 500, error: 'Could not verify the code right now. Please request a new one.' }
        }
        const newAttempts = bumped?.[0]?.attempts
        if (typeof newAttempts !== 'number') {
            // RPC ran but matched 0 rows — a concurrent request already flipped `used` between
            // our read above and this call. Report it as such rather than guessing a count.
            return { ok: false, status: 400, error: 'Verification already used. Please request a new code.' }
        }
        if (newAttempts > 3) {
            await db.from('phone_otp_verifications').delete().eq('id', record.id)
            return { ok: false, status: 400, error: 'Too many wrong attempts. Please request a new code.' }
        }
        const remaining = 3 - newAttempts
        return { ok: false, status: 400, error: `Wrong code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` }
    }

    // Atomic mark-as-used: the extra .eq('used', false) means a concurrent request
    // that already flipped the flag will match 0 rows, preventing the same OTP from
    // being accepted twice (TOCTOU fix).
    const { data: updated } = await db
        .from('phone_otp_verifications')
        .update({ used: true })
        .eq('id', record.id)
        .eq('used', false)
        .select('id')

    if (!updated || updated.length === 0) {
        return { ok: false, status: 400, error: 'Verification already used. Please request a new code.' }
    }

    // Permanently allowlist this number — future charges skip the OTP entirely.
    await markNumberVerified(db, record.phone)

    return { ok: true, phone233: record.phone, pendingCharge: record.pending_charge, recordId: record.id }
}
