-- ═══════════════════════════════════════════════════════════
-- Task 3 addition: freeze the Paystack fee quoted at checkout time.
--
-- shop_afa_pending_orders already freezes cost_price/selling_price/profit at
-- checkout, but lib/shop-afa-order-processor.ts re-derived the Paystack fee
-- LIVE at verify time. If a shop's paystack_fee_percent changes between
-- checkout and payment confirmation, the expected total shifts and a
-- legitimately-paid registration can be rejected as an amount mismatch.
--
-- Nullable: existing staged rows have no frozen fee — the processor falls
-- back to the live lookup for those.
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.shop_afa_pending_orders ADD COLUMN IF NOT EXISTS paystack_fee numeric;

NOTIFY pgrst, 'reload schema';
