---
name: kingflexy-workflow
description: KiNG FLEXY GH project-specific dev gates that layer on top of superpowers' engineering workflow â€” a fintech security audit, a Postman docs sync for the public v2 API, and a TypeScript/lint QA gate before any push. Invoke alongside superpowers on Tier 2 work in this repo.
---

# KiNG FLEXY Project-Specific Gates

This project uses `superpowers` for the generic engineering lifecycle â€” brainstorming, planning, worktrees, subagent-driven-development, TDD, code review, and finishing a branch. Don't duplicate that here.

This skill adds only the three things superpowers doesn't know about: KiNG FLEXY's fintech security checklist, its QA/push checklist, and its public-API docs sync. All slot into superpowers' existing checkpoints â€” they are not a separate parallel process.

Applies to **Tier 2** work only (see CLAUDE.md). Tier 0/1 tasks skip this skill.

## Where these gates fire

- **Security gate** â€” before `requesting-code-review` / `finishing-a-development-branch`, if any changed file touches payments, wallet, fulfillment, or auth.
- **Postman docs gate** â€” before `finishing-a-development-branch`, if any file under `app/api/v2/**` was added or changed.
- **QA gate** â€” as part of `finishing-a-development-branch`, before offering to push or open a PR.

## Security Gate ðŸ”’

Trigger: any changed file under `app/api/**` involving payments, wallet, fulfillment, or auth.

1. Run the `payments-security-reviewer` subagent against each such changed file.
2. Fix every CRITICAL/HIGH finding before proceeding. For MEDIUM, fix or document why it's acceptable. For LOW, fix if quick, otherwise note it.
3. Regardless of agent output, manually confirm:
   - No `.env.local` variables referenced in client components
   - Wallet balance changes use RPC, not direct `UPDATE`
   - Paystack webhook has HMAC verification
   - Fulfillment calls have reference codes for idempotency
   - No `supabaseAdmin` client used in user-facing routes

## Postman Docs Gate ðŸ“˜

Trigger: any file under `app/api/v2/**` added, removed, or changed in a way that alters its request/response contract (new field, changed type, new error code, new auth requirement). Pure internal refactors with an unchanged contract don't need this.

**Scope â€” `app/api/v2/**` only.** Never include `admin/`, `shop/`, `cron/`, `auth/`, `user/`, or `webhooks/` routes. Those are internal; publishing them exposes the platform's attack surface. If a task seems to call for documenting a non-v2 route publicly, stop and ask the user.

1. Update the spec by hand at `postman/specs/openapi.yaml` (this is the actual live spec location, already synced to the existing Postman workspace â€” not a fresh generation). For a genuinely new project with no existing spec, start with `Skill("postman:api-engineer")`, which routes to `postman:api-documentation` (spec/collection authoring) and `postman:bootstrap` (first-time CLI/workspace setup). (Corrected 2026-09-29 â€” `postman:generate-spec`/`postman:sync`/`postman:docs` no longer exist under those names.)
1b. **Re-copy the spec to `public/openapi.yaml`** (served at `kingflexygh.com/openapi.yaml` for AI agents and `llms.txt`), and update `lib/developer-products.ts` if an endpoint was added or renamed. `npx tsx scripts/check-ai-discoverability.ts` fails if the two spec copies drift or a listed endpoint is missing from the spec.
2. Push the spec and sync the collection via the Postman MCP tools directly: find the existing spec/collection/workspace with `searchPostmanElements`, push with `updateSpecFile`, then `syncCollectionWithSpec`.
3. Publish the docs page with `publishDocumentation` â€” **always pass `customization.appearance.themes[*].logo = "https://kingflexygh.com/logo.png"` on both light and dark themes**, or the owner's logo is dropped on that publish.
4. Confirm before moving on:
   - Every new/changed v2 endpoint appears with correct method, path, and auth scheme
   - No non-v2 path leaked into the spec
   - **No secrets in examples** â€” no live API keys, bearer tokens, Paystack keys, real MSISDNs, or real customer names. Use placeholders
   - Error responses documented in the project's shape: `{ success: false, error: "message" }`
5. Report the published docs URL in the task summary so the user can verify it.

If the Postman MCP server is unauthorized or unreachable, don't silently skip this â€” say so plainly and let the user decide whether to proceed or authorize first.

## QA Gate ðŸš€

Trigger: whenever superpowers' `finishing-a-development-branch` is about to offer merge/PR/push.

```bash
npx tsc --noEmit          # Zero TypeScript errors
npx next lint             # Zero ESLint errors
npm run test:guards       # Static invariants (rate-limit prefixes)
git diff --stat           # Confirm only planned files changed
```

All three must pass before push. Never force-push to `main`.

## After push

1. Run `claude-md-management:revise-claude-md` to capture any new learnings.
2. For any new payment gateway, fulfillment API, user role, or major flow: create or update the relevant memory file in
   `C:\Users\KiNGFLXY\.claude\projects\d--Projects-CLONED-REPO-KFT\memory\`
   so future sessions have accurate context, and add a one-line pointer to `MEMORY.md` in that directory.

## Also always apply

- `new-api-route` for API route scaffolding
- `kingflexy-supabase` for all database operations
- `kingflexy-fulfillment` for all fulfillment API calls
- `kingflexy-domain` for business logic involving roles or pricing
