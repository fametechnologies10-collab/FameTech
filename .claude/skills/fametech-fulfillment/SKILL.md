---
name: kingflexy-fulfillment
description: Fulfillment patterns for KiNG FLEXY GH — DataKazina API integration, network IDs, circuit breaker, bundle mapping cache, and Paystack webhook handling. Use when working with order fulfillment, data bundle purchases, or payment webhooks.
---

# KiNG FLEXY GH — Fulfillment Patterns

## Primary fulfillment provider: DataKazina

All data bundle and airtime orders go through the DataKazina API (`lib/fulfillment-service.ts`).

**Network IDs** (required in DataKazina API calls):
```ts
const NETWORK_IDS = {
  'MTN': 3,
  'Telecel': 2,
  'AT-iShare': 1,
  'AT-BigTime': 4,
}
```

**Bundle mapping cache:**
- In-memory cache: `bundleMappingCache` (1-hour TTL)
- Shared persistent cache: `admin_settings` table, key `datakazina_bundle_map`
- Supabase is used as the shared cache to prevent 429s during cold starts across multiple serverless containers
- Always call `fetchAllBundleMappings()` before fulfillment — it handles both cache layers

## Circuit breaker

The fulfillment service has a module-level circuit breaker:
- `closed` → normal operation
- `open` → failing fast after 5 failures; retries after 60s recovery timeout
- `half-open` → allowing one probe request

When the circuit is open, orders should be marked `pending` (not `failed`) and retried via the re-fulfillment cron.

## FulfillmentResponse shape

```ts
interface FulfillmentResponse {
  success: boolean
  reference?: string
  transactionId?: string
  error?: string
  apiResponse?: any
  isRateLimited?: boolean
}
```

If `isRateLimited: true`, back off and retry — do not mark the order failed immediately.

## Other fulfillment services

| File | Provider | Use case |
|---|---|---|
| `lib/codecraft-service.ts` | CodeCraft | Telecel data bundles (legacy fallback) |
| `lib/xpress-service.ts` | Xpress | Airtime top-up |
| `lib/moolre-transfer-service.ts` | Moolre | Airtime/mobile money transfers |
| `lib/at-ishare-service.ts` | AT-iShare | AirtelTigo iShare bundles |
| `lib/datagod-service.ts` | DataGod | Data bundles (alternative provider) |
| `lib/results-checker-service.ts` | Results checker | WAEC/BECE/WASSCE voucher delivery |
| `lib/bundleportal-service.ts` | Bundle Portal | MTN/Telecel/AT-iShare data bundles (single action-based endpoint, no AT-BigTime support) |
| `lib/hendylinks-service.ts` | HendyLinks | MTN/Telecel/AT-iShare/AT-BigTime data bundles. No client-supplied idempotency key on order placement, so its dispatch functions surface `ambiguous: true` when a transport failure can't be reconciled via order-history scan (see the "Adding a new supplier" checklist, item 7, and Gotchas below). Has webhooks (HMAC-SHA256) — completion is webhook-first, not polled. |
| `lib/atishare-console-service.ts` | AT-iShare Console (SPFastIT) | AT-iShare network only — no MTN, Telecel, or AT-BigTime. Poll-only, no webhook; completion is discovered by `app/api/cron/sync-atishare-console-status/route.ts` calling `check_order_status.php`. (Bundle Portal used to be the other poll-only supplier this compared to — it moved to a webhook in its v2 migration, see `app/api/webhooks/bundleportal/route.ts`.) See Gotchas below. |
| `lib/shop-order-processor.ts` | — | Processes orders placed through shop storefronts |

## Paystack webhooks (`/api/webhooks/paystack`)

- Verify signature: `x-paystack-signature` header must match `HMAC-SHA512(body, PAYSTACK_SECRET_KEY)`
- On `charge.success`: call `processCompletedWalletPayment(reference, metadata)` from `lib/payments.ts`
- On dealer upgrade payment: call `processCompletedDealerUpgradePayment` (re-exported from `lib/dealer-payments.ts`)
- `processCompletedWalletPayment` is idempotent — safe to call multiple times for same reference

## Re-fulfillment cron

Failed/pending orders are retried by the re-fulfillment cron (`/api/cron/refulfill` or similar). The `lib/refulfillment-service.ts` handles retry logic. When adding new product types, register them there.

## Adding a new supplier — checklist (read before wiring in a new integration)

Every supplier added so far (Bundle Portal, HendyLinks) shipped with the exact same class of
bug: the CHECK-constraint-widening migration and the dispatch wiring landed, but three other
places that MUST stay in sync with the new supplier's reference column did not, and nobody
noticed until a much later audit (2026-08-20) traced two real production symptoms — a retried
order still showing/exporting its old supplier, and a stale webhook from an abandoned supplier
flipping a retried order's status back to `failed` without it actually failing. A follow-up
security review of the HendyLinks merge (2026-08-20) found three more instances of the same
underlying "written against the pre-fix file shape" problem, now folded into items 5, 6, and 21
below — and HendyLinks' first day in production immediately produced four more live bugs
(items 9–12), every one of which was a classification mistake rather than a wiring mistake.
Items 13–15 come from the DataKazina retry/webhook work the same day: a supplier-side
idempotency key we could never vary, identifiers we stored only half of, and a fail-closed
webhook whose secret was never configured — so it had silently rejected every delivery since
the day it was written. Items 16–19 came from finally probing HendyLinks' live endpoint
instead of trusting its spec, and are the ones worth reading twice: a field name that was
wrong from day one (making a whole safety path dead while its tests passed), a timezone-less
timestamp, a webhook that outran our own database write by 44 seconds, and an unpaginated
history sweep. **Every one of items 16–19 was invisible to `tsc`, to lint, and to a green test
suite** — they were only found by calling the real API and reading real logs. Item 20 is
different again: not a bug that broke anything, but a supplier string that was about to be
shown to paying customers. Items 22–25 come from building the AT-iShare Console supplier
(2026-08-21), the first one built on top of a shared supplier registry instead of five
hand-maintained lists — three of the four are process gaps the registry itself doesn't close
(a UI row, a dispatch-claim discipline, a migration-verification step), and the fourth is a
route/admin-twin parity gap that has now recurred across two different suppliers.
Do all twenty-five of these in the SAME PR that adds the supplier, not as a follow-up:

1. **Migration**: widen `orders_fulfillment_method_check` to include the new supplier name, add
   its `<supplier>_reference` (or `_order_id`) column, and index it if it's a webhook join key
   (see `20260819_widen_fulfillment_method_check_hendylinks.sql` for the pattern).
2. **`claim_order_retry` RPC** (new migration, `CREATE OR REPLACE`): add the new reference
   column to the in-place retry branch's `NULL`-out list, alongside `codecraft_reference` /
   `dakazina_reference` / `ghdata_order_id` / `bundleportal_reference`. Forgetting this was the
   root cause found in Bundle Portal (added 2026-08-16, fixed 2026-08-20) and HendyLinks (same
   commit) — the CHECK-widening migration is a different file from the RPC migration, so it's
   easy to ship one without the other. Include a scoped one-time backfill UPDATE for any order
   already stuck with a stale value from before the fix (see the 2026-08-20 migrations for the
   exact scoping: `status='pending' AND <ref> IS NOT NULL AND retried_by IS NOT NULL AND
   retry_from_status='failed'`).
3. **`lib/fulfillment-trigger.ts`**: add the new reference column to BOTH inline revert
   UPDATEs (the exception-catch branch and the definite-failure branch — these are two
   separate object literals, not a shared named constant, despite how that might sound; grep
   the file for `bundleportal_reference: null` to find both spots and edit each one). This is
   what nulls `fulfillment_method` + every reference column when a dispatch is reverted to
   `pending` — skipping a supplier here means an order that failed via that supplier keeps a
   stale reference forever, exactly the bug this checklist exists to prevent. Current full
   column list to keep in sync: `fulfillment_method`, `codecraft_reference`,
   `dakazina_reference`, `ghdata_order_id`, `bundleportal_reference`, `hendylinks_order_id`.
4. **`lib/refulfillment-service.ts`**: add the same column to its own step-11 revert UPDATE
   ("revert DEFINITE failures to pending") — same column list as item 3. The two files
   intentionally keep separate inline copies (single-order vs. bulk dispatch paths); they must
   list the exact same columns.
5. **Every route that can resolve this order's terminal status** — not just "the supplier's own
   webhook", ALL of them: `app/api/webhooks/<supplier>/route.ts`, any cron reconciliation sweep
   (`app/api/cron/sync-<supplier>-status/route.ts`), and any admin-triggered sync
   (`app/api/admin/fulfillment/sync-<supplier>/route.ts`). Every UPDATE that changes an order's
   status MUST filter on `.eq('fulfillment_method', '<supplier>')` (or `.eq('fulfilled_by',
   '<supplier>')` for any `shop_orders` update), in addition to matching on the supplier's own
   reference/order-id and `status IN (pending, processing)`. Without this, a late/delayed
   delivery event from a supplier an order has since been retried away from can still match by
   reference alone and overwrite the order's real status. **Watch for the SELECT-then-UPDATE
   split** some of these routes use (fetch candidate rows filtered by `fulfillment_method`, then
   UPDATE by id only) — filtering only in the SELECT is not enough: `claimFallbackDispatch()`
   (item 6) can reassign `fulfillment_method` to a different supplier in the window between that
   SELECT and the UPDATE while `status` stays unchanged, so the UPDATE needs its OWN repeated
   `fulfillment_method` filter too. This exact gap was found post-merge in HendyLinks's cron
   sweep and admin sync routes (2026-08-20) even though its webhook route had the guard from the
   start — mirror `lib/agentportal-apply-outcome.ts` or `app/api/webhooks/hendylinks/route.ts`
   for the correct combined-guard shape.
6. **If the new supplier can be dispatched to as a FALLBACK target** (another supplier's
   rejection routes to it, or it can fall back to another supplier): call
   `claimFallbackDispatch()` (defined once per file, in both `lib/fulfillment-trigger.ts` and
   `lib/refulfillment-service.ts`) immediately before the actual dispatch call, and skip
   dispatching entirely if it returns `false`. The primary dispatch already stamps
   `fulfillment_method` atomically before calling the supplier (see the claim-time comment in
   `fulfillment-trigger.ts`); a fallback dispatch previously did NOT, leaving a window where the
   fallback supplier's own (correctly-guarded, per item 5) webhook would find zero matching rows
   and strand the order — `claimFallbackDispatch` closes that window and doubles as a
   double-dispatch guard (0 rows matched = something else already resolved the order, so don't
   dispatch a second supplier against it).
   **Also go back and check every EXISTING fallback block that could now dispatch INTO this new
   supplier** (in both `lib/fulfillment-trigger.ts` and `lib/refulfillment-service.ts`) — if the
   new supplier is one that sets `ambiguous: true` (item 7), each of those existing blocks' bulk
   `fallbackSettled.forEach(...)` handlers must propagate `ambiguous` forward when the fallback
   dispatch itself fails-but-ambiguous, not only overwrite the result on success. A `forEach`
   that early-returns on `!settled.value.success` silently keeps the ORIGINAL supplier's
   definite-failure result, which then gets reverted-to-pending and re-dispatched by the next
   cron run — a real double-charge if the fallback (now possibly HendyLinks) had actually
   accepted the order. This bug is dormant (unreachable) until an admin actually configures the
   new supplier as another supplier's fallback target, which is exactly why it survived
   undetected through HendyLinks's original merge — found in a post-merge security review, not
   in `tsc`/lint (both pass either way).
7. **If the supplier has no client-supplied idempotency key on order placement** (HendyLinks is
   the first: a dropped connection mid-request means you cannot tell whether the supplier
   received/charged it), its `fulfillOrder`/bulk dispatch functions should set `ambiguous: true`
   on that specific failure mode (network exception on the placement call, not a definite
   HTTP/business rejection) rather than a plain `success: false`. Every failure-revert branch in
   `lib/fulfillment-trigger.ts` and step 11 of `lib/refulfillment-service.ts` already checks for
   `ambiguous` and leaves that order in `processing` (alerting for manual reconciliation)
   instead of reverting it to `pending` and letting the next cron run re-dispatch — silently
   paying and delivering it twice. `lib/agentportal-service.ts` and `lib/hendylinks-service.ts`
   are the two suppliers that set this flag today; only wire it if genuinely applicable (a
   supplier WITH an idempotency key on placement doesn't need it). See item 6's second
   paragraph for the propagation trap this creates in OTHER suppliers' fallback blocks.
8. **`lib/order-supplier.ts`**: add the supplier to `SupplierTag`, `KNOWN_SUPPLIERS`,
   `KNOWN_FULFILLMENT_METHODS`, `SUPPLIER_META` (label + badge color), and `SUPPLIER_FILTERS` —
   this is what the Admin Fulfillment Center reads to display/filter by supplier.
9. **Classify EVERY business-rejection HTTP status before launch, and never guess them from a
   spec.** Two separate live bugs on HendyLinks' first production day (2026-08-20) both came
   from one missing status code, `403` ("Recipient phone number is not a verified beneficiary"):
   - It was missing from `isBusinessRejection`, so every unverified recipient counted as an
     *instability* failure. Five in a row **opened the circuit breaker** and fast-failed every
     other order for that supplier — a routine per-order rejection escalated into a
     supplier-wide self-inflicted outage (observed live: `[HendyLinks] Circuit breaker OPENED`).
   - It was missing from `isFallbackWorthyRejection`, so the MTN fallback never fired for the
     single most common case it exists for.
   Rule: an "unverified/unregistered/not-allowlisted recipient" rejection is ALWAYS (a) a
   business rejection that must not trip the breaker, and (b) fallback-worthy. Every supplier
   has one; find its real code from a live rejection before enabling the supplier, and don't
   trust the integration spec — HendyLinks' spec listed only five codes and 403 was not
   among them. Write the live response body into the test file as a regression case.
10. **A supplier's own duplicate/idempotency rejection is NOT a retryable failure — it is proof
   the order was already submitted, and possibly already delivered and charged.** DataKazina
   returns `HTTP 422 {"errors":{"incoming_api_ref":[...]}}` when we resubmit an order id it
   already holds (it must be the plain order UUID — see `lib/datakazina-request.ts` for why
   `dispatchKey` deliberately isn't used). Treating that as an ordinary failure did two bad
   things at once: it called `recordFailure()` (so the repeating rejection opened the breaker
   for ALL orders of that supplier — the "Service temporarily unavailable" storms in
   `mtn_fulfillment_tracking` are this), and it reverted the order to `pending`, so the cron
   re-dispatched it forever AND left it eligible for the fallback engine to route to a
   different supplier that knows nothing about the first supplier's reference — delivering it
   twice. Classify it as `ambiguous: true` instead (the existing contract), attach NO
   rejection marker a fallback classifier reads, and skip `recordFailure()`. Found live
   2026-08-20 with 16 real orders in this state; the supplier's own duplicate guard was the
   only thing preventing the second delivery.
11. **When you make a NEW supplier able to set `ambiguous`, re-audit every fallback block that
   can dispatch INTO it** — see item 6. This bit twice: the HendyLinks bulk fallback block in
   `lib/refulfillment-service.ts` correctly omitted the `ambiguous` branch while HendyLinks was
   the only flag-setter (it cannot fall back to itself), and became silently wrong the moment
   DataKazina started setting the flag, because `datakazina` is a selectable
   `mtn_hendylinks_fallback` target. Grep for `fallbackSettled.forEach` and confirm every one
   has an `else if ((fb as any).ambiguous)` branch. Also grep for comments claiming
   "`ambiguous` is set ONLY by <supplier>" and fix them — they actively mislead the next change.
12. **Capture the supplier's failure REASON, not just its status.** HendyLinks' webhook carries
   `order.message` explaining why an order failed; the original route read only `order.id` and
   `order.status` and discarded it, so a failed order appeared in the admin panel with a blank
   `error_message` and the only way to learn the reason was to open the supplier's own
   dashboard. Persist it (sanitized/bounded via `lib/sanitize-for-storage.ts`) on `failed`, and
   clear it on `completed` so a stale reason can't linger on an order that later succeeded.
13. **If the supplier dedupes on a reference WE choose, that reference must vary per deliberate
   retry — but NOT per cron re-dispatch.** DataKazina permanently records the `incoming_api_ref`
   we send and rejects any resubmission with HTTP 422, *even when their own earlier attempt
   failed*. Since the reference was the bare order id, an admin retry of a failed order
   resubmitted the identical value and was rejected forever (16 real orders stuck this way,
   2026-08-20). The fix is `buildIncomingApiRef(orderId, attemptNo)` →
   `<uuid>-r<attemptNo>`, keyed on **`orders.retry_count`**. That specific column is what makes
   it safe, and the reason is worth internalising: `retry_count` is written ONLY by the
   `claim_order_retry` RPC (verify with a repo-wide grep — every other `retry_count` write
   targets `mtn_fulfillment_tracking`, a different table). So the re-fulfillment cron, which
   re-dispatches a still-pending order every couple of minutes and never touches it, keeps
   sending the SAME reference and stays blocked by the supplier's duplicate guard — while a
   deliberate retry gets a fresh one. **Never key such a suffix on a timestamp, a random value,
   or an attempt counter the cron can advance**, or the cron will mint a brand-new paid supplier
   order on every pass. Keep the order id as a whole, dash-delimited prefix so the webhook can
   still recover it, and default `attemptNo` to 0 so every existing order keeps its exact
   current reference.
14. **Store EVERY identifier the supplier might quote back, not just one.** DataKazina's webhook
   may cite either their own order code (`ORDER-1066677` / `BULK-…`) or the `incoming_api_ref`
   we sent, and we cannot control which — so `orders.dakazina_reference` now holds exactly what
   we sent and `orders.dakazina_order_code` holds theirs, with the webhook matching on the order
   id, our reference, **or** their code. Index any column a webhook joins on (partial index,
   `WHERE col IS NOT NULL`). Related trap found the same day: the webhook's id-recovery helper
   required ≥35 hex characters while all 1,893 stored references were exactly 32 — so that
   entire matching path had **never once executed in production** and nobody noticed, because a
   second path silently covered for it. When a matcher has multiple legs, verify each leg
   actually fires against real stored data instead of assuming the aggregate result proves it.
15. **A webhook route that fails closed on a missing secret is invisible when the secret is
   never set.** `/api/webhooks/dakazina` returns `503` before any matching logic when
   `DAKAZINA_WEBHOOK_SECRET` is unset — and it had never been set, so *every* DataKazina
   delivery had been rejected and the admin had been completing those orders by hand without
   realising why. When a supplier offers no signing secret and their webhook config is
   URL-only, **generate the secret yourself** and register it in the URL
   (`?secret=…`, or HTTP Basic userinfo `https://x:<secret>@host/…`, which keeps it out of
   access logs) — never weaken the fail-closed check, since without it any unauthenticated POST
   could mark orders completed without payment. Document the variable in `.env.example` when
   the route is written, not later.
16. **Verify every response field name against the LIVE endpoint, and seed a verbatim row into
   the tests.** HendyLinks' history rows carry `recipient_msisdn`; the design spec said
   `recipient_phone`, so `matchesRecentOrder` compared `undefined` on every row and **the whole
   post-transport-failure reconciliation path had never matched anything since the day it was
   written** — the very safety net that exists because HendyLinks has no idempotency key. It
   was invisible because the fixture used the same wrong name, so 60 assertions passed while
   the real predicate could only ever return false. Two rules: (a) probe the endpoint and paste
   a **verbatim** row into the test file as a regression case — a fixture written from the same
   spec as the code proves nothing; (b) read the field through a tiny accessor that also
   tolerates the old name, so a rename on their side degrades instead of silently dying.
17. **Parse supplier timestamps as UTC explicitly — never `new Date(theirString)`.** Their
   `created_at` is `"2026-08-20 20:23:45"` with NO timezone, and a bare `new Date()` resolves
   that against the *process* timezone. Under `TZ=America/New_York` the same string parses four
   hours later, which trivially satisfies a freshness window and silently turns a 5-minute
   reconciliation window into an unbounded one — that window is the only thing stopping an
   unrelated older order being adopted along with its supplier order id, so this is a
   wrong-adoption/double-charge risk, not a cosmetic one. It was masked purely by Vercel
   defaulting to `TZ=UTC` and Ghana being UTC+0; nothing in the repo pins `TZ`. Use
   `parseHendyLinksTimestamp`-style parsing (append `Z` when no zone is present, honour an
   explicit one) and assert exact UTC equality in tests so they fail under any `TZ`.
18. **Write the supplier's order id to the DB IMMEDIATELY after dispatch, never at the end of a
   bulk run.** A supplier webhook can outrun your own write. Measured live 2026-08-20:
   HendyLinks' webhook for order 1633587 arrived at 20:15:17 and found no row because the bulk
   path only persisted `hendylinks_order_id` at step 12b — 20:16:01, a **44-second window** —
   and the route then acked 200, discarding the outcome permanently and stranding the order in
   `processing`. The single-order path never had this bug because it writes the id straight
   after dispatch, which is exactly why manual fulfilments worked while bulk runs stranded
   orders. Add an early, idempotent, `status='processing'`-guarded write right after the
   dispatch resolves; the later bookkeeping write can stay. Also make the webhook's
   "no order found" branch distinguish a **race** from a **stray** using the event's own
   timestamp — redeliver (500) if the event is recent, ack only if it is old — otherwise the
   race silently eats outcomes with nothing in the logs to explain it.
19. **Paginate any supplier history sweep, and drive it off their `total`.** A single-page
   fetch stops covering the history the moment it grows past the page size, and a stuck order
   is by definition an OLD one — precisely the row that drops off first. Treat a short page as
   the authoritative stop signal (`total` can drift while you walk), cap the page count so a
   bad `total` cannot spin an unbounded request loop, and de-dupe by id since offset paging
   repeats rows when new orders land mid-walk. Extract the stop condition into a pure function
   so it is testable — the surrounding loop is untestable I/O.
20. **NEVER write raw supplier text into `orders.error_message` — that column is CUSTOMER-FACING.**
   `components/dashboard/RecentOrdersWidget.tsx` selects it and renders it to the buyer under a
   red **"Failure Reason"** heading. A supplier string like `"API request failed"`, or anything
   naming a supplier or their upstream provider, must never reach it — customers should never
   learn which wholesaler we route through, and raw supplier text is meaningless to them anyway.
   Supplier reasons belong in **`mtn_fulfillment_tracking.api_response`**, which is internal and
   is what the Admin Fulfillment Center reads. This was very nearly shipped on 2026-08-20: the
   HendyLinks webhook and both sweeps were written to persist their `message` into
   `error_message` "so the reason shows in admin" — it would have shown it to every affected
   customer instead. Before persisting ANY supplier-controlled string, grep the column name
   across `components/` and `app/` (not just `app/admin/`) and confirm no customer surface
   selects it.
21. **Every `mtn-<supplier>-fallback.ts` module's exported `FallbackSupplier`-style type** should
   be derived as `Exclude<AnySupplier, '<supplier>'>` from the shared `AnySupplier` union in
   `lib/mtn-fallback-dispatch.ts` — never a hand-listed string union. `lib/mtn-agentportal-fallback.ts`
   and `lib/mtn-bundleportal-fallback.ts` already do this correctly (adding the new supplier to
   `AnySupplier` alone keeps them in sync); `lib/mtn-codecraft-fallback.ts` originally hand-listed
   its union and silently fell out of sync when HendyLinks was added (the RUNTIME
   `VALID_FALLBACK_SUPPLIERS` set was updated, so nothing broke, but the static type was wrong) —
   fixed 2026-08-20, now also derived via `Exclude`.
22. **Add the admin UI toggle row, in the same PR, not as a follow-up.** The AT-iShare Console
   build (2026-08-21) wired the full data path — registry entry, dispatch columns, cron sweep —
   and nearly shipped without a rendered toggle row on `app/admin/ishare/page.tsx`/
   `app/admin/fulfillment/page.tsx`. A supplier with no toggle a human can flip cannot be turned
   on at all, and this is invisible to every automated gate: `tsc --noEmit`, `next lint`, and the
   full test suite all pass with a missing UI row, because none of them render a page. Treat "can
   an admin actually enable this supplier by clicking something" as its own checklist line, not
   an assumption that follows from the data plumbing being correct.
23. **A route and its admin-triggered/cron twin must gate side effects IDENTICALLY.** Wherever a
   status-resolving UPDATE can be reached two ways — an admin-triggered sync
   (`app/api/admin/fulfillment/sync-<supplier>/route.ts`) and a scheduled cron sweep
   (`app/api/cron/sync-<supplier>-status/route.ts`) — both must `.select()` the UPDATE and check
   rows-actually-affected BEFORE firing any side effect keyed to "this order just resolved":
   tracking-table inserts, `shop_orders` sync, push notifications, counters. Skip the check in
   either twin and a losing race (the other twin, or a webhook, resolves the order first) still
   fires the side effect a second time — a customer gets a second "your order is complete" push
   for one delivery. The AT-iShare Console build shipped this guard correctly in the cron sweep
   and initially omitted it in the admin sync twin; the two routes are separate files with
   separate UPDATE statements, so having it in one is no evidence it's in the other — diff them
   against each other, not just against the checklist.
24. **Never `return` from a dispatch branch after the order has been atomically claimed.** The
   claim step (see item 6's reference to the claim-time comment in `fulfillment-trigger.ts`)
   flips the order to `processing` BEFORE the supplier call happens, specifically so a crash
   mid-dispatch is recoverable. A bare `return` inside that branch — for an unhandled status, an
   unexpected shape, a "this shouldn't happen" guard — exits the function without reverting
   `status` and without alerting, so the order sits in `processing` forever with nothing watching
   it: no cron picks it up (it isn't `pending`), no alert fired, no tracking row explains why.
   `throw` instead, every time, so the branch's own enclosing `catch` reverts it to `pending` and
   sends the alert exactly like every other failure path does. This applies to every dispatch
   branch across every supplier, not just AT-iShare Console — it surfaced while wiring this
   supplier's branch into `lib/fulfillment-trigger.ts`/`lib/refulfillment-service.ts`.
25. **Before writing a CHECK-constraint-widening migration, verify the value list against the
   LIVE constraint, not against what you assume it says**: `SELECT pg_get_constraintdef(oid)
   FROM pg_constraint WHERE conname = 'orders_fulfillment_method_check'`. A migration drafted
   from memory or from an older migration file can add an extra value the author intended but
   the constraint never actually had, silently loosening a production guard beyond what item 1
   intends — the constraint is supposed to be an exhaustive allowlist of real suppliers, and a
   stray extra value defeats that. Run the query, diff its output against the list you're about
   to write, and only then draft the `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT`.

## Gotchas

- DataKazina uses numeric package IDs, not volume strings. Always resolve `volume → packageId` via `fetchAllBundleMappings()` before calling the API.
- The `isRateLimited` flag in FulfillmentResponse is distinct from circuit open state. Handle both.
- XPress and Moolre webhooks have their own signature verification in `/api/webhooks/xpress` and `/api/webhooks/sms-forward`. Don't mix them up with Paystack's HMAC.
- Results checker vouchers are codes returned from the provider — store in `orders.metadata`, not a separate table.
- Bundle Portal (`lib/bundleportal-service.ts`) moved to v2 and uses a signed inbound webhook (`app/api/webhooks/bundleportal/route.ts`, HMAC-SHA256 verified via `lib/bundleportal-webhook.ts`) for delivery status — the old `check_status` polling action now always returns `410 polling_disabled` and was removed, along with its cron/admin-sync-button safety net. **Confirmed live 2026-09-28: real MTN orders can land in Bundle Portal's undocumented "held for review" state with NO webhook event for it (only `order.completed/failed/cancelled/refunded` exist) and no way to poll** (`check_status` 410s even for a held sandbox order) — this stranded ~95 real orders in `processing` between 15:13–18:35 UTC that day, unrelated to and not fixed by the base-URL bug found the same day. `lib/bundleportal-stale-alert.ts` (cron: `/api/cron/alert-bundleportal-stuck`, 60 min threshold — mirrors `lib/agentportal-reconcile.ts`'s `STUCK_THRESHOLD_MINS`) is a pure ALERT (not a resolver, since there is nothing left to poll or resolve programmatically) that raises one digest admin alert per stuck-order-set so a human can check Bundle Portal's own dashboard. Its `verify_number` pre-flight check exists in the API but is deliberately NOT wired in yet (deferred) — see `docs/reference/bundleportal-developer-api.md` and `docs/superpowers/specs/2026-09-28-bundleportal-v2-webhook-migration-design.md` for the full API surface and the reasoning for deferring it.
- `lib/mtn-bundleportal-fallback.ts` mirrors `lib/mtn-codecraft-fallback.ts`/`lib/mtn-agentportal-fallback.ts` — it retries an MTN order on another supplier when Bundle Portal rejects it with `code: 'not_allowlisted'`. `lib/shop-order-processor.ts` deliberately has no fallback wiring for ANY supplier (pre-existing asymmetry) — only `lib/fulfillment-trigger.ts` and `lib/refulfillment-service.ts` implement fallback.
- HendyLinks (`lib/hendylinks-service.ts`) has no client-supplied idempotency key on `POST /api/orders` — unlike every other supplier, `fulfillOrder` does NOT retry on transport failure; it instead scans `GET /api/orders` for a matching recent order before giving up (see checklist item 7 above for the `ambiguous` handling this requires downstream). A transport failure that can't be reconciled this way carries a genuine (logged, flagged) duplicate-charge risk on the next retry — this is a known, accepted limitation of their API, not a bug. `lib/mtn-hendylinks-fallback.ts` mirrors the other MTN fallback modules but triggers only on HTTP 404 ("plan not found") — HTTP 402 (insufficient balance) is deliberately excluded per a user decision; that case is left `pending` for an admin top-up + cron retry instead. HendyLinks' AT-iShare/AT-BigTime split doesn't exist on their side (both send as `network: "AirtelTigo"`) — `isValidAtSizeForNetwork` in the service file enforces the size ranges (iShare 1-15GB, BigTime 25-50GB) that keep them from being silently confused. See `docs/superpowers/specs/2026-08-19-hendylinks-supplier-design.md` for the full design, including unresolved pre-launch verification items (404-vs-400 ambiguity for an unsold size, exact `GET /api/orders`/`GET /api/balance` response shapes, and whether a failed order auto-reverses the wallet charge).
- Stale supplier data (`fulfillment_method` + reference columns left stamped after a failed dispatch) was a real, multi-supplier bug fixed 2026-08-20 across GhData/Xpress/Dakazina's webhooks, `lib/fulfillment-trigger.ts`, `lib/refulfillment-service.ts`, and `claim_order_retry` — see the "Adding a new supplier" checklist above; every item in it exists because skipping it caused this exact bug at least twice (Bundle Portal, HendyLinks). HendyLinks' own webhook (`app/api/webhooks/hendylinks/route.ts`), its cron sweep (`app/api/cron/sync-hendylinks-status/route.ts`), and its admin sync (`app/api/admin/fulfillment/sync-hendylinks/route.ts`) all guard on `fulfillment_method='hendylinks'` on their final UPDATE (not just their initial SELECT), and both fallback-dispatch files route the HendyLinks-404 fallback through `claimFallbackDispatch()` — all wired in as part of merging this supplier onto the post-2026-08-20-fix `main`, not present in the original feature-branch commits (the cron/admin-sync guards and the CodeCraft/AgentPortal/BundlePortal fallback blocks' `ambiguous` propagation, item 6, were found by a post-merge security review, not caught by the merge itself).
- **Two known, NOT-yet-fixed gaps found during the HendyLinks security review (2026-08-20), deliberately left as follow-ups rather than fixed inline** (both pre-exist HendyLinks and are not specific to it — fixing them touches other suppliers' established behavior, so they need their own reviewed change):
  1. `lib/shop-order-processor.ts`'s failure/exception revert paths (search for `status: 'pending'` near the end of the file) only reset `status`, never `fulfillment_method` or any reference column, unlike the equivalent revert blocks in `lib/fulfillment-trigger.ts`/`lib/refulfillment-service.ts`. Not currently exploitable for HendyLinks specifically (the webhook's own `fulfillment_method` guard still protects it), but it's the same class of stale-reference bug this whole checklist exists to prevent, just in the one file the checklist doesn't cover.
  2. When `fulfillOrdersConcurrent`/`fulfillOrdersBulk` itself throws (not a per-order failure — the whole bulk call rejecting), `lib/refulfillment-service.ts`'s `makeFailResults()` marks every order in that bucket as a definite failure, never `ambiguous`, even for AgentPortal/HendyLinks (the two suppliers with no idempotency key). Narrow — the per-order network/business failures these two services see are already caught and flagged `ambiguous` internally, so this only matters if the bulk function crashes before finishing its own per-order handling — but real if it happens.
- **Naming trap: `lib/at-ishare-service.ts` is NOT this supplier.** That file is the CodeCraft
  integration that happens to fulfil AT-iShare-*network* orders — it predates this build. The
  AT-iShare Console (vendor SPFastIT) lives in `lib/atishare-console-service.ts`, supplier tag
  `atishare_console`. The names are one dash and four letters apart and both fulfil the same
  network, which is exactly what makes them easy to confuse — grepping `at-ishare` instead of
  `atishare_console` (or vice versa) when tracing a dispatch bug silently lands you in the wrong
  file, and wiring a fix or a new reference column into the wrong service misroutes orders
  rather than erroring loudly. Always match on the full tag string, `atishare_console`, never
  a substring.
- **AT-iShare Console needs no `ambiguous` handling — do not add it by analogy with HendyLinks/
  AgentPortal.** Those two set `ambiguous: true` because they have no client-supplied
  idempotency key on order placement, so a dropped connection is genuinely unrecoverable without
  scanning order history. The Console's `client_reference` (`lib/atishare-console-service.ts`,
  `buildClientReference`) is exactly that missing key: replaying the identical request after a
  transport failure returns the existing transaction (`duplicate: true`) instead of creating a
  second one, so recovery is deterministic and a plain `success: false` on transport fault is
  correct as-is. Item 7 of the checklist above explicitly says only wire `ambiguous` "if
  genuinely applicable" — this is the case where it is not.
- **AT-iShare Console's balance is denominated in DATA (MB/GB), not currency.** Its
  `check_balance.php` response maps to `atishare_console_wallet_mb` / `_reserved_mb` /
  `_available_mb` in `app/api/admin/fulfillment/balance/route.ts`, and is deliberately kept OUT
  of that route's all-suppliers `{ balance, currency }` aggregate — every other supplier's
  balance is cash, and feeding MB through the currency shape would render as, e.g., "GHS 95"
  when the real meaning is 95 GB. `available_mb` (not `wallet_mb`) is the figure to surface,
  since queued and processing orders reserve part of the wallet that `wallet_mb` still counts.
- **AT-iShare Console is deliberately absent from `AnySupplier`** (`lib/mtn-fallback-dispatch.ts`)
  and from every MTN fallback module (`lib/mtn-*-fallback.ts`). It serves AT-iShare only and can
  never fulfil an MTN order, so unlike checklist item 21 it does NOT get a
  `Exclude<AnySupplier, ...>` treatment anywhere — it was never added to the union in the first
  place. Don't "complete" the pattern by adding it; that would make it selectable as an MTN
  fallback target it cannot actually serve.
- **AT-iShare Console's reads deliberately stay outside its circuit breaker — only `sendBundle`
  participates.** `checkOrderStatus` and `fetchConsoleBalance` neither gate on nor record into
  `circuitState` in `lib/atishare-console-service.ts`; this used to differ from
  `lib/bundleportal-service.ts`, whose now-deleted `checkOrderStatus` gated on and recorded into
  its own breaker — Bundle Portal's status-check action was removed entirely in its v2 webhook
  migration (`app/api/webhooks/bundleportal/route.ts` replaces it), so there is no longer a
  status-read code path on that supplier to compare against. The reasoning below is written as
  a comment directly above the breaker in the service file: gating reads on the breaker would
  block reconciliation of already-dispatched orders during exactly the outage when their fate
  matters most, and letting read failures open the breaker would fast-fail `sendBundle` (halting
  new dispatches) over a flaky read endpoint — the same self-inflicted-outage shape HendyLinks'
  misclassified 403 caused, just reached through the read path instead of a status code.
- **Manual-send references must be unique per send, never content-derived.** The free-form
  gift/testing tool behind `POST /api/admin/atishare-console/send` builds each `client_reference`
  as `MANUAL-<uuid>`, not from the phone number, bundle size, or admin id. Because a replayed
  `client_reference` returns the *existing* transaction rather than erroring (the same recovery
  semantics that make `ambiguous` unnecessary above), a content-derived key would make a second,
  genuinely-intended gift to the same number/size silently return the first transaction and
  report success while sending nothing. Duplicate-click protection is instead a 60-second
  recency check against `atishare_console_manual_sends`, not the reference itself.
- **Historical note (superseded):** the developer API's data-purchase handler
  used to have its own private dispatch logic (`app/api/v1/data/purchase/route.ts`,
  before the v1→v2 port) that predated the HendyLinks/AT-iShare-Console
  suppliers and silently fell through to the wrong one. That was fixed during
  the v1→v2 port — `lib/api-handlers/data-purchase.ts` (the shared handler
  behind `/api/v2/data/purchase`, and formerly `/api/v1` too before it was
  removed) now calls `lib/fulfillment-trigger.ts` directly, the same
  canonical, full-registry dispatch function the web purchase route uses. See
  `kingflexy-developer-api` for the current developer-API handler layout.
