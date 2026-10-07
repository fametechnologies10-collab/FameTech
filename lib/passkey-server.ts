/**
 * Server-only passkey helpers. Do NOT import from browser code.
 * RPID must exactly match the domain where credentials were created.
 *
 * Pass the request `origin` so passkeys work on Vercel preview deployments —
 * each deployment gets its own RPID derived from its own hostname.
 * Passkeys registered on a preview URL are only usable on that same domain;
 * production passkeys (RPID = kingflexygh.com) only work on production.
 */

const PRODUCTION_HOSTNAMES = new Set([
    'kingflexygh.com',
    'www.kingflexygh.com',
    'shop.kingflexygh.com',
])

export function getPasskeyRpId(origin?: string | null): string {
    if (origin) {
        try {
            const hostname = new URL(origin).hostname
            if (PRODUCTION_HOSTNAMES.has(hostname)) return 'kingflexygh.com'
            if (hostname === 'localhost') return 'localhost'
            // Preview / custom domains: use the full hostname as RPID
            return hostname
        } catch {}
    }
    if (process.env.NODE_ENV === 'development') return 'localhost'
    return 'kingflexygh.com'
}

export function getPasskeyRpName(): string {
    return 'KiNG FLEXY GH'
}

const PRODUCTION_ORIGINS = [
    'https://kingflexygh.com',
    'https://www.kingflexygh.com',
    'https://shop.kingflexygh.com',
]

export function getPasskeyOrigins(origin?: string | null): string[] {
    if (origin) {
        try {
            const hostname = new URL(origin).hostname
            if (PRODUCTION_HOSTNAMES.has(hostname)) return PRODUCTION_ORIGINS
            if (hostname === 'localhost') {
                return ['http://localhost:3000', 'http://localhost:3001']
            }
            return [origin]
        } catch {}
    }
    if (process.env.NODE_ENV === 'development') {
        return ['http://localhost:3000', 'http://localhost:3001']
    }
    return PRODUCTION_ORIGINS
}

/** Auto-detect a friendly display name from WebAuthn transports + device type. */
export function inferPasskeyName(
    transports: string[] | null | undefined,
    deviceType: string | null | undefined
): string {
    const t = transports ?? []
    if (t.includes('usb') || t.includes('nfc') || t.includes('ble')) return 'Security Key'
    if (deviceType === 'multiDevice') return 'Synced Passkey (Cloud)'
    if (t.includes('internal')) return 'This Device'
    return 'Passkey'
}
