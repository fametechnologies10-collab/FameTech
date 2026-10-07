---
name: kingflexy-developer-api
description: The public developer API surface for KiNG FLEXY GH (/api/v2/ — the only version; v1 was retired and removed) — key-type scoping, the idempotency/race pattern, rate limiting, and webhook signing. Use when adding or changing any app/api/v2/** route.
---

# KiNG FLEXY GH — Developer API (v2)

This skill covers the *public* developer API specifically. For general route
auth-model selection (session vs. developer-API vs. cron), see
`kingflexy-api-routes` first.

## Versioning: v2 only

`/api/v1/**` was removed (v1 had no more integrator uptake worth carrying the
dead-code cost of a parallel version). `/api/v2/**` — base URL
`https://api.kingflexygh.com/api/v2` — is now the only developer API surface.

Path predicates live in `lib/api-version.ts` (`isV2Path`). The prefix constant
carries a TRAILING SLASH on purpose — that is what stops `/api/v2x/...` and
`/api/v20/...` matching. Never reimplement this check inline, and never switch
it to `.includes()`; `scripts/test-api-version.ts` guards this.

Several security-sensitive checks (`RESTRICTED_SCOPES` in `lib/api-auth.ts`,
the middleware rate-limit branch, `API_FAIL_CLOSED_SUFFIXES`) still match a
version-agnostic `/api/v\d+/` pattern rather than a hardcoded `/api/v2/`.
That's deliberate, not leftover v1 scaffolding — it means a future API version
inherits correct scoping/rate-limiting/fail-closed behavior automatically,
with no edit required here. Do not "simplify" those patterns to a literal
`/api/v2/...` — see `scripts/test-api-auth-scope.ts`.

### Auth constraint for every `/api/v2/**` route

`middleware.ts`'s developer-API fast path skips Supabase session creation AND
serves open CORS (`Access-Control-Allow-Origin: *`). v2 routes MUST therefore
authenticate by API key (`validateApiKey` from `lib/api-auth.ts`) and MUST NOT
use cookie/session auth (`createRouteClient`) — there is no session to read,
and open CORS makes a cookie-authed route genuinely unsafe.

The eslint override blocks the common vectors but cannot catch everything —
constructing a cookie-reading client directly from `@supabase/ssr`, or calling
`request.cookies.get()` on the `NextRequest`, will pass lint. It also cannot
prove a route authenticated at all; it only proves it did not use cookies.
Always call `validateApiKey` first.

## Key types & scope guard

Three key types on `api_keys.key_type`, enforced centrally by
`keyTypeScopeGuard` in `lib/api-auth.ts` — never by a route check alone:

```
standard   → unrestricted (data, airtime, results-checker, AFA registration,
             packages, orders, wallet) — the "data API key"
commission → only /api/v2/utilities/*
sms        → only /api/v2/sms/*
```

`scripts/test-api-auth-scope.ts` covers the scope guard.

The guard runs on fresh lookups AND on 60s-cache hits — scope is a permission
check, not part of the cached identity. Restricted-type routes additionally
call `requireKeyType(auth, 'commission' | 'sms')` as their first post-auth
line (belt-and-suspenders with the central guard).

A new product added under the `standard` key needs NO scope-guard change — an
unlisted prefix is unrestricted for `standard` and automatically blocked for
`commission`/`sms`.

## The idempotency / race pattern

Every money-moving developer-API route follows the same shape:

1. Pre-debit check-then-act scoped to `user_id` (cheap; closes the common case).
2. Prefix the developer-supplied `reference` → `API-<reference>`, atomically
   deduct via the `deduct_wallet_balance` RPC, then insert the order row.
3. A concurrent duplicate that races past step 1 hits the DB's
   `UNIQUE(reference_code)` constraint on insert — present on `orders`,
   `utility_orders`, `airtime_orders`, `results_checker_orders`, and
   `afa_orders` — lands in the insert-failure branch, and is refunded by an
   atomic `credit_wallet_balance` RPC. (Verified against the live database. Only
   `results_checker_orders` and `utility_orders` have an in-repo migration
   asserting it — `orders`, `airtime_orders` and `afa_orders` predate the
   migration history, so do not expect to find it by grepping
   `supabase/migrations/`.)

Net guarantee: two simultaneous identical requests produce exactly one charge
— never zero, never two.

**Never refund on a downstream fulfillment/dispatch failure.** A supplier
rejecting an order that was already inserted stays admin-manual-refund-only,
matching every existing money route here. Compensating refunds are only for
"money moved but the DB proves nothing was created."

## Rate limiting

Two layers, both real:

- **In-route (preferred for new routes):** fixed per-route limits via
  `consumeRateLimit` (`lib/simple-rate-limit.ts`):
  ```ts
  const rl = consumeRateLimit(`<feature>:${apiKeyId}`, LIMIT_PER_MINUTE, 60_000)
  if (!rl.allowed) return apiError(429, `Rate limit exceeded (${LIMIT_PER_MINUTE}/min)`)
  ```
  Prefer this over the older per-key-configurable `auth.rateLimits.*` shape.
- **Middleware (Upstash):** a branch chain in the developer-API fast path.

Both layers are keyed independently. Every `Ratelimit` instance in
`middleware.ts` declares an explicit `prefix` of `kfg:<propertyName>` — this is
mandatory, not stylistic. The Upstash key is `prefix:identifier` and does not
encode which limiter issued the call, so two limiters sharing a prefix would
silently share one sliding window and each judge that shared counter against
its own threshold. That was a real bug here (all 65 instances defaulted to the
same prefix). It is fixed, and `scripts/test-ratelimit-prefixes.ts` enforces
this — it is wired into `npm run test:guards`, which `npm run audit:all` and
the `kingflexy-workflow` QA gate both run. Run it after adding or renaming any
limiter.

Note that identifiers still matter independently of prefixes: `rateLimiters.general`
is deliberately called with different identifier namespaces (`api-unrouted:…` in the
developer-API catch-all vs. a raw IP in the main chain) so those two traffic classes
do not share a window.

## Webhook signing

HMAC-SHA256 over the raw JSON body, sent as `X-KFT-Signature`,
fire-and-forget with one retry on non-2xx, best-effort only — never blocks or
fails the money-critical path. Reference implementation: `lib/sms-webhook.ts`.
The secret is shown once at generation and never logged or returned again,
same discipline as the API key itself.

## List / status endpoint cap

Any `GET` returning multiple records (as opposed to a single-reference
lookup) is capped at **30 records**, newest first, no cursor pagination.
Webhook delivery is the primary real-time channel; these endpoints are a
lightweight recent-activity view, not an export mechanism. `sms/campaigns`
and `sms/senders` are known exceptions — see their route files.

## Response envelope

- Success: `{ success: true, data: {...}, meta: { timestamp, version: 'v2' } }`
- Error: `{ success: false, error: { code, message } }`

Built by `apiSuccess` / `apiError` in `lib/api-auth.ts`. `apiSuccess` defaults
`meta.version` to `'v2'` and spreads any extra `meta` you pass.
