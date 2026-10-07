const DEFAULT_SITE_URL = 'https://kingflexygh.com'
// De-branded sub-agent storefront + invite domain. Single source of truth: set
// NEXT_PUBLIC_STORE_URL once and the invite-link builder, both origin allowlists
// (this file + middleware.ts) and the middleware host router all follow.
const DEFAULT_STORE_URL = 'https://store.kingflexygh.com'
// Sub-agent login subdomain (spec 2026-09-14). Single source of truth: set
// NEXT_PUBLIC_AGENT_URL once; the origin allowlist follows so POST routes
// guarded by hasTrustedRequestOrigin accept agent.* requests.
const DEFAULT_AGENT_URL = 'https://agent.kingflexygh.com'
const LOCAL_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://shop.localhost:3000',
    'http://shop.localhost:3001',
    'http://store.localhost:3000',
    'http://store.localhost:3001',
]

function normalizeSiteUrl(siteUrl: string) {
    return siteUrl.replace(/\/+$/, '')
}

function getOrigin(value: string) {
    return normalizeSiteUrl(new URL(value).origin)
}

function isLocalDevelopment() {
    return process.env.NODE_ENV === 'development'
        || process.env.VERCEL_ENV === 'development'
        || process.env.VERCEL_ENV === 'preview'
}

export function getSiteUrl() {
    return normalizeSiteUrl(
        process.env.NEXT_PUBLIC_SITE_URL
        || process.env.NEXT_PUBLIC_APP_URL
        || DEFAULT_SITE_URL
    )
}

// The de-branded store domain. Env-driven with a safe built-in default so links
// and the allowlist keep working even if the env var is briefly unset.
export function getStoreUrl() {
    return normalizeSiteUrl(process.env.NEXT_PUBLIC_STORE_URL || DEFAULT_STORE_URL)
}

// The sub-agent login domain. Env-driven with a safe built-in default so links
// and the allowlist keep working even if the env var is briefly unset.
export function getAgentUrl() {
    return normalizeSiteUrl(process.env.NEXT_PUBLIC_AGENT_URL || DEFAULT_AGENT_URL)
}

export function getPasswordRecoveryUrl() {
    const recoveryUrl = new URL('/auth/update-password', getSiteUrl())
    recoveryUrl.searchParams.set('flow', 'recovery')
    return recoveryUrl.toString()
}

export function getAllowedAppOrigins() {
    const origins = new Set<string>()

    // Vercel sets VERCEL_URL (deployment) and VERCEL_BRANCH_URL (branch alias) without a protocol
    const vercelCandidates = [
        process.env.VERCEL_URL,
        process.env.VERCEL_BRANCH_URL,
    ]
        .filter(Boolean)
        .map(u => `https://${u}`)

    const candidateUrls = [
        process.env.NEXT_PUBLIC_SITE_URL,
        process.env.NEXT_PUBLIC_APP_URL,
        DEFAULT_SITE_URL,
        'https://www.kingflexygh.com',
        'https://shop.kingflexygh.com',
        'https://preview.kingflexygh.com',
        // De-branded store domain (env-driven, default store.kingflexygh.com) so
        // POST routes guarded by hasTrustedRequestOrigin accept store.* requests.
        getStoreUrl(),
        // Sub-agent login origin so agent.* can POST to auth routes guarded by
        // hasTrustedRequestOrigin.
        getAgentUrl(),
        ...vercelCandidates,
    ].filter(Boolean) as string[]

    for (const candidate of candidateUrls) {
        try {
            origins.add(getOrigin(candidate))
        } catch {
            // Ignore malformed environment values and rely on the remaining configured origins.
        }
    }

    if (isLocalDevelopment()) {
        for (const localOrigin of LOCAL_ORIGINS) {
            origins.add(localOrigin)
        }
    }

    return origins
}

export function isTrustedAppOrigin(origin: string | null) {
    if (!origin) {
        return false
    }

    try {
        return getAllowedAppOrigins().has(getOrigin(origin))
    } catch {
        return false
    }
}

export function hasTrustedRequestOrigin(request: Request) {
    const origin = request.headers.get('origin')
    if (isTrustedAppOrigin(origin)) {
        return true
    }

    const referer = request.headers.get('referer')
    return isTrustedAppOrigin(referer)
}
