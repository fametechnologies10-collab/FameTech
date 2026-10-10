---
name: kingflexy-api-routes
description: API route conventions for KiNG FLEXY GH — how to auth user routes vs developer API (/api/v2/) vs cron jobs, response shapes, rate limiting, and CORS. Use when writing or reviewing any app/api/** route handler.
---

# KiNG FLEXY GH — API Route Patterns

## Three auth models

### 1. User session routes (most routes)
```ts
import { createRouteClient } from '@/lib/supabase-server'

const supabase = await createRouteClient()
const { data: { user } } = await supabase.auth.getUser()
if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
```

### 2. Developer API routes (`/api/v2/**`)
> Key-type scoping, the idempotency/race pattern, and the rate-limiting convention all live in `kingflexy-developer-api`. Read that skill first for anything under `app/api/v2/**` — the guidance below is the generic route-auth shape only.

```ts
import { validateApiKey, isApiError, apiSuccess, apiError, logApiRequest } from '@/lib/api-auth'

export async function POST(request: NextRequest) {
  const startTime = Date.now()
  const auth = await validateApiKey(request)
  if (isApiError(auth)) return auth  // already a NextResponse error

  // auth.userId, auth.userRole, auth.supabase, auth.rateLimits
  // ...

  logApiRequest({ apiKeyId: auth.apiKeyId, userId: auth.userId, endpoint: '/api/v2/...', method: 'POST', statusCode: 200, responseTimeMs: Date.now() - startTime, ip: getClientIp(request) })
  return apiSuccess({ ... })
}
```

**Response shape:**
- Success: `{ success: true, data: {...}, meta: { timestamp, version: 'v2' } }`
- Error: `{ success: false, error: { code: 4xx, message: "..." } }`

### 3. Cron job routes (`/api/cron/**`)
```ts
const authHeader = request.headers.get('authorization')
if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}
```
Cron routes are GET handlers. They are called by cron-job.org with `Authorization: Bearer <CRON_SECRET>`. There are 14 scheduled jobs. Use `createServerClient` (not route client) inside cron handlers.

## Rate limiting

Upstash Redis is the primary rate limiter. `lib/simple-rate-limit.ts` provides an in-memory fallback:

```ts
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
// For developer-API routes: use auth.rateLimits.purchase / .bulk / .balance / .status
```

## Role hierarchy

`admin` > `sub-admin` > `dealer` > `agent` > `customer`

Check roles from `lib/roles.ts`. For API access, check `admin_settings.api_allowed_roles` (parsed via `lib/role-parser.ts`).

## CORS

CORS is handled in `middleware.ts`. The allowlist is `kingflexygh.com` in production and `localhost` variants in dev. Route handlers do not need to set CORS headers themselves.

## Gotchas

- API key format: `kf_live_xxxxx`. The auth lib accepts both `Authorization: kf_live_xxx` and `Authorization: Bearer kf_live_xxx`. The key_prefix is the first **16 characters** — this must match the slice used when generating keys in `app/api/user/api-keys/route.ts`.
- `logApiRequest` is fire-and-forget — never `await` it. It inserts into `api_logs` using the service-role client.
- The `api_feature_enabled` admin_setting is a master kill-switch for all `/api/v2/` routes. It returns 503 if disabled.
- User status must be `active` for API access. Suspended users are rejected even with a valid API key.
- Rate limits resolve in priority order: per-key override → admin_settings global → hardcoded fallback (purchase: 20, bulk: 10, balance: 5, status: 10).
