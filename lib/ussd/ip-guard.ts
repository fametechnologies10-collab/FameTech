import type { NextRequest } from 'next/server'

// Hubtel's service fulfillment sender IPs (from official docs).
// HUBTEL_EXTRA_IPS (comma-separated env) extends the list WITHOUT a code
// deploy: if Hubtel rotates or adds egress IPs, every USSD request 403s and
// the whole service is invisibly dead until the list is updated — the env
// override turns that from a redeploy into a dashboard edit. The guard stays
// fail-closed: an empty/unset env changes nothing.
const HUBTEL_IPS = new Set(['52.50.116.54', '18.202.122.131', '52.31.15.68'])
// Only literal IPs are accepted — no wildcards/CIDR — so a fat-fingered env
// value can never silently open the allowlist. (Security review M-2.)
const IP_LITERAL_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+:[0-9a-fA-F:]*)$/
for (const ip of (process.env.HUBTEL_EXTRA_IPS ?? '').split(',')) {
    const trimmed = ip.trim()
    if (!trimmed) continue
    if (IP_LITERAL_RE.test(trimmed)) HUBTEL_IPS.add(trimmed)
    else console.warn(`[USSD IP Guard] Ignored invalid HUBTEL_EXTRA_IPS entry: "${trimmed}"`)
}

/**
 * Returns true if the request comes from a Hubtel IP or from pure local dev.
 * Only fully bypass the allowlist for local development (no Vercel deployment
 * env). On Vercel preview/staging (VERCEL_ENV = 'preview' | 'production') the
 * Hubtel IP allowlist still applies so deployed envs never accept arbitrary IPs.
 */
export function isAllowedHubtelIP(request: NextRequest): boolean {
    // HARDENING(ip-guard): bypass only for non-deployed local dev. VERCEL_ENV is
    // set on every Vercel deployment ('preview'/'production'); when it is absent
    // or 'development' AND we're not in a production Node build, we're running
    // locally and can skip the allowlist for testing. Preview/staging enforce it.
    const vercelEnv = process.env.VERCEL_ENV
    const isLocalDev =
        process.env.NODE_ENV !== 'production' &&
        (vercelEnv === undefined || vercelEnv === 'development')
    if (isLocalDev) return true

    // SECURITY: the LEFTMOST x-forwarded-for entry is whatever the caller sent —
    // an attacker can prepend a Hubtel IP and Vercel only appends the real one,
    // so trusting it let any client forge a "Hubtel" source and pass this gate.
    // x-real-ip is set by the Vercel edge to the actual connecting IP and cannot
    // be overridden through Vercel, so trust it first; only if it is absent
    // (non-Vercel) fall back to the RIGHTMOST forwarded hop (the one the proxy
    // appended), never the leftmost client-supplied value.
    const realIp = request.headers.get('x-real-ip')?.trim()
    const forwarded = request.headers.get('x-forwarded-for')

    let candidateIp = realIp ?? ''
    if (!candidateIp && forwarded) {
        const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean)
        candidateIp = hops.length ? hops[hops.length - 1] : ''
    }

    const allowed = HUBTEL_IPS.has(candidateIp)
    if (!allowed) {
        // Log the ACTUAL rejected IP: a burst of rejects from one unknown IP is
        // the signature of a Hubtel egress change (= total invisible outage —
        // rejection happens before any session/telemetry write). Copy that IP
        // into HUBTEL_EXTRA_IPS after confirming it with Hubtel.
        console.warn(
            `[USSD IP Guard] Rejected ${request.nextUrl?.pathname ?? 'ussd'} request from IP "${candidateIp || 'unknown'}" (x-forwarded-for: ${forwarded ?? 'none'})`,
        )
    }
    return allowed
}
