// lib/api-version.ts
// Path helpers for the developer API (v2 — v1 was retired and removed).
// Kept pure and dependency-free so middleware.ts (Edge runtime) and any
// route/lib code can both import it, and so it's unit-testable without
// mocking NextRequest.

export const API_V2_PREFIX = '/api/v2/'
export const API_V2_HOST = 'api.kingflexygh.com'
export const API_V2_BASE_URL = `https://${API_V2_HOST}/api/v2`

export function isV2Path(pathname: string): boolean {
    return pathname.startsWith(API_V2_PREFIX)
}

export type ApiVersion = 'v2'

/**
 * Kept as a function (rather than inlining 'v2' at each call site) so every
 * lib/api-handlers/* caller — several build a version-labelled `endpoint`
 * string for logging via this — stays unchanged now that v1 is gone; only
 * this file's internals simplified.
 */
export function apiVersionFromPath(_pathname: string): ApiVersion {
    return 'v2'
}

/**
 * The `meta` object a shared handler should pass to apiSuccess.
 */
export function versionMeta(pathname: string): { version: ApiVersion } {
    return { version: apiVersionFromPath(pathname) }
}
