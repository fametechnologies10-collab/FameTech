import crypto from 'crypto'

// App-lock PIN primitives, shared by app/api/auth/pin/route.ts and routes that
// demand the PIN as step-up proof (e.g. /api/shop/withdraw).

export function hashPin(pin: string, salt: string): string {
    // 100,000 iterations of PBKDF2-SHA512 to prevent brute-force of the 6-digit PIN
    return crypto.pbkdf2Sync(pin, salt, 100000, 64, 'sha512').toString('hex')
}

// Constant-time compare of a candidate PIN against a stored hash.
export function pinMatches(candidate: string, salt: string, storedHash: string): boolean {
    const inputBuf = Buffer.from(hashPin(candidate, salt), 'hex')
    const storedBuf = Buffer.from(storedHash, 'hex')
    return inputBuf.length === storedBuf.length && crypto.timingSafeEqual(inputBuf, storedBuf)
}

export type PinCheck =
    | { status: 'not_set' }
    | { status: 'ok' }
    | { status: 'required' }
    | { status: 'locked' }
    | { status: 'wrong'; attemptsRemaining: number }

const MAX_PIN_ATTEMPTS = 5
const PIN_LOCK_MS = 30 * 60 * 1000

/**
 * Checks `pin` against the user's app-lock PIN using the same attempt counter and
 * 30-minute lockout as the `verify` action. `admin` must be a service-role client
 * (the PIN columns are pinned against client-session writes).
 *
 * `not_set` means the user has no PIN, so there is nothing to enforce.
 */
export async function checkUserPin(admin: any, userId: string, pin: string | undefined): Promise<PinCheck> {
    const { data } = await admin
        .from('users')
        .select('pin_hash, pin_salt, pin_attempts, pin_locked_until')
        .eq('id', userId)
        .single()

    if (!data?.pin_hash) return { status: 'not_set' }
    if (!pin) return { status: 'required' }

    if (data.pin_locked_until && new Date(data.pin_locked_until) > new Date()) {
        return { status: 'locked' }
    }

    // Legacy PINs set before the per-user salt migration verify against the user id.
    const salt: string = data.pin_salt || userId
    if (pinMatches(pin, salt, data.pin_hash)) {
        if ((data.pin_attempts || 0) > 0 || data.pin_locked_until) {
            await admin.from('users').update({ pin_attempts: 0, pin_locked_until: null }).eq('id', userId)
        }
        return { status: 'ok' }
    }

    // Record the failure with compare-and-swap on the counter we read: two concurrent
    // wrong guesses can no longer both write the same value (which would let extra guesses
    // land before the lockout). The loser re-reads and increments from the fresh value.
    let observed: number | null = data.pin_attempts ?? null
    let lockActive = !!data.pin_locked_until   // an expired lock restarts the counter
    let attempts = 0
    for (let i = 0; i < 5; i++) {
        attempts = (lockActive ? 0 : (observed || 0)) + 1
        const update: Record<string, unknown> = { pin_attempts: attempts }
        update.pin_locked_until = attempts >= MAX_PIN_ATTEMPTS ? new Date(Date.now() + PIN_LOCK_MS).toISOString() : null
        let q = admin.from('users').update(update).eq('id', userId)
        q = observed === null ? q.is('pin_attempts', null) : q.eq('pin_attempts', observed)
        const { data: written } = await q.select('id')
        if (written && written.length > 0) break
        const { data: fresh } = await admin.from('users').select('pin_attempts, pin_locked_until').eq('id', userId).single()
        observed = fresh?.pin_attempts ?? null
        // A concurrent guess may have just locked the account.
        if (fresh?.pin_locked_until && new Date(fresh.pin_locked_until) > new Date()) return { status: 'locked' }
        lockActive = !!fresh?.pin_locked_until   // present but not in the future = expired lock
    }

    return attempts >= MAX_PIN_ATTEMPTS
        ? { status: 'locked' }
        : { status: 'wrong', attemptsRemaining: MAX_PIN_ATTEMPTS - attempts }
}
