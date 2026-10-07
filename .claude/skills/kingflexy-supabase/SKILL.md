---
name: kingflexy-supabase
description: Supabase patterns for KiNG FLEXY GH — which client to use (route vs server vs admin), idempotency with PGRST116, RLS-aware queries, wallet operations, and common table names. Use when writing or reviewing any database code in this project.
---

# KiNG FLEXY GH — Supabase Patterns

## Which client to use

| Context | Import | When |
|---|---|---|
| API route handlers (`app/api/**/route.ts`) | `createRouteClient` from `@/lib/supabase-server` | Needs user session from cookies |
| Server components (`page.tsx`, `layout.tsx`) | `createServerComponentClient` from `@/lib/supabase-server` | Read-only, no cookie writes |
| Service-layer code (`lib/*.ts`) | `createServerClient` from `@/lib/supabase` | Used inside lib functions, no cookies |
| Admin bypass of RLS | `createAdminClient` from `@/lib/supabase-admin` | Cron jobs, webhooks, system operations |
| Client components | `createBrowserClient` from `@/lib/supabase` | Browser-side, uses anon key |

**Never use `createRouteClient` in lib/ files** — that's cookie-based and belongs in route handlers only.

## Idempotency pattern (wallet payments)

Update with a status condition, then check for `PGRST116` (no rows matched = already processed):

```ts
const { data, error } = await supabase
  .from('wallet_payments')
  .update({ status: 'completed', ... })
  .eq('id', payment.id)
  .eq('status', 'pending')   // idempotency guard
  .select()
  .single()

if (error?.code === 'PGRST116') {
  return { success: true, alreadyProcessed: true }
}
```

Use `.maybeSingle()` when zero rows is valid; use `.single()` only when exactly one row is expected.

## Key tables

| Table | Purpose |
|---|---|
| `users` | All accounts; `role` ∈ `admin, sub-admin, dealer, agent, customer`; `status` ∈ `active, suspended, inactive` |
| `wallets` | One per user; `balance`, `total_credited`, `total_spent` |
| `wallet_payments` | Paystack top-up records; `status` ∈ `pending, completed, failed` |
| `orders` | All purchases; links to `users`, `wallets`; `status` ∈ `pending, processing, completed, failed, refunded` |
| `packages` | Data bundle definitions; `network`, `volume`, `price`, `agent_price`, `dealer_price` |
| `api_keys` | Developer API keys; `key_prefix` (first 16 chars), `key_hash` (bcrypt), `status`, `rate_limits` |
| `admin_settings` | Key-value store for feature flags; query by `key` |
| `api_logs` | Request logs for /api/v2/ — fire-and-forget inserts |
| `shops` | Reseller storefronts |

## Gotchas

- Always filter `users` by `status = 'active'` when checking if a user can perform actions — suspended/inactive users must be blocked.
- The `admin_settings` table is queried as `{ key, value }` pairs. Batch fetch multiple keys with `.in('key', [...])` to avoid N+1 queries.
- Wallet operations must be atomic. Use `supabase.rpc()` for any operation that reads then writes `wallets.balance` to avoid race conditions.
- Service-role client bypasses RLS — only use it where user isolation is intentionally absent (cron jobs, webhook handlers, admin operations).
- TypeScript types in `@/types/supabase` exist but are often cast to `any` in practice due to schema evolution. Don't rely solely on generated types; validate at runtime when handling webhook data.
