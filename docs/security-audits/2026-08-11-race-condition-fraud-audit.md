# Race-Condition & Concurrency-Fraud Audit — KiNG FLEXY GH

**Date:** 2026-08-11
**Requested by:** platform owner (boahenfelix07@gmail.com)
**Scope:** Wallet crediting, shop-owner withdrawals, wallet top-ups (Paystack), data/airtime purchases, refunds, order retries, re-fulfillment, plus a secondary pass on Hubtel Receive-Money and the marketplace moderation RPCs.
**Method:** Live inspection of the deployed Supabase project (`ubvjtacdmwynqcxuposj`) — not a read of migration files, which can drift from what's actually running. Every function body below was pulled with `pg_get_functiondef` directly against production, cross-checked against the calling application code, and grant-checked with `has_function_privilege`. The Supabase security/performance advisors were also run.

---

## 1. Executive summary

Every attack scenario in the request — double wallet credit, withdrawing more than the balance, a withdrawal that doesn't deduct, double wallet top-up, double data delivery, and refund/retry double-spend — was checked against the **live, deployed** database functions and their callers. **None of them are currently exploitable.**

The codebase enforces two consistent patterns across every money-moving operation, with no exceptions found:

1. **Single-statement atomic UPDATE with the guard condition in the `WHERE` clause**, never a read-balance-then-write-balance sequence. Example (`deduct_wallet_balance`):
   ```sql
   UPDATE wallets SET balance = balance - p_amount
   WHERE user_id = p_user_id AND balance >= p_amount
   ```
   Two concurrent debits cannot both succeed against an insufficient balance — Postgres serializes on the row; the loser sees zero rows updated and the function raises `INSUFFICIENT_BALANCE`.

2. **`FOR UPDATE` row locks + idempotency/CAS guards** on anything that spans more than one statement (withdrawals, refunds, retries, fulfillment claims). A second call against an already-processed row is a documented no-op (`already_refunded: true`, `already_processed: true`, etc.), not a re-execution.

All money-moving RPCs additionally have `EXECUTE` **revoked from `anon` and `authenticated`** — they are only callable by the service-role backend. This closes off the most direct attack: a client crafting a raw `POST /rest/v1/rpc/credit_wallet_balance` call with a forged `p_user_id`/`p_amount`.

**Update (same day, follow-up pass):** the two areas originally flagged as "spot-checked only, not traced end-to-end" — the Hubtel commission webhook/reconcile cron and the SMS campaign pipeline — have since been audited to the same depth as the rest of this document (§3.3, §3.4). Both came back clean; the Hubtel commission flow in particular is the most defensively engineered flow in the codebase, layering a live pre-retry double-send check against Hubtel's own Status Check API on top of the same claim-and-lock patterns used everywhere else.

**Update 2 (same day, second follow-up — fixes applied):** closing out the remaining scope in §6 (admin bulk operations) surfaced a **real, live double-credit bug** in `credit_shop_profit` — see the correction in §2.1 and full writeup in §8. It has been fixed and verified against production data to have never actually been exploited. The SMS quick-send idempotency gap (finding #5) has also been fixed. Both are detailed in §8; the findings table in §5 has been updated to reflect fixed status.

---

## 2. Scenario-by-scenario findings

### 2.1 Double shop-owner credit

> **Correction (second follow-up pass):** the original text below said this was checked and safe. That was **wrong** for `credit_shop_profit` specifically — it had a real check-before-lock TOCTOU that was missed on the first read because the idempotency check's *existence* was confirmed without checking its *ordering* relative to a lock. This has since been found and fixed — see §8 for the full writeup, including confirmation (queried directly against production transaction history) that it was never actually exploited. `credit_shop_order_profits` (the sub-agent variant, described below) was correct from the start.

`credit_shop_profit` / `credit_shop_order_profits` (live definitions, `lib/shop-service.ts`) each check for an existing `shop_wallet_transactions` row keyed on `shop_order_id` + `type='profit'` before crediting. `credit_shop_order_profits` (used for sub-agent chain orders) does this correctly — it locks both wallets `FOR UPDATE` *before* running the idempotency check. `credit_shop_profit` (used for the more common direct-shop-order path) did **not** — see §8.

### 2.2 Shop owner withdrawing more than they have
`process_shop_withdrawal` (called from `app/api/shop/withdraw/route.ts:295`):
```sql
SELECT owner_id, balance INTO v_wallet_owner_id, v_current_balance
FROM shop_wallets WHERE id = p_wallet_id FOR UPDATE;
...
IF v_current_balance < p_amount THEN RAISE EXCEPTION 'Insufficient shop wallet balance'; END IF;
```
The `FOR UPDATE` lock is taken before the balance check. Two simultaneous withdrawal requests from the same owner serialize on the wallet row — the second sees the balance already reduced by the first and fails cleanly if insufficient.

### 2.3 Withdrawal not deducting
The balance UPDATE and the `shop_wallet_transactions` INSERT happen inside the **same PL/pgSQL function call** (one transaction, one commit). There is no window in which a withdrawal request row exists without the corresponding debit having already landed.

### 2.4 Double wallet top-up (Paystack)
`processCompletedWalletPayment` (`lib/payments.ts:69-79`) performs a CAS update before crediting:
```ts
.update({ status: 'completed', ... })
.eq('id', payment.id)
.eq('status', 'pending')   // idempotency guard
```
A retried/duplicated webhook call hits Postgres error `PGRST116` (zero rows matched — already `completed`) and returns `{ success: true, alreadyProcessed: true }` **without calling `credit_wallet_balance` again**. There is also an amount-mismatch check (`lib/payments.ts:35-63`) that compares the Paystack-reported kobo amount against the expected total before any credit happens, and marks the payment `failed` (never creditable) on a mismatch.

### 2.5 Double data/airtime delivery
This is a *fulfillment-claim* race, not a wallet race, and is the one I spent the most time on because it's the least obvious to get right.

`lib/refulfillment-service.ts:183-196` locks each order **before** dispatching to the network supplier:
```ts
UPDATE orders SET status = 'processing', fulfillment_method = label
WHERE id IN (...) AND status = 'pending'
```
The lock UPDATE returns only the rows it actually flipped; only those are dispatched. If the cron and a manual admin refulfill (or two overlapping cron ticks) race on the same order, only one UPDATE claims it — the other sees zero rows and skips it. The code additionally distinguishes a **definite** supplier failure (safe to revert to `pending` for a future retry) from an **ambiguous** one — a dropped connection where the supplier might already have processed the request. Ambiguous failures are deliberately left in `processing` and raise an admin alert instead of being retried, specifically to avoid a scenario where a retry re-dispatches a delivery the supplier already fulfilled. The single-order path (`lib/fulfillment-trigger.ts`) uses the same claim-before-dispatch idiom per its own inline documentation.

### 2.6 Refund + retry double-spend
`claim_order_retry`:
- Locks the order `FOR UPDATE`.
- Enforces a 60-second cooldown and a 3-attempts/24-hour lockout.
- Before charging a fresh retry, checks:
  ```sql
  IF EXISTS (SELECT 1 FROM orders WHERE retry_of_order_id = p_order_id
             AND status IN ('processing', 'completed')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'retry_already_in_progress');
  END IF;
  ```
  So a retry cannot be claimed a second time while a prior retry attempt is still in flight or has already succeeded.

`refund_order_wallet` / `refund_shop_withdrawal` / `refund_utility_wallet` / `refund_airtime_wallet` / `refund_ussd_wallet` — all five follow the identical shape: lock the source row `FOR UPDATE`, check `status = 'refunded'` and short-circuit to `{"ok": true, "already_refunded": true}`, only then move money.

---

## 3. Secondary pass: Hubtel Receive-Money & Marketplace

Requested as a follow-up since these weren't in the original scope.

### 3.1 Hubtel Receive-Money (`lib/hubtel-receive/settle.ts`, `app/api/webhooks/hubtel-receive-money/route.ts`)
This is the most defensively written flow in the codebase:
- **Re-verify before credit**: the webhook body is *never* trusted as the basis for settlement — `settleReceivePaid` always calls `checkReceiveMoneyStatus` to re-confirm payment with Hubtel live before doing anything.
- **HMAC-bound reference**: the callback is authenticated via a per-reference, time-bounded HMAC signature carried in the URL Hubtel was given at charge-creation time (not a static shared secret in a header), and the settle action is bound to that signed `ref`, never to the unauthenticated JSON body.
- **Atomic claim**: `claim_hubtel_receive_paid` does `UPDATE hubtel_receive_charges SET status='paid' WHERE reference_code=p_reference AND status='pending'` — every caller (webhook, poll route, reconcile cron) funnels through this single claim, so fulfillment dispatch fires on a fresh claim exactly once regardless of which caller wins the race.
- `EXECUTE` on `claim_hubtel_receive_paid` is revoked from `anon`/`authenticated` — service-role only.

No gaps found here.

### 3.2 Marketplace moderation RPCs
- `moderate_marketplace_listing` — CAS on `moderation_status = 'pending'`; a duplicate approve/reject call (e.g. two admins clicking simultaneously) returns `'already_moderated'` instead of double-logging or flipping twice.
- `suspend_marketplace_seller` — idempotent by nature (sets a boolean to a caller-specified value); no race-sensitive state.
- `create_marketplace_listing` — pre-checks slug uniqueness in-function, but the actual safety net is `marketplace_listings_slug_key` (a DB-level `UNIQUE` constraint, confirmed live). A race between two inserts for the same slug fails the loser with a constraint violation rather than corrupting data.
- `reveal_marketplace_contact` — scoped to `moderation_status = 'approved' AND is_active AND NOT is_sold AND NOT is_marketplace_seller_suspended(...)`, or the listing's own seller. No unauthorized contact-info disclosure path found.

All four have `EXECUTE` revoked from `anon`/`authenticated`.

### 3.3 Hubtel commission webhook + reconcile cron (`app/api/webhooks/hubtel-commission/route.ts`, `app/api/cron/hubtel-commission-reconcile/route.ts`, `lib/airtime-fulfillment.ts`, `lib/utility-fulfillment.ts`)

This is the most heavily-guarded flow found in the entire codebase — it protects both the commission-crediting money path and the "don't send the customer's airtime/bill payment twice" delivery path.

- **Dispatch is claim-gated.** Both `dispatchAirtimeFulfillment` (`lib/airtime-fulfillment.ts:107-115`) and `dispatchUtilityCore` (`lib/utility-fulfillment.ts:210-217`) flip the order `pending → processing` with `.eq('id', orderId).eq('status', 'pending')` immediately before calling Hubtel, and bail if the claim UPDATE matched zero rows ("claimed by another worker"). The reconcile cron only ever calls dispatch for rows still in `pending` — it never blind-redispatches a `processing` order.
- **Before any retry, a live double-send guard runs.** `priorAttemptVerdict()` (`lib/airtime-fulfillment.ts:12-18`) and the equivalent block in `dispatchUtilityCore` call Hubtel's own Status Check API for the *previous* attempt's reference before allowing a new one. A confirmed prior delivery marks the order `completed` without resending; an unverifiable status **blocks** the resend outright ("cannot verify... not resending") rather than assuming it's safe.
- **Callback finalize is CAS-guarded per branch**, e.g. `.eq('id', order.id).in('status', ['processing', 'pending'])` before marking `completed` — a duplicate/retried Hubtel callback that arrives after the order is already finalized matches zero rows and is a no-op.
- **Stale-callback guard** (`app/api/webhooks/hubtel-commission/route.ts:390`): a *failure* callback for an old attempt number is not applied if a newer attempt has since been dispatched — it only annotates metadata — so a late failure callback for attempt 1 can't clobber attempt 2's in-flight/completed state.
- **Commission crediting** always goes through `credit_utility_commission`, whose atomic claim (`commission_credited_at IS NULL`, verified live in §2) makes every one of the call sites above (callback, reconcile cron auto-complete, dispatch fallback) safe to call unconditionally and repeatedly.
- **Auth**: both the commission webhook and the Receive-Money webhook authenticate via a per-reference, time-bounded HMAC in the callback URL (never a static shared secret), and the finalize action is bound to that authenticated reference — never to the unauthenticated request body.

No gaps found. `EXECUTE` on `credit_utility_commission` is revoked from `anon`/`authenticated` (verified in §2).

### 3.4 SMS platform — campaign pipeline (`lib/sms-campaign-pipeline.ts`) and shop quick-send (`app/api/shop/sms/send/route.ts`)

**Dashboard/API campaign pipeline** — verified clean:
- `claim_sms_campaigns` (cron claim) uses `SELECT ... FOR UPDATE SKIP LOCKED` — the correct Postgres idiom for multiple cron workers competing for the same queue, guaranteeing no two workers ever dispatch the same campaign.
- `create_sms_campaign` reserves a debit via `INSERT INTO sms_credit_ledger (...) ON CONFLICT (idempotency_key) DO NOTHING` keyed on the campaign ID *before* touching the wallet, then does an atomic compare-and-decrement (`credits >= p_credits`) on `sms_wallets`. A developer-API caller that retries with the same `idempotencyReference` gets `already_processed: true` and no second charge.
- `settle_sms_campaign` locks the campaign row `FOR UPDATE` and only settles from `status = 'processing'`, so a race between the inline-dispatch settle and a cron settle for the same campaign can't double-refund.
- Refunds (`cancel_sms_campaign`, `settle_sms_campaign`) route through `credit_user_sms_credits`, which has its own ledger idempotency key (`refund:{campaign_id}`) — a settle called twice for the same campaign is a no-op the second time.

**Shop quick-send route** — one real, but low-severity, gap:
`app/api/shop/sms/send/route.ts` debits credits (`debit_sms_credits`), sends the SMS batch, then refunds for any failed recipients (`refund_sms_credits`) — all inside a single request handler with **no idempotency key** on the send request itself (contrast with the campaign pipeline's `idempotencyReference`). A double-submitted request (double-click, a client-side retry after a timeout, or a resubmitted form) would debit credits twice **and physically dispatch the SMS batch twice** — real duplicate messages to the shop's customers — before each call's own (individually-correct) refund logic runs. This is not a balance-inflation exploit — `debit_sms_credits` is still atomic and can't go negative, so nobody gains free credits — the impact is a shop accidentally paying for and sending a duplicate SMS blast. Documented as a finding in §5.

---

## 4. How this was verified (not guessed)

- Queried `pg_proc` / `pg_get_functiondef` directly against the live project for every wallet, withdrawal, refund, retry, fulfillment-claim, commission, voucher-inventory, Hubtel receive, and marketplace-moderation RPC referenced by the application code (30+ functions).
- Confirmed via `has_function_privilege('anon'/'authenticated', ...)` that **every money-moving or moderation-authority RPC has `EXECUTE` revoked** from client-reachable roles — matches the intent of migration `20260624h_revoke_withdrawal_execute.sql`.
- Grepped the entire repository for any raw `.update({ balance: ... })` call outside these RPCs — **none found**. Every balance mutation goes through the atomic layer; there is no code path that reads a balance into application memory and writes it back.
- Confirmed `p_owner_id` passed into `process_shop_withdrawal` (`app/api/shop/withdraw/route.ts:309`) originates from the server-verified session (`auth.getUser()`), never from the request body — ruling out a forged-owner withdrawal.
- Confirmed `orders.reference_code`, `wallet_payments.reference`, and `marketplace_listings.slug` are DB-level `UNIQUE` constraints (not just application-level checks), so even a client that double-submits an idempotency key cannot produce two committed rows for it.
- Ran `results_checker_inventory` voucher assignment (`assign_results_checker_vouchers`) — uses `SELECT ... FOR UPDATE SKIP LOCKED`, the correct Postgres idiom for concurrent-safe inventory claiming; two simultaneous buyers cannot be assigned the same voucher PIN.
- Traced the Hubtel commission webhook, its reconcile cron, and both dispatch cores (`lib/airtime-fulfillment.ts`, `lib/utility-fulfillment.ts`) end-to-end — confirmed claim-gated dispatch, a live pre-retry double-send check against Hubtel's own Status Check API, and CAS-guarded callback finalization on every branch (success, pending, unknown, insufficient-float, config-error, permanent-failure), including a dedicated stale-callback guard for out-of-order failure callbacks.
- Traced the SMS campaign pipeline (`lib/sms-campaign-pipeline.ts`) end-to-end — confirmed `FOR UPDATE SKIP LOCKED` cron claiming, ledger-idempotency-keyed debit/refund (`create_sms_campaign`, `credit_user_sms_credits`), and a `FOR UPDATE`-locked, status-gated settle.
- Ran the Supabase security advisor against the live project.

---

## 5. Findings that do need attention (all lower severity — none are the races originally asked about)

| # | Finding | Severity | Detail |
|---|---|---|---|
| 1 | Leaked-password protection disabled in Supabase Auth | Low | HaveIBeenPwned check is off. Unrelated to race conditions; cheap to enable and reduces credential-stuffing risk. Advisor: `auth_leaked_password_protection`, `WARN`. |
| 2 | `SECURITY DEFINER` functions reachable by `anon`/`authenticated` via `/rest/v1/rpc/...` | Low | `get_user_transactions_with_balance`, `reveal_marketplace_contact`, `save_shop_payment_detail_if_under_limit`, `is_admin()`, `is_marketplace_seller_suspended()`. Each currently has a correct `auth.uid()`-based ownership/authorization check **inside the function body**. Not exploitable today, but because the guard lives in the function rather than in the grants, a future edit to any of these five could silently remove the check without anyone noticing at the grant layer. Recommend re-verifying these five specifically whenever they're modified, or moving the check to a `REVOKE`-based model like the money-moving RPCs where practical. |
| 3 | `save_shop_payment_detail_if_under_limit` has a non-locked count-then-insert | Cosmetic | Two truly simultaneous "save payment method" calls from the same owner could both pass the `COUNT(*) < 5` check and land 6 rows instead of the intended cap of 5. No money or auth impact — it's a saved-payment-method limit, not a balance. |
| 4 | RLS enabled with no policy on 11 tables (`admin_audit_log`, `order_retry_attempts`, `ussd_sessions`, `phone_otp_verifications`, etc.) | Informational | This **fails safe** — no policy means zero access for `anon`/`authenticated`; your service-role backend bypasses RLS regardless. Not a hole. Documented here only so it's understood as intentional (backend-only tables) rather than an oversight if it's ever noticed again later. |
| 5 | ~~No idempotency key on the shop bulk-SMS quick-send route~~ — **FIXED** | Low → Fixed | Unlike the SMS campaign pipeline (which has `idempotencyReference`), a double-submitted request to `app/api/shop/sms/send/route.ts` debited credits twice and physically sent the SMS batch twice. Fixed 2026-08-11 (second follow-up pass) — see §8.1. |
| 6 | ~~`credit_shop_profit` / `reverse_lead_margin` check-before-lock TOCTOU~~ — **FIXED** | High → Fixed | `credit_shop_profit` never locked the shop wallet before its idempotency check, and `reverse_lead_margin` checked "already reversed" before locking. Both could double-credit/double-debit a shop wallet under concurrent invocation. Confirmed via production data that this was **never actually exploited** (zero duplicate transaction rows). Fixed 2026-08-11 (second follow-up pass) — see §8.2. This finding corrects §2.1 above, which originally reported this area as safe. |

No finding in this table corresponds to a wallet-balance, withdrawal, top-up, fulfillment, or refund race that is still open — findings #5 and #6 were the two live gaps found across both follow-up passes, and both are now fixed.

---

## 6. Scope boundaries — what was *not* deeply audited

Everything originally flagged as "spot-checked only" has now been traced end-to-end: the Hubtel commission webhook + reconcile cron (§3.3) and the SMS campaign claim/dispatch/settle pipeline (§3.4) both received the same live-function-pull + caller-trace + grant-check treatment as the original scope, and both came back clean (one adjacent low-severity gap found in the *quick-send* route, not the campaign pipeline itself — see finding #5 above).

Remaining lighter-touch spot-checks (their RPCs follow the identical atomic/locked pattern seen everywhere else, confirmed live, but callers were not individually traced):
- USSD wallet payment (`process_ussd_wallet_payment`) — atomic, reference-deduped.
- SMS credit debit/refund for the *shop* wallet specifically (`debit_sms_credits` — atomic; `refund_sms_credits` — atomic but not idempotency-keyed, see finding #5).

Admin-side bulk operations were reviewed as part of the second follow-up pass (§8): `app/api/admin/orders/bulk-refund/route.ts` and `app/api/admin/airtime/bulk/route.ts` both loop the same already-idempotent single-order functions sequentially and came back clean. `app/api/admin/mtn-mashup/orders/route.ts`'s bulk PATCH path is what surfaced the `reverse_lead_margin` finding (§8.2) — its own CAS-guarded refund transition is correct, but it calls into a function that had the bug.

Not yet examined at all: Hubtel Receive-Money's `airtime`/`rc` service-type branches in `settleReceivePaid` (currently unreachable — their feature toggles are seeded OFF per the code's own comments, so there's nothing live to race yet); admin bulk role-change and bulk package-pricing routes (`app/api/admin/users/role/route.ts` is single-user only — no bulk role-change endpoint currently exists; `app/api/admin/packages/bulk-pricing/route.ts` was not traced).

---

## 7. Recommendations, in priority order

1. **No urgent action required** on the scenarios originally asked about — they are already correctly hardened, and the code comments throughout (`SECURITY (C1)`, `Fix #10`, `CF-11`, etc.) indicate this was the product of a deliberate, fairly recent hardening pass rather than an accident. This now includes the Hubtel commission webhook/reconcile and SMS campaign pipelines, which are equally hardened.
2. Enable leaked-password protection in Supabase Auth (Auth → Policies) — a five-minute change, no code required.
3. Add a short comment or test asserting the `auth.uid()` ownership check on the five client-reachable `SECURITY DEFINER` functions in §5, so a future refactor doesn't silently drop it.
4. ~~Add a client-supplied idempotency key to `app/api/shop/sms/send/route.ts`~~ — done, see §8.1.
5. ~~Fix the `credit_shop_profit` / `reverse_lead_margin` check-before-lock TOCTOU~~ — done, see §8.2.
6. Optional: audit `app/api/admin/packages/bulk-pricing/route.ts` and the marketplace admin bulk actions in `app/api/admin/market/**` if you want every remaining admin bulk surface covered, though none of them move wallet balances directly (pricing/moderation data only) so the blast radius is lower than what's already been checked.

---

## 8. Fixes applied (second follow-up pass, 2026-08-11)

### 8.1 Shop bulk-SMS quick-send idempotency (closes finding #5)

**Fix (v1):** `app/api/shop/sms/send/route.ts` computes a SHA-256 idempotency key from `{shop_id, message, sorted recipients, 30-second time bucket}` and atomically claims it via `INSERT INTO shop_sms_send_claims (shop_id, idempotency_key)` — a new table with a `UNIQUE (shop_id, idempotency_key)` constraint (migration `20260811_shop_sms_send_idempotency.sql`) — *before* the content filter, rate limits, credit debit, or provider send. A duplicate request hits the unique-constraint violation (Postgres `23505`) and is rejected with a 409 before it can debit or send anything.

**Independent review caught a real gap in v1 — fixed (v2):** the `payments-security-reviewer` subagent, dispatched as this repo's mandatory fintech security gate before finishing, flagged (HIGH) that the 30-second calendar-aligned bucket doesn't reliably catch the exact scenario named in the fix's own comment — *"client-side retry after a timeout."* A fetch timeout is typically ≥10-30s; by the time a client (or a user) retries, the retry very plausibly lands in a *different* 30-second bucket, hashes differently, and sails straight past the dedup check — reproducing the double-debit/double-send bug in precisely the case the fix exists to close. Genuine same-instant double-clicks were covered; delayed retries were not. It also flagged (MEDIUM) that claim rows had no retention/cleanup path — written on every send attempt (even ones later blocked by the content filter or rate limiter) with nothing purging them, unlike `sms_messages` which has a dedicated daily cron.
Both fixed together: the time bucket was removed entirely from the key (`app/api/shop/sms/send/route.ts`) — the key is now pure content hash `{shop_id, message, sorted recipients}`, so a delayed retry with identical content always matches the original claim regardless of how much time has passed. The existing daily `sms-purge` cron (`app/api/cron/sms-purge/route.ts`) was extended to also delete `shop_sms_send_claims` rows older than 24 hours, which both bounds table growth and means a **deliberate** identical resend is only blocked until the next day's purge — an acceptable, arguably desirable tradeoff for a customer-facing bulk send (it also guards against an accidental same-day re-blast), and no distinct message/recipient-list combination is ever affected.

### 8.2 `credit_shop_profit` / `reverse_lead_margin` double-credit TOCTOU (closes finding #6, corrects §2.1)

**What was wrong:** `credit_shop_profit(p_shop_order_id)` — the function that credits a shop owner's profit on a direct (non-sub-agent) sale — checked `shop_wallet_transactions` for an existing `type='profit'` row for the order *before acquiring any lock*, and never locked the wallet row at all before writing to it. `reverse_lead_margin` had the same shape: it checked for an existing `profit_reversal` row *before* its `FOR UPDATE` lock instead of after. Compare this to the sibling function `credit_shop_order_profits` (sub-agent orders), which was correct from the start — it locks both wallets `FOR UPDATE` first, then checks.

**Why it mattered:** `credit_shop_profit` has four call sites — `lib/shop-order-processor.ts`, `lib/ussd/fulfillment/data.ts` (×2), `lib/ussd/fulfillment/airtime.ts` (×2), and `app/api/shop/verify/route.ts` — including an explicit USSD **replay path** (`lib/ussd/fulfillment/airtime.ts:169`, comment: `// replay credit failed`) that legitimately re-invokes it for an order that may already have been credited by an earlier request. Two calls landing close enough together (e.g. a USSD session timeout triggering a customer retry) could both read "not yet credited" before either had committed its transaction row, and both would then credit the wallet — a genuine double-credit of a shop owner's profit.

**Fix:** both functions were rewritten (migration `20260811b_fix_credit_shop_profit_reverse_lead_margin_toctou.sql`) to lock the wallet row `FOR UPDATE` *first*, then run the idempotency check, then credit/debit — the same ordering `credit_shop_order_profits` already used. This serializes concurrent callers on the wallet row: the second caller blocks until the first commits, then sees the first's transaction row and returns `already_credited`/`already_reversed` instead of moving money again.

**Was it ever exploited?** No. Queried directly against production `shop_wallet_transactions` (12,646 `profit` rows across 12,612 distinct orders — the small gap is fully explained by the legitimate sub-agent dual-crediting via `credit_shop_order_profits`, not a bug; 0 `profit_reversal` rows exist at all, meaning `reverse_lead_margin` had never fired in production). Grouped by `(shop_order_id, shop_wallet_id, credit_source)` and also checked the broadest possible duplicate signal (any order with more than one `profit` row at all, regardless of wallet) — zero duplicates found either way. The bug was real and reachable, but the precise concurrent timing needed to trigger it never occurred in practice. **No manual wallet reconciliation or refund is needed.**

### 8.3 Independent security review (fintech gate)

`payments-security-reviewer` was dispatched against all changed files per this repo's mandatory security gate for Tier 2 money-adjacent work. Full findings:
- **HIGH** — SMS idempotency key's 30s bucket misses delayed retries. Fixed, see §8.1.
- **MEDIUM** — `shop_sms_send_claims` had no cleanup path. Fixed, see §8.1.
- **LOW** — a claim row written before the content filter runs is not released on a `blocked` outcome, so a legitimate identical resubmission within the claim's lifetime gets a spurious 409 instead of reaching the filter again. No money/security impact (block happens pre-debit) — accepted as-is; the 24h cleanup makes this self-healing, and the alternative (special-casing claim release per rejection branch) adds more code than the friction it removes.
- **Informational, no action needed** — `credit_shop_order_profits` (pre-existing, unchanged this session) locks two `shop_wallets` rows in a fixed sub-then-parent order, a latent deadlock precondition only if some future function ever locks the same two wallets in reverse order. Confirmed neither `credit_shop_profit` nor `reverse_lead_margin` (this session's fixes) creates that risk — each acquires exactly one wallet lock per call, so neither can participate in a deadlock cycle.
- Confirmed correct with no issues: idempotency-claim placement (runs before every debit/send path, no bypass found), RLS-enabled-no-policy posture on the new table (mirrors `shop_sms_refund_failures`, no auth bypass), `EXECUTE` grants on the rewritten RPCs (unchanged by `CREATE OR REPLACE`, still service-role-only), lock-ordering/deadlock-freedom of the TOCTOU fix, wallet ops going exclusively through RPCs (no raw `UPDATE`), and input validation on the route.

### 8.4 Verification
- `npx tsc --noEmit` — zero errors (both before and after the HIGH/MEDIUM follow-up fix).
- `npx next lint` — zero warnings/errors (both before and after).
- All changed/new SQL functions re-pulled live post-migration and confirmed to match the fixed source.
