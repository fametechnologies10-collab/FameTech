# Storefront audit — 2026-10-12

Scope: the public shop storefront (`app/shop/[shopSlug]`, `app/shop-domain/[shopSlug]`), the guest API routes it
calls, and the Supabase objects those routes touch. Static code review plus read-only checks against the live
project (counts as `anon`; no customer data read).

## Critical (live DB)

| # | Finding | Fix |
|---|---|---|
| C1 | `shop_orders_effective` and `v_shop_profit_credit_reconciliation` were `SECURITY DEFINER` views with full `anon`/`authenticated` grants. The anon key could read every shop order (cost, profit, payer MoMo number/name) and all shop payout rows. Verified: `anon` got rows from both. | `security_invoker = true`, all client grants revoked, `service_role` only. Neither view is used by app code. |
| C2 | `admin_search_users()` is `SECURITY DEFINER` with no admin check and was executable by `anon` — returned every user's email, phone, name, role, wallet balance. Verified as `anon`. | `EXECUTE` revoked from `PUBLIC/anon/authenticated` (both overloads); sole caller `/api/admin/users` uses the service role. |

## High

| # | Finding | Fix |
|---|---|---|
| H1 | `protect_shop_admin_columns` did not guard `pricing_status`/`pricing_*`, `sms_sender_*`, `ussd_active`/`ussd_activated_at`: an owner could self-approve pricing, self-approve any SMS sender ID (spoofing), and activate paid USSD for free by PATCHing their own row. | Trigger extended (admins exempt; service role unaffected). `ussd_code` deliberately left unguarded — `/api/shop/ussd-code` writes it via the owner's RLS client and it is inert without `ussd_active`. Verified with a rolled-back txn as a non-admin owner. |
| H2 | `shop_pricing` was directly writable by the owner (RLS) — bypassing admin pricing review. | `INSERT/UPDATE/DELETE` revoked from `anon/authenticated`; every writer is service-role/RPC. |
| H3 | `guest-subscribe` stored a client-asserted `guestPhone`; order pushes (size, network, recipient number) are keyed on it → anyone could subscribe as a victim's phone. No legitimate client ever sent it. | Field no longer accepted; existing values scrubbed. |

## Medium

- MoMo-prompt / SMS abuse: only `/api/shop/charge` had a dedicated Redis limiter + fail-closed fallback, and nothing capped prompts **per target phone**. Added per-`momoPhone` cap (`checkChargePhoneLimit`) to the four storefront charge routes; new middleware limiters + fail-closed fallbacks for `afa/charge`, `results-checker/charge`, `utility/charge`, `verify-number`; OTP-SMS caps (`number-verification.ts`) moved from per-instance memory to Redis (`lib/guest-ratelimit.ts`, never fail-open).
- Storefront pages spread the whole `shop_profiles` row into a client component (`owner_id`, `owner_email`, approval/pricing status…). Now an explicit allowlist (`lib/storefront-shared.ts → toClientShop`).
- `/api/shop/details` returned owner phone/email for any slug incl. unapproved/inactive shops → contact only for live shops.

## Low / bugs

- Leftmost `x-forwarded-for` (spoofable) used as limiter key on guest routes → `lib/client-ip.ts getGuestIp` (x-real-ip → request.ip → rightmost hop). Also `results-checker/order-status` (returns vouchers) moved to a Redis limiter.
- `push-service` selected `shop_profiles.slug` (column is `shop_slug`) → guest push deep links always fell back to `/`.
- `scriptBlockRegex` substring match rejected "description", "subscription", "Cheap Data: MTN"… → vector-based pattern; test: `scripts/test-validation-text.ts`.
- `/shop/[shopSlug]` never checked `is_active`; utilities gate differed between the two pages (sub-agents wrongly excluded on the primary domain) → shared helpers.
- `lookup-orders`: `?limit=abc` → `LIMIT NULL` (unbounded) → clamped to 1..100.
- `/api/shop/verify`: unvalidated `slug`/`ref` in redirects; `/api/shop/initialize`: Paystack callback origin taken from the Host header → validated / origin allow-listed.
- `utility/charge`: client-supplied `accountName` / `lookupSnapshot` stored verbatim → scrubbed + depth/size bounded.
- `profile`: `logo_url` accepted any https host → must be the owner's own `shop-logos` object.
- DB: trigger functions no longer RPC-executable; server-only tables (`verified_phone_numbers`, `phone_otp_verifications`, `guest_push_subscriptions`, `shop_afa_pending_orders`, `security_events`) lose all client grants; `TRUNCATE/TRIGGER/REFERENCES` revoked from client roles; `shop_announcements.message` length check.

## Accepted / open

- `lookup-orders` still returns a phone number's 48 h order history to anyone who knows the number + shop slug (by design — "track my order" without login). Rate-limited; consider a reference or OTP later.
- `/shop/[shopSlug]` and `/shop-domain/[shopSlug]` return a bare 404 for a shop that is not yet active, so the branded "Under Review" page is effectively unreachable (pre-existing on shop-domain; now consistent on both). Product decision.
- `sendGuestOrderPush` is keyed on a phone that no client supplies any more, so guest order pushes are inert until a verified binding (e.g. a subscribe token issued on the success page) is built.
- Supabase Auth "leaked password protection" is off — dashboard toggle, not code.
- `is_admin()`, `delete_shop_data()`, `get_user_transactions_with_balance()` stay callable by signed-in users on purpose (RLS helper / self-service / own-rows check).
