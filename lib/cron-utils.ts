import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'

/**
 * Validates the Authorization header for all cron job routes.
 *
 * Rules:
 * - If CRON_SECRET env var is missing entirely → returns HTTP 500 (hard failure,
 *   never run an unsecured cron).
 * - If the Authorization header does not match `Bearer <CRON_SECRET>` → returns HTTP 401.
 * - If auth passes → returns null (caller proceeds normally).
 *
 * Uses constant-time comparison so an attacker can't probe the secret byte-by-byte
 * via timing side-channels.
 *
 * Usage:
 *   const authError = validateCronAuth(request)
 *   if (authError) return authError
 */
export function validateCronAuth(request: Request): NextResponse | null {
    const cronSecret = process.env.CRON_SECRET

    // Hard failure: CRON_SECRET must always be set in production.
    if (!cronSecret) {
        console.error('[CronAuth] CRON_SECRET is not configured — refusing to run unsecured cron job.')
        return NextResponse.json(
            { error: 'Server misconfiguration: CRON_SECRET is not set.' },
            { status: 500 }
        )
    }

    const authHeader = request.headers.get('authorization') || ''
    const expected = `Bearer ${cronSecret}`
    const authBuf = Buffer.from(authHeader)
    const expectedBuf = Buffer.from(expected)

    const ok =
        authBuf.length === expectedBuf.length &&
        timingSafeEqual(authBuf, expectedBuf)

    if (!ok) {
        console.warn('[CronAuth] Unauthorized cron request — invalid or missing Authorization header.')
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return null // Auth passed.
}
