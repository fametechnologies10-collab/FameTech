import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { createHash } from 'crypto'
import { LRUCache } from 'lru-cache'
import { createServerClient } from '@/lib/supabase'
import { parseAllowedRoles } from '@/lib/role-parser'
import { effectiveRoleFromExpiry } from '@/lib/effective-role'

// ============================================================================
// Developer API — Authentication & Utilities
// This is the API-key equivalent of createRouteClient().
// Used by all /api/v2/ routes instead of cookie-based session auth.
// Never uses cookies — all auth is via API key in the Authorization header
// (accepts both "kf_live_xxx" and "Bearer kf_live_xxx" formats).
// ============================================================================

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ApiAuthResult {
    userId: string
    apiKeyId: string
    /** Raw `users.role`. Use for PERMISSIONS (allowlists, capability checks). */
    userRole: string
    /**
     * Role to PRICE at, with dealer/agent expiry applied. Differs from userRole
     * when a tier has lapsed — nothing downgrades an expired agent, so
     * `users.role` keeps saying 'agent' forever. Always use this for money.
     * See lib/effective-role.ts.
     */
    effectiveRole: string
    keyPrefix: string
    keyType: 'standard' | 'commission' | 'sms'
    rateLimits: ResolvedRateLimits
    supabase: ReturnType<typeof createServerClient>
}

export interface ResolvedRateLimits {
    packages: number
    purchase: number
    bulk: number
    balance: number
    status: number
    sms: number
}

interface ApiKeyRow {
    id: string
    user_id: string
    key_hash: string
    key_prefix: string
    name: string
    status: 'pending' | 'active' | 'revoked'
    key_type: 'standard' | 'commission' | 'sms'
    rate_limits: Record<string, number> | null
    last_used_at: string | null
    created_at: string
    updated_at: string
}

// ─── Global Default Rate Limits ─────────────────────────────────────────────
// These are fallbacks if admin_settings 'api_rate_limits' is missing.
// The admin_settings value takes priority, and per-key overrides take priority
// over both.

const FALLBACK_RATE_LIMITS: ResolvedRateLimits = {
    packages: 10,
    purchase: 20,
    bulk: 10,
    balance: 5,
    status: 10,
    sms: 30,
}

// ─── Validated-Key Cache ────────────────────────────────────────────────────
// Avoids running bcrypt.compare() (~100ms) on every request for the same key.
// Keyed by SHA-256 of the full key (never the key itself). 60-second TTL —
// short enough that admin revocations propagate quickly, long enough to
// neutralise bcrypt-flood CPU DoS. Module-level, so each serverless instance
// builds its own cache (no cross-instance leakage).

interface CachedAuth {
    apiKeyId: string
    userId: string
    userRole: string
    // Cached alongside userRole, so a role that lapses mid-window is priced at
    // its old tier for up to the 60s TTL. Acceptable: expiry is a date boundary,
    // not a security control, and the same staleness already applies to
    // userRole, rateLimits and the suspended-account check.
    effectiveRole: string
    keyPrefix: string
    keyType: 'standard' | 'commission' | 'sms'
    rateLimits: ResolvedRateLimits
}

const validatedKeyCache = new LRUCache<string, CachedAuth>({
    max: 5_000,
    ttl: 60_000, // 60 s
})

function fingerprintKey(fullKey: string): string {
    return createHash('sha256').update(fullKey).digest('hex')
}

// A real bcrypt hash of an unreachable value, used to keep the not-found
// branch's timing comparable to the found-but-wrong branch (see V-6).
// Generated once at module load; cost matches the production hash cost (10).
const DUMMY_HASH = bcrypt.hashSync('___not_a_real_api_key___', 10)

// ─── Key-type scope guard (CENTRAL enforcement) ─────────────────────────
//
// Keys with no entry here (standard) are unrestricted EXCEPT on sections owned
// by a restricted type — that exclusion list is derived from RESTRICTED_SCOPES
// itself so it can't drift out of sync.
//
// Each restricted key type is confined to one API section, across EVERY API
// version. The version segment is matched as a wildcard on purpose: hardcoding
// /api/v1/... here would silently fail OPEN when v2 routes land (a standard key
// would be allowed into /api/v2/utilities/*, and a commission key would be 403'd
// on its own endpoint). See .claude/skills/kingflexy-developer-api/SKILL.md.
const RESTRICTED_SCOPES: Record<'commission' | 'sms', RegExp> = {
    commission: /^\/api\/v\d+\/(?:utilities|airtime)(?:\/|$)/,
    sms: /^\/api\/v\d+\/sms(?:\/|$)/,
}

function matchesPrefix(pathname: string, pattern: RegExp): boolean {
    return pattern.test(pathname)
}

export function keyTypeScopeGuard(
    keyType: 'standard' | 'commission' | 'sms',
    pathname: string
): NextResponse | null {
    if (keyType === 'commission' || keyType === 'sms') {
        if (!matchesPrefix(pathname, RESTRICTED_SCOPES[keyType])) {
            // NOTE: this branch fires when a commission/sms key is used
            // OUTSIDE its own scope. The path it landed on may itself
            // belong to another restricted type (e.g. an sms key calling
            // /api/v1/utilities/pay) or to no restricted type at all (a
            // plain standard-only path). Report the type that actually
            // owns the path it hit when known, falling back to "standard"
            // otherwise, so the error is never misleading.
            const owner = (Object.entries(RESTRICTED_SCOPES) as [string, RegExp][])
                .find(([, pattern]) => matchesPrefix(pathname, pattern))?.[0]
            return apiError(403, `This endpoint requires a ${owner ?? 'standard'} API key`)
        }
        return null
    }
    // standard: blocked on any OTHER type's exclusive prefix.
    for (const [restrictedType, pattern] of Object.entries(RESTRICTED_SCOPES)) {
        if (matchesPrefix(pathname, pattern)) {
            return apiError(403, `This endpoint requires a ${restrictedType} API key`)
        }
    }
    return null
}

// ─── API Key Validation ─────────────────────────────────────────────────────

/**
 * Validates an API key from the Authorization header.
 * Returns the authenticated user context or an error response.
 *
 * Flow:
 * 1. Extract API key from Authorization header (supports both raw key and "Bearer <key>")
 * 2. Lookup by key_prefix (first 16 chars) — fast indexed query
 * 3. Check status before bcrypt (fast rejection path)
 * 4. Verify full key against bcrypt hash
 * 5. Check admin_settings: api_feature_enabled, api_allowed_roles
 * 6. Resolve rate limits (per-key override > admin_settings > fallback)
 * 7. Fire-and-forget: update last_used_at
 * 8. Return authenticated context
 */
export async function validateApiKey(
    request: NextRequest
): Promise<ApiAuthResult | NextResponse> {

    const supabase = createServerClient()

    // ── Step 1: Extract API key from Authorization header ───────────────
    // Accept both formats for caller convenience:
    //   Authorization: kf_live_xxx           (direct — what our docs show)
    //   Authorization: Bearer kf_live_xxx    (standard HTTP convention — what
    //                                         Postman/Insomnia/many SDKs default to)
    const authHeader = request.headers.get('authorization')
    if (!authHeader || !authHeader.trim()) {
        return apiError(401, 'Missing Authorization header. Use: Authorization: <api_key>')
    }

    let fullKey = authHeader.trim()
    if (/^Bearer\s+/i.test(fullKey)) {
        fullKey = fullKey.replace(/^Bearer\s+/i, '').trim()
    }

    if (fullKey.length < 20) {
        return apiError(401, 'Invalid API key format')
    }

    // ── Step 2a: Cache check ────────────────────────────────────────────
    // Same key validated within the last 60s? Skip the DB hit and bcrypt.
    const fingerprint = fingerprintKey(fullKey)
    const cached = validatedKeyCache.get(fingerprint)
    if (cached) {
        // Re-run the central commission-key path guard on every cache hit too —
        // the cache stores the validated identity, not a permission verdict, so
        // scope enforcement must not be skippable by hitting the 60s cache.
        const scopeError = keyTypeScopeGuard(cached.keyType, request.nextUrl.pathname)
        if (scopeError) return scopeError

        return {
            userId: cached.userId,
            apiKeyId: cached.apiKeyId,
            userRole: cached.userRole,
            effectiveRole: cached.effectiveRole,
            keyPrefix: cached.keyPrefix,
            keyType: cached.keyType,
            rateLimits: cached.rateLimits,
            supabase,
        }
    }

    // ── Step 2b: Lookup by prefix ───────────────────────────────────────
    // 16 chars — wide enough to keep UNIQUE(key_prefix) collision-free at
    // many thousands of issued keys. Must match the slice in
    // app/api/user/api-keys/route.ts when generating new keys.
    const keyPrefix = fullKey.substring(0, 16)

    const { data: keyRow, error: keyError } = await (supabase
        .from('api_keys') as any)
        .select('*')
        .eq('key_prefix', keyPrefix)
        .single()

    if (keyError || !keyRow) {
        // Equalise timing with the found-but-wrong branch below so attackers
        // can't distinguish "prefix exists" from "prefix doesn't" by latency.
        await bcrypt.compare(fullKey, DUMMY_HASH)
        return apiError(401, 'Invalid API key')
    }

    const apiKey = keyRow as ApiKeyRow

    // ── Step 3: Check status BEFORE bcrypt (fast path) ──────────────────
    if (apiKey.status === 'pending') {
        return apiError(403, 'API key pending admin approval')
    }

    if (apiKey.status === 'revoked') {
        return apiError(403, 'API key has been revoked')
    }

    // ── Step 4: Verify full key against hash ────────────────────────────
    const isValid = await bcrypt.compare(fullKey, apiKey.key_hash)
    if (!isValid) {
        return apiError(401, 'Invalid API key')
    }

    // ── Step 5: Check feature toggle and role allowlist ──────────────────
    const { data: settingsRows } = await (supabase
        .from('admin_settings') as any)
        .select('key, value')
        .in('key', ['api_feature_enabled', 'api_allowed_roles', 'api_rate_limits'])

    const settings: Record<string, any> = {}
    ;((settingsRows as any[]) || []).forEach((s: any) => {
        settings[s.key] = s.value
    })

    // Check master switch
    const featureEnabled = settings['api_feature_enabled']
    if (featureEnabled === 'false' || featureEnabled === false) {
        return apiError(503, 'API feature is currently disabled')
    }

    // Check role allowlist
    const { data: userData, error: userError } = await supabase
        .from('users')
        // Expiry columns come along on this existing query — no extra round-trip.
        .select('role, status, dealer_expires_at, agent_expires_at')
        .eq('id', apiKey.user_id)
        .single()

    if (userError || !userData) {
        return apiError(401, 'User account not found')
    }

    const userRole = (userData as any).role as string
    const userStatus = (userData as any).status as string
    // Deliberately NOT used for the allowlist check below: a lapsed agent keeps
    // API ACCESS (their raw role is still 'agent'), they just stop getting the
    // discounted tier. Collapsing the two would silently revoke API access from
    // every expired reseller, which is a different decision from pricing.
    const effectiveRole = effectiveRoleFromExpiry(
        userRole,
        (userData as any).agent_expires_at ?? null,
        (userData as any).dealer_expires_at ?? null,
    )

    // Block suspended/inactive users
    if (userStatus !== 'active') {
        return apiError(403, 'Your account is suspended or inactive')
    }

    // Parse allowed roles (defensive against malformed historical data)
    const allowedRoles = parseAllowedRoles(settings['api_allowed_roles'])

    if (!allowedRoles.includes(userRole)) {
        return apiError(403, 'API access not available for your account type')
    }

    // ── Step 6: Resolve rate limits ─────────────────────────────────────
    let globalLimits: Record<string, number> = {}
    const rawGlobalLimits = settings['api_rate_limits']
    if (rawGlobalLimits) {
        try {
            globalLimits = typeof rawGlobalLimits === 'string'
                ? JSON.parse(rawGlobalLimits)
                : rawGlobalLimits
        } catch {
            // Use fallback
        }
    }

    const rateLimits = resolveRateLimits(apiKey.rate_limits, globalLimits)

    // ── Populate the validated-key cache ───────────────────────────────
    // 60-second TTL set when the cache was created. Subsequent requests
    // with the same key skip the DB lookup and bcrypt. keyType is carried so
    // cache hits enforce the commission-key scope guard identically to a
    // fresh lookup (see the cache-hit branch above).
    validatedKeyCache.set(fingerprint, {
        apiKeyId: apiKey.id,
        userId: apiKey.user_id,
        userRole,
        effectiveRole,
        keyPrefix,
        keyType: apiKey.key_type,
        rateLimits,
    })

    // ── Step 7: Update last_used_at (fire-and-forget) ───────────────────
    ;(supabase.from('api_keys') as any)
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', apiKey.id)
        .then(() => {})
        .catch((e: any) => console.error('[API Auth] last_used_at update error:', e.message))

    // ── Central key-type scope guard ─────────────────────────────────────
    // See keyTypeScopeGuard's doc comment for the full asymmetry this
    // implements. Runs after the cache is populated so the NEXT request with
    // this same key hits the (cheaper) cache-hit guard above instead of
    // repeating the full DB + bcrypt path.
    const scopeError = keyTypeScopeGuard(apiKey.key_type, request.nextUrl.pathname)
    if (scopeError) return scopeError

    // ── Step 8: Return authenticated context ────────────────────────────
    return {
        userId: apiKey.user_id,
        apiKeyId: apiKey.id,
        userRole,
        effectiveRole,
        keyPrefix,
        keyType: apiKey.key_type,
        rateLimits,
        supabase,
    }
}

// ─── Rate Limit Resolver ────────────────────────────────────────────────────

/**
 * Merges per-key overrides with global defaults.
 * Per-key values take priority over global values.
 * Both take priority over hardcoded fallbacks.
 */
export function resolveRateLimits(
    keyLimits: Record<string, number> | null,
    globalLimits: Record<string, number>
): ResolvedRateLimits {
    return {
        packages: keyLimits?.packages ?? globalLimits?.packages ?? FALLBACK_RATE_LIMITS.packages,
        purchase: keyLimits?.purchase ?? globalLimits?.purchase ?? FALLBACK_RATE_LIMITS.purchase,
        bulk:     keyLimits?.bulk     ?? globalLimits?.bulk     ?? FALLBACK_RATE_LIMITS.bulk,
        balance:  keyLimits?.balance  ?? globalLimits?.balance  ?? FALLBACK_RATE_LIMITS.balance,
        status:   keyLimits?.status   ?? globalLimits?.status   ?? FALLBACK_RATE_LIMITS.status,
        sms:      keyLimits?.sms      ?? globalLimits?.sms      ?? FALLBACK_RATE_LIMITS.sms,
    }
}

// ─── Key-Type Guard (opt-in, per-route) ─────────────────────────────────────

/**
 * Route-level guard: rejects the request unless the authenticated key matches
 * the required type. This is the OPT-IN half of key-type enforcement — the
 * /api/v2/utilities/* routes call `requireKeyType(auth, 'commission')`
 * as their first line to reject standard keys (the mirror image of the
 * central `keyTypeScopeGuard` inside validateApiKey, which already
 * rejects commission/sms keys on every OTHER route). Existing standard-only
 * routes need no change — they simply never call this helper, so their
 * behavior is untouched.
 */
export function requireKeyType(
    auth: ApiAuthResult,
    type: 'standard' | 'commission' | 'sms'
): NextResponse | null {
    if (auth.keyType !== type) {
        return apiError(403, `This endpoint requires a ${type} API key`)
    }
    return null
}

// ─── Response Helpers ───────────────────────────────────────────────────────

/**
 * Standard success response for every developer-API (v2) endpoint.
 * Shape: { success: true, data: {...}, meta: { timestamp, version } }
 */
export function apiSuccess(data: any, meta?: Record<string, any>): NextResponse {
    const resolvedVersion = (meta?.version as string) ?? 'v2'
    return NextResponse.json({
        success: true,
        data,
        meta: {
            timestamp: new Date().toISOString(),
            version: resolvedVersion,
            ...meta,
        },
    })
}

/**
 * Standard error response for every developer-API (v2) endpoint.
 * Shape: { success: false, error: { code: 401, message: "..." } }
 */
export function apiError(code: number, message: string): NextResponse {
    return NextResponse.json(
        {
            success: false,
            error: { code, message },
        },
        { status: code }
    )
}

// ─── API Request Logger ─────────────────────────────────────────────────────

/**
 * Logs an API request to the api_logs table.
 * Fire-and-forget — never awaited in route handlers.
 * Uses service role client to bypass RLS for inserts.
 */
export function logApiRequest(params: {
    apiKeyId: string | null
    userId: string | null
    endpoint: string
    method: string
    statusCode: number
    responseTimeMs: number
    ip: string | null
    errorMessage?: string
}): void {
    const supabase = createServerClient()

    ;(supabase.from('api_logs') as any)
        .insert({
            api_key_id:       params.apiKeyId,
            user_id:          params.userId,
            endpoint:         params.endpoint,
            method:           params.method,
            status_code:      params.statusCode,
            response_time_ms: params.responseTimeMs,
            ip_address:       params.ip,
            error_message:    params.errorMessage || null,
        })
        .then(() => {})
        .catch((e: any) => console.error('[API Log] Insert error:', e.message))
}

// ─── Utility: Check if response is an error ─────────────────────────────────

/**
 * Type guard to check if validateApiKey returned a NextResponse (error)
 * or the authenticated context (success).
 */
export function isApiError(result: ApiAuthResult | NextResponse): result is NextResponse {
    return result instanceof NextResponse
}

// ─── Utility: Extract client IP ─────────────────────────────────────────────

/**
 * Extract the client IP address, preferring sources a caller cannot spoof.
 *
 * SECURITY (fixed 2026-09-29, matches middleware.ts's getIP): Vercel APPENDS
 * the real connecting IP to X-Forwarded-For, it does not overwrite the
 * header — so the LEFTMOST entry is whatever the caller sent and the
 * RIGHTMOST is the one Vercel actually appended. Trusting the leftmost let
 * any caller forge a fresh IP per request and defeat every per-IP rate limit
 * built on this function (guest whitelist checks, OTP send/verify, and other
 * v2 endpoints — see every call site of getClientIp).
 *
 * Order of trust:
 *   1. x-real-ip — set by the Vercel edge to the real client IP.
 *   2. request.ip — populated by Vercel in some runtimes.
 *   3. x-forwarded-for RIGHTMOST hop — the entry Vercel appended.
 *   4. cf-connecting-ip — vestigial: this app has no Cloudflare in front of
 *      Vercel, so nothing trustworthy ever sets this header. Kept only as a
 *      last-resort fallback for the case where 1-3 are all absent (never
 *      happens for a request that actually reached a Vercel Function).
 */
export function getClientIp(request: NextRequest): string | null {
    const realIp = request.headers.get('x-real-ip')?.trim()
    if (realIp) return realIp

    const reqIp = (request as { ip?: string }).ip
    if (reqIp) return reqIp

    const xff = request.headers.get('x-forwarded-for')
    if (xff) {
        const hops = xff.split(',').map(h => h.trim()).filter(Boolean)
        if (hops.length > 0) return hops[hops.length - 1]
    }

    return request.headers.get('cf-connecting-ip') || null
}
