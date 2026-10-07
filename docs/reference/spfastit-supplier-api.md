# SPFastIT Supplier API — Developer Reference (full account, not the Console)

**Source:** supplier-provided integration docs, pasted into chat by the platform owner, captured 2026-09-25.
**Base URL:** `https://spfastit.com/wp-json/custom-api/v1`
**Network coverage (per these docs):** `mtn`, `telecel`. No `at-ishare` / `at-bigtime` values are documented.
**Transport:** `POST` with a **JSON** body (unlike the Console, which is form-encoded).

> ⚠️ **This is NOT `lib/atishare-console-service.ts`** (`docs/reference/atishare-console-spfastit-api.md`).
> That is a *different SPFastIT product* — the "Console" — reachable at `console.spfastit.com/api`,
> AT-iShare-only, MB-denominated, form-encoded, no webhooks. This document describes SPFastIT's
> other product: a full reseller/wallet account reachable at `spfastit.com/wp-json/custom-api/v1`,
> JSON-encoded, cash-denominated (₵), covering MTN + Telecel, with webhook support. Same vendor,
> two unrelated integrations. Keep the naming, env vars, and service files completely separate —
> do not let a future edit "consolidate" these into one file by analogy.

---

## Authentication

Every request is `POST` with `api_key` inside the **JSON** request body (not a header, not a
query param, not form-encoded like the Console).

---

## Endpoint 1 — Check Wallet Balance

`POST https://spfastit.com/wp-json/custom-api/v1/balance`

### Request body
```json
{ "api_key": "YOUR_API_KEY" }
```

### Success response
```json
{
    "status": "success",
    "message": "Balance retrieved.",
    "balance": 948.21,
    "currency": "₵",
    "formatted": "₵948.21"
}
```

Balance is real currency (Ghana cedis), unlike the Console's MB wallet — this can likely feed the
existing all-suppliers `{ balance, currency }` aggregate in
`app/api/admin/fulfillment/balance/route.ts` directly, once `currency: "₵"` is normalized to
`"GHS"` for display consistency with every other supplier there.

---

## Endpoint 2 — Place Order (Buy Data)

`POST https://spfastit.com/wp-json/custom-api/v1/place-order`

### Request body
```json
{
    "api_key": "YOUR_API_KEY",
    "phone": "054xxxxxxx",
    "size_mb": 1024,
    "network": "mtn",
    "reference": "YOUR_UNIQUE_ID_123",
    "webhook_url": "https://your-site.com/webhook"
}
```

- `size_mb` must be in MB (e.g. `1024` for 1GB).
- `network` is lowercase: `"mtn"` or `"telecel"` — NOT `"MTN"` / `"Telecel"` like our internal
  network names.
- `webhook_url` is supplied **per request**, not registered once in a vendor dashboard — unlike
  every other supplier in this codebase.

### Supported networks & sizes (MB) — per these docs
| Network | Sizes (MB) |
|---|---|
| `mtn` | 1024, 2048, 3072, 4096, 5120, 6144, 8192, 10240, 15360, 20480, 25600, 30720, 40960, 51200 |
| `telecel` | 10000, 15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000 |

Note: Telecel here only goes down to 10GB — there is no small (1–5GB) Telecel size in this list,
unlike MTN which starts at 1GB. This supplier may only be viable as a **large-bundle** Telecel
source, not a full replacement for existing small-bundle Telecel suppliers, pending price
comparison.

### Success response
```json
{
    "status": "success",
    "message": "Order placed.",
    "order_id": 646856,
    "wallet_balance_before": 948.21,
    "wallet_balance_after": 943.71,
    "order_status": "initiated",
    "size_gb": "1.00 GB"
}
```

Only ONE non-terminal status (`initiated`) and ONE terminal status (`completed`, from the status
endpoint) are shown anywhere in these docs. No failure/rejection status values or error response
shapes are documented at all — a major gap versus the Console docs, which enumerated 7 statuses
including specific failure states (`failed_blocked`, `billed_failure`). This must be discovered
from live testing before launch (see "Open questions" below).

---

## Endpoint 3 — Webhook (push, not a numbered endpoint in the source doc)

If `webhook_url` is provided on Place Order, SPFastIT `POST`s to it when order status changes.

### Payload
```json
{
    "reference": "YOUR_UNIQUE_ID_123",
    "status": "completed",
    "status_label": "Completed",
    "order_id": 646856,
    "phone": "054xxxxxxx",
    "message": "Order updated to status: Completed"
}
```

**No signature, secret, or HMAC scheme is documented anywhere in this spec.** This is a
significant gap relative to every other webhook-based supplier in this repo (HendyLinks signs
with HMAC-SHA256; the DataKazina webhook fails closed on a missing shared secret per
`kingflexy-fulfillment` checklist item 15). An unauthenticated webhook endpoint would let anyone
who guesses/observes a `reference` POST a fake `completed` status. **Do not build the webhook
route without a mitigation** — the established pattern in this codebase for a vendor with no
native signing is to generate our own secret and embed it in the URL we register
(`webhook_url: "https://.../api/webhooks/spfastit?secret=..."`, or HTTP Basic userinfo), never to
accept the payload unauthenticated.

---

## Endpoint 4 — Check Order Status

`POST https://spfastit.com/wp-json/custom-api/v1/status`

### Request body — Option A (by order_id)
```json
{ "api_key": "YOUR_API_KEY", "order_id": 646856 }
```

### Request body — Option B (by reference)
```json
{ "api_key": "YOUR_API_KEY", "reference": "YOUR_UNIQUE_ID_123" }
```

### Success response
```json
{
    "status": "success",
    "order_id": 646856,
    "order_status": "completed",
    "status_label": "Completed",
    "reference": "YOUR_UNIQUE_ID_123",
    "amount": "4.50"
}
```

Supports lookup by our own reference, which is useful for reconciliation — but there is still no
documented list of possible `order_status` failure values, and no documented history/list
endpoint (same gap the Console has — checklist item 19 on paginated sweeps doesn't apply here
since there's nothing to paginate, but recovery-by-scan per checklist item 16 is also unavailable
if a reference is ever lost).

---

## Endpoint 5 — Check My Prices

`POST https://spfastit.com/wp-json/custom-api/v1/prices`

### Request body
```json
{ "api_key": "YOUR_API_KEY" }
```

### Success response
```json
{
    "status": "success",
    "prices": {
        "mtn": [
            { "size_mb": 1024, "size_gb": 1, "price": 4.50 },
            { "size_mb": 2048, "size_gb": 2, "price": 9.00 }
        ],
        "telecel": [
            { "size_mb": 10000, "size_gb": 10, "price": 39.00 }
        ]
    }
}
```

This is the endpoint to call once the API key is set, to see the platform owner's actual reseller
rates before deciding whether/how to enable this supplier for Telecel.

---
---

# ── Integration analysis — OUR notes, NOT from the supplier docs ──

Written 2026-09-25 while reading the pasted docs above, before any code exists for this supplier.
Nothing below is supplier-stated behavior — every "unverified" item must be confirmed against the
live endpoint before this supplier is enabled in production, per `kingflexy-fulfillment` checklist
items 9 and 16 (a spec is not evidence).

## What this API gives us that others don't (relative to existing Telecel suppliers)

- Reseller-specific pricing via a dedicated `/prices` endpoint — none of the other 8 suppliers in
  this codebase expose a live price list this way; pricing is otherwise negotiated out of band.
- Cash-denominated balance (₵) — slots into the existing all-suppliers balance aggregate more
  naturally than the MB-denominated Console.
- Reference-based status lookup (`/status` by `reference`, not just `order_id`) without needing a
  webhook at all — useful as a fallback poll path even if webhooks are wired up.

## What this API lacks, versus the Console and other existing suppliers

1. **No documented idempotency/duplicate-reference behavior on Place Order.** The Console
   explicitly guarantees replaying `client_reference` returns the existing transaction
   (`duplicate: true`). DataKazina explicitly rejects a resubmitted reference with HTTP 422. This
   doc says **nothing** about what happens if `reference` is reused — it could silently create a
   second paid order, silently return the first one, or error. This is the single most important
   thing to test live before writing any dispatch code, since it determines whether this supplier
   needs `ambiguous: true` handling (checklist item 7) at all.
2. **No documented failure/rejection status values.** Only `initiated` and `completed` appear
   anywhere in the docs. Business-rejection codes (invalid/blocked recipient, insufficient
   balance, unsupported size) are completely undocumented — checklist item 9's lesson (HendyLinks
   shipped with a missing 403 that opened its own circuit breaker) applies with extra force here
   since there isn't even a partial enum to start from.
3. **No signing/authentication on the webhook payload** (see Endpoint 3 above) — needs a
   self-generated secret embedded in the registered `webhook_url`, per the DataKazina precedent
   (checklist item 15), before the webhook route can be trusted.
4. **No documented HTTP status codes for errors** — unclear whether errors come back as non-200
   or as HTTP 200 with `status: "error"` in the body (the Console's pattern). Must confirm live;
   until then, do not treat `response.ok` as a usable success signal by default.
5. **No history/list endpoint** — recovery after a lost reference has no fallback scan path,
   unlike HendyLinks' `GET /api/orders` reconciliation scan.
6. **Telecel's smallest size is 10GB.** If the goal is to compete on small/everyday Telecel
   bundles, this supplier can't serve that segment — only worth it for large-bundle Telecel
   demand, pending the `/prices` numbers.

## Open questions to resolve before writing any dispatch code

| # | Question | Why it matters |
|---|---|---|
| 1 | What happens on a repeated `reference` — duplicate order, rejected, or existing order returned? | Determines `ambiguous` handling entirely (checklist item 7/13). |
| 2 | Full set of `order_status` / `status_label` values, especially failure ones | Needed to build `classifyFailure`-style logic without guessing (checklist item 9). |
| 3 | Exact shape of an error response (HTTP code + body) for: invalid API key, insufficient balance, invalid/blocked recipient, unsupported `size_mb` for a network | Same as above — must come from live calls, not this spec. |
| 4 | Does the webhook fire from a stable, allowlistable source (IP or user-agent) as a defense-in-depth alongside our own secret? | Hardens the unsigned-webhook gap. |
| 5 | ~~Actual reseller prices from `/prices` for `telecel` sizes~~ | **Resolved 2026-09-25 — see "Live `/prices` result" below.** |
| 6 | Does `network: "mtn"` ever need enabling too, or is this strictly Telecel-only per the platform owner's stated focus? | **Resolved 2026-09-25:** platform owner wants all networks this supplier actually offers, not just Telecel. Confirmed live: only `mtn` and `telecel` exist — no `at-ishare`/`at-bigtime` key appears in the real response, matching the docs. So "all networks" here means MTN + Telecel, both in scope. |

## Live `/prices` result — verified 2026-09-25

Called `POST /prices` with the platform owner's real API key. Two undocumented things showed up
in the live response that are NOT in the pasted spec (checklist item 16 — verify against live,
never trust the spec alone):

1. **A 100GB tier exists on both networks** (`mtn`: 102400MB/₵394, `telecel`: 100000MB/₵340) —
   absent from the "Supported Networks & Sizes" table in the supplier's own docs above.
2. **Telecel entries carry an undocumented `stock_remaining` field** (e.g. `378`, `500`, `262`);
   MTN entries do not have this field at all. This implies Telecel bundles can genuinely sell out
   supplier-side — a pre-flight/availability check (or at least monitoring) may be needed before
   dispatch, unlike MTN where no such signal exists to check. Confirm with the supplier whether
   `stock_remaining: 0` is possible and what Place Order does in that case (documented `order_status`
   values still don't cover a "sold out" rejection — open question #2 remains unresolved).

### Verbatim live response (own account rates, captured 2026-09-25)

```json
{
  "status": "success",
  "prices": {
    "mtn": [
      { "size_mb": 1024, "size_gb": 1, "price": 4.3 },
      { "size_mb": 2048, "size_gb": 2, "price": 8.5 },
      { "size_mb": 3072, "size_gb": 3, "price": 12.6 },
      { "size_mb": 4096, "size_gb": 4, "price": 16.6 },
      { "size_mb": 5120, "size_gb": 5, "price": 20.4 },
      { "size_mb": 6144, "size_gb": 6, "price": 24.4 },
      { "size_mb": 8192, "size_gb": 8, "price": 32.4 },
      { "size_mb": 10240, "size_gb": 10, "price": 41 },
      { "size_mb": 15360, "size_gb": 15, "price": 62.5 },
      { "size_mb": 20480, "size_gb": 20, "price": 81.5 },
      { "size_mb": 25600, "size_gb": 25, "price": 99.5 },
      { "size_mb": 30720, "size_gb": 30, "price": 122 },
      { "size_mb": 40960, "size_gb": 40, "price": 160 },
      { "size_mb": 51200, "size_gb": 50, "price": 198.5 },
      { "size_mb": 102400, "size_gb": 100, "price": 394 }
    ],
    "telecel": [
      { "size_mb": 10000, "size_gb": 10, "price": 34, "stock_remaining": 378 },
      { "size_mb": 15000, "size_gb": 15, "price": 51, "stock_remaining": 362 },
      { "size_mb": 20000, "size_gb": 20, "price": 68, "stock_remaining": 262 },
      { "size_mb": 25000, "size_gb": 25, "price": 85, "stock_remaining": 476 },
      { "size_mb": 30000, "size_gb": 30, "price": 102, "stock_remaining": 446 },
      { "size_mb": 35000, "size_gb": 35, "price": 119, "stock_remaining": 500 },
      { "size_mb": 40000, "size_gb": 40, "price": 136, "stock_remaining": 481 },
      { "size_mb": 45000, "size_gb": 45, "price": 153, "stock_remaining": 499 },
      { "size_mb": 50000, "size_gb": 50, "price": 170, "stock_remaining": 474 },
      { "size_mb": 100000, "size_gb": 100, "price": 340, "stock_remaining": 491 }
    ]
  }
}
```

No `at-ishare` / `at-bigtime` key is present — this supplier's network coverage is confirmed to be
exactly `mtn` + `telecel`, nothing more, live and documented in agreement.

## Live production findings — verified 2026-09-26 (first real orders)

Three real Telecel orders were placed (10GB×2, 15GB×1). Findings below are from the vendor's
**actual** JSON responses, captured verbatim into `mtn_fulfillment_tracking.api_response` —
not from docs or dashboard wording.

### The real `order_status` value on Place Order is `"not-served"` — not `"initiated"`, not `"Not Served"`

Verbatim Place Order response (order id and phone redacted):
```json
{
  "status": "success",
  "message": "Order placed.",
  "order_id": 881930,
  "order_status": "not-served",
  "price_charged": 34,
  "wallet_balance_before": 49,
  "wallet_balance_after": 15,
  "stock": { "size_mb": 10000, "remaining": 316 }
}
```

This is a THIRD distinct spelling, differing from both the vendor's own docs (`"initiated"`) and
the admin-dashboard wording relayed earlier (`"Not Served"`, space-separated, title case). The
current `mapSpfastitStatus()` in `lib/spfastit-service.ts` does not explicitly match
`"not-served"` — it falls through to the safe default (`return 'processing'`), which happens to
be the *correct* outcome here, but only by luck of the default, not by design. **Action:** add an
explicit `s === 'not-served'` (or `s.replace(/[-\s]/g, '') === 'notserved'` to catch all three
spellings at once) branch so this stops depending on the fallback.

Also newly observed and undocumented anywhere before now:
- **`price_charged`** — the exact amount (in ₵) deducted for this order. Not previously known to
  exist as a response field. Useful for real-cost reconciliation independent of the wallet-delta
  math below.
- **`wallet_balance_before` / `wallet_balance_after`** — confirms `price_charged` exactly
  (`before - after == price_charged` held on all 3 real orders).
- **`stock: { size_mb, remaining }`** — a live per-size stock counter returned on EVERY Place
  Order response, not just `/prices`. `remaining` decremented by exactly 1 across the two 10GB
  orders (316 → 315), confirming this is a real, live-decrementing counter, not a cached/static
  number. Could be used as an additional signal if a pre-flight low-stock check is ever built.

### Real cost was significantly cheaper than the catalog's recorded `cost_price`

| Size | Catalog `cost_price` (stale, prior supplier) | SPFastIT actual `price_charged` |
|---|---|---|
| 10GB | ₵38–39 | **₵34** |
| 15GB | ₵55.50 | **₵51** |

`orders.cost_price_at_time` (and therefore `admin_profit_logs`, via `trg_log_main_profit`) is
under-recording real margin on every SPFastIT-fulfilled order until `data_packages.cost_price`
is updated to reflect these real, cheaper rates for Telecel 10GB/15GB.

### Size validation policy changed 2026-09-27: no local allowlist

`lib/spfastit-service.ts`'s `sizeToMb()` originally only accepted a hardcoded set of
live-verified sizes (10/15/.../100 GB) and returned `null` for anything else, causing our own
dispatch code to fail the order before ever calling SPFastIT. Per an explicit platform-owner
decision, this was changed: **any parseable GB figure now converts and is sent on to SPFastIT**
— whether a size is actually sellable is their call, made via their own business-rejection
response (handled generically as a non-success JSON body — never trips the circuit breaker,
never counted as ambiguous), not something this codebase pre-emptively blocks. Rationale: the
vendor told the platform owner they restore sizes like Telecel 5GB "when stock is available" —
a local allowlist would keep blocking that size on our own side even after they start accepting
it again, with no code change ever prompting anyone to notice. The only validation left is basic
parse sanity (a real, finite, positive GB number) — never a business judgement about which
sizes exist.

### Webhook: never fired

All 3 orders completed via the **admin manual "Sync" button** (`/api/admin/fulfillment/sync-spfastit`
calling `/status` directly), never via `/api/webhooks/spfastit`. Confirmed via Vercel runtime logs
(24h window, both a full-text search and a path-count breakdown): zero requests of any kind —
not a rejected/401 one, not an error — ever reached the webhook route. The webhook URL sent on
Place Order was correctly built and publicly reachable (`kingflexygh.com`, a custom domain
excluded from Vercel's SSO/Deployment Protection), so this points to the vendor's webhook simply
not firing in practice, not a config/reachability problem on our side. **The cron-poll backup
(`/api/cron/sync-spfastit-status`) and the manual Sync button are therefore not just
defense-in-depth — they are, so far, the ONLY mechanism that actually resolves an order.**
Register the cron on cron-job.org before relying on this supplier at any volume; until then every
order requires a manual Sync click.

**Nothing here should be implemented yet.** Per this repo's workflow rules, a new supplier
integration is Tier 2 work — the next step once open questions above are answered is
`superpowers:brainstorming` → `kingflexy-workflow` → `superpowers:writing-plans`, not code.
