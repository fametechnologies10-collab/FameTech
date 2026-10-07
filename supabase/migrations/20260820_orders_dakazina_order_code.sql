-- ============================================================================
-- MIGRATION: orders.dakazina_order_code — store DataKazina's OWN order identifier
--            alongside our incoming_api_ref, so their webhook can be matched on either.
-- Date:      2026-08-20
--
-- Problem: we only ever stored ONE DataKazina identifier (orders.dakazina_reference), and
-- which value landed there was inconsistent — `responseData?.reference || orderId`, so
-- sometimes their reference, sometimes ours. Their webhook may quote EITHER their own order
-- code ("ORDER-1066677" / "BULK-6A84DB55E13DE", the values shown on their dashboard) or the
-- incoming_api_ref we sent, and we cannot control which. Storing one and hoping it matches
-- is a coin flip; app/api/webhooks/dakazina/route.ts could not resolve an order whose stored
-- value happened to be the other one.
--
-- Fix: keep both. dakazina_reference now always holds the exact incoming_api_ref WE SENT
-- (see buildIncomingApiRef in lib/datakazina-request.ts — on a deliberate retry that now
-- carries a "-r<retry_count>" suffix), and this new column holds THEIR code. The webhook
-- matches on our order id, our reference, or their code.
--
-- Partial index: the column is NULL for every non-DataKazina order, so indexing only
-- non-NULL rows keeps it small, matching the pattern used for
-- idx_orders_hendylinks_order_id (20260819_widen_fulfillment_method_check_hendylinks.sql).
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS are idempotent.
-- No backfill: historical rows keep dakazina_reference as-is and continue to match through
-- the existing exact-reference path; nothing is rewritten.
-- ============================================================================

ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS dakazina_order_code text;

COMMENT ON COLUMN public.orders.dakazina_order_code IS
  'DataKazina''s own order identifier (e.g. ORDER-1066677 / BULK-6A84DB55E13DE). Stored alongside dakazina_reference (the incoming_api_ref we sent) because their webhook may quote either one.';

CREATE INDEX IF NOT EXISTS idx_orders_dakazina_order_code
ON public.orders (dakazina_order_code)
WHERE dakazina_order_code IS NOT NULL;

-- dakazina_reference is also a webhook join key and was never indexed. The webhook filters
-- `.in('dakazina_reference', ...)` on every delivery, so on a high-volume orders table that
-- is a sequential scan per webhook. Same partial-index treatment.
CREATE INDEX IF NOT EXISTS idx_orders_dakazina_reference
ON public.orders (dakazina_reference)
WHERE dakazina_reference IS NOT NULL;

NOTIFY pgrst, 'reload schema';
