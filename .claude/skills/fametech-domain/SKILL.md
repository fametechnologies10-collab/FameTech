---
name: kingflexy-domain
description: Ghana telecom domain knowledge for KiNG FLEXY GH — user roles, pricing tiers, network operators, product types, wallet system, and agent/dealer business logic. Use when reasoning about business logic, pricing, order flows, or user permissions.
---

# KiNG FLEXY GH — Domain Knowledge

## User roles (hierarchy: admin > sub-admin > dealer > agent > customer)

| Role | Description | API access |
|---|---|---|
| `admin` | Full platform control | Yes |
| `sub-admin` | Delegated admin tasks | Yes |
| `dealer` | Wholesale reseller; creates own shop storefronts | Yes |
| `agent` | Retail reseller; buys at agent prices | Yes |
| `customer` | End user; buys at retail prices | No |

Role display config (icons, colors) is in `lib/roles.ts`. Use `roleConfig[role]` for UI rendering.

## Networks (Ghana telecom operators)

| Name | DataKazina ID | Notes |
|---|---|---|
| MTN | 3 | Largest; also supports AFA registrations |
| Telecel | 2 | Formerly Vodafone |
| AT-iShare | 1 | AirtelTigo iShare bundles |
| AT-BigTime | 4 | AirtelTigo BigTime bundles |

## Product types

| Type | Description |
|---|---|
| Data bundles | MTN, Telecel, AirtelTigo data packages (volume in MB/GB) |
| Airtime | Direct mobile credit top-up |
| Mashup | Combined data + SMS or mixed bundles |
| Results checker | WAEC, BECE, WASSCE voucher codes for school exam results |
| AFA registration | MTN Authorized Field Agent registration service |

## Pricing tiers

Packages have 3 price tiers stored in the `packages` table:
- `price` — retail (customer) price
- `agent_price` — discounted price for `agent` role
- `dealer_price` — further discounted price for `dealer` role

Apply the correct tier based on `userRole` when calculating order cost.

## Wallet system

- Every user has one wallet (`wallets` table)
- Top-up via Paystack (GHS only)
- Orders are deducted atomically from `wallets.balance`
- Failed orders trigger a refund back to `wallets.balance`
- Wallet transactions are logged in `wallet_transactions` or similar audit table

## Agent/Dealer upgrade system

- Agents and dealers pay an upgrade fee to activate their role
- Upgrade plans: 3-day, 14-day, 30-day, lifetime
- Payment tracked in a separate payments table; fulfilled via `lib/dealer-payments.ts`
- Expiry is stored per user and enforced at order time

## Shop storefronts

- Dealers and agents can create branded shops
- Each shop has a custom subdomain or slug
- Shop orders flow through `lib/shop-order-processor.ts`
- Shop domain resolution handled in `app/shop-domain/`

## Cron jobs (14 total)

Called by cron-job.org with `Authorization: Bearer <CRON_SECRET>` as GET requests to `/api/cron/**`. Used for: re-fulfillment retries, bundle cache refresh, expiry enforcement, notification dispatch.

## Gotchas

- "Dealer" and "Agent" are both reseller tiers but with different price points. Never apply dealer pricing to an agent or vice versa.
- AFA (Authorized Field Agent) registration is an MTN-specific product, not a general platform role.
- WAEC/BECE vouchers are delivered as codes (strings), not credits — they go into `orders.metadata`.
- Ghana phone numbers are typically 10 digits starting with 02x or 05x. Validation is in `lib/phone-validation.ts`.
- GHS (Ghana Cedis) is the only currency. Never store fractional cedis — amounts are in whole pesewas (integer) or GHS with 2 decimal places depending on the table; check the column type before inserting.
