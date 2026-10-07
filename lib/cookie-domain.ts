// lib/cookie-domain.ts
// Single source of truth for the auth-cookie Domain attribute.
//
// NEXT_PUBLIC_COOKIE_DOMAIN is set ONLY in Vercel Production (".kingflexygh.com")
// so one Supabase session is visible on kingflexygh.com, shop.* and market.*.
// It must stay UNSET on previews/local: *.vercel.app cannot set a
// .kingflexygh.com cookie, so emitting Domain there would break auth entirely.
// Read at call time (not module scope) so tests can vary the env; Next.js
// still inlines NEXT_PUBLIC_* occurrences in the client bundle at build time.

export function getAuthCookieDomain(): string | undefined {
    const domain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN?.trim()
    return domain ? domain : undefined
}

export function getAuthCookieOptions(): { domain: string } | undefined {
    const domain = getAuthCookieDomain()
    return domain ? { domain } : undefined
}
