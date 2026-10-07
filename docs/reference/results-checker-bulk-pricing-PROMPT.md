# Copy-paste prompt for your friend's Claude Code

> Hand everything below the line to Claude Code in his project. It tells his AI to study
> his existing results-checker feature first, then add quantity-based **bulk pricing** and
> polish the **buy UI/UX** to match this reference. Stack assumed: Next.js (App Router) +
> TypeScript + Postgres/Supabase. If his stack differs, the AI should map the concepts over.

---

I have an existing **results checker** feature in this app — it sells exam-result voucher
cards (each voucher is a `serial_number` + `PIN`). It already lists exam types, takes a
quantity, charges the buyer, and reveals/sends the voucher. I want to add **quantity-based
bulk pricing ("buy more, pay less per unit")** and bring the buy screen's UI/UX up to the
spec below.

**Do this in order:**

### Step 0 — Audit my repo first (read-only)
Find and report, before changing anything:
- My exam-types table/model and its price columns (whatever I call cost/sell price).
- Where my unit price is calculated (server-side) and where the buy page renders the price.
- My quantity input + checkout flow + voucher-reveal UI.
Then map my names to the reference below and tell me your plan. **Adapt to my code — don't
rip out working pieces or rename my tables unless necessary.**

### Step 1 — Data model: add bulk tiers + role prices
On the exam-types table add (use my existing equivalents where present):
- `cost_price numeric` — my true supplier cost. **This must never be sent to the browser.**
- Optional role-based sell prices `customer_price`, `agent_price`, `dealer_price` (if I only
  have one sell price, keep one — bulk pricing works with a single base too).
- **`bulk_pricing jsonb default '[]'`** — an array of quantity bands:
  ```json
  [
    { "min_qty": 1,  "max_qty": 10,    "unit_price": 55 },
    { "min_qty": 11, "max_qty": 50,    "unit_price": 50 },
    { "min_qty": 51, "max_qty": 99999, "unit_price": 45 }
  ]
  ```
- A DB CHECK so a sell price can never be below `cost_price`.
- (If I resell through sub-shops) a per-shop, per-exam markup table
  `{ shop_id, exam_type_id, markup }`, plus an optional global "max markup" setting.

### Step 2 — The pricing engine (server-side, single source of truth)
Create ONE server function every checkout path calls. **The client never sends a price; the
server recomputes it.** It's a small waterfall:

```ts
// 1) base unit price (role-based if I have roles, else my single sell price)
let unitPrice = getBasePrice(type, role)

// 2) BULK OVERRIDE: first band the quantity falls inside replaces the unit price.
//    NOTE: no proration — buy 51 and ALL 51 are priced at the 51+ rate.
const tiers = Array.isArray(type.bulk_pricing) ? type.bulk_pricing : []
const matched = tiers.find(t => quantity >= t.min_qty && quantity <= t.max_qty)
if (matched) unitPrice = Math.max(matched.unit_price, type.cost_price) // never below cost

// 3) optional reseller markup, capped by the global max (0 = uncapped)
const appliedMarkup = maxMarkup > 0 ? Math.min(shopMarkup, maxMarkup) : shopMarkup

// 4) totals (+ payment-gateway fee only if the buyer pays the fee)
const subtotal = +(((unitPrice + appliedMarkup) * quantity).toFixed(2))
const fee      = chargeFeeToBuyer ? +(subtotal * (feePercent / 100)).toFixed(2) : 0
const total    = +(subtotal + fee).toFixed(2)

return { unitPrice, appliedMarkup, subtotal, fee, total, appliedTier: matched ?? null }
```
Rules: tier override replaces the **base** price, then markup is added **on top** (so resale
margin survives bulk discounts). Floor every layer at `cost_price`. Throw if anything lands
below cost.

### Step 3 — Buyer UI/UX on the buy screen
Recreate this interaction (use my existing components/styling — match these behaviors):
- **Exam-type select** — cards; show the price on each; selecting is required (no default).
  Out-of-stock types are dimmed with a "Sold out" overlay and disabled controls.
- **Quantity stepper** — `[ − ] [ number input ] [ + ]`, clamped to `1…maxQuantity`, native
  number-spinners hidden. Hint: "Bulk discounts apply automatically · Max {maxQuantity}".
- **Bulk-tier strip** — visible only when the selected type has tiers. Render one pill per
  band as `"min–max · {price}/ea"` (show the top band as `"51+"`). **Highlight the band that
  matches the current quantity** (e.g. amber fill) and recompute the price **live** as the
  user taps +/−. Put a small "Bulk pricing" badge on the section header when tiers exist.
- **Order summary** — exam name, quantity, **unit price** (with a small "bulk" tag when a
  tier matched), the payment fee row (only if the buyer pays it), and a bold **Total**.
- **CTA** — disabled until a type is selected and in stock. If paying from a balance and the
  total exceeds it, swap the button to an "insufficient — top up" state.
- **Success/reveal** — show the voucher(s) as cards with `PIN` + `serial`, each with a
  **Copy** button and a **blur-to-reveal** PIN toggle (eye icon), plus a **Download receipt**
  (a `.txt`/PDF listing all vouchers + reference + the exam portal URL).
- Re-pull live prices on mount + window focus so a stale snapshot can't disagree with the
  server's charge. **Make the UI's tier-match rule identical to the server's** or the shown
  total won't equal the charged total.

### Step 4 — Admin: author the tiers
On my admin exam-type form add a **bulk-pricing editor**: an "Add Tier" button that appends
`{ min_qty, max_qty, unit_price }` rows (`[min][max][price][✕]` each), saved into the
`bulk_pricing` JSONB. Validate server-side: reject `unit_price < cost_price`, `min_qty < 1`,
or `max_qty < min_qty`. (Author bands disjoint — overlaps aren't auto-checked; first match
wins.) Add a global "max markup" + "max quantity per order" + "fee %" setting if I resell.

### Step 5 — (If I have sub-shops) shop-owner markup
A per-exam markup input per exam with a live "Sells for / Your profit" preview. Clamp it to
the global max **server-side** on save (and show "clamped to X" in the UI when over).

### Acceptance criteria
- Changing quantity instantly updates the highlighted tier, unit price, and total on screen,
  and the **charged** total equals the **displayed** total for every quantity.
- A tier or markup can never sell below `cost_price`; `cost_price` never appears in any API
  response or browser payload.
- Admin can add/edit/remove tiers; buyer sees them as pills; out-of-stock is handled.

### Guardrails (keep brief but do them)
- Server is authoritative for price — ignore any client-sent amount.
- Keep `cost_price` strictly server-side (and out of any payment-gateway metadata).
- If voucher stock is finite, reserve the exact quantity atomically at checkout so two
  buyers can't claim the same card (one DB transaction; all-or-nothing). Don't over-engineer
  beyond that for this task.

Show me your audit findings and plan before writing code.
