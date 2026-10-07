---
name: new-api-route
description: Scaffold a new KiNG FLEXY API route with correct auth, Supabase client selection, rate limiting, and response shape. Use when creating any new app/api/** route handler.
user-invocable: false
---

# New API Route — KiNG FLEXY GH

Always invoke `kingflexy-api-routes` for the full auth/rate-limit rules. This skill provides the code template.

## Choose the Right Template

| Route type | Auth method | Supabase client |
|---|---|---|
| User-facing (`/api/user/*`, `/api/orders/*`) | `createRouteClient()` cookie auth | RLS-enforced client |
| Admin-only (`/api/admin/*`) | `createRouteClient()` + role check | `supabaseAdmin` for writes |
| Developer API (`/api/v2/*`) | `validateApiKey()` from `lib/api-auth` | `supabaseAdmin` |
| Cron (`/api/cron/*`) | `validateCronAuth(request)` | `supabaseAdmin` |
| Webhooks (`/api/webhooks/*`) | HMAC signature | `supabaseAdmin` |

---

## Template: User-Facing Route

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'

export async function POST(request: NextRequest) {
    try {
        // ── 1. Authenticate ───────────────────────────────────────────────────
        const cookieStore = await cookies()
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // ── 2. Parse & validate body ──────────────────────────────────────────
        const body = await request.json()
        // TODO: validate with Zod

        // ── 3. Business logic ─────────────────────────────────────────────────
        // Use supabase (RLS-enforced) for user data reads
        // Never use supabaseAdmin here unless explicitly needed

        // ── 4. Respond ────────────────────────────────────────────────────────
        return NextResponse.json({ success: true, data: {} })
    } catch (error) {
        console.error('[api/route-name]', error)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
```

---

## Template: Admin Route

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function GET(request: NextRequest) {
    try {
        // ── 1. Authenticate + verify admin role ───────────────────────────────
        const cookieStore = await cookies()
        const supabaseAuth = await createRouteClient()
        const { data: { user } } = await supabaseAuth.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { data: userData } = await supabaseAdmin
            .from('users')
            .select('role')
            .eq('id', user.id)
            .single()

        if ((userData as any)?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        // ── 2. Business logic ─────────────────────────────────────────────────
        // Safe to use supabaseAdmin here

        return NextResponse.json({ success: true, data: {} })
    } catch (error) {
        console.error('[api/admin/route-name]', error)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
```

---

## Response Shape (always)

```ts
// Success
return NextResponse.json({ success: true, data: { ... } })

// Error
return NextResponse.json({ success: false, error: 'Human-readable message' }, { status: 4xx })
```

## Idempotency (for mutation routes)

For any route that creates an order or triggers fulfillment, generate and store a reference code BEFORE calling the external API:

```ts
import { generateReferenceCode } from '@/lib/utils'
const referenceCode = generateReferenceCode()
// 1. INSERT order with referenceCode into DB
// 2. THEN call fulfillment API with referenceCode as idempotency key
```
