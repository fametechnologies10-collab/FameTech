# Hubtel Commission Services API — Reference

> Saved 2026-06-17 from Hubtel's Commission Services docs (last updated 2026-06-15)
> + live recon (repo mapping + web research). **Status: GREENFIELD — not yet
> implemented in this codebase.** This is the reference for IF/WHEN we add airtime,
> data, and bill-payment **reselling** (we push value OUT and earn commission),
> as opposed to our existing Hubtel USSD integration (which *collects* MoMo from
> customers). See [hubtel-programmable-services-api.md](hubtel-programmable-services-api.md)
> for the collection side.

---

## 1. What this is (and how it differs from what we run today)

| | Existing Hubtel USSD (collection) | Commission Services (this doc) |
|---|---|---|
| Money direction | Customer **pays us** (MoMo collection) | **We push** airtime/data/bills OUT to customers |
| We hold | Nothing pre-funded | A pre-funded **Disbursement Account** (float) |
| We earn | Product margin | A **commission** Hubtel adds, returned per transaction (`Meta.Commission`) |
| Base URL | `gs-callback.hubtel.com`, `api-txnstatus.hubtel.com` | `https://cs.hubtel.com/commissionservices` |
| Auth | Basic (`HUBTEL_API_ID:HUBTEL_API_KEY`) | **Same** Basic-Auth scheme |

It is a **reseller / disbursement** product. We pre-fund a Disbursement Account;
every airtime/data/bill we sell **debits** that float and pays us a commission.

---

## Developer API: airtime is now Commission-Services-key only

As of 2026-09, `/api/v2/airtime/*` requires a `commission`-type developer API
key (previously `standard`). API buyers pay Hubtel's face value with no
markup fee. A share of Hubtel's real per-transaction commission
(`Meta.Commission`) is credited to the buyer's commission wallet
(`/dashboard/commission`) — but only when the buyer is a **lifetime** agent
(`agent_expires_at IS NULL`) or a dealer. A non-lifetime agent, or any other
role, can still purchase airtime fee-free via this key but earns nothing —
the platform keeps 100% of Hubtel's commission in that case. See
`credit_airtime_commission` in `supabase/migrations/20260907e_airtime_commission.sql`
and `docs/superpowers/specs/2026-09-07-airtime-commission-migration-design.md`
for the full design. Shop-sold and dashboard/web self-purchase airtime are
unaffected — they keep the pre-existing role-tiered markup fee.

---

## 2. Base endpoint + Service IDs

```
{BaseUrl}/{Disbursement_Account_Number}/{ServiceID}
e.g.  https://cs.hubtel.com/commissionservices/11691/fdd76c884e614b1c8f669a3207b09a98
```

`{Disbursement_Account_Number}` is issued by Hubtel with the merchant account.
`11691` in the docs is Hubtel's **sample** account — ours will differ.

| ServiceID | Service | Pattern |
|---|---|---|
| `fdd76c884e614b1c8f669a3207b09a98` | MTN Airtime | POST |
| `f4be83ad74c742e185224fdae1304800` | Telecel Airtime | POST |
| `dae2142eb5a14c298eace60240c09e4b` | AirtelTigo Airtime | POST |
| `b230733cd56b4a0fad820e39f66bc27c` | MTN Data | GET query → POST |
| `fa27127ba039455da04a2ac8a1613e00` | Telecel Data | GET query → POST |
| `06abd92da459428496967612463575ca` | AirtelTigo Data | GET query → POST |
| `b9a1aa246ba748f9ba01ca4cdbb3d1d3` | Telecel Broadband | GET query → POST |
| `e6d6bac062b5499cb1ece1ac3d742a84` | ECG Prepaid & Postpaid | GET query → POST |
| `6c1e8a82d2e84feeb8bfd6be2790d71d` | Ghana Water | GET query → POST |
| `297a96656b5846ad8b00d5d41b256ea7` | DSTV | GET query → POST |
| `e6ceac7f3880435cb30b048e9617eb41` | GOtv | GET query → POST |
| `6598652d34ea4112949c93c079c501ce` | StarTimes TV | GET query → POST |
| `a3ab78c84c6b4976b78a6f393e247a72` | Telecel Postpaid Bills | GET query → POST |

> ⚠️ The Ghana Water Service ID above is from the (truncated) public doc; the real
> GUID for **our** account is issued by Hubtel — confirm before coding.

**Auth header (all calls):** `Authorization: Basic base64(ClientId:ClientSecret)`.
This is identical to how `lib/ussd/hubtel-callback.ts` and
`app/api/ussd/status-check/route.ts` already build the header from
`HUBTEL_API_ID:HUBTEL_API_KEY`.

---

## 3. Service flow (fully asynchronous)

1. **(Data/bills) Query first** — `GET .../{ServiceID}?destination={number}` returns
   the live bundle list (data) or account details (name, amount due, meter list).
   Bundles change, so query before **every** top-up.
2. **Initiate** — `POST .../{Disbursement_Account_Number}/{ServiceID}` with
   `Destination`, `Amount`, `CallbackUrl`, `ClientReference`, plus `Extradata.bundle`
   for data/bills. The Disbursement Account is debited here.
3. **Sync response** — `ResponseCode: "0001"` = *“pending, expect callback”*.
4. **Callback** — Hubtel POSTs the final result to our `CallbackUrl`:
   `ResponseCode: "0000"` (success) and `Meta.Commission` = **what we earned**.
5. **Mandatory fallback** — if **no callback within 5 minutes**, we MUST call the
   **Status Check API** to resolve the real outcome. Never treat callback-silence
   as failure. (Same discipline as our existing USSD status-check cron.)

---

## 4. Endpoint shapes by category

All POST bodies share: `Destination`, `Amount` (Float, 2 dp max), `CallbackUrl`,
`ClientReference` (our unique idempotency key). Data/bill POSTs add
`Extradata: { bundle: "<value>" }`. All responses return
`Data: { ClientReference, Amount, TransactionId, Meta: { Commission } }`.

### 4a. Airtime (MTN / Telecel / AirtelTigo) — POST only, no query
```http
POST /commissionservices/{acct}/{airtimeServiceId}
{ "Destination": "233246912184", "Amount": 0.5,
  "CallbackUrl": "https://kingflexygh.com/api/webhooks/hubtel-commission",
  "ClientReference": "HCS-AIR-<orderId>" }
```
> Airtime: only `Destination` + `Amount`, no `Extradata`. (See §6 for the airtime cap caveat.)

### 4b. Data (MTN / Telecel / AirtelTigo) — query then top-up
```http
GET  /commissionservices/{acct}/{dataServiceId}?destination=233246912184
→ Data: [ { "Display": "1.19GB", "Value": "flexi_data_bundle", "Amount": 20.0 }, ... ]

POST /commissionservices/{acct}/{dataServiceId}
{ "Destination": "233246912184", "Amount": 20.0,
  "CallbackUrl": "...", "ClientReference": "HCS-DATA-<orderId>",
  "Extradata": { "bundle": "flexi_data_bundle" } }
```
> **`Amount` AND `bundle` must match a row from the query** or the txn fails.
> `Value` formats differ per network: MTN = `data_bundle_1` / `flexi_data_bundle`;
> AirtelTigo = `DATA1`/`DATA50`; Telecel = the literal size string like `25 MB`.

### 4c. Telecel Broadband — query (account lookup) then top-up
```http
GET  /commissionservices/{acct}/b9a1aa.../?destination=0302450262
→ name / amountDue / account
POST body adds Extradata.bundle = the broadband number.
```
> Broadband commission is frequently **0** — confirm before relying on it.

### 4d. TV bills (DSTV / GOtv / StarTimes) — query (account lookup) then pay
```http
GET  /commissionservices/{acct}/{tvServiceId}?destination={accountNumber}
→ name / amountDue / account (or Name / Account Number / Bouquet for StarTimes)
POST { "Destination": "{accountNumber}", "Amount": 50,
       "CallbackUrl": "...", "ClientReference": "HCS-TV-<orderId>" }   # no Extradata
```

### 4e. ECG (prepaid & postpaid) — query (meter list) then top-up
```http
GET  /commissionservices/{acct}/e6d6ba.../?destination=233541312238
→ list of meters: { Display: "THOMAS ANANE (G131099826)", Value: "G131099826", Amount: -1.1432 }
POST { "Destination": "233541312238", "Amount": 1, "CallbackUrl": "...",
       "ClientReference": "HCS-ECG-<orderId>",
       "Extradata": { "bundle": "<MeterNumber>" } }
```
> ⚠️ The ECG top-up **links the phone number to the meter** if not already linked.
> Make sure that is intended.
>
> **The POST (top-up) shape above is now CONFIRMED OFFICIAL** — see
> [hubtel-ecg-meter-topup.md](hubtel-ecg-meter-topup.md) (pasted verbatim
> from Hubtel 2026-08-19). Critical finding from that doc: **the top-up
> response/callback never returns an account-holder name** (`RecipientName`
> is `null` in Hubtel's own sample) — so the top-up call itself provides
> zero identity verification, before or after paying. The GET query line
> above (phone → meter list with names) is still the **only** verification
> source, and its shape is still RECONSTRUCTED/unofficial — whether it (or
> any endpoint) accepts a bare **meter number** as `destination` and returns
> a name is still unconfirmed. See the "Open question" section of the ECG
> doc above.

### 4f. Ghana Water (GWCL) — RECONSTRUCTED, verify before coding
Truncated in the source doc; the businessdocs portal blocks automated fetch.
**Field names below are INDICATIVE — confirm against Hubtel's v01.08.20 PDF / portal.**
```http
GET  /commissionservices/{acct}/{ghanaWaterServiceId}?destination={meter}&mobile={phone}
POST { "Destination": "{meter}", "Amount": {ghs}, "CallbackUrl": "...",
       "ClientReference": "HCS-GW-<orderId>", "Mobile": "{phone}" }
```
> ⚠️ Ghana Water REQUIRES **both** `destination` (meter/account) **and** `&mobile=`
> (customer phone) — GWCL keys the lookup on the registered mobile. Easy to miss.

### Sample success callback (shape is consistent across services)
```json
{ "ResponseCode": "0000",
  "Data": {
    "AmountDebited": 0.5, "TransactionId": "5b40e2e4...", "ClientReference": "HCS-DATA-123",
    "Description": "GHC 0.50 (data_bundle_1) has been sent to 233242825109 ...",
    "ExternalTransactionId": "2024012416592042208544402",
    "Amount": 0.5, "Charges": 0,
    "Meta": { "Commission": "0.0198" }, "RecipientName": null } }
```

---

## 5. Commission — the real rate card

> ⚠️ **Do NOT use the commission numbers inside the API JSON samples.** They are
> placeholders (e.g. AirtelTigo airtime showing `0.35` on a `0.50` top-up = 70%).
> The same is true of the marketing tiles on `designs.hubtel.com`.

**Verified baseline rate card** — Hubtel's own legal page
([explore.hubtel.com/legal/service-fees](https://explore.hubtel.com/legal/service-fees/),
"Commission on Bill Payment Integrations", fetched June 2026):

| Service | Commission | Per GHS 1,000 sold |
|---|---:|---:|
| MTN Airtime | **5.5%** | GHS 55 |
| AirtelTigo Airtime | **7%** | GHS 70 |
| Telecel Airtime | **7%** | GHS 70 |
| Glo Airtime | 7% | GHS 70 |
| MTN Data | **5.5%** | GHS 55 |
| AirtelTigo Data | **7%** | GHS 70 |
| Telecel Data | **7%** | GHS 70 |
| Glo Data | 7% | GHS 70 |
| MTN Fibre Data | 3% | GHS 30 |
| DSTV | 1% | GHS 10 |
| GOtv | 1% | GHS 10 |
| StarTimes | 0.95% | GHS 9.50 |
| ECG (prepaid & postpaid) | 1.90% | GHS 19 |
| WAEC Results | 8% | GHS 80 |
| SHS Placement | 10% | GHS 100 |
| Ghana Water | **not listed — confirm with Hubtel** | ? |

**Two critical nuances:**
1. **These are the DEFAULT baseline.** The commission you *actually* earned is
   returned LIVE per transaction in `Meta.Commission`. Always trust the live value,
   never a hardcoded %, because rates are merchant-negotiable and some services
   compute commission inclusive vs exclusive of face value.
2. **Volume rebates** — Hubtel publishes turnover rebate tiers (~10% uplift at
   GHS 20–40M turnover, up to ~30% at GHS 100M+). High volume raises the effective rate.

### "How much will I get for all?" — worked projection (real rates)

There is no single total — earnings = Σ(volume × live rate). Example monthly mix
for a busy KiNG-FLEXY-style merchant (illustrative volumes, **verified** rates):

| Category | Monthly sales | Rate | Commission |
|---|---:|---:|---:|
| MTN Airtime | GHS 15,000 | 5.5% | GHS 825 |
| AirtelTigo Airtime | 3,000 | 7% | 210 |
| Telecel Airtime | 2,000 | 7% | 140 |
| MTN Data | 20,000 | 5.5% | 1,100 |
| AirtelTigo Data | 4,000 | 7% | 280 |
| Telecel Data | 3,000 | 7% | 210 |
| DSTV | 5,000 | 1% | 50 |
| GOtv | 2,000 | 1% | 20 |
| StarTimes | 1,000 | 0.95% | 9.50 |
| ECG | 8,000 | 1.90% | 152 |
| **Total** | **GHS 63,000** | **~4.75% blended** | **≈ GHS 2,996 / month** |

**Takeaways:** airtime + data (5.5–7%) are where the money is; TV/utilities are
thin (~1%). Swap in your real volumes and your measured `Meta.Commission` values.
Settlement is **instant per sale** (commission realized as a reduced debit against
your Disbursement Account float), not on a T+N payout cycle.

---

## 6. Response codes & known issues

**Response codes** (0000/0001 verified; failure codes INDICATIVE — confirm):
- `0000` = SUCCESS, value delivered, commission realized.
- `0001` = PENDING (normal first response) — wait for callback / status-check. Do
  NOT treat as success or failure.
- `2001` / `2000-series` = failed / validation/processing failure (bad destination,
  unsupported amount, downstream rejection).
- `4xxx` / "insufficient balance" class = **Disbursement Account float too low** —
  the single most important operational failure. Top up the float.
- `401` = bad/missing Basic-Auth credentials.

**Gotchas:**
1. **Mandatory 5-minute status check** (VERIFIED) — never finalize/refund on
   callback-silence; poll the Status Check API.
2. **Async by default** — build idempotent, de-duped callback handling keyed on
   `ClientReference` (callbacks can arrive more than once).
3. **Insufficient Disbursement float** is the top real-world failure — monitor the
   balance and alert before zero.
4. **Airtime cap** — the public doc mentions a "100 GHS per request" airtime max,
   but the universal figure is UNVERIFIED; network-imposed per-txn ceilings exist.
   Confirm per network.
5. **Rate limits** — none published; design for 429/backoff, confirm your tier.
6. **Sample-value trap** — never hardcode commission from the JSON samples.
7. **Static IP** — like USSD, Commission callbacks/outbound calls may need our
   **Fixie static IP** if Hubtel IP-allowlists us → same per-order proxy cost floor.
   Separately, Hubtel's own **outbound callback IP** is `18.202.122.131`
   (confirmed 2026-08-19, see [hubtel-ecg-meter-topup.md](hubtel-ecg-meter-topup.md))
   — optional inbound allowlisting, not required since our webhook already
   fail-closed authenticates via a per-request HMAC in the CallbackUrl.
8. **Ghana Water** needs BOTH `Destination` (meter) AND `&mobile=` (phone).

### Status Check API (RECONSTRUCTED — verify path/param spelling)
```http
GET /commissionservices/{acct}/transactionstatus?clientReference={ourRef}
    (some surfaces also accept &hubtelTransactionId={id})   # Basic-Auth
```
Returns authoritative final `ResponseCode`/Status for that `ClientReference`.

---

## 7. Disbursement Account / onboarding

- **What:** a pre-funded float account on Hubtel ("the account you fund when you
  need to send money out … API and commission services"). Formerly "Prepaid Account".
- **To get one:** (1) hold a Hubtel **Merchant Account**, (2) request Commission
  Services / API access be enabled, (3) Hubtel issues the **Disbursement Account
  Number** (the path segment) + Basic-Auth Client ID/Secret. Self-service steps are
  **not** publicly documented — confirm with Hubtel onboarding.
- **Settlement:** commission is realized instantly per sale on-platform; moving the
  accumulated balance out to bank/MoMo follows Hubtel's normal payout schedule (T+1..T+3).

---

## 8. Implementation-fit notes for KiNG FLEXY GH (greenfield)

Recon of the current codebase (2026-06-17) — slot a Commission Services provider
into the **existing swappable-provider pattern** (DataKazina / Xpress / GhData / CodeCraft):

| Concern | Existing pattern to reuse | Cite |
|---|---|---|
| Auth | Basic `HUBTEL_API_ID:HUBTEL_API_KEY` | `lib/ussd/hubtel-callback.ts:26`, `app/api/ussd/status-check/route.ts:47` |
| Static IP egress | `HttpsProxyAgent(HUBTEL_PROXY_URL)`, IPs `54.217.142.99 / 54.195.3.54` | `lib/ussd/hubtel-callback.ts:8,35,50` |
| Provider dispatch | `admin_settings.fulfillment_settings` JSON, single-enabled-per-network guard | `lib/fulfillment-trigger.ts:76,93-147` |
| Provider interface | `fulfillOrder() → { success, reference, transactionId, error, apiResponse }` | each `*-service.ts` |
| Circuit breaker | open/half-open/closed | `lib/fulfillment-service.ts:9-90` |
| Inbound webhook | IP-guard / fail-closed HMAC `timingSafeEqual`, post-webhook sync + push | `app/api/webhooks/dakazina/route.ts:36,129-150`, `xpress/route.ts:17-38` |
| Idempotency | `orders.reference_code` unique check (`PGRST116`); atomic claim `WHERE … IS NULL` | `lib/ussd/fulfillment/data.ts:39,47-52`; `app/api/ussd/fulfill/route.ts:65-68` |
| Order tables | `orders`, `shop_orders`, `airtime_orders`, `results_checker_orders`, `mtn_fulfillment_tracking` | — |

**Files to create when we build it:**
- `lib/hubtel-commission-service.ts` — `fulfillOrder(network, phone, amount, bundle, orderId)`,
  query-then-topup for data/bills, returns the standard provider shape, uses the
  Fixie proxy. Reference format `HCS-<category>-<orderId>`.
- `app/api/webhooks/hubtel-commission/route.ts` — inbound callback; verify signature
  fail-closed (`HUBTEL_COMMISSION_WEBHOOK_SECRET`); `processing → completed`; persist
  `Meta.Commission`; then `syncShopOrderStatus` + push notification (Dakazina pattern).
- Add `commission_networks` to `admin_settings.fulfillment_settings`; dispatch branch
  in `lib/fulfillment-trigger.ts`. Track float in `admin_settings.hubtel_commission_balance`.

**New env vars:** `HUBTEL_DISBURSEMENT_ACCOUNT`, `HUBTEL_COMMISSION_WEBHOOK_SECRET`
(reuse `HUBTEL_API_ID` / `HUBTEL_API_KEY` / `HUBTEL_PROXY_URL`).

> Build under the **5-stage `kingflexy-workflow`** when we decide to implement — this
> doc is the Stage-1 exploration input, not an approved plan.

---

## 9. Confirm with Hubtel before coding

- Our **Disbursement Account Number** + Commission Services Client ID/Secret.
- The real **Ghana Water ServiceID** GUID (and any others account-specific).
- Exact **Status Check** path + param casing; exact **failure ResponseCodes**.
- Exact **Ghana Water** query/pay field names (`Mobile` casing, `&mobile=`).
- Whether Hubtel **IP-allowlists** us (→ Fixie cost floor) and the **rate limits** for our tier.
- The real **airtime per-transaction cap** per network.
- Whether Commission Services callbacks carry a **signature header** to verify (and its name).

## 10. Sources
- Rate card: <https://explore.hubtel.com/legal/service-fees/>
- Commission Services overview: <https://news.hubtel.com/commission-services/>
- Disbursement Account: <https://news.hubtel.com/clearer-account-names-on-your-money-page/>
- Authoritative PDF (body not machine-fetchable): Hubtel Commission Services API Guide v01.08.20
- Portal (blocks bots): <https://businessdocs-developers.hubtel.com/docs/general-services-1>
