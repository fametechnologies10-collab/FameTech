---
name: fametech-workflow
description: FameTech project-specific dev gates that layer on top of superpowers' engineering workflow â€” a fintech security audit and a TypeScript/lint QA gate before any push. Invoke alongside superpowers on Tier 2 work in this repo.
---

# FameTech Project-Specific Gates

This project uses `superpowers` for the generic engineering lifecycle â€” brainstorming, planning, worktrees, subagent-driven-development, TDD, code review, and finishing a branch. Don't duplicate that here.

This skill adds only the two things superpowers doesn't know about: FameTech's fintech security checklist and its QA/push checklist. All slot into superpowers' existing checkpoints â€” they are not a separate parallel process.

Applies to **Tier 2** work only (see CLAUDE.md). Tier 0/1 tasks skip this skill.

## Where these gates fire

- **Security gate** â€” before `requesting-code-review` / `finishing-a-development-branch`, if any changed file touches payments, wallet, fulfillment, or auth.
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
- `fametech-supabase` for all database operations
- `fametech-fulfillment` for all fulfillment API calls
- `fametech-domain` for business logic involving roles or pricing
