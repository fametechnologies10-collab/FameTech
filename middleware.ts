import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'
import { getAuthCookieDomain, getAuthCookieOptions } from '@/lib/cookie-domain'
import { isV2Path, API_V2_HOST } from '@/lib/api-version'

// Salt for hashing API keys into rate-limit bucket IDs. Must be set in env.
// Without this, the public key_prefix alone would be enough to address — and
// exhaust — another user's bucket from outside.
const API_RATE_LIMIT_SALT = process.env.API_RATE_LIMIT_SALT || ''
// Exact shape of a valid issued key: kf_live_ + 32 lowercase hex chars
const API_KEY_SHAPE = /^kf_live_[a-f0-9]{32}$/

// Write endpoints that must NOT serve traffic when the rate limiter is down.
// Stored as VERSION-AGNOSTIC suffixes (matched against the normalised apiSuffix,
// e.g. '/api/v2/data/purchase' -> '/data/purchase') so that porting a money route
// to a new API version cannot silently drop its fail-closed protection.
const API_FAIL_CLOSED_SUFFIXES: ReadonlySet<string> = new Set([
    '/data/purchase',
    '/data/bulk',
    '/airtime/purchase',
    '/resultschecker/purchase',
    '/afa/register',
    // Pre-existing gap, closed per explicit owner decision (2026-08-24): this
    // endpoint moves money and previously had no fail-closed protection at all.
    '/utilities/pay',
    // Added per explicit owner decision (2026-08-27). SMS credits are PREPAID —
    // the developer has already paid cash for them — so spending them is a money
    // path under the owner's "all money endpoints fail closed" rule, even though
    // it debits sms_wallets rather than the main wallet. Without this entry a
    // Redis outage left the only endpoint that can burn a balance at 10k
    // recipients per call completely unmetered at the edge.
    '/sms/send',
])

// ============================================================
// STRICT CORS ALLOWLIST - Only these origins are trusted.
// NEVER add a wildcard (*) here. Never reflect the raw Origin.
// ============================================================
// De-branded sub-agent store domain. Single source of truth: NEXT_PUBLIC_STORE_URL
// (default store.kingflexygh.com) drives BOTH the CORS allowlist below AND the host
// router further down — change the env var once and both follow, no code edit.
const STORE_ORIGIN = (process.env.NEXT_PUBLIC_STORE_URL || 'https://store.kingflexygh.com').replace(/\/+$/, '')
const STORE_HOST = (() => { try { return new URL(STORE_ORIGIN).host } catch { return 'store.kingflexygh.com' } })()

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
    'https://kingflexygh.com',
    'https://www.kingflexygh.com',
    'https://shop.kingflexygh.com',
    'https://agent.kingflexygh.com',
    'https://preview.kingflexygh.com',
    STORE_ORIGIN,
])

const LOCALHOST_ORIGINS: ReadonlySet<string> = new Set([
    'http://localhost:3000',
    'http://localhost:3001',
    'http://shop.localhost:3000',
    'http://shop.localhost:3001',
    'http://store.localhost:3000',
    'http://store.localhost:3001',
])

type InMemoryLimitConfig = {
    maxRequests: number
    windowMs: number
}

const inMemoryRateLimitStore = new Map<string, number[]>()
const fallbackCriticalLimits: Record<string, InMemoryLimitConfig> = {
    '/api/auth/login': { maxRequests: 5, windowMs: 60 * 1000 },
    '/api/auth/forgot-password': { maxRequests: 3, windowMs: 60 * 60 * 1000 },
    '/api/auth/subagent-reset': { maxRequests: 3, windowMs: 60 * 60 * 1000 },
    '/api/users/change-password': { maxRequests: 5, windowMs: 10 * 60 * 1000 },
    // Mirror the pinManage limiter so a Redis outage can't reopen the password-
    // guessing oracle on /api/auth/pin.
    '/api/auth/pin': { maxRequests: 15, windowMs: 10 * 60 * 1000 },
    '/api/auth/phone-verify-gate/hint': { maxRequests: 20, windowMs: 10 * 60 * 1000 },
    '/api/auth/phone-verify-gate/recover': { maxRequests: 15, windowMs: 10 * 60 * 1000 },
    '/api/auth/phone-verify-gate/recover/complete': { maxRequests: 10, windowMs: 10 * 60 * 1000 },
    '/api/auth/phone-verify-gate/send-current': { maxRequests: 20, windowMs: 10 * 60 * 1000 },
    '/api/auth/phone-verify-gate/verify-current': { maxRequests: 20, windowMs: 10 * 60 * 1000 },
    // A single password typo on the confirm-to-delete field must not lock the
    // whole flow for 24h. 5/15m still hard-caps brute-force of the delete
    // password while letting an honest retry through. Mirror in rateLimiters.deleteAccount.
    '/api/users/delete-account': { maxRequests: 5, windowMs: 15 * 60 * 1000 },
    // Charge endpoints trigger real MoMo prompts — never let a Redis outage
    // open them up. Per-Lambda in-memory cap is a weaker but non-zero backstop.
    '/api/payments/charge': { maxRequests: 5, windowMs: 60 * 1000 },
    '/api/payments/charge/submit-otp': { maxRequests: 8, windowMs: 60 * 1000 },
    // Storefront guest MoMo charge — same reasoning (real prompts). Fail-closed on Redis outage.
    '/api/shop/charge': { maxRequests: 10, windowMs: 60 * 1000 },
    '/api/shop/charge/submit-otp': { maxRequests: 10, windowMs: 60 * 1000 },
    // Admin payout endpoint — triggers real MoMo/bank transfers; cap tightly if Redis is down.
    '/api/admin/process-withdrawal': { maxRequests: 5, windowMs: 60 * 1000 },
    // Money/fulfillment paths — a Redis outage must NOT remove their limit (they
    // move real value or supplier credit). Mirrors each route's primary window.
    // Keyed on authUser.id in the catch block, so the cap holds even if the
    // caller rotates x-forwarded-for.
    '/api/orders/purchase': { maxRequests: 5, windowMs: 60 * 1000 },
    '/api/orders/bulk-purchase': { maxRequests: 3, windowMs: 60 * 1000 },
    '/api/payments/initialize': { maxRequests: 10, windowMs: 60 * 1000 },
    '/api/payments/verify': { maxRequests: 30, windowMs: 60 * 1000 },
    '/api/airtime/create': { maxRequests: 5, windowMs: 60 * 1000 },
    // Shop payout request — real money out. 3/hour matches the primary limiter.
    '/api/shop/withdraw': { maxRequests: 3, windowMs: 60 * 60 * 1000 },
    // KFG SMS: send debits credits + hits Hubtel; purchase debits the main
    // wallet. Keep a per-Lambda backstop if Redis is down (audit L-4).
    '/api/sms/campaigns': { maxRequests: 5, windowMs: 60 * 1000 },
    '/api/sms/purchase': { maxRequests: 5, windowMs: 60 * 1000 },
    // Sub-agent creation mints a real Supabase Auth account (final-review C1)
    // — a Redis outage must not silently drop this to a fully unmetered
    // fail-open. This exact-path lookup applies to both GET (listing) and
    // POST (creation) since fallbackCriticalLimits has no method awareness,
    // but that only makes the fallback backstop slightly stricter for
    // listing too, which is harmless.
    '/api/dashboard/subagents': { maxRequests: 5, windowMs: 60 * 60 * 1000 },
}

// Paths that must never accept requests when Redis is unavailable.
// In-memory fallback is per-Lambda and provides no shared state in serverless.
const SIGNUP_FAIL_CLOSED_PATHS: ReadonlySet<string> = new Set([
    '/api/auth/signup',
    // Resend-confirmation sends a real email + is an anti-enumeration surface —
    // reject outright on a Redis outage rather than falling through to a weaker
    // per-Lambda backstop.
    '/api/auth/resend-confirmation',
    // ⚠️ DO NOT add '/api/auth/pin' here. It looks tempting — the set/remove
    // step-up verifies the account password, so a Redis outage dropping to the
    // per-Lambda fallback does widen the guess budget. But failing closed makes
    // the `status` action 503, and PinContext's status check treats ANY !res.ok
    // as "verified" (contexts/pin-context.tsx) — so a Redis blip would silently
    // BYPASS the app lock entirely while also stranding genuinely locked users.
    // An auth bypass is strictly worse than a widened rate limit. The real
    // protections here are the shared pin_attempts/pin_locked_until DB lockout
    // (see verifyStepUp in app/api/auth/pin/route.ts), which is independent of
    // Redis, plus the per-Lambda entry in fallbackCriticalLimits above.
])

// ============================================================
// UPSTASH REDIS CLIENT & RATE LIMITERS
// Supports both Vercel KV naming (KV_REST_API_URL / KV_REST_API_TOKEN)
// and legacy Upstash naming (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
// If neither is present the limiter is null and all routes fail-open.
// ============================================================
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const REDIS_CONFIGURED = !!(REDIS_URL && REDIS_TOKEN)
const redis = REDIS_CONFIGURED
    ? new Redis({ url: REDIS_URL!, token: REDIS_TOKEN! })
    : (null as unknown as InstanceType<typeof Redis>)

// Every limiter MUST pass an explicit `prefix`. The Redis key is
// `prefix:identifier` and does NOT encode which Ratelimit instance issued the
// call, so two limiters sharing a prefix share one sliding window whenever they
// are called with the same identifier — each then judging that shared counter
// against its own threshold. Before these prefixes existed — and before the
// developer-API catch-all was given its own `api-unrouted:` identifier
// namespace — all 65 shared Upstash's default and collided: 12 requests to
// /api/v2/ping (general, 100/min) drove /api/v1/packages (10/min) to a false
// 429. The convention for limiters IN THIS FILE is `kfg:<propertyName>`. Limiters
// defined in lib/ use their own bare, distinct prefixes (e.g. 'rc-retrieve').
// What matters globally is that no two limiters anywhere share a prefix —
// scripts/test-ratelimit-prefixes.ts enforces both rules.
const rateLimiters = REDIS_CONFIGURED ? {
    // ── Auth routes ────────────────────────────────────────────
    // 5 attempts / 60s per IP (owner decision 2026-09-29, was 5 / 10 min). Shared by
    // the main-platform AND sub-agent login pages — both post to /api/auth/login.
    // Keep in sync with fallbackCriticalLimits['/api/auth/login'].
    login: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m'), prefix: 'kfg:login' }),
    signup: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h'), prefix: 'kfg:signup' }),
    forgotPassword: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h'), prefix: 'kfg:forgotPassword' }),
    subAgentSelfServiceReset: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h'), prefix: 'kfg:subAgentSelfServiceReset' }),
    resendConfirmation: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h'), prefix: 'kfg:resendConfirmation' }),
    // /api/auth/pin — the set/remove step-up now verifies the ACCOUNT PASSWORD, so
    // this endpoint must not fall to the loose general limiter (which would make it
    // a 100/min password-guessing oracle for anyone holding a valid session). 15/10m
    // per-user caps guessing hard while still covering a legit lock cycle (a status
    // check + up to 5 verify attempts + a forgot-PIN remove/set). Both the verify
    // path AND the set/remove step-up path are additionally DB-capped at 5 attempts
    // sharing one pin_attempts/pin_locked_until counter (see verifyStepUp).
    pinManage: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(15, '10 m'), prefix: 'kfg:pinManage' }),
    changePassword: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '10 m'), prefix: 'kfg:changePassword' }),
    phoneVerifyGateHint: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '10 m'), prefix: 'kfg:phoneVerifyGateHint' }),
    phoneVerifyGateRecover: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(15, '10 m'), prefix: 'kfg:phoneVerifyGateRecover' }),
    phoneVerifyGateRecoverComplete: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '10 m'), prefix: 'kfg:phoneVerifyGateRecoverComplete' }),
    phoneVerifyGateSendCurrent: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '10 m'), prefix: 'kfg:phoneVerifyGateSendCurrent' }),
    phoneVerifyGateVerifyCurrent: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '10 m'), prefix: 'kfg:phoneVerifyGateVerifyCurrent' }),
    checkAvailability: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '10 m'), prefix: 'kfg:checkAvailability' }),
    // A successful sign-in is exactly ONE callback, but a whole CGNAT/shared-NAT
    // (common on Ghanaian mobile) shares one IP here, so keep the budget generous
    // to avoid throttling honest concurrent sign-ins. Junk hits fail fast in
    // exchangeCodeForSession anyway, so this is a cost/DoS guard, not an auth control.
    oauthCallback: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(40, '10 m'), prefix: 'kfg:oauthCallback' }),
    // ── Admin routes (broad) ───────────────────────────────────
    adminProcessWithdrawal: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m'), prefix: 'kfg:adminProcessWithdrawal' }),
    admin: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'kfg:admin' }),
    adminSettings: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:adminSettings' }),
    supplierBalance: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:supplierBalance' }),
    // ── Orders & Purchases ─────────────────────────────────────
    airtimeCreate: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m'), prefix: 'kfg:airtimeCreate' }),
    ordersPurchase: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m'), prefix: 'kfg:ordersPurchase' }),
    ordersBulk: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 m'), prefix: 'kfg:ordersBulk' }),
    // ── Payments ──────────────────────────────────────────────
    paymentsInitialize: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:paymentsInitialize' }),
    paymentsVerify: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'kfg:paymentsVerify' }),
    // Charge API (server-side MoMo direct debit). Each call triggers a real
    // MoMo prompt to the supplied phone + burns Paystack quota, so it is
    // throttled hard and keyed per-user (not just per-IP) to stop prompt spam.
    paymentsCharge: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m'), prefix: 'kfg:paymentsCharge' }),
    // OTP submission for an in-flight charge — slightly higher to allow retypes.
    paymentsChargeOtp: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(8, '1 m'), prefix: 'kfg:paymentsChargeOtp' }),
    // Status polling — legit clients poll ~6×/min; cap generously above that.
    paymentsChargePoll: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m'), prefix: 'kfg:paymentsChargePoll' }),
    // ── Shop ──────────────────────────────────────────────────
    shopValidateAccount: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m'), prefix: 'kfg:shopValidateAccount' }),
    shopInitialize: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:shopInitialize' }),
    shopVerifyOrder: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m'), prefix: 'kfg:shopVerifyOrder' }),
    shopPricing: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m'), prefix: 'kfg:shopPricing' }),
    shopWithdraw: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h'), prefix: 'kfg:shopWithdraw' }),
    shopAnnouncements: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m'), prefix: 'kfg:shopAnnouncements' }),
    shopAlerts: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m'), prefix: 'kfg:shopAlerts' }),
    shopLookupOrders: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m'), prefix: 'kfg:shopLookupOrders' }),
    shopMyOrders: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 m'), prefix: 'kfg:shopMyOrders' }),
    shopDomainSearch: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:shopDomainSearch' }),
    shopUssdCode: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(6, '1 m'), prefix: 'kfg:shopUssdCode' }),
    // Logo upload now decodes + resizes + re-encodes server-side, so each call
    // costs real CPU/memory. It previously fell through to `general` (100/min,
    // IP-keyed) — too loose for the new cost, and IP-keying lets one account
    // spread load across addresses. Keyed per-user; changing a logo is rare.
    shopUpload: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:shopUpload' }),
    // ── Sub-agents ────────────────────────────────────────────
    shopInvites: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:shopInvites' }),
    shopSubAgents: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'kfg:shopSubAgents' }),
    shopSubWithdrawals: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m'), prefix: 'kfg:shopSubWithdrawals' }),
    joinRedeem: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '10 m'), prefix: 'kfg:joinRedeem' }),
    // Direct-recruit sub-agent creation (final-review C1, 2026-09-14) — mints
    // a REAL Supabase Auth account with an arbitrary caller-supplied
    // email/phone, so this must not fall through to the loose IP-keyed
    // `general` limiter (100/min) the way it did before this fix. Deliberately
    // as tight as the recruit cap itself normally allows in one sitting (5/hr
    // default cap) rather than signup's 3/hr — a legit recruiter may create
    // several subs back-to-back. Keyed per-user (an authenticated session is
    // required to reach this route at all).
    subAgentCreate: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 h'), prefix: 'kfg:subAgentCreate' }),
    // Regenerate never mints a new account, but it does deliver a real
    // credential via SMS/email to on-file contact info — throttle harder than
    // general but looser than creation, since a recruiter recovering a sub's
    // access legitimately may need a few tries.
    subAgentRegenerate: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 h'), prefix: 'kfg:subAgentRegenerate' }),
    // Storefront native MoMo charge — GUEST, keyed per-IP. /charge + submit-otp fire real
    // MoMo prompts (prompt-spam + Paystack-quota risk), so throttle hard; status is a poll.
    shopCharge: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:shopCharge' }),
    shopChargeOtp: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:shopChargeOtp' }),
    shopChargePoll: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 m'), prefix: 'kfg:shopChargePoll' }),
    // ── Webhooks ──────────────────────────────────────────────
    webhook: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m'), prefix: 'kfg:webhook' }),
    // ── User actions ──────────────────────────────────────────
    user: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 m'), prefix: 'kfg:user' }),
    userUpgrade: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h'), prefix: 'kfg:userUpgrade' }),
    afaRegistration: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(2, '1 h'), prefix: 'kfg:afaRegistration' }),
    agentDowngrade: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(2, '1 h'), prefix: 'kfg:agentDowngrade' }),
    updateProfile: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '10 m'), prefix: 'kfg:updateProfile' }),
    // 5/15m (not 1/24h): the limiter runs BEFORE the handler verifies the
    // password, so a single typo used to burn a whole 24h window. Still hard-caps
    // brute-force of the delete-password. Kept in sync with fallbackCriticalLimits.
    deleteAccount: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '15 m'), prefix: 'kfg:deleteAccount' }),
    airtimeHistory: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 m'), prefix: 'kfg:airtimeHistory' }),
    afaPrice: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m'), prefix: 'kfg:afaPrice' }),
    pageAccess: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'kfg:pageAccess' }),
    // ── Support & Cron ────────────────────────────────────────
    supportChat: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:supportChat' }),
    cron: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:cron' }),
    // ── Developer API v2 ──────────────────────────────────────
    apiPackages: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:apiPackages' }),
    apiBalance: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m'), prefix: 'kfg:apiBalance' }),
    apiStatus: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:apiStatus' }),
    apiPurchase: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 m'), prefix: 'kfg:apiPurchase' }),
    apiBulk: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:apiBulk' }),
    apiSms: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'kfg:apiSms' }),
    // ── User SMS platform (KFG SMS) ───────────────────────────
    // Sends debit credits + hit Hubtel — throttled hard per user; the route
    // adds DB-backed hourly/daily counters on top (fail-closed).
    smsSend: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 m'), prefix: 'kfg:smsSend' }),
    smsGeneral: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 m'), prefix: 'kfg:smsGeneral' }),
    // ── General catch-all ─────────────────────────────────────
    general: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(100, '1 m'), prefix: 'kfg:general' }),
} : null

// Helper to add cache-prevention headers
function addNoCacheHeaders(response: NextResponse) {
    response.headers.set('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate')
    response.headers.set('Pragma', 'no-cache')
    response.headers.set('Expires', '0')
    return response
}

// Returns a consistent 429 response with Retry-After and no-cache headers.
function rateLimitExceeded(retryAfter: number): NextResponse {
    const response = NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429 }
    )
    response.headers.set('Retry-After', retryAfter.toString())
    return addNoCacheHeaders(response)
}

// Extracts the real client IP, preferring sources a client cannot spoof.
// SECURITY: the LEFTMOST element of x-forwarded-for is whatever the caller
// sent — Vercel only *appends* the real connecting IP — so trusting it lets an
// attacker forge a fresh IP per request and defeat every per-IP rate limit.
// Order of trust:
//   1. x-real-ip      — set by the Vercel edge to the real client IP (the
//                       caller cannot override it through Vercel). Same source
//                       the Hubtel ip-guard already trusts.
//   2. request.ip     — populated by Vercel in some runtimes.
//   3. x-forwarded-for RIGHTMOST hop — the entry Vercel appended, not the
//                       spoofable leftmost client value. Last resort only.
//   4. loopback       — local dev / no proxy.
function getIP(request: NextRequest): string {
    const realIp = request.headers.get('x-real-ip')?.trim()
    if (realIp) return realIp

    const reqIp = (request as { ip?: string }).ip
    if (reqIp) return reqIp

    const xff = request.headers.get('x-forwarded-for')
    if (xff) {
        const hops = xff.split(',').map((h) => h.trim()).filter(Boolean)
        if (hops.length > 0) return hops[hops.length - 1]
    }

    return '127.0.0.1'
}

function allowLocalOrigins() {
    return process.env.NODE_ENV === 'development'
        || process.env.VERCEL_ENV === 'development'
        || process.env.VERCEL_ENV === 'preview'
}

function applyFallbackRateLimit(identifier: string, config: InMemoryLimitConfig) {
    const now = Date.now()
    const attempts = (inMemoryRateLimitStore.get(identifier) || []).filter(
        (timestamp) => now - timestamp < config.windowMs
    )

    if (attempts.length >= config.maxRequests) {
        const retryAfter = Math.ceil((attempts[0] + config.windowMs - now) / 1000)
        inMemoryRateLimitStore.set(identifier, attempts)
        return Math.max(1, retryAfter)
    }

    attempts.push(now)
    inMemoryRateLimitStore.set(identifier, attempts)

    if (inMemoryRateLimitStore.size > 1000) {
        for (const [key, timestamps] of inMemoryRateLimitStore.entries()) {
            const activeTimestamps = timestamps.filter(
                (timestamp) => now - timestamp < 24 * 60 * 60 * 1000
            )

            if (activeTimestamps.length === 0) {
                inMemoryRateLimitStore.delete(key)
                continue
            }

            inMemoryRateLimitStore.set(key, activeTimestamps)
        }
    }

    return null
}

// Sets CORS headers ONLY for explicitly allowlisted origins.
// Never reflects the raw origin. Never uses wildcard with credentials.
function isAllowedOrigin(origin: string | null): boolean {
    if (!origin) return false
    if (ALLOWED_ORIGINS.has(origin)) return true
    if (allowLocalOrigins() && LOCALHOST_ORIGINS.has(origin)) return true

    // Allow only the specific Vercel deployment URLs set by Vercel at build time.
    // Never allow all *.vercel.app — that would let any Vercel-hosted app pass.
    const isPreviewOrDev = process.env.VERCEL_ENV === 'preview' || process.env.VERCEL_ENV === 'development'
    if (isPreviewOrDev) {
        const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null
        const vercelBranchUrl = process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : null
        if ((vercelUrl && origin === vercelUrl) || (vercelBranchUrl && origin === vercelBranchUrl)) {
            return true
        }
    }

    return false
}

function setCORSHeaders(response: NextResponse, origin: string | null, isDeveloperApi: boolean = false): NextResponse {
    if (isDeveloperApi) {
        // Developer API: open CORS — called from external servers, not browsers.
        // Credentials are NOT used (API key is in Authorization header).
        response.headers.set('Access-Control-Allow-Origin', '*')
        response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key')
        response.headers.set('Vary', 'Origin')
    } else if (isAllowedOrigin(origin)) {
        response.headers.set('Access-Control-Allow-Origin', origin!)
        response.headers.set('Access-Control-Allow-Credentials', 'true')
        response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
        response.headers.set('Vary', 'Origin')
    }
    // For untrusted/missing origins: emit NO Access-Control-* headers at all.
    return response
}

export async function middleware(request: NextRequest) {
    const origin = request.headers.get('origin')
    const pathname = request.nextUrl.pathname

    // === CORS PREFLIGHT HANDLER ===
    // Handle OPTIONS preflight FIRST, before any Supabase logic.
    const isDevApi = isV2Path(pathname)

    if (request.method === 'OPTIONS') {
        if (isDevApi) {
            // Developer API: always approve preflight (open CORS)
            const preflightResponse = new NextResponse(null, { status: 204 })
            return addNoCacheHeaders(setCORSHeaders(preflightResponse, origin, true))
        } else if (isAllowedOrigin(origin)) {
            // Trusted origin: approve the preflight
            const preflightResponse = new NextResponse(null, { status: 204 })
            return addNoCacheHeaders(setCORSHeaders(preflightResponse, origin))
        } else {
            // Untrusted origin: reject the preflight entirely
            return new NextResponse(null, { status: 403 })
        }
    }

    const hostname = request.headers.get('host') || ''

    // === API HOST CONFINEMENT (api.kingflexygh.com) ===
    // The API host serves ONLY the public developer API (/api/v2/**) — NOT
    // the whole /api/** surface. The original check here
    // only redirected non-/api/ PAGE paths, which left every INTERNAL route
    // (/api/admin/*, /api/cron/*, /api/user/*, /api/webhooks/*, /api/shop/*,
    // etc.) reachable on this host too. That matters because auth cookies are
    // scoped to .kingflexygh.com (see lib/cookie-domain.ts) — Vercel doesn't
    // silently make a second hostname resolve, but once the owner points DNS
    // at it (done 2026-08-27+), a logged-in admin's browser sends its session
    // cookie to api.kingflexygh.com exactly as it would to kingflexygh.com,
    // and subdomains of the same site are NOT blocked from each other by
    // SameSite=Lax. That is the same admin-login-phishing shape the comment
    // below already describes for the de-branded store host, just for a host
    // that went live more recently and was missed. Confining to the actual
    // public API paths closes it. 307 (temporary), not 301, so no browser
    // pins the redirect.
    if (hostname === API_V2_HOST && !isDevApi) {
        return NextResponse.redirect(new URL(pathname + request.nextUrl.search, 'https://kingflexygh.com'), 307)
    }

    const isShopSubdomain = hostname.startsWith('shop.') || hostname === 'shop.kingflexygh.com'

    if (isShopSubdomain) {
        const pathname = request.nextUrl.pathname

        // Guard: prevent rewrite loop if path already starts with /shop-domain
        if (pathname.startsWith('/shop-domain')) {
            return NextResponse.redirect(new URL('/', request.url))
        }

        // Redirect auth and dashboard attempts back to main domain
        if (pathname.startsWith('/auth') || pathname.startsWith('/dashboard') || pathname.startsWith('/download')) {
            return NextResponse.redirect(new URL(pathname, 'https://kingflexygh.com'))
        }

        // Never rewrite API routes or Next.js internals — they must reach their real
        // handlers. The previous `^\/(api|_next|...)$` regex was anchored with `$`, so it
        // ONLY matched the exact path `/api` — meaning POST /api/shop/charge (and every
        // other /api/* subpath, plus /_next/image) was rewritten to /shop-domain/... and
        // 404'd. Using startsWith('/api/') (WITH the trailing slash) still lets a shop
        // whose slug is literally "api" render its storefront at /api.
        const isApiOrInternal = pathname.startsWith('/api/') || pathname.startsWith('/_next/')
        // Static/PWA assets must keep their real MIME type (sw.js → JS, manifest.json → JSON),
        // so they must not be rewritten either.
        const isStaticAsset =
            /^\/(favicon\.ico|robots\.txt|sitemap\.xml|sw\.js|swe-worker-[^/]*\.js|workbox-[^/]*\.js|worker-[^/]*\.js|manifest\.json|manifest\.webmanifest|apple-touch-icon[^/]*)$/.test(pathname)
            || /^\/icons?\//.test(pathname)
            || /\.(?:js|json|png|jpg|jpeg|svg|gif|webp|ico|woff2?|ttf|map)$/.test(pathname)

        // Only rewrite true storefront page paths (e.g. /felix-s-shop → /shop-domain/felix-s-shop).
        if (!isApiOrInternal && !isStaticAsset) {
            const url = request.nextUrl.clone()
            url.pathname = `/shop-domain${pathname}`
            return NextResponse.rewrite(url)
        }
        // API routes and static assets fall through to existing middleware naturally
    }

    // === DE-BRANDED STORE DOMAIN ROUTING (store.kingflexygh.com) ===
    // The store host must NEVER render the main app/marketing/admin. It serves ONLY:
    //   /               → neutral partner portal (rewritten to /join)
    //   /join, /join/*  → owner-branded sub-agent onboarding
    //   /{slug}         → the sub-agent's storefront (rewritten to /shop-domain/{slug})
    // Everything app-facing (dashboard/admin/auth/download) is redirected to the
    // canonical domain — keeps KiNG FLEXY identity off the de-branded host and
    // removes an admin-login phishing surface. STORE_HOST is env-driven (see top).
    const isStoreSubdomain = hostname === STORE_HOST || hostname.startsWith('store.')
    if (isStoreSubdomain) {
        if (pathname.startsWith('/dashboard') || pathname.startsWith('/admin')
            || pathname.startsWith('/auth') || pathname.startsWith('/download')) {
            return NextResponse.redirect(new URL(pathname + request.nextUrl.search, 'https://kingflexygh.com'))
        }

        const isApiOrInternal = pathname.startsWith('/api/') || pathname.startsWith('/_next/')
        const isStaticAsset =
            /^\/(favicon\.ico|robots\.txt|sitemap\.xml|sw\.js|swe-worker-[^/]*\.js|workbox-[^/]*\.js|worker-[^/]*\.js|manifest\.json|manifest\.webmanifest|apple-touch-icon[^/]*)$/.test(pathname)
            || /^\/icons?\//.test(pathname)
            || /\.(?:js|json|png|jpg|jpeg|svg|gif|webp|ico|woff2?|ttf|map)$/.test(pathname)

        if (!isApiOrInternal && !isStaticAsset) {
            if (pathname.startsWith('/shop-domain')) {
                // Loop guard: the rewrite target must never be requested directly.
                return NextResponse.redirect(new URL('/', request.url))
            } else if (pathname === '/') {
                const url = request.nextUrl.clone()
                url.pathname = '/join'
                return NextResponse.rewrite(url)
            } else if (pathname !== '/join' && !pathname.startsWith('/join/')) {
                // Any other page path is a sub-agent storefront slug.
                const url = request.nextUrl.clone()
                url.pathname = `/shop-domain${pathname}`
                return NextResponse.rewrite(url)
            }
            // /join and /join/* fall through to render normally.
        }
        // API routes and static assets fall through to existing middleware naturally.
    }

    // === AGENT SUBDOMAIN (agent.kingflexygh.com) — sub-agent login (spec 2026-09-14) ===
    // Unlike store.*, this is a first-party branded surface with no
    // de-branding concern, so ONLY /auth gets a dedicated page here — everything
    // else (notably /dashboard) falls through to the SAME app unmodified, since
    // the session cookie is already domain-scoped to .kingflexygh.com. No
    // /agent-domain rewrite mirror exists or is needed.
    // KNOWN MINOR (final-review, 2026-09-14): this rewrite returns before
    // `authUser` is resolved (that Supabase call happens later in this
    // function) and before the "redirect authenticated users away from auth
    // pages" check further down — so a logged-in user visiting
    // agent.*/auth sees the rewritten login form instead of being bounced to
    // /dashboard. Fixing it properly would mean moving the session lookup
    // earlier or duplicating an auth check here, either of which restructures
    // this function's flow more than a final-review fix round should risk.
    // Cosmetic only — the same session cookie already works there, so a
    // logged-in user who submits the (redundant) form or navigates to
    // /dashboard manually is unaffected.
    const AGENT_HOST = (() => { try { return new URL(process.env.NEXT_PUBLIC_AGENT_URL || 'https://agent.kingflexygh.com').host } catch { return 'agent.kingflexygh.com' } })()
    const isAgentSubdomain = hostname === AGENT_HOST || hostname.startsWith('agent.')
    if (isAgentSubdomain && (pathname === '/auth' || pathname === '/auth/')) {
        const url = request.nextUrl.clone()
        url.pathname = '/agent-domain/auth'
        return NextResponse.rewrite(url)
    }

    // === REDIRECT OLD SHOP LINKS TO SUBDOMAIN ===
    // kingflexygh.com/shop/my-shop → shop.kingflexygh.com/my-shop
    // ONLY on the real production apex — NEVER on Vercel previews or localhost,
    // where there is no shop.* subdomain, so /shop/<slug> must render directly
    // (otherwise previews bounce to production).
    const isProdApex = hostname === 'kingflexygh.com' || hostname === 'www.kingflexygh.com'
    if (isProdApex && pathname.startsWith('/shop/')) {
        const slug = pathname.replace(/^\/shop\//, '')
        if (slug) {
            const subdomainUrl = new URL(`https://shop.kingflexygh.com/${slug}`)
            // Preserve any query string (e.g., ?error=payment_failed)
            subdomainUrl.search = request.nextUrl.search
            // 307 (temporary), not 301 — a permanent redirect gets cached by the
            // browser and would pin preview/localhost visits to production.
            return NextResponse.redirect(subdomainUrl, 307)
        }
    }

    // === ORIGIN ENFORCEMENT FOR API ROUTES ===
    // For cross-origin requests (Origin header present) to API routes,
    // block the request if origin is not in the allowlist.
    // EXCEPTION: /api/v2/ routes have open CORS (called by external developers).
    if (origin && pathname.startsWith('/api') && !isDevApi && !isAllowedOrigin(origin)) {
        console.warn(`[CORS] Blocked request from untrusted origin: ${origin} → ${pathname}`)
        return new NextResponse(
            JSON.stringify({ error: 'CORS: Origin not allowed' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
        )
    }

    // === DEVELOPER API FAST PATH ===
    // Skip Supabase session creation for /api/v2/ routes (saves ~200ms). API
    // key auth is handled in the route handlers via lib/api-auth.ts.
    if (isDevApi) {
        const ip = getIP(request)
        let apiLimiter: Ratelimit | null = null
        // Bucket namespace for the limiter chosen below. The catch-all arm uses a
        // DIFFERENT namespace on purpose — see the comment on that arm.
        let apiBucketPrefix = 'api'

        // Version-agnostic endpoint matching: /api/v2/packages normalises to
        // '/packages'. Kept as a `/api/v\d+/` strip (not hardcoded to v2) so a
        // future API version needs no edit here.
        const apiSuffix = pathname.replace(/^\/api\/v\d+\//, '/')

        if (rateLimiters) {
            if (apiSuffix === '/packages') {
                apiLimiter = rateLimiters.apiPackages
            } else if (apiSuffix === '/wallet/balance') {
                apiLimiter = rateLimiters.apiBalance
            } else if (apiSuffix.startsWith('/orders/')) {
                apiLimiter = rateLimiters.apiStatus
            } else if (apiSuffix === '/data/purchase') {
                apiLimiter = rateLimiters.apiPurchase
            } else if (apiSuffix === '/data/bulk') {
                apiLimiter = rateLimiters.apiBulk
            } else if (apiSuffix.startsWith('/sms')) {
                apiLimiter = rateLimiters.apiSms
            } else {
                // Catch-all floor for any developer-API path that matched no branch
                // above: the utilities routes, and the product routes (account/role,
                // airtime/*, resultschecker/*, afa/*), which carry their own per-key
                // consumeRateLimit inside the handler.
                //
                // Without this floor the fast path would return before reaching the
                // general limiter that other /api paths fall through to, leaving these
                // completely unmetered — strictly weaker than not having the fast path
                // at all.
                //
                // The distinct bucket namespace is still required, though no longer
                // because of the old shared-prefix bug (fixed: every limiter now declares
                // prefix 'kfg:<name>'). rateLimiters.general is used by
                // this arm, /api/admin/get-prices, and the main non-developer-API chain further
                // down — so all three share the
                // 'kfg:general' prefix; the identifier is what keeps unrouted developer-API
                // traffic from sharing a window with ordinary /api traffic. Keep them
                // distinct.
                apiLimiter = rateLimiters.general
                apiBucketPrefix = 'api-unrouted'
            }
            // AUTH CONSTRAINT for every /api/v2/** route: this fast path skips
            // Supabase session creation AND serves open CORS
            // (Access-Control-Allow-Origin: *). v2 routes MUST therefore
            // authenticate via API key (validateApiKey in lib/api-auth.ts) and
            // MUST NOT use cookie/session auth (createRouteClient) — there is no
            // session here to read, and open CORS makes a cookie-authed route
            // genuinely unsafe. Enforced by an eslint override on app/api/v2/**.
        }

        if (apiLimiter) {
            // Build a bucket id the caller CANNOT spoof. The public key_prefix
            // alone is not enough — only a request that presents the full key
            // hashes into a real user's bucket. Garbage/malformed headers get
            // their own per-IP bucket and can never starve a real key.
            // Strip optional Bearer prefix so both formats bucket correctly
            // (matches the dual-format acceptance in lib/api-auth.ts).
            let authHeader = (request.headers.get('authorization') || '').trim()
            if (/^Bearer\s+/i.test(authHeader)) {
                authHeader = authHeader.replace(/^Bearer\s+/i, '').trim()
            }
            let apiIdentifier: string
            if (API_KEY_SHAPE.test(authHeader)) {
                // Web Crypto API — available in Edge runtime (Node crypto is not)
                const encoded = new TextEncoder().encode(API_RATE_LIMIT_SALT + authHeader)
                const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
                const hash = Array.from(new Uint8Array(hashBuffer))
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('')
                apiIdentifier = `k:${hash.substring(0, 24)}`
            } else {
                apiIdentifier = `ip:${ip}`
            }

            try {
                const { success, reset } = await apiLimiter.limit(`${apiBucketPrefix}:${apiIdentifier}`)
                if (!success) {
                    const retryAfter = Math.ceil((reset - Date.now()) / 1000)
                    const errResponse = rateLimitExceeded(Math.max(1, retryAfter))
                    return setCORSHeaders(errResponse, origin, true)
                }
            } catch (error) {
                console.error('[RateLimiter] API v2 Redis error:', error)
                // Fail CLOSED on money-moving endpoints; fail open on reads.
                if (API_FAIL_CLOSED_SUFFIXES.has(apiSuffix)) {
                    const errResponse = NextResponse.json(
                        { success: false, error: { code: 503, message: 'Rate limiter unavailable. Try again shortly.' } },
                        { status: 503 }
                    )
                    return setCORSHeaders(errResponse, origin, true)
                }
            }
        }

        // Return early — no Supabase session needed for API v2 routes
        const apiResponse = NextResponse.next({ request: { headers: request.headers } })
        return addNoCacheHeaders(setCORSHeaders(apiResponse, origin, true))
    }

    // The signout route deliberately clears auth cookies. If middleware runs
    // supabase.auth.getClaims()/getUser() here it may refresh the token and
    // write it back to res.cookies, which Next.js merges into the final
    // response — overriding the signout route's cleared cookies and making
    // logout appear broken.
    if (pathname === '/api/auth/signout') {
        return NextResponse.next()
    }

    // ── @supabase/ssr compliant middleware client ──────────────────────────
    // Session cookies are read from the incoming request and written back to
    // the outgoing response so the browser always has a fresh token.
    const res = NextResponse.next({
        request: { headers: request.headers },
    })

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookieOptions: getAuthCookieOptions(),
            cookies: {
                getAll() {
                    return request.cookies.getAll()
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
                    cookiesToSet.forEach(({ name, value, options }) =>
                        res.cookies.set(name, value, options)
                    )
                },
            },
        }
    )

    // authUser only ever needs `.id` below (rate-limit bucket keys + the
    // admin role lookup's `.eq('id', authUser.id)`), so a decoded+verified
    // JWT claim set is a drop-in replacement for the full Supabase User object.
    let authUser: { id: string } | null = null

    try {
        // 10s timeout to prevent the middleware from hanging on a slow
        // Supabase response. We clear the timer as soon as the real call
        // resolves so we don't leak a `setTimeout` handle into the Lambda's
        // event loop (which would keep it alive longer than necessary).
        let timeoutId: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Session timeout')), 10000)
        })

        // getClaims() verifies the JWT signature (same security guarantee as
        // getUser()) but does it LOCALLY via the project's JWKS once asymmetric
        // JWT signing keys are enabled in Supabase — no network round-trip per
        // request. On the current symmetric secret it still falls back to a
        // getUser()-equivalent network call, so this is a safe no-regression
        // swap today and the actual cost win activates the moment the project
        // switches to asymmetric keys (dashboard action, not a code change).
        const claimsPromise = supabase.auth.getClaims().finally(() => {
            if (timeoutId) clearTimeout(timeoutId)
        })

        const { data } = await Promise.race([
            claimsPromise,
            timeout
        ]) as any

        authUser = data?.claims?.sub ? { id: data.claims.sub as string } : null
    } catch (error) {
        console.error('Middleware session error:', error)
        // On error or timeout, treat as no session
        authUser = null
    }

    // NOTE: the one-time cookie-domain migration (kfg_cd1) used to live here.
    // It now runs immediately before the final fallthrough `return`, below —
    // see that block for the full rationale and the placement note.

    // === RATE LIMITING ===
    // Runs AFTER supabase.auth.getClaims() so authUser.id is available for
    // user/admin-keyed limits. Runs BEFORE role checks to guard the
    // expensive database query.
    // OPTIONS preflights are already short-circuited above — safe.
    try {
        const ip = getIP(request)
        let limiter: Ratelimit | null = null
        let identifier: string = ip

        if (!rateLimiters) {
            // Redis not configured — skip all rate limiting, fail open
        } else if (pathname === '/api/cron/sync-moolre-withdrawals') {
            limiter = null // Excluded entirely; protected by CRON_SECRET only
        } else if (pathname === '/api/shop/validate-account') {
            limiter = rateLimiters.shopValidateAccount
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/admin/process-withdrawal') {
            limiter = rateLimiters.adminProcessWithdrawal
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/admin/withdrawals') {
            limiter = rateLimiters.admin
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/admin/shop-credits') {
            limiter = rateLimiters.admin
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/auth/login') {
            limiter = rateLimiters.login
            identifier = ip
        } else if (pathname === '/api/auth/signup') {
            limiter = rateLimiters.signup
            identifier = ip
        } else if (pathname === '/api/auth/check-availability') {
            limiter = rateLimiters.checkAvailability
            identifier = ip
        } else if (pathname === '/auth/callback') {
            limiter = rateLimiters.oauthCallback
            identifier = ip
        } else if (pathname === '/api/auth/forgot-password') {
            limiter = rateLimiters.forgotPassword
            identifier = ip
        } else if (pathname === '/api/auth/subagent-reset') {
            limiter = rateLimiters.subAgentSelfServiceReset
            identifier = ip
        } else if (pathname === '/api/auth/resend-confirmation') {
            limiter = rateLimiters.resendConfirmation
            identifier = ip
        } else if (pathname === '/api/auth/pin') {
            limiter = rateLimiters.pinManage
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/auth/phone-verify-gate/hint') {
            limiter = rateLimiters.phoneVerifyGateHint
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/auth/phone-verify-gate/recover') {
            limiter = rateLimiters.phoneVerifyGateRecover
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/auth/phone-verify-gate/recover/complete') {
            limiter = rateLimiters.phoneVerifyGateRecoverComplete
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/auth/phone-verify-gate/send-current') {
            limiter = rateLimiters.phoneVerifyGateSendCurrent
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/auth/phone-verify-gate/verify-current') {
            limiter = rateLimiters.phoneVerifyGateVerifyCurrent
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/users/change-password') {
            limiter = rateLimiters.changePassword
            identifier = authUser?.id ?? ip
        } else if (pathname === '/api/admin/get-prices') {
            limiter = rateLimiters.general
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname.startsWith('/api/admin')) {
            limiter = rateLimiters.admin
            identifier = authUser?.id ?? ip
        } else if (pathname === '/api/sms/campaigns' && request.method === 'POST') {
            limiter = rateLimiters.smsSend
            identifier = authUser?.id ?? ip
        } else if (pathname.startsWith('/api/sms')) {
            limiter = rateLimiters.smsGeneral
            identifier = authUser?.id ?? ip
        } else if (pathname === '/api/shop/initialize') {
            limiter = rateLimiters.shopInitialize
            identifier = ip
        } else if (pathname === '/api/shop/charge') {
            limiter = rateLimiters.shopCharge
            identifier = ip
        } else if (pathname === '/api/shop/charge/submit-otp') {
            limiter = rateLimiters.shopChargeOtp
            identifier = ip
        } else if (pathname === '/api/shop/charge/status') {
            limiter = rateLimiters.shopChargePoll
            identifier = ip
        } else if (pathname === '/api/webhooks/paystack') {
            limiter = rateLimiters.webhook
            identifier = ip
        } else if (pathname === '/api/webhooks/paystack-transfer-approval') {
            limiter = rateLimiters.webhook
            identifier = ip
        } else if (pathname === '/api/airtime/create') {
            limiter = rateLimiters.airtimeCreate
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/orders/purchase') {
            limiter = rateLimiters.ordersPurchase
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/orders/bulk-purchase') {
            limiter = rateLimiters.ordersBulk
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/payments/initialize') {
            limiter = rateLimiters.paymentsInitialize
            identifier = ip
        } else if (pathname === '/api/payments/verify') {
            limiter = rateLimiters.paymentsVerify
            identifier = ip
        } else if (pathname === '/api/payments/charge') {
            limiter = rateLimiters.paymentsCharge
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/payments/charge/submit-otp') {
            limiter = rateLimiters.paymentsChargeOtp
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/payments/charge/check-pending') {
            limiter = rateLimiters.paymentsChargePoll
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/verify') {
            limiter = rateLimiters.shopVerifyOrder
            identifier = ip
        } else if (pathname === '/api/user/upgrade/initialize') {
            limiter = rateLimiters.userUpgrade
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/pricing') {
            limiter = rateLimiters.shopPricing
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/withdraw') {
            limiter = rateLimiters.shopWithdraw
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/invites') {
            limiter = rateLimiters.shopInvites
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/sub-agents' || pathname === '/api/shop/sub-pricing') {
            limiter = rateLimiters.shopSubAgents
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/sub-withdrawals' || pathname === '/api/shop/sub-withdrawals/approve') {
            limiter = rateLimiters.shopSubWithdrawals
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/dashboard/subagents' && request.method === 'POST') {
            // Mints a real Supabase Auth account (final-review C1) — must not
            // fall through to the generic IP-keyed `general` limiter. GET
            // (downline listing) intentionally falls through below.
            limiter = rateLimiters.subAgentCreate
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname.startsWith('/api/dashboard/subagents/') && pathname.endsWith('/regenerate')) {
            limiter = rateLimiters.subAgentRegenerate
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/join') {
            limiter = rateLimiters.joinRedeem
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/announcements') {
            limiter = rateLimiters.shopAnnouncements
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/alerts') {
            limiter = rateLimiters.shopAlerts
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/users/update-profile') {
            limiter = rateLimiters.updateProfile
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/users/delete-account') {
            limiter = rateLimiters.deleteAccount
            identifier = authUser?.id ?? ip
        } else if (pathname === '/api/user/afa-registration') {
            limiter = rateLimiters.afaRegistration
            identifier = ip
        } else if (pathname === '/api/agent/downgrade') {
            limiter = rateLimiters.agentDowngrade
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/admin-settings') {
            limiter = rateLimiters.adminSettings
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/lookup-orders') {
            limiter = rateLimiters.shopLookupOrders
            identifier = ip
        } else if (pathname === '/api/shop/my-orders') {
            limiter = rateLimiters.shopMyOrders
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/ussd-code') {
            limiter = rateLimiters.shopUssdCode
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/shop/upload') {
            limiter = rateLimiters.shopUpload
            identifier = authUser?.id ?? ip
        } else if (pathname === '/api/airtime/history') {
            limiter = rateLimiters.airtimeHistory
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname.startsWith('/api/admin/supplier-balance')) {
            limiter = rateLimiters.supplierBalance
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname === '/api/support-chat') {
            limiter = rateLimiters.supportChat
            identifier = ip
        } else if (pathname.startsWith('/api/cron')) {
            limiter = rateLimiters.cron
            identifier = ip
        } else if (pathname === '/api/settings/page-access') {
            limiter = rateLimiters.pageAccess
            identifier = authUser?.id ?? ip
        } else if (pathname === '/api/user/afa-price') {
            limiter = rateLimiters.afaPrice
            identifier = authUser?.id ? `${authUser.id}-${ip}` : ip
        } else if (pathname.startsWith('/api/user')) {
            limiter = rateLimiters.user
            identifier = authUser?.id ?? ip
        } else if (pathname === '/api/shop-domain/search') {
            limiter = rateLimiters.shopDomainSearch
            identifier = ip
        } else if (pathname.startsWith('/api')) {
            limiter = rateLimiters.general
            identifier = ip
        }

        if (limiter) {
            const { success, reset } = await limiter.limit(identifier)
            if (!success) {
                const retryAfter = Math.ceil((reset - Date.now()) / 1000)
                // Page routes (non-/api) are full-document navigations — e.g. Google
                // redirecting the browser to /auth/callback. Returning a raw JSON 429
                // renders as an unusable dead-end page with no way back. Redirect to
                // an HTML page that has a working retry path instead. /auth matches no
                // limiter branch, so this cannot loop.
                if (!pathname.startsWith('/api')) {
                    const redirectUrl = new URL('/auth', request.url)
                    redirectUrl.searchParams.set('error', 'rate_limited')
                    const nextParam = request.nextUrl.searchParams.get('next')
                    if (nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//')) {
                        redirectUrl.searchParams.set('next', nextParam)
                    }
                    return addNoCacheHeaders(NextResponse.redirect(redirectUrl))
                }
                return rateLimitExceeded(Math.max(1, retryAfter))
            }
        }
    } catch (error) {
        // Signup fails closed — in-memory fallback is per-Lambda and useless in serverless.
        if (SIGNUP_FAIL_CLOSED_PATHS.has(pathname)) {
            console.error('[RateLimiter] Redis error, blocking signup (fail-closed):', error)
            return NextResponse.json(
                { error: 'Registration is temporarily unavailable. Please try again shortly.' },
                { status: 503 }
            )
        }
        // Other critical auth routes use the in-memory fallback; remaining routes fail open.
        const fallbackConfig = fallbackCriticalLimits[pathname]
        if (fallbackConfig) {
            const fallbackIdentifier = authUser?.id ?? getIP(request)
            const retryAfter = applyFallbackRateLimit(fallbackIdentifier, fallbackConfig)

            if (retryAfter !== null) {
                console.error('[RateLimiter] Redis error, fallback limiter blocked request:', error)
                return rateLimitExceeded(retryAfter)
            }
        }
        console.error('[RateLimiter] Redis error, failing open:', error)
    }

    // Protected dashboard routes
    if (pathname.startsWith('/dashboard')) {
        if (!authUser) {
            return addNoCacheHeaders(NextResponse.redirect(new URL('/auth', request.url)))
        }
    }

    // Protected admin routes (UI and API)
    const isAdminUI = pathname.startsWith('/admin')
    const isAdminAPI = pathname.startsWith('/api/admin')

    // Whitelisted admin endpoints accessible to all authenticated users
    const adminPublicEndpoints = ['/api/admin/get-prices', '/api/admin-settings']
    const isAdminPublicEndpoint = adminPublicEndpoints.some(ep => pathname === ep)

    if ((isAdminUI || isAdminAPI) && !isAdminPublicEndpoint) {
        if (!authUser) {
            if (isAdminAPI) return addNoCacheHeaders(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
            return addNoCacheHeaders(NextResponse.redirect(new URL('/auth', request.url)))
        }

        try {
            // 8s timeout for the role check, with the timer cleared as soon
            // as the real query resolves — same pattern as the session call
            // above. Prevents leaking `setTimeout` handles under load.
            let roleTimeoutId: ReturnType<typeof setTimeout> | undefined
            const timeout = new Promise((_, reject) => {
                roleTimeoutId = setTimeout(() => reject(new Error('Role check timeout')), 8000)
            })

            const roleQuery = supabase
                .from('users')
                .select('role')
                .eq('id', authUser.id)
                .single()
                .then((result) => {
                    if (roleTimeoutId) clearTimeout(roleTimeoutId)
                    return result
                })

            const { data: user } = await Promise.race([
                roleQuery,
                timeout
            ]) as any

            if (!user || (user.role !== 'admin' && user.role !== 'sub-admin')) {
                if (isAdminAPI) return addNoCacheHeaders(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
                return addNoCacheHeaders(NextResponse.redirect(new URL('/dashboard', request.url)))
            }

            // Strict Sub-Admin Lockdown
            // Use exact-prefix matching, NOT pathname.includes() — `.includes`
            // would also match `/admin/orders-archive`, `/admin/order-scanner`,
            // etc., accidentally widening sub-admin access if such a route is
            // ever added.
            if (user.role === 'sub-admin') {
                const isOrderPath =
                    pathname === '/admin/orders' ||
                    pathname.startsWith('/admin/orders/') ||
                    pathname === '/api/admin/orders' ||
                    pathname.startsWith('/api/admin/orders/')

                if (!isOrderPath) {
                    console.warn(`[MiddlewareAudit] Sub-admin ${authUser.id} blocked from ${pathname}`)

                    if (isAdminAPI) {
                        return addNoCacheHeaders(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
                    }

                    return addNoCacheHeaders(NextResponse.redirect(new URL('/admin/orders', request.url)))
                }
            }
        } catch (error) {
            console.error('Middleware role check error:', error)
            if (isAdminAPI) return addNoCacheHeaders(NextResponse.json({ error: 'Internal server error' }, { status: 500 }))
            return addNoCacheHeaders(NextResponse.redirect(new URL('/dashboard', request.url)))
        }
    }

    // Removed 2026-09-30 (owner decision): this API-level must-change-password
    // gate (and the paired page-level redirect in app/dashboard/layout.tsx)
    // blocked every /api/** call for a sub-agent still flagged
    // must_change_password=true, outside a 4-path allowlist — which broke
    // ordinary dashboard actions (e.g. MTN Number Registration) with
    // "You must change your password before continuing." Now that access
    // keys are delivered over SMS (already a real, private channel), the
    // owner judged the forced change unnecessary overhead rather than a
    // meaningful additional control. See app/dashboard/layout.tsx for the
    // fuller rationale. Trivially reversible — the DB column and helpers are
    // still there, just unused.

    // Redirect authenticated users away from auth pages.
    // EXCEPTIONS:
    //   /auth/update-password — Supabase creates a recovery session on link click;
    //     redirecting away would prevent the user from setting a new password.
    //   /auth/enable-biometric & /auth/setup-pin — require an active session to read
    //     dbUser.email/id for credential registration; must stay reachable post-login.
    //   /auth/change-password-required — no longer an automatic redirect target
    //     (the forced password change was removed 2026-09-30, see
    //     app/dashboard/layout.tsx), but the page itself still exists for anyone
    //     who navigates to it directly to change their password voluntarily.
    //     Kept exempted so that still works instead of bouncing them to
    //     /dashboard.
    const authExceptions = ['/auth/update-password', '/auth/enable-biometric', '/auth/setup-pin', '/auth/complete-profile', '/auth/change-password-required', '/auth/verify-phone-required']
    if (pathname.startsWith('/auth') && !authExceptions.some(p => pathname.startsWith(p))) {
        if (authUser) {
            return addNoCacheHeaders(NextResponse.redirect(new URL('/dashboard', request.url)))
        }
    }

    // ── One-time cookie-domain migration (kfg_cd1) ──────────────────────────
    // Pre-existing sessions have host-scoped sb-* cookies. Once cookieOptions
    // adds Domain=.kingflexygh.com, a token refresh would create a SECOND
    // cookie with the same name; browsers send the older host-scoped one first,
    // shadowing the fresh token and breaking auth. So, exactly once per browser:
    // delete each host-scoped sb-* cookie (raw header — ResponseCookies dedupes
    // by name) and re-issue the same value domain-scoped. NOT httpOnly: the
    // browser client reads these via document.cookie.
    //
    // Placement note: this MUST run here, immediately before the final
    // fallthrough return — NOT earlier in the function. A later `supabase`
    // query (e.g. the admin role check above) can trigger a token-refresh
    // `setAll` → `res.cookies.set()`, and ResponseCookies.set() wipes and
    // re-serializes the ENTIRE Set-Cookie header from its internal map on
    // every call. That would destroy this block's raw-appended deletion
    // headers while the map-resident kfg_cd1 marker survives — leaving
    // permanent duplicate host+domain cookies. At this final return, no
    // further `.cookies.set()` can run after this block.
    const migrationDomain = getAuthCookieDomain()
    // Host-gate: the prod build also serves *.vercel.app aliases. On those
    // hosts, the Domain=.kingflexygh.com re-issue below is REJECTED by the
    // browser (domain mismatch) but the raw host-scoped DELETIONS are still
    // accepted — destroying that alias's session while marking it migrated.
    // Only run when the request host actually belongs to the cookie domain.
    const bareCookieDomain = migrationDomain?.startsWith('.') ? migrationDomain.slice(1) : migrationDomain
    const hostOnCookieDomain = !!bareCookieDomain &&
        (hostname === bareCookieDomain || hostname.endsWith('.' + bareCookieDomain))
    if (migrationDomain && hostOnCookieDomain && !request.cookies.get('kfg_cd1')) {
        // Narrowed to the auth token (+ its .0/.1 chunks + code-verifier) —
        // NOT every sb-* cookie — so an attacker-planted sb-* cookie can't be
        // promoted to a year-long domain-scoped cookie. Mirrors the predicate
        // the signout route already uses.
        const sbCookies = request.cookies.getAll().filter(c => c.name.startsWith('sb-') && c.name.includes('auth-token'))
        // ORDERING IS LOAD-BEARING: ResponseCookies.set() wipes and re-serializes
        // the ENTIRE Set-Cookie header from its internal map on every call, which
        // destroys any raw headers.append('Set-Cookie', ...) made earlier. So ALL
        // res.cookies.set() calls (domain re-issues + marker) happen FIRST, and the
        // raw host-scoped deletions are appended AFTER the last .set() call.
        for (const { name, value } of sbCookies) {
            res.cookies.set(name, value, {
                domain: migrationDomain,
                path: '/',
                maxAge: 60 * 60 * 24 * 365,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
                httpOnly: false,
            })
        }
        res.cookies.set('kfg_cd1', '1', {
            path: '/',
            maxAge: 60 * 60 * 24 * 180,
            sameSite: 'lax',
        })
        // Second pass — raw host-scoped deletions, appended after ALL .set() calls.
        for (const { name } of sbCookies) {
            res.headers.append('Set-Cookie', `${name}=; Path=/; Max-Age=0`)
        }
    }

    return addNoCacheHeaders(setCORSHeaders(res, origin, false))
}

export const config = {
    // Exclude static files but INCLUDE api/admin for protection
    matcher: [
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2)$).*)'
    ],
}
