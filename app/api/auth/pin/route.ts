import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerAnonClient, createServerClient } from '@/lib/supabase'

/**
 * PIN Management API
 *
 * POST /api/auth/pin — Manage the user's 6-digit app-lock PIN
 * Body: { action: 'set' | 'verify' | 'status' | 'remove' | 'dismiss', pin?, currentPin?, password?, reminder? }
 *
 * The PIN is hashed with PBKDF2 (SHA-512, 100k iterations) using a per-user
 * random salt, stored in `pin_hash` on the `users` table. RLS ensures each user
 * can only read/write their own row. Brute-force is mitigated by a 5-attempt
 * lockout (30 min cooldown) shared across the `verify` action and the step-up
 * check below (a wrong current-PIN or account-password guess on `set`/`remove`
 * counts against the same counter).
 *
 * STEP-UP (SEC): changing (overwriting) or removing an EXISTING PIN now requires
 * proof — either the current PIN, or the account password. This closes the gap
 * where a briefly-unlocked session could silently disable the app-lock, AND it
 * powers the "Forgot PIN" recovery on the lock screen: the user proves their
 * password, then either sets a NEW PIN or disables it (no more permanent lockout).
 * First-time PIN setup (no existing pin_hash) stays open — only the session is required.
 */

import crypto from 'crypto'

function hashPin(pin: string, salt: string): string {
    // Enterprise-grade PBKDF2 hashing for the 6-digit PIN
    // Uses 100,000 iterations of SHA-512 to prevent brute-force attacks
    return crypto.pbkdf2Sync(pin, salt, 100000, 64, 'sha512').toString('hex')
}

// 16 random bytes → 32-char hex string. Stored on the user row in `pin_salt`.
// Makes each user's PIN hash unique even if two users pick the same PIN.
function generatePinSalt(): string {
    return crypto.randomBytes(16).toString('hex')
}

// Constant-time compare of a candidate PIN against a stored hash.
function pinMatches(candidate: string, salt: string, storedHash: string): boolean {
    const inputBuf = Buffer.from(hashPin(candidate, salt), 'hex')
    const storedBuf = Buffer.from(storedHash, 'hex')
    return inputBuf.length === storedBuf.length && crypto.timingSafeEqual(inputBuf, storedBuf)
}

// Verifies the account password WITHOUT touching the caller's cookie session.
// Uses the anon client (persistSession:false) so a successful sign-in here does
// not rotate or clobber the user's real session tokens. Returns true iff the
// password is correct for `email`.
async function verifyAccountPassword(email: string | undefined, password: unknown): Promise<boolean> {
    if (!email || typeof password !== 'string' || password.length === 0 || password.length > 128) return false
    try {
        const anon = createServerAnonClient()
        const { error } = await anon.auth.signInWithPassword({ email, password })
        return !error
    } catch {
        return false
    }
}

export async function POST(request: Request) {
    try {
        const authClient = await createRouteClient()

        const { data: { user } } = await authClient.auth.getUser()
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // SEC (F6, 2026-09-28): the PIN columns are pinned against client-session writes by
        // guard_users_privilege_change — otherwise a session holder could reset
        // pin_attempts/pin_locked_until (escaping the lockout) or overwrite pin_hash directly
        // via REST, bypassing the step-up below. So every PIN read/write here goes through the
        // service role, and EVERY query stays scoped to .eq('id', user.id) — the caller's
        // identity still comes only from the verified session above.
        const supabase = createServerClient() as any

        const body = await request.json()
        const { pin, action, currentPin, password } = body

        if (!action) {
            return NextResponse.json({ error: 'Action required' }, { status: 400 })
        }

        // ─── STATUS: Check if PIN is configured ───
        if (action === 'status') {
            const { data: userData } = await supabase
                .from('users')
                .select('pin_hash, pin_reminder')
                .eq('id', user.id)
                .single()

            return NextResponse.json({
                hasPin: !!(userData as any)?.pin_hash,
                pinReminder: (userData as any)?.pin_reminder || null,
            })
        }

        // ─── SET: Create or update PIN ───
        if (action === 'set') {
            if (!pin || pin.length !== 6 || !/^\d{6}$/.test(pin)) {
                return NextResponse.json({ error: 'PIN must be exactly 6 digits' }, { status: 400 })
            }

            // Read the existing PIN state to decide whether step-up is needed.
            const { data: existing } = await (supabase
                .from('users') as any)
                .select('pin_hash, pin_salt, pin_locked_until, pin_attempts')
                .eq('id', user.id)
                .single()
            const ex = existing as any

            // Overwriting an EXISTING PIN requires proof (current PIN or password).
            // First-time setup (no pin_hash) is allowed on the session alone.
            if (ex?.pin_hash) {
                const stepUp = await verifyStepUp(supabase, user.id, ex, currentPin, password, user.email, user.id)
                if (stepUp.locked) {
                    return NextResponse.json({
                        error: 'PIN locked. Too many failed attempts. Use your account password to reset it.',
                        locked: true,
                    }, { status: 423 })
                }
                if (!stepUp.ok) {
                    return NextResponse.json(
                        { error: 'Verification required. Enter your current PIN or your account password to change it.' },
                        { status: 401 }
                    )
                }
            }

            // New PINs always get a fresh random salt. Legacy PINs that pre-date
            // the salt migration continue to verify against user.id until re-set,
            // at which point they auto-upgrade.
            const pinSalt = generatePinSalt()
            const pinHash = hashPin(pin, pinSalt)

            const { error } = await (supabase
                .from('users') as any)
                .update({
                    pin_hash: pinHash,
                    pin_salt: pinSalt,
                    pin_attempts: 0,
                    pin_locked_until: null,
                })
                .eq('id', user.id)

            if (error) {
                return NextResponse.json({ error: 'Failed to set PIN' }, { status: 500 })
            }

            return NextResponse.json({ success: true, message: 'PIN set successfully' })
        }

        // ─── VERIFY: Check PIN against stored hash ───
        if (action === 'verify') {
            if (!pin || pin.length !== 6 || !/^\d{6}$/.test(pin)) {
                return NextResponse.json({ error: 'Invalid PIN format' }, { status: 400 })
            }

            const { data: userData } = await (supabase
                .from('users') as any)
                .select('pin_hash, pin_salt, pin_attempts, pin_locked_until')
                .eq('id', user.id)
                .single()

            const data = userData as any

            if (!data?.pin_hash) {
                return NextResponse.json({ error: 'No PIN configured' }, { status: 400 })
            }

            // Check if locked out
            if (data.pin_locked_until) {
                const lockedUntil = new Date(data.pin_locked_until)
                if (lockedUntil > new Date()) {
                    return NextResponse.json({
                        error: 'PIN locked. Too many failed attempts. Tap "Forgot PIN?" to reset it with your password.',
                        locked: true,
                    }, { status: 423 })
                }
                // Lock expired, reset attempts
                await supabase
                    .from('users')
                    .update({ pin_attempts: 0, pin_locked_until: null })
                    .eq('id', user.id)
            }

            // Use the per-user random salt if it exists; otherwise fall back to
            // the legacy user.id salt so existing PINs keep verifying.
            const effectiveSalt: string = data.pin_salt || user.id
            const hashMatches = pinMatches(pin, effectiveSalt, data.pin_hash as string)

            if (hashMatches) {
                // Correct PIN — reset attempts
                await supabase
                    .from('users')
                    .update({ pin_attempts: 0, pin_locked_until: null })
                    .eq('id', user.id)

                return NextResponse.json({ success: true, verified: true })
            } else {
                // Wrong PIN — increment attempts
                const newAttempts = (data.pin_attempts || 0) + 1
                const updateData: any = { pin_attempts: newAttempts }

                // Lock after 5 failed attempts (30 min lockout)
                if (newAttempts >= 5) {
                    updateData.pin_locked_until = new Date(Date.now() + 30 * 60 * 1000).toISOString()
                }

                await supabase
                    .from('users')
                    .update(updateData)
                    .eq('id', user.id)

                const remaining = Math.max(0, 5 - newAttempts)

                return NextResponse.json({
                    success: false,
                    verified: false,
                    attemptsRemaining: remaining,
                    locked: newAttempts >= 5,
                    message: newAttempts >= 5
                        ? 'PIN locked. Tap "Forgot PIN?" to reset it with your password.'
                        : `Wrong PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
                }, { status: 401 })
            }
        }

        // ─── REMOVE: Delete PIN (step-up required if one is set) ───
        if (action === 'remove') {
            const { data: existing } = await (supabase
                .from('users') as any)
                .select('pin_hash, pin_salt, pin_locked_until, pin_attempts')
                .eq('id', user.id)
                .single()
            const ex = existing as any

            // Only require proof if a PIN actually exists. If none is set, the
            // remove is a harmless no-op success (keeps callers idempotent).
            if (ex?.pin_hash) {
                const stepUp = await verifyStepUp(supabase, user.id, ex, currentPin, password, user.email, user.id)
                if (stepUp.locked) {
                    return NextResponse.json({
                        error: 'PIN locked. Use your account password to remove it.',
                        locked: true,
                    }, { status: 423 })
                }
                if (!stepUp.ok) {
                    return NextResponse.json(
                        { error: 'Verification required. Enter your current PIN or your account password to remove it.' },
                        { status: 401 }
                    )
                }
            }

            const { error } = await (supabase
                .from('users') as any)
                .update({
                    pin_hash: null,
                    pin_salt: null,
                    pin_attempts: 0,
                    pin_locked_until: null,
                })
                .eq('id', user.id)

            if (error) {
                return NextResponse.json({ error: 'Failed to remove PIN' }, { status: 500 })
            }

            return NextResponse.json({ success: true, message: 'PIN removed successfully' })
        }

        // ─── DISMISS: Set reminder preference ───
        if (action === 'dismiss') {
            const { reminder } = body // 'later' or 'never'
            await supabase
                .from('users')
                .update({
                    pin_reminder: reminder === 'later' ? 'later' : 'never',
                })
                .eq('id', user.id)

            return NextResponse.json({ success: true })
        }

        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    } catch (error) {
        console.error('PIN API error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

/**
 * Step-up verification for changing/removing an existing PIN.
 * Passes if EITHER the account password is correct OR the current PIN matches.
 * The password path bypasses the PIN LOCKOUT CHECK (it proves identity
 * independently), which is exactly what makes "Forgot PIN" recovery possible
 * while a 30-min PIN lock is active. The current-PIN path is rejected while locked.
 *
 * SEC: a wrong guess on EITHER path still counts against the same pin_attempts
 * counter the `verify` action uses. Without this, `set`/`remove` would let a
 * session-holding attacker brute-force the PIN (or the account password) with
 * zero DB-level lockout, since neither path wrote back on failure.
 */
async function verifyStepUp(
    supabase: any,
    userId: string,
    existing: { pin_hash?: string | null; pin_salt?: string | null; pin_locked_until?: string | null; pin_attempts?: number | null },
    currentPin: unknown,
    password: unknown,
    email: string | undefined,
    legacySalt: string,
): Promise<{ ok: boolean; locked: boolean }> {
    let attemptMade = false

    // Password path first — independent proof of identity, ignores the PIN
    // lockout GATE (but a wrong guess still feeds the shared attempt counter below).
    if (typeof password === 'string' && password.length > 0) {
        attemptMade = true
        if (await verifyAccountPassword(email, password)) {
            await supabase.from('users').update({ pin_attempts: 0, pin_locked_until: null }).eq('id', userId)
            return { ok: true, locked: false }
        }
    }

    // Current-PIN path — respects the lockout. Falls back to the legacy user.id
    // salt for PINs set before the per-user pin_salt migration.
    if (typeof currentPin === 'string' && /^\d{6}$/.test(currentPin) && existing.pin_hash) {
        if (existing.pin_locked_until && new Date(existing.pin_locked_until) > new Date()) {
            return { ok: false, locked: true }
        }
        attemptMade = true
        const salt = existing.pin_salt || legacySalt
        if (salt && pinMatches(currentPin, salt, existing.pin_hash)) {
            await supabase.from('users').update({ pin_attempts: 0, pin_locked_until: null }).eq('id', userId)
            return { ok: true, locked: false }
        }
    }

    if (attemptMade) {
        const newAttempts = (existing.pin_attempts || 0) + 1
        const updateData: any = { pin_attempts: newAttempts }
        if (newAttempts >= 5) {
            updateData.pin_locked_until = new Date(Date.now() + 30 * 60 * 1000).toISOString()
        }
        await supabase.from('users').update(updateData).eq('id', userId)
        return { ok: false, locked: newAttempts >= 5 }
    }

    return { ok: false, locked: false }
}
