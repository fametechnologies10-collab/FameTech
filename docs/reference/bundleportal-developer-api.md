# Bundle Portal — Developer API (v2)

Source: user-provided, updated 2026-09-28 (supersedes the 2026-08-16 v1 snapshot). Place MTN, Telecel, and AirtelTigo (AT-iShare) data-bundle orders.

One endpoint takes every request. JSON body with an `action` field decides what happens. Authenticated via `x-api-key` header. Orders are charged against the Bundle Portal wallet.

**Base URL:** `https://api.bundleportal.com/v2` — confirmed 2026-09-28: `/v1` now returns a bare HTTP 404 (not a JSON error) for every action, including ones that used to work under v1 (e.g. `set_webhook`). Production's `BUNDLEPORTAL_API_BASE_URL` was still pointed at `/v1` until this date; updated in both `.env.local` and Vercel (all environments) — see `docs/security-audits/` if a wider impact write-up is ever needed (checked: no live orders were routed through Bundle Portal during the affected window, so this had no customer-facing impact).

## Authentication

```
x-api-key: bp_live_xxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

Keys are created from the Bundle Portal dashboard (Developer / API). Server-side only — never expose in browser/mobile.

## Rate limits

- Requests are rate limited per API key. Reads and order placement have **separate allowances**, both set well above what a correctly written integration needs — no fixed numbers are published (the 2026-08-16 v1 snapshot's specific figures — 18,000 reads/min, 4,500 orders/min — are no longer given by Bundle Portal as of this v2 update and should not be relied on).
- **API v2 has no status polling.** Order results are sent to your webhook the moment an order settles — see the Webhooks section below.
- A `429` carries both a `Retry-After` header and `retry_after` seconds in the JSON body. Wait that long, then back off with jitter.
- Use bounded concurrency, and never retry a spending request without the same `order_id`.
- **Limits may be adjusted without notice — treat the response, not a fixed number, as the source of truth.** Don't hardcode a request budget against the old v1 figures.

## Actions

### `verify_number` (free, no charge, creates nothing)

**⚠️ Not yet confirmed against v2 docs — this section is carried over from the 2026-08-16 v1 snapshot.** User has said the verification docs will be shared separately; re-verify this section before implementing against it.

Run before every order — a previous in-flight order or an unapproved number will otherwise cause `place_order` to be refused.

Request:
```json
{ "action": "verify_number", "network": "mtn", "recipient": "0241234567" }
```

Response:
```json
{
  "success": true,
  "data": {
    "network": "mtn",
    "recipient": "0241234567",
    "allowed": true,
    "can_order": true,
    "allowlist_message": null,
    "pending_order": null
  }
}
```

| Field | Meaning |
|---|---|
| `allowed` | Number is approved for this network |
| `can_order` | Approved AND no earlier order still in flight — only order when `true` |
| `pending_order` | Details of the unfinished order blocking this number, or `null` |

### `get_bundles`

```json
{ "action": "get_bundles", "network": "mtn" }
```

`network` is optional. Omit it for everything. Each bundle carries an `id`, `size`, `size_gb`, `price` and `validity`. Use `size_gb` as the `package_size` when ordering.

```json
{
  "success": true,
  "data": {
    "bundles": [{
      "id": 42, "network": "mtn", "size": "5GB",
      "size_gb": 5, "price": 20.00, "validity": "30 days",
      "pricing_source": "user_override", "has_custom_price": true,
      "has_role_price": false
    }],
    "count": 1
  }
}
```

### `place_order`

```json
{
  "action": "place_order",
  "network": "mtn",
  "recipient": "0241234567",
  "package_size": 5,
  "order_id": "your-own-reference-001"
}
```

| Field | Required | Notes |
|---|---|---|
| `network` | yes | `mtn`, `mtn_2`, `mtn_3`, `telecel`, `airteltigo` (or `ishare`). See MTN options below. |
| `recipient` | yes | 10 digits starting with 0, e.g. `0241234567` |
| `package_size` | yes | Size in GB, matching a bundle from `get_bundles` |
| `order_id` | no (strongly recommended) | Our own reference — letters, numbers, `_`, `-`, up to 80 chars |

**MTN options — v2 change.** MTN is now available on three independent delivery routes, separate catalogues each. Call `get_bundles` with the same `network` value you intend to order on, since sizes and prices can differ per route.

| Value | Use |
|---|---|
| `mtn` | Default. Use this unless you have a reason not to. Existing integrations already send it and need no change. |
| `mtn_2` | Alternative MTN route. Availability can vary by recipient number. |
| `mtn_3` | Alternative MTN route, more limited range of sizes. |

`mtn_1` is accepted as a legacy alias of `mtn` and behaves identically.

**Current integration decision (2026-09-28): we only ever send `network: "mtn"` — `mtn_2`/`mtn_3` are accepted-but-unused for now.** No routing logic exists in this codebase to select between the three MTN routes.

```json
{
  "success": true,
  "message": "Order placed successfully",
  "data": {
    "order_id": "your-own-reference-001",
    "reference": "KT-88213",
    "network": "mtn",
    "recipient": "0241234567",
    "bundle": "5GB",
    "amount": 20.00,
    "status": "processing",
    "new_balance": 180.00
  }
}
```

`status: "cached"` means accepted and queued for manual delivery rather than sent straight to a provider — still a real, paid order.

**Idempotency:** always send `order_id`. Retrying with the same `order_id` after a lost reply returns the original order with `"duplicate": true` — no double charge. Without `order_id`, a retry is a brand-new order.

**One in-flight order per recipient number.** A second order for a number still being delivered is refused with `409 pending_order`. This protects customers from paying twice for the same bundle.

### `check_status` — **REMOVED in v2, returns `410 polling_disabled`**

API v2 does not support status polling. Any call to `check_status` is refused:

```
HTTP 410
{
  "success": false,
  "code": "polling_disabled",
  "message": "Order status is not polled on v2. When an order is delivered or fails we send the result to your webhook."
}
```

When an order is delivered, fails, is cancelled, or refunded, Bundle Portal sends the result to a **registered webhook** instead — see "Webhooks" below. Every order is also visible in the Bundle Portal dashboard.

The status values an order can reach (now delivered via webhook, not `check_status`):

| Status | Meaning |
|---|---|
| `processing` | Sent to the provider, delivery under way. |
| `cached` | Accepted and queued for manual delivery. |
| `completed` | Delivered. |
| `failed` | Not delivered. Any charge is reversed. |

### `check_balance`

```json
{ "action": "check_balance" }
```

```json
{
  "success": true,
  "data": {
    "wallet_balance": 180.00, "currency": "GHS",
    "user": { "name": "Ama Mensah", "email": "ama@example.com" }
  }
}
```

## Webhooks (new in v2 — required, replaces polling)

Register a URL once; Bundle Portal calls it the moment an order reaches a final state. On v2 this is the ONLY way to learn an order's outcome — there is no status polling.

### Registering

```json
{ "action": "set_webhook", "webhook_url": "https://your-server.example/bundleportal/orders" }
```

```json
{
  "success": true,
  "data": {
    "webhook_url": "https://your-server.example/bundleportal/orders",
    "webhook_secret": "whsec_4f1c...",
    "events": ["order.completed", "order.failed", "order.cancelled", "order.refunded"]
  }
}
```

- The secret is shown **once** at registration and cannot be read back. Store it immediately (env var, not DB).
- Call `set_webhook` again to **rotate** the secret (invalidates the old one).
- `delete_webhook` stops delivery.
- `get_webhook` returns the registered URL but never the secret.
- The URL must be `https` and resolve to a public host.

### Delivery

Bundle Portal POSTs this body on every terminal event:

```json
{
  "event": "order.completed",
  "order_id": "your-own-reference-001",
  "reference": "KT-88213",
  "status": "completed",
  "network": "mtn",
  "bundle": "5GB",
  "recipient": "0244000000",
  "amount": 24.5,
  "failure_reason": null,
  "settled_at": "2026-08-15T10:22:04.000Z"
}
```

`order_id` is OUR reference — the same `order_id` we sent on `place_order` — so it's the join key back to our `orders` row (`bundleportal_reference` currently stores Bundle Portal's own `reference`, e.g. `KT-88213`; `order_id` is separate and is what we control).

### Verifying signatures (mandatory)

Header: `X-BundlePortal-Signature: sha256=<hex>` — an HMAC-SHA256 of the **raw request body**, keyed with the webhook secret. The endpoint is public, so this signature is the only thing distinguishing a real Bundle Portal call from anyone else's POST.

```js
// Node
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
```

Must use the **raw** (unparsed) body for the HMAC — parsing to JSON and re-serializing before hashing will not match.

### Response contract

Answer `2xx` quickly (5 second delivery timeout, **no retries** on our side — a slow or failing response means that event is lost for good, recoverable only by checking the Bundle Portal dashboard manually). Do any slower side-effect work (push notifications, our own outbound order webhook) after acking, not before.

## Errors

`success: false`, a customer-safe `error`/`message`, usually a branchable `code`.

```json
{
  "success": false,
  "error": "Recipient not approved",
  "code": "not_allowlisted",
  "message": "This number is awaiting approval for MTN."
}
```

| HTTP / identifier | Cause | Fix |
|---|---|---|
| 400 · validation | Missing/invalid action, network, phone, size, reference, product, offer | Correct the named field. Do not retry unchanged input. |
| 400 · provider/product failure | No matching bundle, recipient ineligible, checker unavailable/out of stock, provider rejected | Refresh via list action, confirm eligibility, or show returned message. Not left charged after hard rejection. |
| 401 · authentication | `x-api-key` missing/malformed/revoked/unknown | Use current `bp_live_…` key; regenerate if compromised. |
| 402 · balance changed | Authoritative wallet balance too low at charge time | `check_balance`, top up, retry with same `order_id`. |
| 403 · not_allowlisted | Number not yet approved for network | `verify_number`, retry only after `allowed` is `true`. |
| 403 · channel_locked | Bundle ordering / Developer API channel paused for maintenance | Stop spending requests, retry later; balance/status checks stay safe. |
| 403 · role_locked | Ordering paused for account's API tier | Contact support — retries won't help. |
| 403 · paused / unavailable | Transactions paused or safety limit reached | Show message; for daily limit, wait or contact support. |
| **403 · suspended** *(new in v2)* | API access for this account has been suspended | Contact support. |
| 409 · pending_order | Earlier order for same number still processing/cached | **v2: wait for that order's webhook**; place next order only after terminal state (was: poll with `check_status`). |
| 409 · network_locked | Network temporarily out of stock (`out_of_stock: true`) | Don't switch network labels for the number; wait for stock. |
| **410 · polling_disabled** *(new in v2)* | `check_status` was called | Register a webhook instead — v2 has no status polling. |
| 429 · rate limit | Key exceeded per-minute allowance | Wait `Retry-After`/`retry_after`, back off with jitter. |
| **429 · read_rate_limited** *(new in v2)* | Too many lookup calls (`get_bundles`, `check_balance`, …) on this key; order placement unaffected | Slow down lookups, cache their results. |
| 500 · server error | Unexpected DB/wallet/status lookup failure | Retry reads. Retry purchases only with exact same `order_id`. |
| 503 · order_capacity_busy | Worker at concurrent provider-order ceiling | Wait `Retry-After`, retry with exact same `order_id`. |
| 503 · feature_disabled / unavailable | Result checkers or data sharing switched off | Hide product temporarily, retry list/balance action later. |

**Handling failures:** treat `409` and `429` as retry-later, not permanent. Treat `403 not_allowlisted` as "pending approval" — tell the customer, don't show a generic failure. `403 suspended` and `410 polling_disabled` are both new in v2 and need explicit handling — see design notes in `docs/superpowers/specs/` for how this codebase classifies them.
