# Client-side order & wallet forgery — Audit 2026-09-24

## 1. Finding (CRITICAL — fixed 2026-09-24)
Any authenticated user could INSERT rows into `orders`, `airtime_orders`, `afa_orders` via
Supabase REST (anon key + own JWT), because of RLS INSERT policies `WITH CHECK (user_id = auth.uid())`
plus table-level INSERT grants to `authenticated`, with no guard trigger or constraint.
Exploit paths: (a) forged `pending` order → `POST /api/user/orders/refund` → `refund_order_wallet`
credits `price` with no prior debit (wallet minting); (b) refulfill cron dispatches any `pending`
order (free data); (c) `hubtel-commission-reconcile` pass (b) dispatches any `pending`
hubtel-commission airtime row (free airtime, ≤ GHS 100/row, 50 rows/run, auto-fulfilment ON).
Also: admin/sub-admin RLS policies allowed direct INSERT into `wallet_transactions`, bypassing the
audited `admin_adjust_wallet` RPC — this one was real (table-level grant + policy both existed).

**CORRECTION:** the brief's original wording for this section also claimed the admin/sub-admin RLS
policy allowed direct `wallets` UPDATE. That is wrong. Per the Task 1 rollback snapshot, `wallets`
never had an `anon`/`authenticated` INSERT/UPDATE/DELETE table-level grant — only 4 GRANT rows
existed pre-fix, covering `orders`, `airtime_orders`, `afa_orders`, and `wallet_transactions`, with
no grant row for `wallets` at all. Postgres RLS policies are only reachable after the table-level
grant check passes, so the "Admins can update wallets" policy was **inert**: staff (or anyone)
could not directly set `wallets.balance` through PostgREST regardless of that policy's USING clause.
The real, exploitable admin-side gap was the `wallet_transactions` INSERT policy/grant combination
described above; the `wallets` guard-trigger coverage added in this fix is defense-in-depth against
a future re-grant, not a fix for a live exploit path.

## 2. Exploitation check — no evidence of abuse
- 750/750 `REFUND-ORDER-*` wallet credits (GHS 9,737.54, all time) trace to a real payment.
- All 46,022 `orders` accounted for (exact-ref debits, RETRY debits, USSD Hubtel sessions,
  archived Paystack shop orders, launch-week Date.now()-derived refs, admin test orders).
- `airtime_orders`: 196 storefront rows matched to Paystack shop orders; 161 web rows paid
  (see §6 F2). API orders: 128/128 exact debits. AFA: 76/77 explained (see F3).
- Users hold no DELETE policy, so no forged row could have been removed after use.

## 3. Root cause
Client INSERT policies on order tables were never needed — every legitimate writer uses the
service role — but were left in place, and nothing downstream (refund RPC, cron dispatchers)
re-verified payment.

## 4. Fix
Migration `supabase/migrations/20260924b_lock_client_money_writes.sql`: dropped 8 client write
policies, revoked INSERT/UPDATE/DELETE from anon+authenticated on the 5 tables, added guard
trigger `block_client_money_writes()` (INSERT-only on order tables — UPDATE would break
`delete_shop_data()`'s FK cascade; INSERT+UPDATE on wallet tables). Note: the REVOKE issued against
`public.wallets` in this migration was a no-op — as established in §1's correction, `wallets` never
carried an `anon`/`authenticated` grant in the first place. It was included for symmetry/future-proofing
and to be covered by the same guard-trigger + verification-script pattern as the other four tables.

## 5. Verification evidence
- `scripts/sql/verify-client-money-write-lock.sql`: **41/41 pass**, run 2026-09-25 (post-apply
  verification performed independently in Task 3). Applied migration version
  `20260924233232` (2026-09-24 23:32:32 UTC) confirmed byte-for-byte identical to the on-disk
  migration file. Note on provenance: the migration was actually applied to the live DB by an
  implementer session that was cut off by a network error immediately after the apply succeeded,
  before it could verify or commit. Nothing in that interrupted session's claims was trusted —
  Task 3 independently re-derived the applied state from scratch (file-vs-DB diff, this 41-row
  verification run, and the advisor diff below) via read-only queries.
- Security advisor: **no new warnings**. Post-apply `get_advisors(type: security)` matched the
  Task 1 baseline exactly — same 5 lint categories, same counts (`rls_enabled_no_policy` 18,
  `function_search_path_mutable` 1, `anon_security_definer_function_executable` 5,
  `authenticated_security_definer_function_executable` 9, `auth_leaked_password_protection` 1).
  No finding in either run mentions `orders`, `airtime_orders`, `afa_orders`, `wallets`,
  `wallet_transactions`, or `block_client_money_writes`.
- Rolled-back probe (verbatim, always-aborted transaction, run 2026-09-25):
  ```
  ERROR:  P0001: PROBE (rolled back) | client orders: BLOCKED: SECURITY: orders can only be written by the server | client airtime: BLOCKED: SECURITY: airtime_orders can only be written by the server | client wallet: BLOCKED: SECURITY: wallets can only be written by the server | server orders: ALLOWED | server airtime: ALLOWED
  CONTEXT:  PL/pgSQL function inline_code_block line 39 at RAISE
  ```
  Leftover check post-probe: `[{"leftover":0},{"leftover":0}]` — zero residual rows in `orders`/
  `airtime_orders` under the `AUDIT-PROBE-%` reference prefix, confirming full rollback.

## 6. Follow-ups (not fixed here)
F1 payment-provenance checks in dispatchers/refund RPC · F2 historical airtime ledger gap
(2026-03-23 → 2026-07-02, 161 orders, ~GHS 891, 49 users; route omitted required
`user_id`/`description`) · F3 one AFA order with no payment trace (2026-03-17, ~GHS 14) ·
F4 upgrade processors complete payment before eligibility/role update; agent upgrade overwrites
dealer/admin role · F5 `save_shop_payment_detail_if_under_limit` caller-controlled `p_limit` ·
F6 PIN columns self-writable (app-lock only) · F7 review `user_payment_references`,
`shop_pricing`, `shop_customers` client write policies — `user_payment_references` and the inert
`ussd_pending_orders`/`shop_orders`/`shop_customers` write grants were fixed in §7 below;
`shop_pricing` remains open · F10 pre-existing bug, unrelated to this fix:
`app/api/shop/customers/route.ts` PATCH (edit customer tags/notes, used by the shop dashboard)
writes to `shop_customers` via the caller's RLS client, but `authenticated` has never held an
UPDATE grant on that table — the feature fails today regardless of this migration. Fix separately,
e.g. a service-role write after an explicit ownership check.

**Status update (2026-09-25):**
- **F2 — fixed.** Migration `supabase/migrations/20260925b_backfill_missing_airtime_ledger.sql`
  (applied as `20260925135741`) inserted the 161 missing debit history rows (GHS 891.47, 49 users),
  history only. Verified: 0 orders still missing, 0 duplicates, wallet balance checksum for the
  49 users identical before/after (`9351ef7b0f818eb7dfaf5453bdac6793`), 39 users now reconcile to
  the pesewa. Security gate (payments-security-reviewer): SAFE TO APPLY.
- **F4 — re-assessed Low–Medium and deferred by the owner.** Checkout already rejects ineligible
  buyers, so the demotion case needs a role change between checkout and payment confirmation;
  no case found among the 34 Paystack upgrade payments ever made (none since 2026-05-28). Also
  noted: completion overwrites the stored plan metadata with Paystack's response.
- **F10 — fixed.** `app/api/shop/customers/route.ts` PATCH now resolves the caller's shop via the
  RLS client and writes with the service role scoped to both the customer id and that shop.
- **F11 — fixed 2026-09-26** (migration `20260926b_ledger_history_rc_sms_ussd.sql`, applied as
  `20260926115158`). Platform-wide reconciliation found 71 wallets whose history showed more money
  than their balance (0 the other way — no wallet ever held unexplained money). Causes: results
  checker wrote ledger source `results_checker`, rejected by the source CHECK (every wallet-paid
  purchase silently lost its history row); `activate_shop_sms`, `purchase_sms_bundle`,
  `purchase_user_sms_credits`, `activate_shop_ussd` debited wallets without a history row. Fix:
  source allowed, history row written in the same transaction as each debit, 322 past rows
  backfilled (USSD activation fees inferred from an exact 30/50 gap and labelled
  "(reconstructed)"), wallet-paid results-checker orders relabelled `payment_method='wallet'`.
  Result: 1,046 of 1,049 wallets reconcile to the pesewa (from 977), 0 over-explained; no balance
  changed during the migration. 3 wallets (GHS 197.01, 127.50, 36.85) remain for manual review.
- **F12 — fixed 2026-09-26** (`20260926_pin_shop_pricing_columns.sql`): owner airtime/mashup fees,
  results-checker markups and AFA fee/price are pinned to the server-validated pricing route and
  CHECK-constrained non-negative.
- **F13 — reviewed 2026-09-26** (`scripts/reverify-saved-payout-accounts.ts`, read-only): of 73
  legacy saved payout accounts, 60 match the provider name, 2 mismatch, 11 could not be resolved;
  flagged for manual review, no automatic deletion (payouts to them completed normally).
- **F15 — fixed 2026-09-26** (`20260926c_lock_shop_row_on_ussd_activation.sql`). Correction: the
  SMS half of this finding was wrong — `shop_sms_activations.shop_id` IS unique, so a concurrent
  second SMS activation fails on insert and rolls back its own debit. The real gap was
  `activate_shop_ussd`: it read the shop row unlocked, so two concurrent calls could both pass the
  "no code yet" check and both charge. It now locks the row (`FOR UPDATE`); the second call sees
  the first's code and returns already-active without charging. Frontend: all four activation
  buttons (USSD page, SMS page, setup wizard SMS + USSD) already disabled with a spinner; each
  handler now also takes a synchronous `useRef` lock so rapid double-taps cannot send two requests.
- **F16 — fixed 2026-09-26** (code only). `protect_shop_admin_columns` pins `approval_status`,
  `is_active`, `approved_by/at` for every `authenticated` writer — admins included — so the admin shop
  detail page's Approve / Suspend / Reject Profile buttons and the `is_active` half of Approve / Revoke
  Pricing were silently reverted while showing a success toast (a "suspended" shop stayed live). No
  data harm found: all 279 shops are `approved`, none ever suspended/rejected. All four actions now
  go through `PATCH /api/admin/shops` (service role, admin-only, zod-validated; pricing approve/reject
  compare-and-swap on `pricing_status='pending_review'`, approve also requires `approval_status='approved'`
  so it can never lift a suspension; revoke takes the shop offline before clearing prices). The dead
  `shop_pricing_pending` flow was removed from the page — nothing has written that table since the
  pricing route started saving owner prices directly (39 stale rows, newest 2026-03-10).
- **F17 — Low, latent, open.** Owners hold INSERT/UPDATE/DELETE on `shop_pricing` (RLS owner policies
  + grants), so they can write live prices without `app/api/shop/pricing`. Checkout and USSD re-check
  `profit > 0` against live cost at sale time, so this cannot cause a platform loss; the only rule it
  skips is the `data_profit_max_<role>` cap, and no such setting exists today (cap = unlimited). Becomes
  Medium the day a profit cap is configured — fix then by revoking owner writes on `shop_pricing` (the
  pricing route already writes via service role).
- **Webhook secret compares — Low, fixed 2026-09-26.** `webhooks/sms-forward` (shared-secret header)
  and `webhooks/xpress` (HMAC hex) compared with `===`/`!==`; both now use `timingSafeEqual`
  (sms-forward via equal-length HMAC digests, same as `lib/ussd/callback-auth.ts`).
- **Moolre payouts retired 2026-09-26** (owner decision): `process-withdrawal` accepts only
  `manual`/`paystack`/`refund`. Verified safe: 0 `moolre_pending` rows exist (10 historical Moolre
  payouts, all `completed`); manual/Paystack/refund only act on `pending`/`failed` rows.

### Follow-ups closed 2026-09-28
- **Last 3 unreconciled wallets — closed** (`20260928b_ledger_reconcile_three_wallets.sql`, history
  only, owner-approved). `3b63904a` (197.01): an admin "old site" compensation credit was written to
  history twice 9 ms apart (balance credited once) — duplicate row removed. `b60fc2f0` (owner's
  admin account, 127.50) and `5ba3a6d0` (owner's own test shop, 36.85): no order/refund explains
  the gap (direct balance edits during testing, before the 2026-09-24 lock) — one labelled
  `AUDIT-RECON-20260928-*` debit each. The migration aborts unless each gap is exactly as measured,
  never touches `wallets`; the 3 balances were byte-identical before/after. **Result: 1,054 of
  1,054 wallets reconcile.**
- **Refund double-credit — verified closed.** Two GhData refunds were credited twice in Feb
  (`REF-GHD-*`, GHS 4.35 + 4.90, both on the owner's own accounts). That code path has not written
  since 2026-03-07 and nothing produces the prefix. Of ~1,690 refunds since July, 0 duplicates.
  `refund_order_wallet` locks the order `FOR UPDATE` before its already-refunded check;
  `refund_ussd_wallet` locks the wallet before its reference check. All 31 wallet/refund/credit
  functions are EXECUTE-able by `service_role` only.
- **F13 re-run:** 55 match, 1 mismatch, 18 unresolved (74 accounts). The mismatch (MTN ***9075) was
  a manual entry from the pre-verification auto-save flow; all 5 payouts to it (GHS 322) came from
  the same owner's own wallet. "Unresolved" was provider flakiness, not the accounts — the same
  numbers resolved/failed minutes apart.
- **Name-lookup bug — fixed** (`lib/momo-verify.ts`). The Paystack fallback sent Telecel as `VDF`;
  Paystack's code is `VOD` ("Unknown bank code: VDF"), so every Telecel lookup failed whenever
  Moolre did. Also Moolre timeout 5 s → 8 s (measured 1.3–5.5 s) and one Moolre retry after a full
  miss (max 3 provider calls; quota consumed first). Guard: `scripts/test-momo-verify.ts`.
  Payouts/charges were never affected (they already used `VOD`). Moolre still performs ~95% of
  name lookups — keep the Moolre account active even though payouts no longer use it.
- **`claim_ussd_callback_retry`** — `search_path` pinned; EXECUTE revoked from anon/authenticated
  (`20260928_claim_ussd_callback_retry_hardening.sql`).
- **Leaked-password protection** enabled by the owner (Supabase Auth, HaveIBeenPwned check).
- **F3 — closed, paid.** The 2026-03-17 AFA order (dealer, GHS 14, no payment reference) was
  charged by an admin manual wallet debit "Admin manual debit for MTN AFA Registration Fee" at
  18:07 the same day (preceded by a mistaken debit + correcting credit that net to zero). The
  payment exists but was never linked to the order. No loss.
- **F6 — fixed** (`38e47d27` + `20260928c_pin_columns_server_only.sql`, applied after that
  deploy was live). App-lock PIN columns were self-writable via RLS, so a session holder could
  reset `pin_attempts`/`pin_locked_until` or overwrite `pin_hash`, bypassing the lockout and
  step-up. `/api/auth/pin` now reads/writes them with the service role (every query scoped to the
  session user), and `guard_users_privilege_change` rejects client-session changes to
  `pin_hash`/`pin_salt`/`pin_attempts`/`pin_locked_until`. Verified live (rolled back): client PIN
  change → rejected; client name edit → allowed; service role PIN change → allowed. Residual
  (accepted): a user can still read their own `pin_hash`/`pin_salt`.
- **F1 — monitoring added, owner-chosen option A** (`20260929_refund_payment_evidence_monitor.sql`,
  2026-09-29). Blocking refunds on a payment-provenance check was rejected: payment evidence is
  spread across formats (direct/USSD-wallet/retry debits, Hubtel USSD sessions), and the root cause
  (client-forged orders) is already closed. Instead `refund_order_wallet` — body otherwise
  byte-identical — calls new `order_has_payment_evidence()` after a successful refund and, if no
  evidence, writes `security_events` `refund_without_payment_trace` for review. The check runs in
  its own sub-transaction and can never fail or undo a refund. Evidence rule validated against all
  376 orders refunded in the prior 60 days: 0 false positives. Verified live (rolled back): order
  without evidence → refunded + 1 event; order with evidence → refunded, 0 events; repeat call →
  `already_refunded`. Security review: no Critical/High. Note: no admin page reads
  `security_events` yet — review via SQL until one exists.
- **F17 — still open (latent)**: owner writes to `shop_pricing`; only matters once a
  `data_profit_max_<role>` cap is configured.

## 7. Addendum — adjacent tables (fixed 2026-09-25)

During this fix's security gate, the payments-security-reviewer flagged four related gaps left
over from the same root cause (client write surface on tables no legitimate app path uses):
**HIGH** — `user_payment_references` still carried a client INSERT policy and grant; because the
MoMo SMS auto-claim flow credits whichever account owns a matching reference row, a
client-writable reference row could let a user redirect that credit to themselves. **MEDIUM/LOW**
— `ussd_pending_orders`, `shop_orders` (INSERT/UPDATE/DELETE), and `shop_customers`
(INSERT/DELETE) each retained `authenticated` write grants with no corresponding write policy
(and, for `shop_customers`, both writers are SECURITY DEFINER triggers, not client requests) — an
unused grant is not exploitable by itself, but it is a landmine for the next policy added.

**Fix:** migration `supabase/migrations/20260924c_lock_client_writes_adjacent_tables.sql` — dropped
the 3 `user_payment_references` client/admin write policies, added guard trigger
`trg_block_client_write` (BEFORE INSERT OR UPDATE, reusing `block_client_money_writes()`) on
`user_payment_references`, and revoked the stale INSERT/UPDATE/DELETE grants on all four tables
(`user_payment_references`, `ussd_pending_orders`, `shop_orders`, `shop_customers`) from
`anon`/`authenticated`. SELECT ("view own") policies were kept on all four.

**Evidence** (live DB, 2026-09-25):
- Verification script grew from 41 to 67 checks: `total: 67, passed: 67, failed: 0` — full
  breakdown 54 no-privilege checks (9 tables × 2 roles × 3 privileges), 6 "only SELECT policies
  remain" checks, 6 guard-trigger checks, 1 guard-function-security-invoker check, all `pass = true`.
- Applied migration version `20260925072620` (2026-09-25 07:26:20 UTC).
- Security advisor (`get_advisors`, type `security`) re-pulled fresh on 2026-09-25 (not the
  snapshot taken during implementation, which had gone stale due to an unrelated concurrent
  marketplace change): `rls_enabled_no_policy` 17, `function_search_path_mutable` 1,
  `anon_security_definer_function_executable` 4, `authenticated_security_definer_function_executable`
  7, `auth_leaked_password_protection` 1 — four fewer findings total than the original 2026-09-24
  baseline (18/1/5/9/1: `rls_enabled_no_policy` −1, `anon_security_definer_function_executable` −1,
  `authenticated_security_definer_function_executable` −2), all four being unrelated
  marketplace-feature lint entries removed by a concurrent change on this project, not by this
  migration. No finding in this fresh pull
  references `user_payment_references`, `shop_orders`, `shop_customers`,
  `block_client_money_writes`, or `trg_block_client_write`. `ussd_pending_orders` appears once,
  under `rls_enabled_no_policy` (RLS enabled with zero policies of any kind, including SELECT) —
  that finding predates this migration and is orthogonal to the GRANT revocation made here (a
  missing-policy lint, not a stale-grant one), so it is expected and unrelated.
- Rolled-back probe (verbatim, always-aborted transaction, run 2026-09-25):
  ```
  ERROR:  P0001: PROBE2 (rolled back) | client: BLOCKED: SECURITY: user_payment_references can only be written by the server | server: ALLOWED
  CONTEXT:  PL/pgSQL function inline_code_block line 29 at RAISE
  ```
  Leftover check: `select count(*) from public.user_payment_references where reference_code='AUDITPRB1'` → **0** — probe transaction fully rolled back, no residual row.

## Appendix A — Rollback SQL (EMERGENCY ONLY — re-opens the vulnerability)

Prefer dropping a single misfiring trigger over running this in full.
Captured from the live DB immediately before the fix was applied.

**Order note:** if migration `20260924c_lock_client_writes_adjacent_tables.sql` is also applied,
run Appendix B first (at minimum its
`DROP TRIGGER IF EXISTS trg_block_client_write ON public.user_payment_references;` line) —
otherwise this appendix's `DROP FUNCTION` below fails with a dependency error, because that
trigger still depends on `block_client_money_writes()`.

```sql
-- Remove guard triggers + function
DROP TRIGGER IF EXISTS trg_block_client_insert ON public.orders;
DROP TRIGGER IF EXISTS trg_block_client_insert ON public.airtime_orders;
DROP TRIGGER IF EXISTS trg_block_client_insert ON public.afa_orders;
DROP TRIGGER IF EXISTS trg_block_client_write  ON public.wallets;
DROP TRIGGER IF EXISTS trg_block_client_write  ON public.wallet_transactions;
DROP FUNCTION IF EXISTS public.block_client_money_writes();

-- Restore grants (paste every regrant_sql row from Step 3)
GRANT DELETE, INSERT, UPDATE ON public.afa_orders TO authenticated;
GRANT DELETE, INSERT, UPDATE ON public.airtime_orders TO authenticated;
GRANT DELETE, INSERT, UPDATE ON public.orders TO authenticated;
GRANT DELETE, INSERT, UPDATE ON public.wallet_transactions TO authenticated;

-- Restore policies (paste every recreate_sql row from Step 2)
CREATE POLICY afa_orders_admin_delete ON public.afa_orders AS PERMISSIVE FOR DELETE TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY afa_orders_admin_update ON public.afa_orders AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY afa_orders_insert_combined ON public.afa_orders AS PERMISSIVE FOR INSERT TO public WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))));
CREATE POLICY "Admins can update airtime orders" ON public.airtime_orders AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY "Users can create airtime orders" ON public.airtime_orders AS PERMISSIVE FOR INSERT TO public WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can create orders" ON public.orders AS PERMISSIVE FOR INSERT TO public WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Admins can insert wallet transactions" ON public.wallet_transactions AS PERMISSIVE FOR INSERT TO public WITH CHECK ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY "Admins can update wallets" ON public.wallets AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
```

## Appendix B — Rollback SQL for the adjacent-tables migration (EMERGENCY ONLY — re-opens the vulnerability)

**Order note:** when rolling back both migrations, run this appendix BEFORE Appendix A — running
only Appendix B leaves the 5 money tables locked (intended partial rollback).

Prefer dropping a single misfiring trigger over running this in full.
Restores only what `20260924c_lock_client_writes_adjacent_tables.sql` removed — the 3
`user_payment_references` write policies and the 4 stale grants captured in the Task 8 rollback
snapshot. `shop_customers_owner_update` is deliberately **excluded**: it was never dropped by this
migration (it was already inert — no UPDATE grant backed it), so recreating it here would fail as
a duplicate-policy error.

```sql
-- Remove guard trigger
DROP TRIGGER IF EXISTS trg_block_client_write ON public.user_payment_references;

-- Restore grants
GRANT DELETE, INSERT ON public.shop_customers TO authenticated;
GRANT DELETE, INSERT, UPDATE ON public.shop_orders TO authenticated;
GRANT DELETE, INSERT, UPDATE ON public.user_payment_references TO authenticated;
GRANT DELETE, INSERT, UPDATE ON public.ussd_pending_orders TO authenticated;

-- Restore policies (user_payment_references only — shop_customers_owner_update was never
-- dropped by this migration and is intentionally NOT recreated here)
CREATE POLICY user_payment_references_admin_delete ON public.user_payment_references AS PERMISSIVE FOR DELETE TO public USING (is_admin());
CREATE POLICY user_payment_references_admin_update ON public.user_payment_references AS PERMISSIVE FOR UPDATE TO public USING (is_admin());
CREATE POLICY user_payment_references_insert_own_or_admin ON public.user_payment_references AS PERMISSIVE FOR INSERT TO public WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
```
