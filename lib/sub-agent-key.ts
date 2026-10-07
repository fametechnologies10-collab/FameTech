// lib/sub-agent-key.ts
// =============================================================================
// Sub-agent access-key generation, hashing, and the grace-period regenerate/
// promote flow (Plan 3, Task 2). A sub-agent's "access key" IS their Supabase
// Auth password — there is no separate credential store. Regenerating a key
// does not overwrite the live password immediately: it stages a new key as a
// separate hash (`sub_agents.pending_key_hash`) for up to 2 hours, and only
// promotes it to the real Supabase Auth password the first time the sub-agent
// actually logs in with it (see tryPromotePendingKey, consumed by the login
// route in Task 6). This gives the sub-agent a grace window where BOTH the
// old and the newly-issued key work, so a regenerate triggered by an admin
// can't lock someone out mid-shift before they've seen the new key over
// SMS/email.
// =============================================================================

import { randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { waitUntil } from '@vercel/functions'
import { deliverSubAgentCredentials, type CredentialsDeliveryDeps } from '@/lib/sub-agent-credentials-delivery'

// Uppercase-alphanumeric charset with the visually-ambiguous characters
// removed (0/O, 1/I) — this key is read off an SMS/email and hand-typed by a
// sub-agent, so a support ticket over "is that a zero or an O" is a real,
// well-known failure mode for this exact credential shape. 32 characters
// (24 letters + 8 digits) also divides 256 evenly, so randomCharsetChar()'s
// rejection sampling below never actually rejects anything for this charset —
// a happy side effect, not the reason for the exclusion.
const KEY_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

// Matches the bcrypt cost factor lib/api-auth.ts already uses for credential
// hashing in this codebase — see DUMMY_HASH (bcrypt.hashSync(..., 10)) and
// the real key hash in app/api/user/api-keys/route.ts
// (`bcrypt.hash(fullKey, 10)`). Kept identical here so a bcrypt.compare()
// against either kind of hash costs the same, and so there's exactly one
// cost factor to reason about across the whole app.
const BCRYPT_COST = 10

// SECURITY (timing side-channel): a real bcrypt hash of an unreachable value,
// compared against whenever tryPromotePendingKey finds no LIVE pending key
// (missing row, no hash, or expired). Without this, "no pending key" would
// skip bcrypt entirely while "pending key exists, wrong guess" pays a
// bcrypt-10 compare — a latency difference that leaks whether a given
// account currently has a regenerate window open. Mirrors DUMMY_HASH in
// lib/api-auth.ts exactly (same cost factor, same purpose).
const DUMMY_HASH = bcrypt.hashSync('___no_pending_key___', BCRYPT_COST)

// The regenerate grace window (spec: up to 2 hours before the pending key
// expires unused).
const PENDING_KEY_TTL_MS = 2 * 60 * 60 * 1000

/**
 * Draws one random character from KEY_CHARSET using rejection sampling over
 * crypto.randomBytes — NOT Math.random(). 256 is not evenly divisible by 36
 * (KEY_CHARSET.length), so a plain `byte % 36` would bias low characters;
 * rejecting bytes >= the largest multiple of 36 below 256 removes that bias
 * entirely. This is a real, sole credential (a sub-agent's Auth password),
 * so it must come from a CSPRNG.
 */
function randomCharsetChar(): string {
    const limit = 256 - (256 % KEY_CHARSET.length)
    let byte: number
    do {
        byte = randomBytes(1)[0]
    } while (byte >= limit)
    return KEY_CHARSET[byte % KEY_CHARSET.length]
}

function randomGroup(length: number): string {
    let out = ''
    for (let i = 0; i < length; i++) out += randomCharsetChar()
    return out
}

/** Generates a new plaintext access key in "XXXX-XXXX-XXXX" shape. */
export function generateAccessKey(): string {
    return `${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}`
}

/** Hashes a plaintext access key with the codebase's standard bcrypt cost. */
export async function hashAccessKey(key: string): Promise<string> {
    return bcrypt.hash(key, BCRYPT_COST)
}

/** Verifies a plaintext access key against a previously-produced hash. */
export async function verifyAccessKey(key: string, hash: string): Promise<boolean> {
    return bcrypt.compare(key, hash)
}

/**
 * Starts a key regenerate for a sub-agent: generates a fresh plaintext key,
 * hashes it into `sub_agents.pending_key_hash` with a 2-hour
 * `pending_key_expires_at`, and hands the PLAINTEXT back exactly once.
 *
 * The caller (Task 5's route) owns delivering that plaintext to the
 * sub-agent (SMS/email) — it is never stored anywhere, including here.
 * Nothing about the sub-agent's real Supabase Auth password changes yet;
 * that only happens on the next successful login via tryPromotePendingKey.
 */
export async function beginRegenerate(
    db: SupabaseClient, subUserId: string
): Promise<{ success: boolean; plaintextKey?: string; message: string }> {
    const plaintextKey = generateAccessKey()
    const pendingKeyHash = await hashAccessKey(plaintextKey)
    const pendingKeyExpiresAt = new Date(Date.now() + PENDING_KEY_TTL_MS).toISOString()

    const { error } = await (db as any)
        .from('sub_agents')
        .update({
            pending_key_hash: pendingKeyHash,
            pending_key_expires_at: pendingKeyExpiresAt,
        })
        .eq('user_id', subUserId)

    if (error) {
        console.error('[beginRegenerate] failed to stage pending key', error)
        return {
            success: false,
            message: 'Failed to generate a new access key. Please try again.',
        }
    }

    return {
        success: true,
        plaintextKey,
        message: 'New access key generated. It becomes active the next time it is used to sign in, within 2 hours.',
    }
}

/**
 * Called from the login path (Task 6) after a login attempt with
 * `submittedPassword` has already failed against the sub-agent's current
 * Supabase Auth password. Looks up this user's `sub_agents` row; if a
 * non-expired `pending_key_hash` matches `submittedPassword`, promotes it to
 * be the REAL Supabase Auth password via the Admin API (the same call shape
 * as app/api/users/change-password/route.ts) and clears the pending columns.
 *
 * Returns true ONLY on a genuine promotion. Every other case — no pending
 * key, an expired one, or a mismatch — returns false. false is NOT an error;
 * it just means "nothing to promote here," and the caller should fall
 * through to its normal invalid-credentials handling.
 */
export async function tryPromotePendingKey(
    db: SupabaseClient, adminAuthClient: SupabaseClient, userId: string, submittedPassword: string
): Promise<boolean> {
    const { data: row, error } = await (db as any)
        .from('sub_agents')
        .select('pending_key_hash, pending_key_expires_at')
        .eq('user_id', userId)
        .maybeSingle()

    if (error) {
        console.error('[tryPromotePendingKey] sub_agents lookup failed', error)
        // SECURITY (timing side-channel): still pay the same bcrypt-10 cost
        // as every other outcome below — a DB error must not become its own
        // (faster) observable timing bucket.
        await verifyAccessKey(submittedPassword, DUMMY_HASH)
        return false
    }

    const expiresAtMs = row?.pending_key_expires_at ? new Date(row.pending_key_expires_at).getTime() : NaN
    const hasLivePendingKey = Boolean(row?.pending_key_hash) && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()

    // SECURITY (timing side-channel): ALWAYS run exactly one bcrypt-10
    // compare here, whether or not a live pending key exists — comparing
    // against the real hash only when found (and skipping bcrypt entirely
    // otherwise) would let an attacker distinguish "this account has a
    // pending-key regenerate window open right now" from "it doesn't" purely
    // by response latency. Same pattern as DUMMY_HASH in lib/api-auth.ts.
    const hashToCompareAgainst = hasLivePendingKey ? row.pending_key_hash : DUMMY_HASH
    const matches = await verifyAccessKey(submittedPassword, hashToCompareAgainst)

    if (!hasLivePendingKey || !matches) return false

    const { error: updateError } = await adminAuthClient.auth.admin.updateUserById(userId, {
        password: submittedPassword,
    })

    if (updateError) {
        console.error('[tryPromotePendingKey] Auth password promotion failed', updateError)
        return false
    }

    // Best-effort cleanup: the password is already promoted at this point, so
    // a failure here must not turn a successful promotion into a reported
    // failure. A stale pending row that keeps matching the (now-current)
    // password is harmless — it just re-promotes the same value again.
    const { error: clearError } = await (db as any)
        .from('sub_agents')
        .update({ pending_key_hash: null, pending_key_expires_at: null })
        .eq('user_id', userId)

    if (clearError) {
        console.error('[tryPromotePendingKey] failed to clear promoted pending key', clearError)
    }

    return true
}

// SECURITY (timing side-channel floor): the shared minimum wall-clock time
// beginSelfServiceReset pads every outcome up to before returning. Chosen to
// comfortably cover this function's slowest DB-bound path (two reads + a
// bcrypt-10 hash + one write, excluding SMS/email delivery — see below) so a
// fast "no such account"/"not a sub-agent" DB-only exit doesn't complete
// observably quicker than a real sub-agent's staging path. 200-300ms is
// enough headroom for that work without making the endpoint feel broken.
const SELF_SERVICE_RESET_RESPONSE_FLOOR_MS = 250

/**
 * Delays the caller by whatever's left of SELF_SERVICE_RESET_RESPONSE_FLOOR_MS
 * after `startedAt`. A no-op once the floor has already elapsed.
 *
 * Exported so the route handler (app/api/auth/subagent-reset/route.ts) can
 * apply the exact same floor to its invalid-identifier early return — that
 * path never reaches beginSelfServiceReset, so without this export it was the
 * one exit from this flow that skipped padding entirely, creating a second,
 * distinguishable latency class from every other response (final-review
 * finding, 2026-09-28). Not an account-existence leak on its own — format
 * validity isn't account-specific — but inconsistent with this flow's
 * timing-safety design.
 */
export async function padToResponseFloor(startedAt: number): Promise<void> {
    const remaining = SELF_SERVICE_RESET_RESPONSE_FLOOR_MS - (Date.now() - startedAt)
    if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining))
    }
}

/**
 * Public, UNAUTHENTICATED entry point for a sub-agent to request their own
 * password reset by email or phone, without going through their recruiter.
 * Reuses beginRegenerate's key-staging logic after resolving the identifier
 * to a user row.
 *
 * SECURITY (enumeration-safety): ALWAYS resolves to `{ attempted: true }` —
 * never throws, never signals whether the identifier matched a real account,
 * a sub-agent account, or whether staging/delivery actually succeeded. The
 * caller (the API route) returns one generic, byte-identical response
 * regardless of this function's internal outcome. Never log
 * `staged.plaintextKey` anywhere in this function.
 *
 * SECURITY (timing side-channel): response latency, not just the response
 * body, must not reveal account state. Two measures work together:
 *   1. Every return path is padded to SELF_SERVICE_RESET_RESPONSE_FLOOR_MS
 *      via padToResponseFloor (mirrors the DUMMY_HASH trick in
 *      tryPromotePendingKey above — same file, same class of bug: don't let
 *      a fast DB-miss become a faster, distinguishable timing bucket).
 *   2. The actual SMS/email delivery — by far the most variable-latency step
 *      (real provider network round-trips) — is deferred via waitUntil to
 *      run AFTER the response is sent, so its latency never leaks into the
 *      response at all. Same fire-and-forget pattern as the welcome-email
 *      route (app/api/emails/welcome/route.ts) and lib/shop-order-processor.ts.
 */
export async function beginSelfServiceReset(
    db: SupabaseClient,
    identifier: { type: 'email' | 'phone'; value: string },
    channel: 'email' | 'sms',
    deps: CredentialsDeliveryDeps,
): Promise<{ attempted: boolean }> {
    const startedAt = Date.now()

    const { data: userRow } = await (db.from('users') as any)
        .select('id, phone_number, email, first_name')
        .eq(identifier.type === 'email' ? 'email' : 'phone_number', identifier.value)
        .maybeSingle()

    if (!userRow) {
        await padToResponseFloor(startedAt) // enumeration-safe: identical outcome AND latency whether or not an account exists
        return { attempted: true }
    }

    const { data: subRow } = await (db.from('sub_agents') as any)
        .select('user_id')
        .eq('user_id', userRow.id)
        .maybeSingle()

    if (!subRow) {
        await padToResponseFloor(startedAt) // not a sub-agent — silently no-op, same response and latency either way
        return { attempted: true }
    }

    const staged = await beginRegenerate(db, userRow.id)
    if (!staged.success || !staged.plaintextKey) {
        await padToResponseFloor(startedAt)
        return { attempted: true }
    }

    // Fire-and-forget: kick off delivery now (so it starts as early as
    // possible) but never await it here — see the timing side-channel note
    // above. waitUntil keeps it alive past this function's return in a real
    // serverless request; outside one (e.g. this repo's test scripts) the
    // promise below still runs to completion on Node's normal microtask
    // queue, it's just not specially tracked.
    const plaintextKey = staged.plaintextKey
    waitUntil(
        deliverSubAgentCredentials(
            'reset',
            {
                phone: channel === 'sms' ? userRow.phone_number : null,
                email: channel === 'email' ? userRow.email : null,
                firstName: userRow.first_name,
            },
            plaintextKey,
            deps,
        ).catch((err) => {
            console.error('[beginSelfServiceReset] deferred delivery failed', err)
        }),
    )

    await padToResponseFloor(startedAt)
    return { attempted: true }
}
