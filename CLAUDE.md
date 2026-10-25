# FameTech — Claude Code Instructions

## FIRST: Pick the right tier (don't burn tokens on small work)

Not every task needs the full engineering lifecycle. Classify the request first, then load only what that tier calls for. When genuinely torn between two tiers, pick the higher one.

### Tier 0 — No skill. Just do it.
Greetings, thanks, small talk. Questions about Claude Code or the environment itself (e.g. "why does my terminal keep popping up"). Explaining existing code, "where is X", "how does Y work". Typos, comments, formatting, copy edits. Config tweaks that don't touch payments, auth, or the database.

**Load nothing. Answer directly.**

### Tier 1 — Domain skill only.
A contained change: one file (or a couple of closely-related ones), no new API surface, no new table, no new dependency, and **not** touching money or auth. Small bug fixes with an obvious cause live here.

**Load only the one relevant `fametech-*` skill** (e.g. editing a route → `fametech-api-routes`). Skip the superpowers lifecycle.

### Tier 2 — Full lifecycle.
New feature, new API route, new table/migration, new third-party integration, multi-file refactor, or anything the user frames as "build/add/implement". **Anything touching payments, wallet, fulfillment, or auth is always Tier 2 regardless of how small it looks** — that's the fintech guardrail.

```
Skill("superpowers:using-superpowers")   # then fametech-workflow
```

**Escalation rule:** if a Tier 0/1 task turns out to touch money, auth, or more files than expected, stop and escalate to Tier 2 at that point — don't retrofit the process afterward.

## Development Workflow (MANDATORY)

*Applies to Tier 2 work. Tier 0/1 tasks skip this section entirely.*

The generic engineering lifecycle — brainstorming, planning, worktrees, subagent-driven execution, TDD, code review, finishing a branch — is owned by the `superpowers` plugin. Its skills trigger automatically; don't skip them and don't re-invent them locally.

On top of that, invoke `fametech-workflow` for any Tier 2 feature/fix in this repo — it adds the two project-specific gates superpowers doesn't know about: a fintech security audit (`payments-security-reviewer`) before review/finishing, and a `tsc`/`lint` QA gate before push. See `.claude/skills/fametech-workflow/SKILL.md` for exactly where each fires. (Postman docs sync removed 2026-10-17 — the user maintains their own API documentation now.)

**Gate rule:** Do not advance past a superpowers checkpoint (design approval, plan approval, etc.) without the user's explicit sign-off.

**Narration rule:** Whenever a spec/design doc, plan, or similar artifact is written to disk (e.g. `docs/superpowers/specs/*.md`, `docs/superpowers/plans/*.md`), narrate its full content in the conversation as well — don't just report the file path and ask the user to go read it. The user reviews these inline in chat.

### Model policy (applies automatically — don't ask the user to pick a model each time)

| Context | Model |
|---|---|
| Main conversation, brainstorming, planning | `sonnet` (global default) |
| `Explore` agent (read-only search/lookup) | `haiku` — no judgment calls, runs frequently |
| Subagent-driven-development task workers | `sonnet` — this is a fintech codebase, don't downgrade execution quality even on small tasks |
| `payments-security-reviewer` | `claude-sonnet-5` (pinned in the agent file) |
| Genuinely hard/ambiguous design decisions | `opus` — only when the user explicitly asks for deeper reasoning on a specific decision, never as a default |

## Project Overview

FameTech is a Next.js 15 e-commerce platform for Ghana digital services (data bundles, airtime, vouchers, AFA registrations). It serves retail users, agents, dealers, and admins across MTN, Telecel, and AirtelTigo networks.

**Stack:** Next.js 15 (App Router), Supabase (Postgres + Auth + RLS), Paystack, Tailwind CSS, shadcn/ui, Framer Motion, Upstash Redis

**API surface — 378 route handlers under `app/api/`** (verified 2026-09-18, after v1 removal; re-count with `Get-ChildItem app/api -Recurse -Filter route.ts` rather than trusting this number blindly):

| Group | Routes | Public? |
|---|---|---|
| `admin/` | 159 | No — internal only |
| `shop/` | 48 | No |
| `cron/` | 33 | No — secret-header auth |
| **`v2/`** | **26** | **Yes — the public developer API (v1 was retired and removed 2026-09-18); the only group that is externally documented** |
| `user/` | 14 | No |
| `auth/` | 13 | No |
| `webhooks/` | 11 | Inbound only (Paystack HMAC) |
| everything else | 74 | No |

Only `app/api/v2/**` is externally documented. Never publish admin, cron, shop, or webhook routes to public docs — that exposes internal attack surface.

## Plugins Installed

All skills come from installed plugins. Use the `Skill` tool with the namespaced form `plugin:skill-name`.

### Superpowers Workflow Skills (`superpowers` plugin)
- `superpowers:brainstorming` — before writing any new feature
- `superpowers:writing-plans` — after design approval
- `superpowers:subagent-driven-development` — executing plans with parallel agents
- `superpowers:executing-plans` — batch execution with checkpoints
- `superpowers:test-driven-development` — RED→GREEN→REFACTOR, always
- `superpowers:using-git-worktrees` — isolated branch per feature
- `superpowers:finishing-a-development-branch` — merge/PR/discard decision
- `superpowers:requesting-code-review` — between tasks
- `superpowers:receiving-code-review` — responding to review feedback
- `superpowers:systematic-debugging` — 4-phase root cause process
- `superpowers:verification-before-completion` — before declaring done
- `superpowers:dispatching-parallel-agents` — concurrent subagent workflows
- `superpowers:writing-skills` — create/edit skills

### FameTech Domain Skills (local `.claude/skills/`)
- `fametech-domain` — user roles, pricing tiers, network operators, wallet system
- `fametech-api-routes` — API route conventions, auth, rate limiting, response shapes
- `fametech-developer-api` — the public v2 developer API surface (v1 retired and removed): key-type scoping, idempotency/race pattern, rate limiting, webhook signing
- `fametech-supabase` — which DB client to use, idempotency, RLS, wallet operations
- `fametech-fulfillment` — DataKazina API, circuit breaker, bundle mapping, Paystack webhooks
- `fametech-cron` — all cron endpoints, schedules, re-enable process after Vercel Pro upgrade
- `fametech-workflow` — project gates: fintech security audit, `tsc`/lint QA
- `new-api-route` — correct scaffold template for user/admin/cron/webhook routes

### Other Plugin Skills (verified installed — do not cite skills not on this list)
- `frontend-design:frontend-design` — production-grade UI components
- `security-review` — built-in security review skill (`/security-review`); not a plugin
- `supabase:supabase` — Supabase best practices; `supabase:supabase-postgres-best-practices` — schema, RLS, indexes, migrations
- `vercel:*` — deployment, env vars, Next.js, caching, functions, firewall, shadcn
- `pr-review-toolkit:review-pr` — multi-agent PR review (silent failures, type design, test coverage)
- `claude-md-management:claude-md-improver` — audit/improve CLAUDE.md files
- `claude-md-management:revise-claude-md` — capture session learnings into CLAUDE.md
- `code-review` — built-in diff/PR review (`/code-review`); not a plugin
- `document-skills:xlsx` — spreadsheet work (this repo uses `xlsx` / `xlsx-js-style` for exports)

**MCP servers connected:** `supabase`, `vercel` — all remote HTTP, OAuth-authorized. Prefer their read tools (`list_tables`, `get_logs`, `get_advisors`, `list_deployments`, `get_runtime_errors`) over guessing at live state.

**Deliberately DISABLED or NOT installed — do not (re)install without asking:**
- `security-guidance` — installed but **disabled 2026-08-09**. Its hooks fire on `UserPromptSubmit` (every prompt), `PostToolUse` for every `Edit`/`Write`/`Bash`, and `Stop`. On Windows each fires `bash sg-python.sh` in a **visible** console window, making the IDE unusable. Security coverage is preserved via the `payments-security-reviewer` subagent, the built-in `/security-review`, and the Security Gate in `fametech-workflow`.
- `chrome-devtools-mcp` — installed and removed 2026-08-09. Only plugin here that runs a **local** stdio MCP server via `npx`, spawning visible `cmd.exe`/`conhost.exe` windows per session. Verify UI changes with `npx tsc --noEmit` + `npx next lint` + manual browser checks instead.
- `postman` — removed 2026-10-17. The user maintains their own API documentation now; never invoke `postman:*` skills or the Postman docs gate again unless the user explicitly asks to bring it back.
- `figma`, `sentry`, `coderabbit`, `firecrawl`, `commit-commands`, `remember` — no matching dependency in `package.json`; previously listed here in error.

> **Windows hook caveat (read before installing any plugin).** Claude Code on Windows spawns hook commands **without** `CREATE_NO_WINDOW`, so every hook opens a visible console window. Before installing a plugin, check `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/hooks/hooks.json`. A plugin with only `SessionStart`/`SessionEnd` hooks costs one window per session (acceptable — `superpowers` and `vercel` are in this category). A plugin with `UserPromptSubmit`, `PostToolUse`, or `Stop` hooks fires constantly and will make the IDE unusable on this machine.

## Skill Trigger Rules

Tier (see top of file) decides *whether* to load skills; this table decides *which*. Tier 0 loads none of these.

| Task type | Tier | Skills to invoke |
|---|---|---|
| "Let's build X" / new feature | 2 | `superpowers:brainstorming` → `fametech-workflow` → `superpowers:writing-plans` |
| Bug / issue / error report | 1 or 2 | **Search → Investigate → Isolate → Articulate the root cause FIRST, then fix.** Obvious one-liner → Tier 1, just fix it. Non-obvious or money/auth → `superpowers:systematic-debugging` → `fametech-workflow` → `superpowers:verification-before-completion` |
| Any DB/Supabase work | 1–2 | `fametech-supabase` + `supabase:supabase` (+ `supabase:supabase-postgres-best-practices` for schema/RLS/migrations) |
| Any API route work | 1–2 | `fametech-api-routes` + `new-api-route` |
| Change to `app/api/v2/**` (public dev API) that alters its request/response contract | 2 | Above — update the user's own API documentation manually; no automated docs gate |
| `app/api/v2/**` route work with no public contract change (internal refactor) | 1–2 | `fametech-developer-api` + `fametech-api-routes` |
| Any fulfillment/order work | 2 | `fametech-fulfillment` |
| Any cron work | 1–2 | `fametech-cron` |
| Any business logic | 1–2 | `fametech-domain` |
| Any UI component | 1–2 | `frontend-design:frontend-design` |
| Before finishing Tier 2 work | 2 | `superpowers:verification-before-completion` |
| Security-sensitive changes (payments/wallet/auth) | 2 | `payments-security-reviewer` subagent + `/security-review` |
| After a substantial session | — | `claude-md-management:revise-claude-md` |
| After shipping a new payment gateway, API, role, or integration | — | Update memory files + `claude-md-management:revise-claude-md` — memory must reflect current project state |

## Key Conventions

- **Auth:** route handlers → `createRouteClient` (lib/supabase-server, cookie/RLS-aware); server components → `createServerComponentClient` (lib/supabase-server); admin/service-role → `createAdminClient` (lib/supabase-admin) or `createServerClient` (lib/supabase). ⚠️ `createServerClient` is SERVICE-ROLE with NO cookies — never call `auth.getUser()` on it in a route handler; use `createRouteClient`. `users` has a self-update RLS policy (`auth.uid()=id`), so user routes can write the caller's own row via the RLS client.
- **Wallet ops:** Always use DB functions/RPCs, never direct UPDATE — prevents race conditions. Inside those RPCs, lock the row (`FOR UPDATE`) *before* checking idempotency, never after — check-before-lock lets two concurrent calls both pass the check (real double-credit bug found in `credit_shop_profit`/`reverse_lead_margin`, fixed 2026-08-11, see `docs/security-audits/`).
- **Money tables are server-write-only:** never grant `anon`/`authenticated` INSERT/UPDATE/DELETE (or add a client write RLS policy) on `orders`, `airtime_orders`, `afa_orders`, `standard_bundle_orders`, `wallets`, `wallet_transactions`, or `user_payment_references` (guarded). The refund RPC `refund_standard_bundle_wallet(p_order_id, p_actor_id, p_expected_updated_at)` is service-role only. A client INSERT policy on `orders` let any user forge a pending order and self-refund it into their wallet (fixed 2026-09-24, see `docs/security-audits/2026-09-24-client-order-forgery.md`). The guard trigger `block_client_money_writes()` (money tables) / `trg_block_client_write` (`user_payment_references`) enforces this even if a grant is re-added; re-check with `scripts/sql/verify-client-money-write-lock.sql`. `ussd_pending_orders`, `shop_orders`, and `shop_customers` are also server-write-only (client write grants revoked, no guard trigger needed since no client write policy ever backed them).
- **Payments:** Paystack webhooks at `/api/webhooks/paystack` — always verify HMAC signature
- **Idempotency:** Use `PGRST116` (not found) pattern for upserts; never assume row exists. For request-level dedup keys (e.g. blocking a double-submitted send/purchase), never include a time bucket — a client retry after a timeout can cross the boundary and defeat it. Hash the exact content instead and expire claim rows via a cleanup cron.
- **RLS:** All user-facing queries go through RLS-aware clients; admin client only for server-side admin ops
- **API responses:** `{ success: true, data: {} }` or `{ success: false, error: "message" }`
- **Local-only docs:** `docs/superpowers/plans/` and `specs/` are gitignored — don't `git add` them. `docs/security-audits/` is the opposite — committed, for race-condition/fraud audit reports.
- **DB migrations:** No local Supabase stack in this repo (no `supabase/config.toml`) — apply migrations directly to the live project via the `apply_migration` MCP tool, then save the same SQL under `supabase/migrations/<name>.sql` for repo history.
- **Tests:** pure-logic via `npx tsx scripts/test-*.ts`; no component test runner — UI verified by `npx tsc --noEmit` + `npx next lint` + manual. A pre-commit hook auto-runs eslint on staged files. `next lint`'s own stderr deprecation notice trips PowerShell's `2>&1` NativeCommandError wrapping (reports exit 1 even on success) — don't pipe its stderr; read for the actual `✔ No ESLint warnings or errors` line.
- **PWA offline fallback:** use `fallbacks: { document: '/~offline' }` in `withPWAInit()` (next.config.ts) + a real page at `app/~offline/page.tsx` — the plugin auto-wires a Workbox `handlerDidError` onto every `runtimeCaching` rule (including custom `NetworkOnly` ones), no manual Workbox wiring needed. That page is a normal NESTED page (renders inside the existing root layout/providers) — it must NOT declare its own `<html>`/`<body>`, only `app/layout.tsx` may. ⚠️ `next lint` is deprecated as of Next 15.5 and will be removed in Next.js 16 (it still runs clean today) — before any Next 16 upgrade, migrate via `npx @next/codemod@canary next-lint-to-eslint-cli .` and update this line plus the QA gate in `fametech-workflow`. When migrating, carry over the `app/api/v2/**` `no-restricted-imports` override from `.eslintrc.json` — it enforces API-key-only auth on v2 routes and would otherwise be silently dropped.
- **`next` is pinned to an exact version** (`"next": "15.5.23"`, no `^`) rather than a range — deliberate, so a `next` bump only ever happens via an explicit `npm install next@<version> --save-exact`, never silently through `npm install`. Bumped from 15.1.9 on 2026-08-21 to close a critical (CVSS 9.1) middleware authorization-bypass CVE (GHSA-f82v-jwr5-mffw) plus ~26 other advisories; verify with `tsc`/`lint`/`npm run build` before ever changing this pin, not just `npm audit fix` (plain `npm audit fix` won't cross an exact pin — it reports "outside the stated dependency range" and needs the manual `npm install next@<version> --save-exact` instead).
- **Standard Bundles (KingFlexyGH, standalone product):** separate from `data_packages`/`orders`/supplier toggles — own table `standard_bundle_orders`, customer page `/dashboard/standard-bundles`, admin page `/admin/standard-bundles`, APIs under `/api/standard-bundles/*` and `/api/admin/standard-bundles/*`. Fulfilled only by KingFlexyGH `/api/v2/bundles/*` using the same `KINGFLEXY_COMMISSION_API_KEY` / `KINGFLEXY_COMMISSION_WEBHOOK_SECRET`. Customer price = catalog price × (1 − per-network discount %, admin-set 0–50, `admin_settings` keys `std_bundles_discount_{mtn,telecel,at}`; broadband never discounted). Bundle webhook events (`product: "bundles"`) are handled by the existing `/api/webhooks/kingflexy-commission`; recovery lives in the existing `kingflexy-commission-reconcile` cron (passes F–I: processing check, pending dispatch, failed-refund backstop, exhausted check — none auto-refund a non-terminal order). Admin manual refund/retry must verify with the supplier first (10-minute freshness window, compare-and-set on `updated_at`, 404 only trusted with the supplier's JSON envelope). Lib files: `lib/standard-bundles-*.ts` and `lib/kingflexy-bundles-service.ts`. Tests: `npx tsx scripts/test-standard-bundles.ts`. Migration `supabase/migrations/20261024_standard_bundles.sql` (apply to live before deploy).
- **Toasts:** Always `import { toast } from '@/lib/toast'` (branded `SplitPanelToast` wrapper) — never raw `sonner`. Same call signature (`toast.success(title)` / `toast.error(title)`), so it's a drop-in swap.
- **Shared validation primitives:** `shortTextSchema`, `longTextSchema`, `phoneSchema`, `adminLongTextSchema` all live in `lib/validation.ts`. `adminLongTextSchema` allows `<>&` (blocks only script-injection patterns) — use it for admin-authored text; the customer-facing `shortTextSchema`/`longTextSchema` reject `<>&` outright.
- **Landing page (`app/page.tsx`) is ISR-cached** (`revalidate = 300`, shared across all visitors) and passes no auth/session data to `HomeClient`. Any landing-page component needing login state must resolve it client-side via `useAuth()`, never via a prop from the server component.
- **Login route is `/auth`, not `/login`.** Its `next` continuation query param is only read by the Google OAuth and magic-link handlers in `app/auth/page.tsx` — the default email/password login path ignores it and always redirects to `/dashboard`.
- **User-submitted "lead intake" tables** (support tickets, website requests, etc.): RLS grants the owner `SELECT` only, never `INSERT`/`UPDATE` for `authenticated`; every write goes through a service-role client after validation. A per-user rate cap uses a `BEFORE INSERT` trigger with `pg_advisory_xact_lock` + `RAISE EXCEPTION '<LITERAL>'`, caught in the API route via `error.message.includes('<LITERAL>')` → friendly error.

## Cron Jobs on cron-job.org (setup tracker)

Audited 2026-10-13 against `app/api/cron/**` (34 routes, all `GET`, all call `validateCronAuth`; every table/RPC they use exists in the live Supabase project; all 34 are deployed — probed `https://fametechgh.com/api/cron/<name>` → 401, never 404). Production host is the apex `fametechgh.com`; `www` 308-redirects to it. `vercel.json` has **no** `crons` and `.github/workflows/cron.yml` is legacy — cron-job.org is the only scheduler. Status below is what's been configured on cron-job.org; update the checkbox as each job is created.

**Job recipe (identical for every job):** URL `https://fametechgh.com/api/cron/<name> (NO www — the www host redirects and a redirect drops the Authorization header → 401)` · method `GET` · header `Authorization: Bearer <CRON_SECRET>` · account timezone **UTC** · request timeout 30s (cron-job.org's cap; routes with `maxDuration=60` may still finish server-side) · enable "notify on failure". `CRON_SECRET` must be set in Vercel **Production** (and redeployed), same value as in the header. Missing secret → route returns 500; wrong header → 401.

**Rate-limit trap:** `middleware.ts` limits `/api/cron/*` to **10 requests/min per IP** (only `sync-moolre-withdrawals` is exempt). cron-job.org calls come from a few shared IPs, so never let >10 jobs fire in the same minute — use the minute offsets below, not "every N minutes" defaults.

### Tier A — core money/ops (needed at launch)
| Done | Route | Schedule (UTC, minutes) |
|---|---|---|
| [ ] | sms-dispatch | every minute |
| [ ] | verify-pending-payments | every 5 min: 0,5,10… |
| [ ] | publish-scheduled-announcements | every 5 min: 4,9,14… |
| [ ] | auto-complete-data | every 10 min: 1,11,21,31,41,51 |
| [ ] | sms-status-reconcile | every 10 min: 3,13,23,33,43,53 |
| [ ] | kingflexy-commission-reconcile | every 10 min: 6,16,26,36,46,56 (also reconciles Standard Bundles orders — required for that product) |
| [ ] | sync-paystack-withdrawals | every 10 min: 8,18,28,38,48,58 |
| [ ] | refulfill-pending-orders | every 15 min: 4,19,34,49 |
| [ ] | auto-unsuspend | hourly at :12 |
| [ ] | escalate-sub-withdrawals | hourly at :14 |
| [ ] | auto-upgrade | every 6h at :30 (0:30, 6:30, 12:30, 18:30) |
| [ ] | downgrade-expired-dealers | every 6h at :00 (2,8,14,20) |
| [ ] | downgrade-expired-agents | daily 02:15 |

### Tier B — housekeeping / engagement
| Done | Route | Schedule (UTC) |
|---|---|---|
| [ ] | delete-old-notifications | daily 00:00 |
| [ ] | delete-old-orders | Sundays 01:00 |
| [ ] | delete-old-complaints | Sundays 01:05 |
| [ ] | purge-afa-staging | daily 03:00 (KYC retention — don't skip) |
| [ ] | sms-purge | daily 03:10 |
| [ ] | reconcile-shop-pricing | daily 03:20 |
| [ ] | agent-renewal-reminder | daily 07:00 |
| [ ] | daily-greeting | daily 08:00 |
| [ ] | shop-sales-report | URL needs `?type=weekly` — Mondays 06:00 (also supports `daily`/`monthly`) |
| [x] | sms-broadcast-recover | every 10 min, e.g. minutes 5,15,25,35,45,55 — created 2026-10-19. Safety net for the admin SMS broadcast queue (`app/admin/sms-broadcast`): finishes any broadcast the admin's browser stopped polling mid-send. Must run **no more often than every 6 min** — the cron's own writes count as recent activity, so a tighter interval would make a tick see its own last run and skip the broadcast forever. |

### Deferred until the feature has data (verified 2026-10-13: `results_checker_types`=0, `sms_campaigns`=0)
- fulfill-pending-rc-vouchers (every 5 min, minutes 2,7,12…) and release-rc-reservations (every 15 min, minutes 9,24,39,54) — create when the first results-checker type/inventory is stocked.
- `sms-dispatch` only dispatches *scheduled bulk SMS campaigns* (`claim_sms_campaigns`); campaign UI exists but 0 campaigns so far — harmless every minute, kept in Tier A.
- Tier B `delete-old-*` jobs have nothing to delete for 30–90 days — create them last.

### ⚠️ URGENT — `sync-agentportal-status` (promoted out of Tier C 2026-10-14)
`auto_fulfillment_enabled` flipped to `true` sometime after the 2026-10-13 snapshot below — AgentPortal is now live and dispatching real orders, but this cron was never created (it was still gated behind "only when the supplier carries orders"). Found via a live stuck order (`GHD-MV6DK2TY-CYAXKY`, stuck in `processing` since 2026-10-13 22:11 UTC) — AgentPortal's webhook is documented to sometimes never fire at all, and this cron (`reconcileAgentPortalDeliveries()`) is the ONLY recovery path for that case, plus the only path that can resolve a *retry* order's outcome (see `lib/agentportal-reconcile.ts` / `lib/agentportal-status.ts` header comments). **Create this job on cron-job.org NOW** — every 10 min, e.g. minutes 7,17,27,37,47,57 — using the standard Job recipe above. Also verify `AGENTPORTAL_API_KEY` is set in Vercel Production (reconcile can't poll at all without it) and `AGENTPORTAL_WEBHOOK_SECRET` is set (webhook fails closed to 503 without it). Until the cron exists, use the admin Fulfillment Center's AgentPortal "Sync" button to manually trigger `reconcileAgentPortalDeliveries()` for any stuck order.

### Tier C — supplier safety-nets (create ONLY when that supplier actually carries orders; live DB had `auto_fulfillment_enabled=false` and ~no orders as of 2026-10-13 — re-verify per-supplier before deferring, see AgentPortal note above)
sync-codecraft-status, sync-xpress-status, sync-ghdata-status, sync-hendylinks-status (10 min — must stay ≤ auto-complete-data's cadence, see route comment), sync-spfastit-status, sync-atishare-console-status, alert-bundleportal-stuck (15 min). Give each a free minute offset (5,12,17,… ) so no minute exceeds 10 hits.

### Do NOT create
- `sync-moolre-withdrawals` — owner has no Moolre account (see memory `shop-withdraw-momo-only-paystack`); create only after Moolre goes live.
- `hubtel-commission-reconcile` — owner has no Hubtel commission account; airtime/utilities run on KingFlexyGH. Only for legacy in-flight Hubtel rows (none exist on the new DB).

**Left to do:** 1 of 23 Tier A+B jobs created so far (`sms-broadcast-recover`, Tier B) — the other 13 Tier A + 9 Tier B jobs are still unchecked, Tier C pending supplier go-live. Set a fresh `CRON_SECRET` in Vercel Production first for the rest.

## Supabase Egress & Media

- **Diagnose egress by BYTES, never request count.** 2026-08-16: 165 image requests outweighed 117,312 REST requests. Measure first, via the `query_logs` MCP tool:
  `select log_attributes['request.path'] as path, count(*) as reqs, sum(toUInt64OrZero(log_attributes['response.headers.content_length'])) as bytes from logs where source='edge_logs' group by path order by bytes desc`
  Caveat: PostgREST replies use chunked encoding (no `content_length`, so REST is undercounted); storage/image responses always carry it. `log_attributes['request.path']` is the right key — `['path']` returns empty.
- **Storage objects are served through `edge_logs`, not `storage_logs`.** A low `storage_logs` count does NOT mean storage is cheap.
- **Shop logos**: public `shop-logos` bucket, path `{owner_id}/logo.{ext}`. `app/api/shop/upload/route.ts` downscales to fit 512×512 before storing — never store raw uploads. `scripts/compress-shop-logos.ts` backfills existing objects (dry-run by default; `--apply` writes, `--all` includes orphans, originals backed up to `scripts/.logo-backups/`).
- **`jimp` 0.22 cannot decode WebP.** Skip WebP instead of re-encoding, and detect real format by magic bytes — the bucket contains WebP saved under `.png` names. Raise `maxMemoryUsageInMB` on the `jpeg-js` decoder for large phone photos, or they fail to decode.
- **`supabase.auth.getUser()` makes NO network call when the request has no auth cookie** — it short-circuits locally (see `_getUser` in `@supabase/auth-js`). Anonymous traffic, Paystack webhooks and cron hits are already free; don't "optimize" them.
- **Authenticated API requests verify auth twice**: `middleware.ts` calls `getUser()` + a `users.role` query, then the route repeats both via `validateAdminAccess` (`lib/auth-utils.ts`). Middleware needs `authUser.id` to key per-user rate limits, so it can't simply be dropped — `getClaims()` + asymmetric JWT signing keys is the fix (local verification, no round-trip). `getClaims()` is safe to deploy *before* rotating keys: on a symmetric secret it just behaves like `getUser()`.

## iOS Mobile Patterns

- **Auto-focus inputs on mobile:** Never use `setTimeout` to focus an input — iOS drops the keyboard. Use double `requestAnimationFrame` inside the click handler (stays within the gesture chain): `requestAnimationFrame(() => { requestAnimationFrame(() => { ref.current?.focus() }) })`

## Bottom Sheet / Dialog Patterns

- **Close button:** Default shadcn `DialogContent` close button is `h-4 w-4` (too small for mobile). Use `hideCloseButton` prop + add `DialogClose` with `w-9 h-9 rounded-full` in the drag handle row.
- **Drag handle row:** Use `relative flex items-center justify-center` so close button can be `absolute right-3`.

## Plugin & Skill Setup

- **Active project root is `D:\Projects\CLONED REPO KFT`.** A stale copy of this repo still exists at `D:\Projects\FameTech` (with its own outdated `CLAUDE.md`) — ignore it; it is not the working tree.
- Plugins are installed at `scope: user` (global, in `~/.claude/settings.json` under `enabledPlugins`), so they load regardless of which directory Claude Code opens from. Manage them with the CLI, not by hand-editing JSON:
  ```
  claude plugin list                    # name, version, enabled/disabled
  claude plugin install <name>@<marketplace>
  claude plugin enable|disable <name>@<marketplace>
  claude plugin marketplace list
  ```
  Note: running `claude plugin install` has been observed to silently flip *other* plugins to disabled — always re-run `claude plugin list` afterward and re-enable anything that got switched off.
- Registered marketplaces: `claude-plugins-official` (`anthropics/claude-plugins-official`, official), `anthropic-agent-skills` (`anthropics/skills`, official), `superpowers-dev` (`obra/superpowers`, third-party). Superpowers is **not** in the official marketplace — it needs `claude plugin marketplace add obra/superpowers` first.
- Only keep `.claude/skills/` for project-custom skills (`fametech-*`); delete any that duplicate plugin skills.
- `.claude/settings.json` (project) holds a read-only Bash/PowerShell permission allowlist to cut permission prompts. Add only non-mutating commands there.

## Output Standards (MANDATORY on every task)

Every task completion must include all four of the following:

### 1. Before / After Walkthrough
For each changed file:
```
### path/to/file.ts
**Before:** what it did / what the problem was
**After:** what it does now
**Why:** reason for the change
```
Include a minimal diff snippet for logic-level changes.

### 2. Manual Actions Required
List every action Claude cannot perform (env vars, Supabase migrations, secrets, MCP config, third-party dashboards). Format as a table. If nothing is needed: **"Manual Actions Required — None"**

### 3. Todo List
Create a `TodoWrite` task list before starting any multi-step work. Mark tasks `in_progress` before starting, `completed` immediately after. Never batch completions.

### 4. User-Facing Announcement Note
After any fix, update, or new implementation, write a short customer-facing announcement the user (the platform owner) can post to FameTech's own users — friendly tone, plain language, no internal jargon (no file names, function names, "root cause", ticket numbers, etc.). Focus on what changed for *them* (e.g. "Login is now smoother" / "You can now sign in with your phone number too"). Keep it short — a couple of sentences to a small paragraph, plus a one-line "what to do" if any user action is needed (e.g. re-login). Skip this note only for pure internal work with zero user-visible effect (e.g. refactors, internal tooling, CLAUDE.md edits) — state explicitly that it's being skipped and why.

---

## What NOT to Do

- Never jump straight to a fix — always search, investigate, isolate, and articulate the root cause first
- Never skip `superpowers:brainstorming` before implementing a new feature
- Never write to wallet balance with direct SQL UPDATE
- Never expose admin client in client components
- Never commit `.env.local`
- Never use `git push --force` on `main`
- Never branch or merge without `git fetch origin` first — local `main` was found 18 commits behind `origin/main` mid-session
- **Always do feature-branch work in an isolated `git worktree`, never directly in the primary checkout** — confirmed 2026-08-22: a second concurrent Claude Code session working directly in the primary checkout caused real branch/commit collisions (a commit landed on `main` via a race, files reverted on disk mid-edit). Existing worktrees live at `.claude/worktrees/<name>`; create new ones there (`git worktree add .claude/worktrees/<name> -b <branch> <base>`) before touching branches/commits, even for small bounded tasks.
- Never diagnose an egress or performance problem from request counts alone — measure bytes first (see Supabase Egress & Media)
