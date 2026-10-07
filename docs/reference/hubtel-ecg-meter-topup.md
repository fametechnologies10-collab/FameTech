# Hubtel Commission Services — ECG Meter Top-Up (Official Doc)

> Saved 2026-08-19, pasted verbatim by the project owner from Hubtel's own
> ECG Meter Top-Up page. This is the **authoritative** POST/top-up shape —
> supersedes the RECONSTRUCTED notes in
> [hubtel-commission-services.md](hubtel-commission-services.md) §4e for the
> POST call specifically. That file's GET query shape (phone → meter list)
> is a **separate, still-unofficial** endpoint — see "Open question" below.

## Endpoint

| | |
|---|---|
| URL | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/e6d6bac062b5499cb1ece1ac3d742a84` |
| Method | `POST` |
| Content-Type | `application/json` |

## Request parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `Destination` | String | Mandatory | **The mobile phone number** linked to a particular ECG Meter (NOT the meter number). |
| `Amount` | Float | Mandatory | Amount to top up. |
| `CallbackUrl` | String | Mandatory | Where Hubtel POSTs the final result. |
| `ClientReference` | String | Mandatory | Our idempotency key. |
| `Extradata.bundle` | String | Mandatory | **The actual Meter Number** being topped up. |

> ⚠️ Hubtel's own note: *"This endpoint will link the phone number to the
> meter if that has not already been done. Please ensure that this is your
> intended action."* — confirms `linksPhoneToAccount: true` in
> `lib/hubtel-utility/billers.ts` is correct, and that the consent-gated
> manual-entry warning in `UtilityFlowSheet.tsx` is doing the right thing.

## Response (sync, 200 OK)

```json
{
  "ResponseCode": "0001",
  "Message": "Transaction pending. Expect callback request for final state",
  "Data": {
    "ClientReference": "TestDATA2022052105",
    "Amount": 1,
    "TransactionId": "6bf810b8f7d5424a973165b36cc1817e",
    "Meta": { "Commission": "0.0171" }
  }
}
```

## Callback (async, final result)

```json
{
  "ResponseCode": "0000",
  "Data": {
    "AmountDebited": 1,
    "TransactionId": "6bf810b8f7d5424a973165b36cc1817e",
    "ClientReference": "TestDATA2022052105",
    "Description": "success",
    "ExternalTransactionId": "7289775",
    "Amount": 1,
    "Charges": 0,
    "Meta": { "Commission": "0.0171" },
    "RecipientName": null
  }
}
```

## ⚠️ Critical finding: no name confirmation anywhere in this call

**Neither the sync response nor the callback returns a usable account-holder
name.** `RecipientName` is present in the callback shape but is `null` in
Hubtel's own sample. Every other field (`AmountDebited`, `TransactionId`,
`ExternalTransactionId`, `Amount`, `Charges`, `Meta.Commission`) is
transaction bookkeeping, not identity confirmation.

**Consequence:** the Top-Up call is a pure "send money to this
phone+meter pair" operation with zero built-in verification. It cannot be
used to confirm — before OR after paying — that the meter belonged to the
intended person. Money moves on `Destination` + `Extradata.bundle` alone;
if either is wrong, there is no signal in this endpoint's own response to
catch it. Any verification has to come from a **separate** query call made
*before* this one, not from this endpoint itself.

## New info not previously captured

- **Inbound callback IP to allowlist (optional hardening):** `18.202.122.131`.
  Hubtel offers this as an optional extra layer ("businesses that want to
  add an extra layer of security... can whitelist Hubtel's callback IP").
  Not required — `app/api/webhooks/hubtel-commission/route.ts` already
  fail-closed authenticates callbacks via a per-request HMAC embedded in the
  `CallbackUrl` itself (`?ref&ts&sig`), which is order-bound and time-bounded
  and doesn't depend on Hubtel's source IP staying static. An IP allowlist
  would be defense-in-depth on top of that, not a replacement.

## Open question — still needs Hubtel's separate Query doc

This doc only covers the **top-up (POST)**. The existing "find my meters"
feature (phone → list of linked meters with names, used in
`UtilityFlowSheet.tsx` step 2) calls a **different, GET query** endpoint
that isn't in this doc — its shape was reconstructed in
[hubtel-commission-services.md](hubtel-commission-services.md) §4e from
general recon, not from an official ECG-specific page.

**What we still don't know:** whether that GET query accepts a **meter
number** as `destination` (not just a phone number) and returns the
account holder's name for it. If Hubtel's official ECG *Query* doc confirms
that, it would let us verify a name for a manually-typed meter number
before payment, closing the current "unverified meter" gap entirely. Ask
for that doc next.
