---
name: fametech-cron
description: FameTech cron jobs — all endpoints, their schedules, security pattern, and how scheduling actually works (external cron-job.org, not GitHub Actions). Use when working on any cron route or setting up a new scheduled task.
user-invocable: false
---

# FameTech Cron Jobs

## Security Pattern (ALL cron routes)

Every cron handler MUST call `validateCronAuth(request)` as its FIRST line:

```ts
export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError
    // ... rest of handler
}
```

`validateCronAuth` checks `Authorization: Bearer ${CRON_SECRET}` header.
Cron routes use `supabaseAdmin` (service role) — they bypass RLS intentionally.

## How scheduling actually works

Vercel Pro is already active on this project, but scheduling runs through the
external service **cron-job.org**, not Vercel's native cron and not GitHub
Actions — that's the user's deliberate choice, since cron-job.org supports far
more scheduled jobs than Vercel's plan tiers allow. Each job in the
cron-job.org dashboard is configured with the target route's URL and an
`Authorization: Bearer <CRON_SECRET>` header, on whatever interval the user
picked.

`.github/workflows/cron.yml` is a **legacy, unused** GitHub Actions file left
over from an earlier approach — it is not the source of truth for what's
actually scheduled and should not be treated as such. Don't infer a route's
live enabled/schedule status from that file or from this table; the
cron-job.org dashboard (external, not accessible from this repo) is
authoritative. If you need to know whether a specific job is currently active
or on what schedule, ask the user rather than assuming from repo state.

## All Cron Endpoints

| Endpoint | Path | Typical Schedule |
|---|---|---|
| verify-pending-payments | `/api/cron/verify-pending-payments` | Every 5 min |
| sync-codecraft-status | `/api/cron/sync-codecraft-status` | Every 10 min |
| sync-moolre-withdrawals | `/api/cron/sync-moolre-withdrawals` | Every 10 min |
| sync-xpress-status | `/api/cron/sync-xpress-status` | Every 10 min |
| agent-renewal-reminder | `/api/cron/agent-renewal-reminder` | Daily 7AM UTC |
| daily-greeting | `/api/cron/daily-greeting` | Daily 8AM UTC |
| delete-old-notifications | `/api/cron/delete-old-notifications` | Daily midnight UTC |
| delete-old-orders | `/api/cron/delete-old-orders` | Sundays 1AM UTC |
| delete-old-complaints | `/api/cron/delete-old-complaints` | Sundays 1AM UTC |
| downgrade-expired-dealers | `/api/cron/downgrade-expired-dealers` | Daily 2AM UTC |
| downgrade-expired-agents | `/api/cron/downgrade-expired-agents` | Daily 2:15AM UTC |
| auto-upgrade | `/api/cron/auto-upgrade` | Every 6 hours |
| auto-complete-data | `/api/cron/auto-complete-data` | Every 10 min |
| refulfill-pending-orders | `/api/cron/refulfill-pending-orders` | Every 15 min |
| release-rc-reservations | `/api/cron/release-rc-reservations` | Every 15 min |
| fulfill-pending-rc-vouchers | `/api/cron/fulfill-pending-rc-vouchers` | Every 5 min |
| shop-sales-report | `/api/cron/shop-sales-report` | Weekly |
| alert-bundleportal-stuck | `/api/cron/alert-bundleportal-stuck` | Every 15 min (recommended) |

## Adding a New Cron Route

Build the route the normal way (below), then tell the user the route path and
your recommended schedule — they add it as a new job in the cron-job.org
dashboard themselves (external service, not something this session can
configure). That's a Manual Action, not a code change.

```ts
// app/api/cron/my-job/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { validateCronAuth } from '@/lib/cron-utils'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    try {
        // ... job logic
        return NextResponse.json({ success: true, processed: 0 })
    } catch (error) {
        console.error('[cron/my-job]', error)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
```

Then add a job to `.github/workflows/cron.yml` following the existing pattern.
