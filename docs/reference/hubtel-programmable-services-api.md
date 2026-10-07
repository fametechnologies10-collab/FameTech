# Hubtel Programmable Services API — Reference

> Saved 2026-06-16 from Hubtel's official docs (last updated 2026-06-15). The
> authoritative contract for our USSD integration (`*713*9939#`). Two endpoints:
> Service Interaction URL (`/api/ussd/interact`) and Service Fulfilment URL
> (`/api/ussd/fulfill`).

## Push request (Hubtel → our Service Interaction URL)

| Field | Type | Notes |
|---|---|---|
| Type | String | `Initiation` \| `Response` \| `Timeout` |
| Message | String | The text the user entered |
| ServiceCode | String | e.g. `713` |
| Operator | String | `tigo` \| `airtel` \| `mtn` \| `vodafone` |
| ClientState | String | Echoed back from our previous response (we sign it, HMAC) |
| Mobile | String | `233XXXXXXXXX` |
| SessionId | String | Unique per session |
| Sequence | Int | Message position |
| Platform | String | `USSD` \| `Webstore` \| `Hubtel-App` |

## Response (our app → Hubtel)

| Field | Req | Notes |
|---|---|---|
| SessionId | Mandatory | |
| Type | Mandatory | `response` \| `release` \| **`AddToCart`** (ends session, sends cart to checkout for payment) |
| Message | Mandatory | `\n` = newline. **Do NOT include special characters (e.g. É)** — causes `Error: UUE` ("response invalid"). |
| Item | Optional | Present ONLY for `AddToCart` (the payable item). Must be empty for other types. |
| Label | Mandatory | Title for web/app channels |
| DataType | Mandatory | `display` \| `input` |
| FieldType | Mandatory | `text` \| `phone` \| `email` \| `number` \| `decimal` \| `textarea` |
| Mask, ServiceCode, Sequence, ClientState | Optional | |

### AddToCart response (triggers the MoMo payment prompt) — canonical example
```json
{
  "SessionId": "3c796dac28174f739de4262d08409c51",
  "Type": "AddToCart",
  "Message": "The request has been submitted. Please wait for a payment prompt soon",
  "Item": { "ItemName": "Send Money", "Qty": 1, "Price": 150.5 },
  "Label": "The request has been submitted. Please wait for a payment prompt soon",
  "DataType": "display",
  "FieldType": "text"
}
```
- **`Price` may be a decimal** (`150.5`) — whole-cedi is NOT required.
- `Item` = `{ ItemName, Qty, Price }`. No `ItemId` needed in the AddToCart item.
- Our impl: `lib/ussd/utils.ts` `addToCart()` — matches this exactly.

## `ItemName` / `Description` content policy (read before adding any Hubtel field)

**Background:** on 2026-08-22 a partner reseller (Ad-Arhms Technologies) had their Hubtel
account suspended from withdrawals. Their `hubtel_receive_charges`/Commission Services
`ClientReference` and `Description` fields both read like `DATA-GHD-...` /
`"ARHMS Data - MTN 2GB"` — i.e. they literally named the resold product ("Data", the
network, the bundle size) plus the recipient's MSISDN, on every single transaction.
Hubtel's financial-monitoring team flags/suspends merchant accounts on exactly this
pattern of description text (reselling data/airtime is against their merchant terms in
volume). **We were never at risk on `ClientReference`** — ours is a random hex code
(`UTIL-ECG-a1b2...`) — but `Item.ItemName` on the USSD `AddToCart` rail *did* carry the
same pattern (`"MTN 2GB Data - 0249095289"`) until this was fixed.

**Where this text ends up — this is why it matters:** any free-text field we send Hubtel
(`ItemName`, `Description`) is not private to the API call. Hubtel republishes it verbatim
on:
1. The merchant **dashboard** transaction list (`description` column).
2. The **settlement CSV** export (same `description` column) — this is what an account
   reviewer or automated monitoring job reads in bulk.
3. The **customer-facing SMS receipt** (`r.hbtl.co/p/<id>`) — a public, unauthenticated
   URL. Anyone with the link (not just the customer) can view it. PII put here is a data
   exposure independent of the account-suspension risk.

**Rules for any current or future field we control (`ItemName` on AddToCart, `Description`
on Direct Receive Money — see `lib/hubtel-receive-money.ts`):**
- **No product words.** Never write "Data", "Bundle", "Airtime Top-up", a network name
  (MTN/Telecel/AirtelTigo), or a size unit (GB/MB) into these fields. Utility bill payments
  (`ECG GHS 10.00` etc., `lib/ussd/handlers/utility.ts`) are the one exception — Hubtel
  itself is the biller there, so there is no "reselling" signature to hide.
- **No customer PII.** Never write a recipient/customer MSISDN or a full name into these
  fields — they end up on the public receipt URL above regardless of the flagging risk.
- **No value that correlates 1:1 with `Price` across transactions.** This includes coded
  substitutes (e.g. a digit meaning "5" = 5GB, a letter meaning "medium bundle"). `Price`
  itself can never be hidden — it is what Hubtel charges. If a description token
  consistently pairs with a specific price across many transactions, that pairing *is* the
  same resale signature, just relabeled — an automated review does not need the word
  "data" to notice "many small charges to distinct MSISDNs, falling into fixed price
  buckets that repeat with a fixed code." Categorizing by *service type only* (a letter
  that is constant regardless of size/amount, e.g. always "D" for every data order
  regardless of GB) would be safe by this rule, but was deliberately **not** adopted here —
  we kept the codes fully random with no letter at all, to leave zero categorization signal.
- **Prefer opaque, session-derived codes.** Our convention: `orderCode(sessionId)` in
  `lib/ussd/utils.ts` — the first 6 alphanumerics of Hubtel's own `SessionId`, uppercased.
  It is never read back on our side (fulfillment always resolves by `SessionId` via
  `ussd_pending_orders.order_payload`, and `HubtelFulfillment.OrderInfo.Items[].Name` is
  ignored — see `lib/ussd/types.ts`), so it costs us nothing to keep it meaningless. Support
  can still trace a receipt back with
  `select * from ussd_pending_orders where session_id ilike '<code>%'`.
- **Current state (2026-08-22):** `data`, `afa`, and `airtime` USSD flows use
  `KFT Order <code>` / include `<code>` — see `lib/ussd/handlers/{data,afa,airtime}.ts`.
  `results_checker` still uses `"${rcTypeName} x${rcQuantity} PIN(s)"` (low risk — RC
  vouchers are not a resale-restricted product) and was left unchanged; revisit if that
  assessment ever changes. `utility` is exempt per the biller exception above.

## IP whitelisting (what it actually gates)
- **Only OUTBOUND calls from us → Hubtel require a whitelisted public IP:**
  1. Service Fulfilment **callback** → `https://gs-callback.hubtel.com:9055/callback` ("not public, IP whitelisting required").
  2. **Transaction Status Check** → `https://api-txnstatus.hubtel.com/transactions/{Collection_Account_Number}/status` ("Only requests from whitelisted IP(s) can reach the endpoint").
- We satisfy this via a **self-hosted tinyproxy static IP on DigitalOcean** (`HUBTEL_PROXY_URL`, egress `178.128.199.211:8888`, droplet name `hubtel-proxy`, region FRA1) — migrated off Fixie as primary on 2026-09-06 after its 500 req/mo quota lapsed; new IP confirmed whitelisted by Hubtel 2026-09-08. BasicAuth creds live only in `HUBTEL_PROXY_URL` and on the droplet's `/etc/tinyproxy/tinyproxy.conf` — not duplicated here.
- **Fixie is kept as a MANUAL-only fallback** — its old IPs (`54.217.142.99` / `54.195.3.54`) remain whitelisted on Hubtel's side and the subscription stays active but unused. If the DigitalOcean droplet ever goes down, recover by manually pointing `HUBTEL_PROXY_URL` back at Fixie in the env — there is no automatic in-code failover between the two (deliberately kept out of `lib/hubtel-*.ts` since that's fulfillment-adjacent, fintech-guardrail territory).
- **Convention for future integrations:** any new endpoint (Hubtel or otherwise) that requires IP-allowlisting should default to routing through this same DigitalOcean `hubtel-proxy` droplet rather than standing up another Fixie-style service per integration.
- ⚠️ **tinyproxy only tunnels CONNECT to ports listed in `ConnectPort` in `/etc/tinyproxy/tinyproxy.conf`** (default ships with just `443` and `563`). The Service Fulfilment callback (`gs-callback.hubtel.com:9055`) uses port **9055**, which was NOT in that list after the 2026-09-06 migration — every callback silently failed at the proxy layer (`403 Access violation` from tinyproxy itself, never reaching Hubtel) until `ConnectPort 9055` was added and tinyproxy restarted on 2026-09-08. **Any future Hubtel/third-party endpoint on a non-443 port must get its own `ConnectPort` line added on the droplet**, or it will fail the same way — check every base URL for a `:<port>` before assuming the proxy just works.
- Hubtel's own service-fulfilment source IPs (optional to whitelist on our side): `52.50.116.54, 18.202.122.131, 52.31.15.68` (used by `lib/ussd/ip-guard.ts`).
- **IP whitelisting does NOT gate the MoMo payment prompt** — that is initiated by Hubtel's checkout after it receives our `AddToCart`.

## Service Fulfilment (Hubtel → our `/api/ussd/fulfill`, after payment)
Payload: `{ SessionId, OrderId, ExtraData, OrderInfo: { ..., Payment: { PaymentType, AmountPaid, IsSuccessful, ... } } }`.

## Fulfilment callback (us → Hubtel, within 1 hour of fulfilment)
`POST https://gs-callback.hubtel.com:9055/callback` → `{ SessionId, OrderId, ServiceStatus: "success"|"failed", MetaData }`.

## Transaction Status Check (mandatory fallback if no final status after 5 min)
`GET https://api-txnstatus.hubtel.com/transactions/{Collection_Account_Number}/status?clientReference={SessionId}` (Basic auth). `data.status` ∈ `Paid | Unpaid | Refunded`.
