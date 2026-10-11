# KingFlexyGH Commission Services — Reference

> Written 2026-10-11. **Status: implemented** (branch `feat/kingflexy-commission`).
> KingFlexyGH replaces Hubtel Commission Services for **airtime and utility bills**
> (ECG, Ghana Water, DSTV, GOtv, StarTimes). Hubtel is kept only for legacy
> in-flight rows, SMS and Receive Money. Design: `docs/superpowers/specs/2026-10-11-kingflexy-commission-services-design.md`
> (local-only; its "Amendments" section wins). Old provider doc: [hubtel-commission-services.md](hubtel-commission-services.md).

---

## 1. Provider contract

- Base URL `https://api.kingflexygh.com/api/v2`.
- Auth: raw `Authorization: kf_cs_live_...` header, **no `Bearer` prefix**. A standard
  (non-commission) key is rejected with 403 here, and vice versa.
- Client: `lib/kingflexy-commission-service.ts` (`fetch`, never throws, separate
  circuit breakers for airtime and utilities: 5 failures, 60s recovery).
- Orders debit the **KingFlexyGH main wallet**, so it must be funded.

| Endpoint | Purpose | Rate limit |
|---|---|---|
| `POST /airtime/purchase` `{network, beneficiary_phone, amount, reference}` | Buy airtime; `reference` is our idempotency key (3-100 chars) | 10/min |
| `GET /airtime/orders/{reference}` | Status by the reference we sent | 30/min |
| `GET /utilities/lookup?biller=&account=&phone=` | Verify account before paying. ECG returns `meters[]` (one phone, many meters); others a flat shape. 404 not found, 502 retryable | 10/min |
| `POST /utilities/pay` `{biller, account, amount, reference, phone?}` | Pay a bill. `phone` required for `ecg`/`ghana_water`; for ECG `account` is the chosen `meterNumber` | **6/min** |
| `GET /utilities/orders/{reference}` | Status by **KingFlexyGH's** generated reference; has `commission_earned` (null until completed) | 30/min |

Airtime `fee_amount` is always 0 (face value). The internal 100 GHS per-order airtime
cap is unchanged.

## 2. Status flow

`pending -> processing -> completed | failed | refunded`

`failed` **and** `refunded` are both terminal failure; checking only `failed` silently
misses refunded orders. `refunded` means KingFlexyGH refunded *our* provider balance,
never the customer's wallet.

## 3. Idempotency key (stable, not per-attempt)

Both endpoints replay (never re-charge) on a repeated `reference`, so the key is the
order's `reference_code`, sanitised to `[A-Za-z0-9._-]`, max 64. Retries after
transient errors reuse it; that is the double-send guard, so Hubtel's
`priorAttemptVerdict` is skipped for orders tagged `fulfillment_service = 'kingflexy-commission'`.
Per-attempt keys are deliberately **not** used: a fresh key per retry could buy twice.

After a definitive failure, an admin manual refulfill bumps
`fulfillment_metadata.kf_generation`, giving key `<reference_code>-m<n>` (otherwise the
replay would just return the failed order). The airtime webhook maps `reference` back
by stripping `-m<n>`.

## 4. Utility reference handling

For utilities the key we send is idempotency-only. The response carries KingFlexyGH's own
`UTIL-<BILLER>-<random>` reference; it is stored in `utility_orders.fulfillment_request_id`
at dispatch and used for every status check and for webhook correlation.

## 5. Webhook

`POST /api/webhooks/kingflexy-commission`, registered once per key in the KingFlexyGH
dashboard (no API for it). One URL covers `product: "airtime"` and `"utilities"`.

- `X-KFT-Signature`: HMAC-SHA256 of the **raw body**, keyed with the secret shown once
  when the URL is saved. Verified with `timingSafeEqual` before any DB read; 503 if the
  secret is unset, 401 on a bad signature.
- Delivery: one retry, then no replay. Polling (the cron) is the only fallback.
- Events `order.completed` / `order.failed`; `status` may be `refunded` (both = failure).
- A utility webhook that beats the `fulfillment_request_id` write gets **503** so the
  retry lands later; a lookup error returns **500**. Unknown reference returns 200.
- Already-terminal orders are no-ops (idempotent against the retry).
- All side effects live in `lib/kingflexy-finalize.ts`, shared by webhook, cron and
  manual status sync.

## 6. Reconcile cron

`GET /api/cron/kingflexy-commission-reconcile`, every 5 minutes (cron-job.org), header
`CRON_SECRET` as for other crons. It also owns pending re-dispatch for both products.

| Pass | What | Cap/run |
|---|---|---|
| A | `processing` airtime whose webhook never arrived (status poll) | 10 |
| B | `pending` airtime with attempts left (re-dispatch) | 8 |
| C | `processing` utilities (status poll; a row with no `fulfillment_request_id` after 5 min reverts to `pending`) | 10 |
| D | `pending` **paid** utilities, any provider (re-dispatch) | 5 |
| E | Commission: E1 retry credit RPC where `commission_credited_at` is NULL (20); E2 backfill `commission_earned` on recently completed utilities (5) | 20 / 5 |

Caps respect the purchase 10/min and pay 6/min limits; a 429 reverts the row to `pending`.

## 7. Failure and commission policy

- **Failure:** existing `autoRefundApiOrderOnFailure` refunds `source = 'api'` orders
  (public v2 contract, preserved). Retail/shop orders are only marked `failed`; reversal
  stays the manual admin action (`manualRefundAirtime` / `manualRefundUtility`).
- **Utilities commission:** `commission_earned` -> `commission_amount` -> `credit_utility_commission` RPC.
- **Airtime commission:** KingFlexyGH reports none, so `commission_amount` stays NULL and
  `credit_airtime_commission` no-ops: **partner airtime commission no longer pays.**
- **Legacy Hubtel rows** (untagged, attempts > 0) keep the Hubtel double-send guard and
  are left pending for manual handling rather than risk a double send.

## 8. Environment variables

| Var | Notes |
|---|---|
| `KINGFLEXY_COMMISSION_API_KEY` | `kf_cs_live_...` Commission Services key |
| `KINGFLEXY_COMMISSION_WEBHOOK_SECRET` | Shown once when the webhook URL is saved |
| `CRON_SECRET` | Existing; used by the reconcile cron |

Existing `admin_settings` gates (`utility_bills_enabled`, `*_auto_fulfillment_enabled`,
`hubtel_commission_paused`, min/max amounts, ...) still govern dispatch, unrenamed.

## 9. Deploy order and owner checklist

**Apply `supabase/migrations/20261011_utility_orders_fulfillment_service.sql` BEFORE
deploying** (adds `utility_orders.fulfillment_service`; the new code writes it).

- [ ] Register `https://<your-domain>/api/webhooks/kingflexy-commission` in the KingFlexyGH dashboard; save the one-time secret.
- [ ] Set `KINGFLEXY_COMMISSION_API_KEY` and `KINGFLEXY_COMMISSION_WEBHOOK_SECRET` in Vercel (prod + preview) and `.env.local`.
- [ ] Add the cron-job.org entry: `GET /api/cron/kingflexy-commission-reconcile`, every 5 min, with the `CRON_SECRET` header.
- [ ] Fund the KingFlexyGH main wallet.
