# KiNG FLEXY GH — Claude Code Instructions

## FIRST: Pick the right tier (don't burn tokens on small work)

Not every task needs the full engineering lifecycle. Classify the request first, then load only what that tier calls for. When genuinely torn between two tiers, pick the higher one.

### Tier 0 — No skill. Just do it.
Greetings, thanks, small talk. Questions about Claude Code or the environment itself (e.g. "why does my terminal keep popping up"). Explaining existing code, "where is X", "how does Y work". Typos, comments, formatting, copy edits. Config tweaks that don't touch payments, auth, or the database.

**Load nothing. Answer directly.**

### Tier 1 — Domain skill only.
A contained change: one file (or a couple of closely-related ones), no new API surface, no new table, no new dependency, and **not** touching money or auth. Small bug fixes with an obvious cause live here.

**Load only the one relevant `kingflexy-*` skill** (e.g. editing a route → `kingflexy-api-routes`). Skip the superpowers lifecycle.

### Tier 2 — Full lifecycle.
New feature, new API route, new table/migration, new third-party integration, multi-file refactor, or anything the user frames as "build/add/implement". **Anything touching payments, wallet, fulfillment, or auth is always Tier 2 regardless of how small it looks** — that's the fintech guardrail.

```
Skill("superpowers:using-superpowers")   # then kingflexy-workflow
```

**Escalation rule:** if a Tier 0/1 task turns out to touch money, auth, or more files than expected, stop and escalate to Tier 2 at that point — don't retrofit the process afterward.

## Development Workflow (MANDATORY)

*Applies to Tier 2 work. Tier 0/1 tasks skip this section entirely.*

The generic engineering lifecycle — brainstorming, planning, worktrees, subagent-driven execution, TDD, code review, finishing a branch — is owned by the `superpowers` plugin. Its skills trigger automatically; don't skip them and don't re-invent them locally.

On top of that, invoke `kingflexy-workflow` for any Tier 2 feature/fix in this repo — it adds the three project-specific gates superpowers doesn't know about: a fintech security audit (`payments-security-reviewer`) before review/finishing, a `tsc`/`lint` QA gate before push, and a Postman docs sync when the public `app/api/v2/**` surface changes. See `.claude/skills/kingflexy-workflow/SKILL.md` for exactly where each fires.

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

KiNG FLEXY GH is a Next.js 15 e-commerce platform for Ghana digital services (data bundles, airtime, vouchers, AFA registrations). It serves retail users, agents, dealers, and admins across MTN, Telecel, and AirtelTigo networks.

**Stack:** Next.js 15 (App Router), Supabase (Postgres + Auth + RLS), Paystack, Tailwind CSS, shadcn/ui, Framer Motion, Upstash Redis

**API surface — 378 route handlers under `app/api/`** (verified 2026-09-18, after v1 removal; re-count with `Get-ChildItem app/api -Recurse -Filter route.ts` rather than trusting this number blindly):

| Group | Routes | Public? |
|---|---|---|
| `admin/` | 159 | No — internal only |
| `shop/` | 48 | No |
| `cron/` | 33 | No — secret-header auth |
| **`v2/`** | **26** | **Yes — the public developer API (v1 was retired and removed 2026-09-18); the only group that gets published Postman docs** |
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

### KiNG FLEXY Domain Skills (local `.claude/skills/`)
- `kingflexy-domain` — user roles, pricing tiers, network operators, wallet system
- `kingflexy-api-routes` — API route conventions, auth, rate limiting, response shapes
- `kingflexy-developer-api` — the public v2 developer API surface (v1 retired and removed): key-type scoping, idempotency/race pattern, rate limiting, webhook signing
- `kingflexy-supabase` — which DB client to use, idempotency, RLS, wallet operations
- `kingflexy-fulfillment` — DataKazina API, circuit breaker, bundle mapping, Paystack webhooks
- `kingflexy-cron` — all cron endpoints, schedules, re-enable process after Vercel Pro upgrade
- `kingflexy-workflow` — project gates: fintech security audit, `tsc`/lint QA, Postman v2 docs sync
- `new-api-route` — correct scaffold template for user/admin/cron/webhook routes

### Other Plugin Skills (verified installed — do not cite skills not on this list)
- `frontend-design:frontend-design` — production-grade UI components
- `security-review` — built-in security review skill (`/security-review`); not a plugin
- `supabase:supabase` — Supabase best practices; `supabase:supabase-postgres-best-practices` — schema, RLS, indexes, migrations
- `vercel:*` — deployment, env vars, Next.js, caching, functions, firewall, shadcn
- `postman:api-engineer` — entry point for API engineering work; routes to `postman:api-documentation` (spec/collection authoring, pushed via the Postman MCP tools) and `postman:bootstrap` (first-time CLI/workspace setup). `postman:security` — OWASP API Top 10 audit. (Corrected 2026-09-29 — `postman:generate-spec`/`postman:sync`/`postman:docs` no longer exist under those names.)
- `pr-review-toolkit:review-pr` — multi-agent PR review (silent failures, type design, test coverage)
- `claude-md-management:claude-md-improver` — audit/improve CLAUDE.md files
- `claude-md-management:revise-claude-md` — capture session learnings into CLAUDE.md
- `code-review` — built-in diff/PR review (`/code-review`); not a plugin
- `document-skills:xlsx` — spreadsheet work (this repo uses `xlsx` / `xlsx-js-style` for exports)

**MCP servers connected:** `supabase`, `vercel`, `postman` — all remote HTTP, OAuth-authorized. Prefer their read tools (`list_tables`, `get_logs`, `get_advisors`, `list_deployments`, `get_runtime_errors`) over guessing at live state.

**Deliberately DISABLED or NOT installed — do not (re)install without asking:**
- `security-guidance` — installed but **disabled 2026-08-09**. Its hooks fire on `UserPromptSubmit` (every prompt), `PostToolUse` for every `Edit`/`Write`/`Bash`, and `Stop`. On Windows each fires `bash sg-python.sh` in a **visible** console window, making the IDE unusable. Security coverage is preserved via the `payments-security-reviewer` subagent, the built-in `/security-review`, and the Security Gate in `kingflexy-workflow`.
- `chrome-devtools-mcp` — installed and removed 2026-08-09. Only plugin here that runs a **local** stdio MCP server via `npx`, spawning visible `cmd.exe`/`conhost.exe` windows per session. Verify UI changes with `npx tsc --noEmit` + `npx next lint` + manual browser checks instead.
- `figma`, `sentry`, `coderabbit`, `firecrawl`, `commit-commands`, `remember` — no matching dependency in `package.json`; previously listed here in error.

> **Windows hook caveat (read before installing any plugin).** Claude Code on Windows spawns hook commands **without** `CREATE_NO_WINDOW`, so every hook opens a visible console window. Before installing a plugin, check `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/hooks/hooks.json`. A plugin with only `SessionStart`/`SessionEnd` hooks costs one window per session (acceptable — `superpowers` and `vercel` are in this category). A plugin with `UserPromptSubmit`, `PostToolUse`, or `Stop` hooks fires constantly and will make the IDE unusable on this machine.

## Skill Trigger Rules

Tier (see top of file) decides *whether* to load skills; this table decides *which*. Tier 0 loads none of these.

| Task type | Tier | Skills to invoke |
|---|---|---|
| "Let's build X" / new feature | 2 | `superpowers:brainstorming` → `kingflexy-workflow` → `superpowers:writing-plans` |
| Bug / issue / error report | 1 or 2 | **Search → Investigate → Isolate → Articulate the root cause FIRST, then fix.** Obvious one-liner → Tier 1, just fix it. Non-obvious or money/auth → `superpowers:systematic-debugging` → `kingflexy-workflow` → `superpowers:verification-before-completion` |
| Any DB/Supabase work | 1–2 | `kingflexy-supabase` + `supabase:supabase` (+ `supabase:supabase-postgres-best-practices` for schema/RLS/migrations) |
| Any API route work | 1–2 | `kingflexy-api-routes` + `new-api-route` |
| Change to `app/api/v2/**` (public dev API) that alters its request/response contract | 2 | Above + **Postman docs gate** in `kingflexy-workflow` |
| `app/api/v2/**` route work with no public contract change (internal refactor) | 1–2 | `kingflexy-developer-api` + `kingflexy-api-routes` — note the row above still wins for any public contract change (Tier 2 + Postman gate) |
| Any fulfillment/order work | 2 | `kingflexy-fulfillment` |
| Any cron work | 1–2 | `kingflexy-cron` |
| Any business logic | 1–2 | `kingflexy-domain` |
| Any UI component | 1–2 | `frontend-design:frontend-design` |
| Before finishing Tier 2 work | 2 | `superpowers:verification-before-completion` |
| Security-sensitive changes (payments/wallet/auth) | 2 | `payments-security-reviewer` subagent + `/security-review` |
| After a substantial session | — | `claude-md-management:revise-claude-md` |
| After shipping a new payment gateway, API, role, or integration | — | Update memory files + `claude-md-management:revise-claude-md` — memory must reflect current project state |

## Key Conventions

- **Auth:** route handlers → `createRouteClient` (lib/supabase-server, cookie/RLS-aware); server components → `createServerComponentClient` (lib/supabase-server); admin/service-role → `createAdminClient` (lib/supabase-admin) or `createServerClient` (lib/supabase). ⚠️ `createServerClient` is SERVICE-ROLE with NO cookies — never call `auth.getUser()` on it in a route handler; use `createRouteClient`. `users` has a self-update RLS policy (`auth.uid()=id`), so user routes can write the caller's own row via the RLS client.
- **Wallet ops:** Always use DB functions/RPCs, never direct UPDATE — prevents race conditions. Inside those RPCs, lock the row (`FOR UPDATE`) *before* checking idempotency, never after — check-before-lock lets two concurrent calls both pass the check (real double-credit bug found in `credit_shop_profit`/`reverse_lead_margin`, fixed 2026-08-11, see `docs/security-audits/`).
- **Money tables are server-write-only:** never grant `anon`/`authenticated` INSERT/UPDATE/DELETE (or add a client write RLS policy) on `orders`, `airtime_orders`, `afa_orders`, `wallets`, `wallet_transactions`, or `user_payment_references` (guarded). A client INSERT policy on `orders` let any user forge a pending order and self-refund it into their wallet (fixed 2026-09-24, see `docs/security-audits/2026-09-24-client-order-forgery.md`). The guard trigger `block_client_money_writes()` (money tables) / `trg_block_client_write` (`user_payment_references`) enforces this even if a grant is re-added; re-check with `scripts/sql/verify-client-money-write-lock.sql`. `ussd_pending_orders`, `shop_orders`, and `shop_customers` are also server-write-only (client write grants revoked, no guard trigger needed since no client write policy ever backed them).
- **Payments:** Paystack webhooks at `/api/webhooks/paystack` — always verify HMAC signature
- **Idempotency:** Use `PGRST116` (not found) pattern for upserts; never assume row exists. For request-level dedup keys (e.g. blocking a double-submitted send/purchase), never include a time bucket — a client retry after a timeout can cross the boundary and defeat it. Hash the exact content instead and expire claim rows via a cleanup cron.
- **RLS:** All user-facing queries go through RLS-aware clients; admin client only for server-side admin ops
- **API responses:** `{ success: true, data: {} }` or `{ success: false, error: "message" }`
- **Local-only docs:** `docs/superpowers/plans/` and `specs/` are gitignored — don't `git add` them. `docs/security-audits/` is the opposite — committed, for race-condition/fraud audit reports.
- **DB migrations:** No local Supabase stack in this repo (no `supabase/config.toml`) — apply migrations directly to the live project via the `apply_migration` MCP tool, then save the same SQL under `supabase/migrations/<name>.sql` for repo history.
- **Tests:** pure-logic via `npx tsx scripts/test-*.ts`; no component test runner — UI verified by `npx tsc --noEmit` + `npx next lint` + manual. A pre-commit hook auto-runs eslint on staged files. `next lint`'s own stderr deprecation notice trips PowerShell's `2>&1` NativeCommandError wrapping (reports exit 1 even on success) — don't pipe its stderr; read for the actual `✔ No ESLint warnings or errors` line.
- **PWA offline fallback:** use `fallbacks: { document: '/~offline' }` in `withPWAInit()` (next.config.ts) + a real page at `app/~offline/page.tsx` — the plugin auto-wires a Workbox `handlerDidError` onto every `runtimeCaching` rule (including custom `NetworkOnly` ones), no manual Workbox wiring needed. That page is a normal NESTED page (renders inside the existing root layout/providers) — it must NOT declare its own `<html>`/`<body>`, only `app/layout.tsx` may. ⚠️ `next lint` is deprecated as of Next 15.5 and will be removed in Next.js 16 (it still runs clean today) — before any Next 16 upgrade, migrate via `npx @next/codemod@canary next-lint-to-eslint-cli .` and update this line plus the QA gate in `kingflexy-workflow`. When migrating, carry over the `app/api/v2/**` `no-restricted-imports` override from `.eslintrc.json` — it enforces API-key-only auth on v2 routes and would otherwise be silently dropped.
- **`next` is pinned to an exact version** (`"next": "15.5.23"`, no `^`) rather than a range — deliberate, so a `next` bump only ever happens via an explicit `npm install next@<version> --save-exact`, never silently through `npm install`. Bumped from 15.1.9 on 2026-08-21 to close a critical (CVSS 9.1) middleware authorization-bypass CVE (GHSA-f82v-jwr5-mffw) plus ~26 other advisories; verify with `tsc`/`lint`/`npm run build` before ever changing this pin, not just `npm audit fix` (plain `npm audit fix` won't cross an exact pin — it reports "outside the stated dependency range" and needs the manual `npm install next@<version> --save-exact` instead).
- **Toasts:** Always `import { toast } from '@/lib/toast'` (branded `SplitPanelToast` wrapper) — never raw `sonner`. Same call signature (`toast.success(title)` / `toast.error(title)`), so it's a drop-in swap.
- **Shared validation primitives:** `shortTextSchema`, `longTextSchema`, `phoneSchema`, `adminLongTextSchema` all live in `lib/validation.ts`. `adminLongTextSchema` allows `<>&` (blocks only script-injection patterns) — use it for admin-authored text; the customer-facing `shortTextSchema`/`longTextSchema` reject `<>&` outright.
- **Landing page (`app/page.tsx`) is ISR-cached** (`revalidate = 300`, shared across all visitors) and passes no auth/session data to `HomeClient`. Any landing-page component needing login state must resolve it client-side via `useAuth()`, never via a prop from the server component.
- **Login route is `/auth`, not `/login`.** Its `next` continuation query param is only read by the Google OAuth and magic-link handlers in `app/auth/page.tsx` — the default email/password login path ignores it and always redirects to `/dashboard`.
- **User-submitted "lead intake" tables** (support tickets, website requests, etc.): RLS grants the owner `SELECT` only, never `INSERT`/`UPDATE` for `authenticated`; every write goes through a service-role client after validation. A per-user rate cap uses a `BEFORE INSERT` trigger with `pg_advisory_xact_lock` + `RAISE EXCEPTION '<LITERAL>'`, caught in the API route via `error.message.includes('<LITERAL>')` → friendly error.

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

- **Active project root is `D:\Projects\CLONED REPO KFT`.** A stale copy of this repo still exists at `D:\Projects\KingFlexyGh` (with its own outdated `CLAUDE.md`) — ignore it; it is not the working tree.
- Plugins are installed at `scope: user` (global, in `~/.claude/settings.json` under `enabledPlugins`), so they load regardless of which directory Claude Code opens from. Manage them with the CLI, not by hand-editing JSON:
  ```
  claude plugin list                    # name, version, enabled/disabled
  claude plugin install <name>@<marketplace>
  claude plugin enable|disable <name>@<marketplace>
  claude plugin marketplace list
  ```
  Note: running `claude plugin install` has been observed to silently flip *other* plugins to disabled — always re-run `claude plugin list` afterward and re-enable anything that got switched off.
- Registered marketplaces: `claude-plugins-official` (`anthropics/claude-plugins-official`, official), `anthropic-agent-skills` (`anthropics/skills`, official), `superpowers-dev` (`obra/superpowers`, third-party). Superpowers is **not** in the official marketplace — it needs `claude plugin marketplace add obra/superpowers` first.
- Only keep `.claude/skills/` for project-custom skills (`kingflexy-*`); delete any that duplicate plugin skills.
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
After any fix, update, or new implementation, write a short customer-facing announcement the user (the platform owner) can post to KiNG FLEXY GH's own users — friendly tone, plain language, no internal jargon (no file names, function names, "root cause", ticket numbers, etc.). Focus on what changed for *them* (e.g. "Login is now smoother" / "You can now sign in with your phone number too"). Keep it short — a couple of sentences to a small paragraph, plus a one-line "what to do" if any user action is needed (e.g. re-login). Skip this note only for pure internal work with zero user-visible effect (e.g. refactors, internal tooling, CLAUDE.md edits) — state explicitly that it's being skipped and why.

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
