import type { NextRequest } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Optional shared-secret second factor for the Hubtel USSD callbacks
 * (/api/ussd/interact and /api/ussd/fulfill).
 *
 * Hubtel calls our FIXED, dashboard-registered URLs and sends no signature, so
 * the primary authentication is the IP allowlist (see ip-guard.ts). This adds a
 * cryptographic second factor that defeats IP-spoofing entirely: register the
 * callback URL in the Hubtel dashboard with a secret query param
 * (`...?k=<secret>`, or send it as the `x-ussd-secret` header) and set
 * USSD_CALLBACK_SECRET to the same value.
 *
 * It is OPT-IN and fail-safe for rollout: while USSD_CALLBACK_SECRET is unset
 * this returns true (no behaviour change), so deploying the code does not break
 * live USSD. Once the env is set AND Hubtel's registered URL carries the secret,
 * the second factor is enforced — a spoofed IP alone no longer suffices.
 *
 * @returns true when the secret is not configured, or when the request carries
 *          the correct secret; false only when a secret IS configured and the
 *          request's secret is missing or wrong.
 */
export function hasValidUssdCallbackSecret(request: NextRequest): boolean {
    const expected = process.env.USSD_CALLBACK_SECRET || ''
    if (!expected) return true // not enabled → no behaviour change

    const provided =
        request.nextUrl.searchParams.get('k') ||
        request.headers.get('x-ussd-secret') ||
        ''
    if (!provided) return false

    // Compare HMAC digests of equal length so the comparison neither leaks the
    // secret's length (timingSafeEqual requires equal-length buffers) nor
    // short-circuits on length. Both sides are fixed 32-byte SHA-256 outputs.
    const a = createHmac('sha256', expected).update(provided).digest()
    const b = createHmac('sha256', expected).update(expected).digest()
    return timingSafeEqual(a, b)
}
