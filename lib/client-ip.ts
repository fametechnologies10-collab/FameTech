import type { NextRequest } from 'next/server'

/**
 * Real client IP for rate-limit keys on guest (unauthenticated) routes.
 *
 * SECURITY: never read the LEFTMOST x-forwarded-for hop — that is whatever the caller
 * sent, so trusting it lets one client mint a fresh "IP" per request and defeat every
 * per-IP limit. Same trust order as middleware.ts getIP() and lib/api-auth getClientIp()
 * (kept dependency-free so guest routes don't have to import the API-key stack):
 *   1. x-real-ip  — set by the Vercel edge, not overridable by the caller
 *   2. request.ip — populated by Vercel in some runtimes
 *   3. x-forwarded-for RIGHTMOST hop — the entry the platform appended
 */
export function getGuestIp(request: NextRequest | Request): string {
    const realIp = request.headers.get('x-real-ip')?.trim()
    if (realIp) return realIp

    const reqIp = (request as { ip?: string }).ip
    if (reqIp) return reqIp

    const xff = request.headers.get('x-forwarded-for')
    if (xff) {
        const hops = xff.split(',').map((h) => h.trim()).filter(Boolean)
        if (hops.length > 0) return hops[hops.length - 1]
    }

    return 'unknown'
}
