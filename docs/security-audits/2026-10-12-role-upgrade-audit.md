# Role-upgrade page audit — 2026-10-12

Scope: `/dashboard/upgrade`, `/api/user/upgrade/{wallet,initialize,toggle-auto-upgrade}`,
`lib/wallet-upgrade.ts`, `/api/cron/auto-upgrade`, the legacy Paystack upgrade processors
(`lib/payments.ts`, `lib/dealer-payments.ts`), `/api/admin/update-prices`.

Already sound before this audit: server-side pricing, `deduct_wallet_balance` (atomic, not client-callable),
`guard_users_privilege_change` blocking self-edits of role/expiry/status, money-table write locks, Paystack
amount check + `status='pending'` idempotency.

## Findings and fixes

| ID | Severity | Finding | Fix |
|---|---|---|---|
| H1 | High | `POST /api/user/upgrade/wallet {plan:'3d'}` on a Lifetime Agent set `agent_expires_at` to now+3d (and charged them). Same hole in `processCompletedUpgradePayment`. | RPC rejects agent plans when `role='agent' AND agent_expires_at IS NULL` (`already_permanent`); legacy processor refunds instead. |
| H2 | High | No lock/idempotency: concurrent or retried requests both passed the pre-check, both deducted, and both computed expiry from the same stale read — user paid twice for one extension. | `process_wallet_upgrade` locks the `users` row `FOR UPDATE` **before** the idempotency check (CLAUDE.md wallet rule); unique ledger index on the upgrade reference; client sends a per-confirmation idempotency key. |
| H3 | High | Wallet deducted (step 4) and role written (step 6) as separate statements; a failed role write kept the money. The cron then re-charged every 6h because its dedup keyed off a success notification. | Deduct + ledger + role grant are one transaction; failure rolls back. Cron re-verifies "due" on the locked row and uses a per-user-per-hour idempotency key. |
| M1 | Medium | Legacy `/api/user/upgrade/initialize` still live (unused): unlimited pending `wallet_payments`, raw `error.message` leak, processors could take payment without granting the role. | Route retired (410). Legacy processors refund to the wallet (`refund_ussd_wallet`, idempotent `REFUND-upgrade-<ref>`) when the role can't be granted. |
| M2 | Medium | Auto-renewal toggle pre-ticked (opt-out recurring wallet debits); toggle failure silently swallowed while UI said "activated". | Defaults off; failure surfaces a warning toast. |
| M3 | Medium | No dedicated rate limit on wallet/toggle routes; no `status='active'` check. | Per-user limiters (`userUpgradeWallet`, `userUpgradeToggle`) + in-memory fallback for the wallet route; RPC returns `account_inactive`. |
| M4 | Medium | `auto_upgrade_enabled/plan` were writable via the user's own RLS session, making the toggle route's validation advisory. | `guard_users_privilege_change` now blocks them for any non-service session. Toggle route also rejects agent plans for Lifetime Agents. |
| L1 | Low | Price shown could differ from price charged (5-min client cache). | Client sends `expected_price`; server returns 409 `priceChanged` and nothing is charged. |
| L2 | Low | `Number(setting)` accepted NaN / 0 / negative. | `resolveUpgradePrice` fails closed (503); `update-prices` validates input. |
| L3 | Low | `update-prices` delete-then-insert left a window where the purchase flow fell back to hardcoded defaults. | Single atomic `upsert`. |
| L4 | Low | Wallet-balance fetch failure showed "Insufficient Balance / GHS 0". | Toast + modal not opened. |
| L5 | Low | Expired (not yet downgraded) agents shown as active members. | Header/badge use expiry-aware `isActiveAgent`. |
| L6 | Low | JS `setMonth` overflow on dealer expiry (Jan 31 + 1 month = Mar 3). | Postgres `make_interval` clamps month-ends. |
| L7 | Low | Cron silently retried users whose saved plan can never be bought; cron 500 echoed `err.message`. | Ineligible → flag switched off + in-app notice; error detail removed. |

## Verification

- `scripts/test-wallet-upgrade.ts` (22 checks, in `npm run test:guards`).
- RPC scenarios run against the live DB inside a rolled-back transaction: customer buy, replay (no second
  charge), extension stacking, permanent, **Lifetime Agent blocked (H1)**, lifetime→dealer, dealer buying an
  agent plan, due / not-due auto-renewal, insufficient balance (no change), invalid inputs, suspended user,
  `authenticated` role denied EXECUTE, and an authenticated session blocked from writing `auto_upgrade_*`.
- Not covered by an automated test: true concurrent execution (relies on the `FOR UPDATE` lock).

## Independent review (payments-security-reviewer) — dispositions

| Finding | Disposition |
|---|---|
| HIGH — legacy Paystack processors read-then-write the user row with no lock and could overwrite a role the wallet RPC granted concurrently (e.g. erase a Lifetime grant) | **Fixed.** Final `UPDATE` is now a compare-and-swap on the role + expiry that was read; 0 rows matched → payment refunded to the wallet (`state_changed`). |
| MEDIUM — legacy dealer processor used JS `setMonth` (month-end overflow) | **Fixed.** `addMonthsClamped` (unit-tested, matches Postgres interval). |
| MEDIUM — cron retries a persistent `rpc_error` every run | **Accepted.** The RPC fails closed (nothing charged), so retrying a transient DB/transport error every 6h is the desired behaviour; a counter column would add schema for no money-safety gain. |
| MEDIUM — toggle route validation is advisory | **Accepted by design.** Real enforcement is the RPC; the route check is UX. |
| LOW — Lifetime Agent with a leftover Agent auto-plan was never cleaned up | **Fixed.** Cron passes them through; RPC answers `already_permanent`, flag is switched off + user notified. |
| LOW — no SQL-level test | **Fixed.** `scripts/sql/verify-wallet-upgrade-rpc.sql` (rolled-back, re-runnable). |

Reviewer confirmed sound: lock ordering (no other function locks `users`), `search_path`/no dynamic SQL, reference
regex vs. UI and cron key formats, cron hourly key vs. due re-check, atomicity, price validation, RLS lock-down,
refund idempotency, no regression for dealer / expired-agent / customer.

## Follow-ups / accepted

- `scripts/test-*.ts` is gitignored; guards must be `git add -f`. `package.json` `test:guards` references
  `scripts/test-ratelimit-prefixes.ts`, which is not in the repo (pre-existing) — the script fails at that
  first step until it is restored or removed from the chain.
- Legacy Paystack processors still hold no row lock, but now use a compare-and-swap + refund (see above), and no
  new payments can be initiated (route retired) — they only settle pre-existing in-flight payments.
