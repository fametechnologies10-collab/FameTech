import crypto from 'crypto'

const TOKEN_TTL_MS = 5 * 60 * 1000

// e.g. "0551234534" -> "05••••••34" — never reveals more than the fixed
// first-2/last-2 pattern. validateGhanaianPhone already guarantees every
// stored phone_number is exactly 10 digits, but a legacy/malformed row must
// never leak its true length via the bullet count, so the fallback is a
// fixed-width mask, not '•'.repeat(phone.length).
export function maskPhoneHint(phone: string): string {
    if (phone.length !== 10) return '••••••••••'
    return `${phone.slice(0, 2)}${'•'.repeat(6)}${phone.slice(-2)}`
}

// Short-lived proof that this user already passed the old-number hint check,
// so "set new number" can't be reached by skipping straight past it.
export function signRecoveryToken(userId: string): string {
    const expires = Date.now() + TOKEN_TTL_MS
    const payload = `${userId}.${expires}`
    const sig = crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY!).update(payload).digest('hex')
    return `${payload}.${sig}`
}

export function verifyRecoveryToken(token: string, userId: string): boolean {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const [tokenUserId, expiresStr, sig] = parts
    if (tokenUserId !== userId) return false
    const expires = Number(expiresStr)
    if (!Number.isFinite(expires) || Date.now() > expires) return false

    const payload = `${tokenUserId}.${expiresStr}`
    const expectedSig = crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY!).update(payload).digest('hex')
    const a = Buffer.from(sig)
    const b = Buffer.from(expectedSig)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
}
